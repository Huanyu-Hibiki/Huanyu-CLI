import { t, command, skillLabel } from './i18n.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, utimes } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from './io.js';
import { inspectSkill, parseSkill, isSkillName, compare, resolveDirectory } from './skills.js';
import { checkTree, validateArchive } from './archive.js';
import { tarInvocation } from './platform.js';
import { catalogNames } from './client.js';

const exec = promisify(execFile);
// 设计「假设清单」#2：包大小上限 100MB，与服务端 413 too_large 阈值一致。
export const SIZE_LIMIT = 100 * 1024 * 1024;

// 规范名映射（设计「命名规范化」）：frontmatter 有合法 name 以其为准；否则由目录名推导
// （小写化并去掉 [a-z0-9-] 以外的字符）。推导名必须以小写字母开头：纯数字开头或清理后为空都拒绝，
// 避免把偶然的目录名发布成规范名。
export function canonicalName(dirName, frontmatterName) {
  if (frontmatterName !== null && frontmatterName !== undefined && isSkillName(frontmatterName)) return frontmatterName;
  const derived = dirName.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!/^[a-z][a-z0-9-]*$/.test(derived)) throw new CliError(t('invalidName', { directory: dirName }), 1, 'invalid_skill_name');
  return derived;
}

async function readSkillMetadata(directory) {
  try {
    const resolved = await realpath(directory);
    if (!(await lstat(resolved)).isDirectory()) return null;
    return parseSkill(await readFile(path.join(resolved, 'SKILL.md'), 'utf8'));
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw new CliError(t('skillRead', { path: directory }), 1, 'skill_read');
  }
}

const invalidPackage = (source) => new CliError(t('invalidPackage'), 1, 'invalid_package', { path: source });

// 把源目录的时间戳（含目录——Node 的 cp 不会保留目录时间）同步到打包副本：
// 归档字节只随内容变化，源未变时重传同 sha256，幂等（设计「假设清单」#1）才有前提。
async function preserveTimes(source, target) {
  const info = await lstat(source);
  await utimes(target, info.atime, info.mtime);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(source, { withFileTypes: true })) await preserveTimes(path.join(source, entry.name), path.join(target, entry.name));
}

// 打包并对称自检：临时目录组装 <规范名>/（内容原样）→ 系统 tar 出未压缩归档 → zlib 压缩（字节稳定）
// → 流式 SHA-256 → 安装侧同一验证器扫自己打的包 → inspectSkill 复核名字/版本。临时目录 finally 清理。
export async function packSkill(source, name, version, { signal } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'hy-publish-'));
  try {
    try { await checkTree(source); }
    catch (error) {
      if (error instanceof CliError && error.error === 'invalid_archive') throw invalidPackage(source);
      throw error;
    }
    const staging = path.join(temporary, 'stage');
    await mkdir(staging);
    // verbatimSymlinks 不跟随源目录里的链接；checkTree 已拒绝，这里是纵深防御。
    await cp(source, path.join(staging, name), { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    await preserveTimes(source, path.join(staging, name));
    const plain = path.join(temporary, 'release.tar'), archive = path.join(temporary, 'release.tar.gz');
    const invocation = tarInvocation(archive, staging);
    try {
      // 归档名不带盘符（tarInvocation 约定）、cwd 用归档所在目录；COPYFILE_DISABLE 避免 macOS 附带资源文件。
      await exec(invocation.command, ['-cf', path.basename(plain), '-C', staging, name],
        { cwd: invocation.cwd, timeout: 60_000, maxBuffer: 1024 * 1024, signal, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(t('packFailed'), 1, 'pack');
    }
    // 压缩交给 Node zlib：bsdtar/GNU tar 的 gzip 头会写入当前时间，同内容也会得到不同 sha256。
    const hash = createHash('sha256');
    const hashing = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
    try {
      await pipeline(createReadStream(plain), createGzip(), hashing, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
    } catch (error) {
      throw new CliError(signal?.aborted ? t('canceled') : t('packFailed'), 1, signal?.aborted ? 'cancelled' : 'pack');
    }
    try { await validateArchive(archive, name); }
    catch (error) {
      if (error instanceof CliError && error.error === 'invalid_archive') throw invalidPackage(source);
      throw error;
    }
    // 对称复核：包内 SKILL.md 与发布声明一致；frontmatter 无 name 的目录推导版退回直接解析。
    const root = path.join(staging, name);
    const packaged = (await inspectSkill(root, [name])) ?? parseSkill(await readFile(path.join(root, 'SKILL.md'), 'utf8'));
    if ((packaged.name !== null && packaged.name !== name) || packaged.version !== version) throw new CliError(t('packageMismatch'), 1, 'skill_mismatch');
    const body = await readFile(archive);
    return { body, sha256: hash.digest('hex'), size: body.length };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// 发布单个 Skill 目录：读 frontmatter → 规范名与版本校验 → 打包自检 → 上传 → 输出摘要。
export async function publishSkill(ctx, directory, { notes } = {}) {
  const source = resolveDirectory(directory);
  const metadata = await readSkillMetadata(source);
  if (!metadata) throw new CliError(t('publishNotSkill', { path: source }), 1, 'skill_read');
  if (!metadata.version) throw new CliError(t('missingNameOrVersion', { path: path.join(source, 'SKILL.md') }), 1, 'missing_skill_field');
  const name = canonicalName(path.basename(source), metadata.name);
  const version = metadata.version;
  // frontmatter 写了 name 却与规范名不一致（此时规范名来自目录推导）：包内容与声明必然对不上，
  // 安装侧也认不出来，就地拒绝并指明修法，而不是等到打包复核才报笼统的 packageMismatch。
  if (metadata.name !== null && metadata.name !== name) throw new CliError(t('nameMismatch', { path: path.join(source, 'SKILL.md'), name: metadata.name, canonical: name }), 1, 'name_mismatch');
  const { body, sha256, size } = await packSkill(source, name, version, { signal: ctx.signal });
  if (size > SIZE_LIMIT) throw new CliError(t('tooLarge', { size }), 1, 'too_large');
  let result;
  try {
    result = await ctx.client.publish(ctx.token, { name, version, sha256, body, notes });
  } catch (error) {
    if (error instanceof CliError) {
      // 409/403/413 语义（设计「接口设计·发布端」）：403 与未登录同走退出码 3 的登录引导。
      if (error.error === 'version_exists') throw new CliError(t('versionExists', { name, version }), 1, 'version_exists', { skill: name, version });
      if (error.error === 'not_a_publisher') throw new CliError(t('notPublisher'), 3, 'not_a_publisher', { next_command: command('login') });
      if (error.error === 'too_large') throw new CliError(t('tooLarge', { size }), 1, 'too_large');
    }
    throw error;
  }
  const fromFrontmatter = metadata.name !== null && isSkillName(metadata.name);
  ctx.output.write({ event: 'publish', skill: name, version, sha256, size, existing: Boolean(result.existing), url: result.url,
      directory: source, name_mapping: { directory: path.basename(source), frontmatter: metadata.name, canonical: name } },
    [t('published', { name: skillLabel(name), version }),
      t('publishSummary', { size, sha256 }),
      t('nameMapping', { source: path.basename(source), name, origin: t(fromFrontmatter ? 'nameFromFrontmatter' : 'nameFromDirectory') }),
      ...(result.existing ? [t('publishIdempotent')] : []),
      t('publishNext')]);
  return { name, version, sha256, size, existing: Boolean(result.existing) };
}

// 对账行与汇总：状态顺序 商店缺 → 待发布 → 本地落后 → 一致 → 商店多。
function reportLines(report, counts) {
  const by = (status) => report.filter((item) => item.status === status);
  return [
    ...by('missing').map((item) => t('auditMissing', { name: item.skill, version: item.local_version })),
    ...by('behind').map((item) => t('auditBehind', { name: item.skill, local: item.local_version, latest: item.store_latest })),
    ...by('local_behind').map((item) => t('auditLocalBehind', { name: item.skill, local: item.local_version, latest: item.store_latest })),
    ...by('current').map((item) => t('auditCurrent', { name: item.skill, version: item.local_version })),
    ...by('store_only').map((item) => t('auditStoreOnly', { name: item.skill })),
    t('auditSummary', counts),
  ];
}

// 仓库模式：扫描一级 skill 目录 → 规范名全集与冲突检测 → catalog+versions 对账 →
// --check 只报告；否则确认后批量发布“商店缺或待发布”，409 自动跳过。
export async function publishRepo(ctx, repoArgument, { all, check, notes } = {}) {
  const repo = resolveDirectory(repoArgument);
  let entries;
  try { entries = await readdir(repo, { withFileTypes: true }); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new CliError(t('skillRead', { path: repo }), 1, 'skill_read');
    throw error;
  }
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const directory = path.join(repo, entry.name);
    const metadata = await readSkillMetadata(directory);
    if (metadata) found.push({ directory, base: entry.name, metadata });
  }
  if (!found.length) throw new CliError(t('repoEmpty', { path: repo }), 1, 'skill_read');
  const byName = new Map();
  for (const item of found) {
    if (!item.metadata.version) throw new CliError(t('missingNameOrVersion', { path: path.join(item.directory, 'SKILL.md') }), 1, 'missing_skill_field');
    item.name = canonicalName(item.base, item.metadata.name);
    byName.set(item.name, [...(byName.get(item.name) || []), item.base]);
  }
  const conflicts = [...byName].filter(([, directories]) => directories.length > 1);
  if (conflicts.length) {
    const [name, directories] = conflicts[0];
    throw new CliError(t('nameConflict', { name, paths: directories.join('、') }), 1, 'name_conflict', { name, paths: directories });
  }
  const catalog = await ctx.client.catalog();
  const versions = await ctx.client.versions(catalog);
  const status = (item) => {
    const latest = versions[item.name]?.latest;
    if (!latest) return 'missing';
    const comparison = compare(item.metadata.version, latest);
    return comparison > 0 ? 'behind' : comparison === 0 ? 'current' : 'local_behind';
  };
  const report = found.map((item) => ({ skill: item.name, directory: item.base, local_version: item.metadata.version, store_latest: versions[item.name]?.latest ?? null, status: status(item) }));
  for (const name of [...new Set([...catalogNames(catalog), ...Object.keys(versions)])]) {
    if (!report.some((item) => item.skill === name)) report.push({ skill: name, directory: null, local_version: null, store_latest: versions[name]?.latest ?? null, status: 'store_only' });
  }
  const counts = { total: report.length, publishable: report.filter((item) => ['missing', 'behind'].includes(item.status)).length,
    current: report.filter((item) => item.status === 'current').length,
    local_behind: report.filter((item) => item.status === 'local_behind').length,
    store_only: report.filter((item) => item.status === 'store_only').length };
  if (check) {
    ctx.output.write({ repo, mode: 'check', skills: report, counts }, reportLines(report, counts));
    return 0;
  }
  ctx.output.write({ repo, mode: all ? 'all' : 'repo', skills: report, counts }, reportLines(report, counts));
  if (!counts.publishable) {
    ctx.output.write({ published: [], skipped: [] }, [t('nothingToPublish')]);
    return 0;
  }
  if (!await ctx.confirm(t('publishConfirm', { count: counts.publishable }), ctx.options.yes, ctx.interactive, ctx.signal)) throw new CliError(t('canceled'), 1, 'cancelled');
  const targets = found.filter((item) => ['missing', 'behind'].includes(report.find((entry) => entry.skill === item.name).status));
  const published = [], skipped = [];
  for (const item of targets) {
    try {
      const result = await publishSkill(ctx, item.directory, { notes });
      published.push({ skill: result.name, version: result.version, sha256: result.sha256, size: result.size });
    } catch (error) {
      // 批量模式：同版本不同内容（409）记录后跳过；其余错误中断整批以保留准确语义。
      if (error instanceof CliError && error.error === 'version_exists') {
        skipped.push({ skill: item.name, version: item.metadata.version, reason: 'version_exists' });
        continue;
      }
      throw error;
    }
  }
  ctx.output.write({ published, skipped }, [t('publishBatchSummary', { published: published.length, skipped: skipped.length }),
    ...skipped.map((item) => t('skippedVersionExists', { name: item.skill, version: item.version }))]);
  return 0;
}
