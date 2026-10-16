import { t, command, skillLabel } from './i18n.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, utimes } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGzip } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from './io.js';
import { inspectSkill, parseSkill, isSkillName, isReservedSkillName, compare } from './skills.js';
import { validateArchive } from './archive.js';
import { tarInvocation, resolveDirectory } from './platform.js';
import { catalogNames } from './client.js';

const exec = promisify(execFile);
// 设计「假设清单」#2：压缩后包大小上限 100MB（与服务端 413 阈值一致）；
// 原始字节粗上限 400MB 用于打包前预拒，避免对明显无望的内容白做压缩。
export const SIZE_LIMIT = 100 * 1024 * 1024;
export const RAW_SIZE_LIMIT = 400 * 1024 * 1024;
// frontmatter 最小解析的读取上限：1MB 的 SKILL.md 必然是误放的内容。
const SKILL_LIMIT = 1024 * 1024;
// 打包时排除的开发与系统垃圾（发现即警告，不阻断）。
const JUNK = new Set(['.git', '.DS_Store', 'Thumbs.db']);

// 规范名映射（设计「命名规范化」）：frontmatter 有合法 name 以其为准；否则由目录名推导
// （小写化并去掉 [a-z0-9-] 以外的字符）。推导名必须以小写字母开头：纯数字开头或清理后为空都拒绝，
// 避免把偶然的目录名发布成规范名。保留设备名检查已下沉 skills.isSkillName（全链一致），
// 这里对显式声明单独报 reserved_name，不静默回落到目录推导。
export function canonicalName(dirName, frontmatterName) {
  if (frontmatterName !== null && frontmatterName !== undefined) {
    if (isReservedSkillName(frontmatterName)) throw new CliError(t('reservedName', { name: frontmatterName }), 1, 'reserved_name');
    if (isSkillName(frontmatterName)) return frontmatterName;
  }
  const derived = dirName.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!/^[a-z][a-z0-9-]*$/.test(derived)) throw new CliError(t('invalidName', { directory: dirName }), 1, 'invalid_skill_name');
  if (isReservedSkillName(derived)) throw new CliError(t('reservedName', { name: derived }), 1, 'reserved_name');
  return derived;
}

// 解析到实体目录（跟随指向 Skill 的符号链接/junction）并读取 frontmatter；返回 null 表示不是 Skill 目录。
async function readSkillSource(directory) {
  try {
    const resolved = await realpath(directory);
    if (!(await lstat(resolved)).isDirectory()) return null;
    const file = path.join(resolved, 'SKILL.md');
    let info = null;
    try { info = await lstat(file); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    // SKILL.md 是目录（Windows 上读目录的报错码不可靠）按“不是 Skill 目录”处理。
    if (!info.isFile()) return null;
    if (info.size > SKILL_LIMIT) throw new CliError(t('skillTooLarge', { path: file }), 1, 'skill_too_large');
    return { resolved, metadata: parseSkill(await readFile(file, 'utf8')) };
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    throw new CliError(t('skillRead', { path: directory }), 1, 'skill_read');
  }
}

const invalidPackage = (source) => new CliError(t('invalidPackage'), 1, 'invalid_package', { path: source });

// 扫源树：验证只有普通文件与目录（符号链接/junction 就地拒绝）、累计原始字节数、找出要排除的垃圾。
async function measureTree(directory, relative = '') {
  let bytes = 0;
  const junk = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name), here = relative ? `${relative}/${entry.name}` : entry.name;
    if (JUNK.has(entry.name)) { junk.push(here); continue; }
    if (entry.isDirectory()) {
      const nested = await measureTree(target, here);
      bytes += nested.bytes;
      junk.push(...nested.junk);
    } else if (entry.isFile()) bytes += (await stat(target)).size;
    else throw invalidPackage(target);
  }
  return { bytes, junk };
}

// 复制实体目录内容（checkTree 语义随行：复制窗口内新出现的链接同样拒绝），跳过垃圾文件。
async function copyTree(from, to) {
  await mkdir(to);
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (JUNK.has(entry.name)) continue;
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, target);
    else if (entry.isFile()) await copyFile(source, target);
    else throw invalidPackage(source);
  }
}

// 把源目录的时间戳（含目录——Node 的 cp 不会保留目录时间）同步到打包副本：
// 归档字节只随内容变化，源未变时重传同 sha256，幂等（设计「假设清单」#1）才有前提。
async function preserveTimes(source, target) {
  const info = await lstat(source);
  await utimes(target, info.atime, info.mtime);
  if (!info.isDirectory()) return;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (JUNK.has(entry.name)) continue;
    await preserveTimes(path.join(source, entry.name), path.join(target, entry.name));
  }
}

// 打包并对称自检：临时目录组装 <规范名>/（内容原样、排除垃圾）→ 系统 tar 出未压缩归档
// → zlib 压缩（字节稳定，输出超限即中止）→ 流式 SHA-256 → 安装侧同一验证器扫自己打的包
// （本机平台 + win32 双跑：POSIX 上发的包也必须 Windows 可装）→ inspectSkill 复核名字/版本。
// runner 与两个字节上限仅供测试注入；临时目录经 cleanup 清理（幂等，失败降级为警告）。
export async function packSkill(source, name, version, { signal, runner = exec, rawLimitBytes = RAW_SIZE_LIMIT, sizeLimitBytes = SIZE_LIMIT } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'hy-publish-'));
  let disposed = false;
  const cleanup = async () => {
    if (disposed) return null;
    disposed = true;
    try { await rm(temporary, { recursive: true, force: true }); return null; }
    catch { return t('cleanupWarning', { path: temporary }); }
  };
  try {
    // 跟随指向 Skill 的符号链接/junction：打包的是实体目录，包内不会出现链接条目。
    const resolved = await realpath(source);
    const { bytes, junk } = await measureTree(resolved);
    if (bytes > rawLimitBytes) throw new CliError(t('packTooLarge', { size: bytes }), 1, 'too_large');
    const staging = path.join(temporary, 'stage');
    await mkdir(staging);
    const root = path.join(staging, name);
    await copyTree(resolved, root);
    await preserveTimes(resolved, root);
    const plain = path.join(temporary, 'release.tar'), archive = path.join(temporary, 'release.tar.gz');
    const invocation = tarInvocation(archive, staging);
    try {
      // 归档名不带盘符（tarInvocation 约定）、cwd 用归档所在目录；COPYFILE_DISABLE 避免 macOS 附带资源文件。
      await runner(invocation.command, ['-cf', path.basename(plain), '-C', staging, name],
        { cwd: invocation.cwd, timeout: 60_000, maxBuffer: 1024 * 1024, signal, env: { ...process.env, COPYFILE_DISABLE: '1' } });
    } catch (error) {
      if (error?.code === 'ENOENT') throw new CliError(t('tarMissing'), 1, 'tar_missing');
      throw new CliError(t('packFailed'), 1, 'pack');
    }
    // 压缩交给 Node zlib：bsdtar/GNU tar 的 gzip 头会写入当前时间，同内容也会得到不同 sha256；
    // 压缩输出超过上限时立即中止，不再把大包写完。
    const hash = createHash('sha256');
    let compressed = 0;
    const hashing = new Transform({ transform(chunk, encoding, callback) {
      compressed += chunk.length;
      if (compressed > sizeLimitBytes) { callback(new CliError(t('tooLarge', { size: compressed }), 1, 'too_large')); return; }
      hash.update(chunk);
      callback(null, chunk);
    } });
    try {
      await pipeline(createReadStream(plain), createGzip(), hashing, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(signal?.aborted ? t('canceled') : t('packFailed'), 1, signal?.aborted ? 'cancelled' : 'pack');
    }
    for (const platform of process.platform === 'win32' ? [process.platform] : [process.platform, 'win32']) {
      try { await validateArchive(archive, name, platform); }
      catch (error) {
        if (error instanceof CliError && error.error === 'invalid_archive') throw invalidPackage(source);
        throw error;
      }
    }
    // 对称复核：包内 SKILL.md 与发布声明一致；frontmatter 无 name 的目录推导版退回直接解析。
    const packaged = (await inspectSkill(root, [name])) ?? parseSkill(await readFile(path.join(root, 'SKILL.md'), 'utf8'));
    if ((packaged.name !== null && packaged.name !== name) || packaged.version !== version) throw new CliError(t('packageMismatch'), 1, 'skill_mismatch');
    return { archive, sha256: hash.digest('hex'), size: (await stat(archive)).size,
      warnings: junk.map((item) => t('junkExcluded', { path: item })), cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

// 发布单个 Skill 目录：读 frontmatter → 规范名与版本校验 → 打包自检 → 流式上传 → 输出摘要。
export async function publishSkill(ctx, directory, { notes } = {}) {
  const target = resolveDirectory(directory);
  const source = await readSkillSource(target);
  if (!source) throw new CliError(t('publishNotSkill', { path: target }), 1, 'skill_read');
  const { resolved, metadata } = source;
  if (!metadata.version) throw new CliError(t('missingNameOrVersion', { path: path.join(resolved, 'SKILL.md') }), 1, 'missing_skill_field');
  const name = canonicalName(path.basename(resolved), metadata.name);
  const version = metadata.version;
  // frontmatter 写了 name 却与规范名不一致（此时规范名来自目录推导）：包内容与声明必然对不上，
  // 安装侧也认不出来，就地拒绝并指明修法，而不是等到打包复核才报笼统的 packageMismatch。
  if (metadata.name !== null && metadata.name !== name) throw new CliError(t('nameMismatch', { path: path.join(resolved, 'SKILL.md'), name: metadata.name, canonical: name }), 1, 'name_mismatch');
  const packed = await packSkill(resolved, name, version, { signal: ctx.signal });
  try {
    let result;
    try {
      // 上传走流式（不把整个包读进内存）；请求结束后立即关闭文件句柄，让临时目录可清理。
      const stream = createReadStream(packed.archive);
      try { result = await ctx.client.publish(ctx.token, { name, version, sha256: packed.sha256, size: packed.size, body: Readable.toWeb(stream), notes }); }
      finally { stream.destroy(); }
    } catch (error) {
      if (error instanceof CliError) {
        // 409/403/413 语义（设计「接口设计·发布端」）：403 与未登录同走退出码 3 的登录引导。
        if (error.error === 'version_exists') throw new CliError(t('versionExists', { name, version }), 1, 'version_exists', { skill: name, version });
        if (error.error === 'not_a_publisher') throw new CliError(t('notPublisher'), 3, 'not_a_publisher', { next_command: command('login') });
        if (error.error === 'too_large') throw new CliError(t('tooLarge', { size: packed.size }), 1, 'too_large');
      }
      throw error;
    }
    const warnings = [...packed.warnings, await packed.cleanup()].filter(Boolean);
    const fromFrontmatter = metadata.name !== null && isSkillName(metadata.name);
    ctx.output.write({ event: 'publish', skill: name, version, sha256: packed.sha256, size: packed.size, existing: Boolean(result.existing), url: result.url,
        directory: resolved, name_mapping: { directory: path.basename(resolved), frontmatter: metadata.name, canonical: name }, warnings },
      [t('published', { name: skillLabel(name), version }),
        t('publishSummary', { size: packed.size, sha256: packed.sha256 }),
        t('nameMapping', { source: path.basename(resolved), name, origin: t(fromFrontmatter ? 'nameFromFrontmatter' : 'nameFromDirectory') }),
        ...(result.existing ? [t('publishIdempotent')] : []),
        t('publishNext'), ...warnings]);
    return { name, version, sha256: packed.sha256, size: packed.size, existing: Boolean(result.existing) };
  } finally {
    // 失败路径兜底清理；成功路径 cleanup 已执行（幂等空转）。清理失败不掩盖原始错误。
    await packed.cleanup();
  }
}

// 对账行与汇总：状态顺序 无效 → 商店缺 → 待发布 → 本地落后 → 一致 → 商店多 → 已下架提示。
function reportLines(report, counts) {
  const by = (status) => report.filter((item) => item.status === status);
  return [
    ...by('invalid').map((item) => t('publishInvalid', { directory: item.directory, reason: item.message })),
    ...by('missing').map((item) => t('auditMissing', { name: item.skill, version: item.local_version })),
    ...by('behind').map((item) => t('auditBehind', { name: item.skill, local: item.local_version, latest: item.store_latest })),
    ...by('local_behind').map((item) => t('auditLocalBehind', { name: item.skill, local: item.local_version, latest: item.store_latest })),
    ...by('current').map((item) => t('auditCurrent', { name: item.skill, version: item.local_version })),
    ...by('store_only').map((item) => t('auditStoreOnly', { name: item.skill })),
    ...report.flatMap((item) => (item.yanked ?? []).map((version) => t('auditYanked', { name: item.skill, version }))),
    t('auditSummary', counts),
  ];
}

// 仓库模式收集为 invalid 的元数据错误（试点上架实测：--check 一病即断让用户逐个试错）：
// 单个目录的缺版本/不可推导名/frontmatter 名不一致进报告标 invalid，不再中断全量视图；
// 跨目录的规范名冲突是仓库结构问题，仍整体拒绝。
const INVALID_SKILL_ERRORS = new Set(['missing_skill_field', 'invalid_skill_name', 'reserved_name', 'name_mismatch']);

// 仓库扫描 + 规范名冲突检测 + 对账（publish --repo 与 audit 共享，二期任务 2 抽取）：
// 扫描一级 skill 目录（含指向 Skill 的链接）→ 规范名全集与冲突检测（一次列全，本地错误先于网络请求）
// → catalog+versions 比对出五态分类 + yanked 提示（假设 #4：下架版本 history 保留）。
export async function reconcileRepo(client, repoArgument) {
  const repo = resolveDirectory(repoArgument);
  let entries;
  try { entries = await readdir(repo, { withFileTypes: true }); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) throw new CliError(t('skillRead', { path: repo }), 1, 'skill_read');
    throw error;
  }
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const source = await readSkillSource(path.join(repo, entry.name));
    if (source) found.push({ directory: source.resolved, base: path.basename(source.resolved), metadata: source.metadata });
  }
  if (!found.length) throw new CliError(t('repoEmpty', { path: repo }), 1, 'skill_read');
  const byName = new Map();
  for (const item of found) {
    try {
      if (!item.metadata.version) throw new CliError(t('missingNameOrVersion', { path: path.join(item.directory, 'SKILL.md') }), 1, 'missing_skill_field');
      item.name = canonicalName(item.base, item.metadata.name);
      // frontmatter 名非法回落目录推导时与包内容必然对不上（单目录路径在 publishSkill 就地拒绝）；
      // 仓库路径收集为 invalid，--all 才不会在批中途被它打断。
      if (item.metadata.name !== null && item.metadata.name !== item.name) throw new CliError(t('nameMismatch', { path: path.join(item.directory, 'SKILL.md'), name: item.metadata.name, canonical: item.name }), 1, 'name_mismatch');
      byName.set(item.name, [...(byName.get(item.name) || []), item.base]);
    } catch (error) {
      if (!(error instanceof CliError) || !INVALID_SKILL_ERRORS.has(error.error)) throw error;
      // canonicalName 可能已写入 item.name（name_mismatch 在其后抛出）：清掉，条目只走 invalid 报告。
      item.name = undefined;
      item.invalid = { reason: error.error, message: error.message };
    }
  }
  const conflicts = [...byName].filter(([, directories]) => directories.length > 1).map(([name, directories]) => ({ name, paths: directories }));
  if (conflicts.length) {
    throw new CliError(t('nameConflict', { conflicts: conflicts.map((conflict) => `${conflict.name}（${conflict.paths.join('、')}）`).join('；') }), 1, 'name_conflict', { conflicts });
  }
  const catalog = await client.catalog();
  const versions = await client.versions(catalog);
  const status = (item) => {
    const latest = versions[item.name]?.latest;
    if (!latest) return 'missing';
    const comparison = compare(item.metadata.version, latest);
    return comparison > 0 ? 'behind' : comparison === 0 ? 'current' : 'local_behind';
  };
  const yankedVersions = (name) => (versions[name]?.history ?? []).filter((entry) => entry.yanked).map((entry) => entry.version);
  const report = found.filter((item) => item.name).map((item) => ({ skill: item.name, directory: item.base, local_version: item.metadata.version, store_latest: versions[item.name]?.latest ?? null, status: status(item) }));
  // 无效目录（元数据收集失败）：带原因进报告——对账给全量就绪视图，不参与五态分类与发布目标。
  for (const item of found.filter((item) => item.invalid)) {
    report.push({ skill: null, directory: item.base, local_version: item.metadata.version || null, store_latest: null, status: 'invalid', reason: item.invalid.reason, message: item.invalid.message });
  }
  for (const name of [...new Set([...catalogNames(catalog), ...Object.keys(versions)])]) {
    if (!report.some((item) => item.skill === name)) report.push({ skill: name, directory: null, local_version: null, store_latest: versions[name]?.latest ?? null, status: 'store_only' });
  }
  // yanked 提示统一挂到每个条目（本地与商店多都可能有下架版本）。
  for (const item of report) {
    const yanked = yankedVersions(item.skill);
    if (yanked.length) item.yanked = yanked;
  }
  const counts = { total: report.length, publishable: report.filter((item) => ['missing', 'behind'].includes(item.status)).length,
    current: report.filter((item) => item.status === 'current').length,
    local_behind: report.filter((item) => item.status === 'local_behind').length,
    store_only: report.filter((item) => item.status === 'store_only').length,
    invalid: report.filter((item) => item.status === 'invalid').length };
  return { repo, found, report, counts, lines: reportLines(report, counts) };
}

// 仓库模式：对账（reconcileRepo 共享件）→ --check 只报告；否则确认后批量发布“商店缺或待发布”，
// 409 与元数据无效的目录都按“跳过并解释”处理（试点上架实测：全量视图优先于一病即断）。
export async function publishRepo(ctx, repoArgument, { all, check, notes } = {}) {
  const { repo, found, report, counts, lines } = await reconcileRepo(ctx.client, repoArgument);
  if (check) {
    ctx.output.write({ repo, mode: 'check', skills: report, counts }, lines);
    return 0;
  }
  // 无效目录与 409 同语义：不发布，进 skipped 与解释行（原因消息在报告里，这里只留原因码）。
  const invalid = found.filter((item) => item.invalid);
  const skipped = invalid.map((item) => ({ directory: item.base, reason: item.invalid.reason }));
  const invalidLines = invalid.map((item) => t('publishInvalid', { directory: item.base, reason: item.invalid.message }));
  // 非交互且未显式 --yes 时批量发布会自动确认：输出提示行保持可见性。
  const auto = counts.publishable > 0 && !ctx.options.yes && !ctx.interactive;
  ctx.output.write({ repo, mode: all ? 'all' : 'repo', skills: report, counts, ...(auto ? { auto_confirmed: true } : {}) },
    [...lines, ...(auto ? [t('autoConfirmed')] : [])]);
  if (!counts.publishable) {
    ctx.output.write({ published: [], skipped }, [t('nothingToPublish'), ...invalidLines]);
    return 0;
  }
  if (!await ctx.confirm(t('publishConfirm', { count: counts.publishable }), ctx.options.yes, ctx.interactive, ctx.signal)) throw new CliError(t('canceled'), 1, 'cancelled');
  const targets = found.filter((item) => item.name && ['missing', 'behind'].includes(report.find((entry) => entry.skill === item.name).status));
  const published = [];
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
    ...skipped.flatMap((item) => item.reason === 'version_exists' ? [t('skippedVersionExists', { name: item.skill, version: item.version })] : []),
    ...invalidLines]);
  return 0;
}
