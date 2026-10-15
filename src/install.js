import { t } from './i18n.js';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from './io.js';
import { inspectSkill, isDevelopmentDirectory, isLinkedInstallation, logicalDirectory } from './skills.js';
import { validateArchive, checkTree } from './archive.js';
import { tarInvocation, directoryKey } from './platform.js';
import { SIZE_LIMIT } from './publish.js';

const exec = promisify(execFile);

// 下载校验管道（设计「publish 管道」的对称面）：下载到临时目录 → 流式 SHA-256 →
// tar 流式预检（validateArchive 拒绝路径穿越/链接条目/保留名）→ 系统 tar 解压 →
// checkTree + inspectSkill 复核身份。付费分支结构保留，一期由 CLI 前置拦截不进入。
// sizeLimitBytes/runner 仅供测试注入（下载字节上限与解压失败），CLI 走默认值。
export async function prepare(client, name, release, token, paid, product, signal, { sizeLimitBytes = SIZE_LIMIT, runner = exec } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'hy-download-'));
  let dispose, response;
  try {
    if (paid && !token) throw new CliError(t('loginRequired'), 3, 'unauthorized');
    const route = `/api/store/download/${encodeURIComponent(name)}?version=${encodeURIComponent(release.latest)}&format=tar.gz`;
    const download = await client.request(route, { token: paid ? token : undefined, download: true, skill: name, product });
    dispose = download.dispose;
    response = download.response;
    // 摘要来源按信道可信度区分：免费版 302 跟随到公开附件，最终响应头可被重定向目标伪造，
    // 以 versions 为唯一权威、缺失即 fail-closed；付费走带令牌的直连 200，响应头可信。
    const expected = paid ? response.headers.get('X-Content-SHA256') : release.sha256;
    if (!/^[a-fA-F0-9]{64}$/.test(expected || '')) throw new CliError(t('missingChecksum'), 1, 'missing_checksum');
    const headerVersion = response.headers.get('X-Skill-Version');
    if ((paid || headerVersion) && headerVersion !== release.latest) throw new CliError(t('versionMismatch'), 1, 'version_mismatch');
    const archive = path.join(temporary, 'release.tar.gz');
    const hash = createHash('sha256');
    let downloaded = 0;
    const hashing = new Transform({ transform(chunk, encoding, callback) {
      // 下载字节上限与发布侧 100MB 对称：超限立即中止管道，不把包写完。
      downloaded += chunk.length;
      if (downloaded > sizeLimitBytes) { callback(new CliError(t('tooLarge', { size: downloaded }), 1, 'too_large')); return; }
      hash.update(chunk); callback(null, chunk);
    } });
    try {
      await pipeline(Readable.fromWeb(download.response.body), hashing, createWriteStream(archive, { flags: 'wx', mode: 0o600 }), { signal });
    } catch (error) {
      // 注入的上限错误原样透出（临时目录照常清理），其余按取消/下载失败归类。
      if (error instanceof CliError) throw error;
      throw new CliError(signal?.aborted ? t('canceled') : t('downloadFailed'), 1, signal?.aborted ? 'cancelled' : 'download');
    }
    if (hash.digest('hex') !== expected.toLowerCase()) throw new CliError(t('checksumMismatch'), 1, 'checksum_mismatch');
    await validateArchive(archive, name);
    const extracted = path.join(temporary, 'extracted');
    await mkdir(extracted);
    const tar = tarInvocation(archive, extracted);
    try { await runner(tar.command, tar.args, { cwd: tar.cwd, timeout: 60_000, maxBuffer: 1024 * 1024, signal }); }
    catch { throw new CliError(t('extractFailed'), 1, 'extract'); }
    const entries = await readdir(extracted);
    if (entries.length !== 1 || entries[0] !== name) throw new CliError(t('invalidArchive'), 1, 'invalid_archive');
    const source = path.join(extracted, name);
    await checkTree(source);
    const skill = await inspectSkill(source, [name]);
    if (!skill || skill.name !== name || skill.version !== release.latest) throw new CliError(t('installPackageMismatch'), 1, 'skill_mismatch');
    return { name, version: release.latest, source, cleanup: () => rm(temporary, { recursive: true, force: true }) };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
    dispose?.();
  }
}

async function exists(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// 在目标文件系统上暂存新目录和备份，跨多个目标一起提交或回滚（设计「错误处理」：
// 暂存前 + 每次 rename 前双重保护、失败逆序回滚、回滚失败保留备份并报 recovery_paths）。
// action.link 表示在 path 放一个指向主安装的目录链接（Windows 用 junction），而不是复制一份
// （任务 7 多宿主共享使用，结构保留）。renameFile、linkDirectory 可供测试注入真实的中途失败。
const systemLink = (target, directory) => symlink(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
export async function replaceAll(actions, { renameFile = rename, linkDirectory = systemLink, signal, names = [] } = {}) {
  // 在暂存前检查整批目标；在每次 rename 前再检查，防止下载期间变成开发目录。
  const protect = async (action) => {
    const directory = action.path;
    if (action.protectSymlinks && await isLinkedInstallation(directory)) throw new CliError(t('skippedSymbolicLink', { name: action.previousName, path: directory }), 1, 'symbolic_link', { path: directory });
    if (await isDevelopmentDirectory(directory)) throw new CliError(t('developmentProtected', { path: directory }), 1, 'development_directory', { path: directory });
  };
  for (const action of actions) await protect(action);
  const paths = await Promise.all(actions.map(async (action) => directoryKey(await logicalDirectory(action.path))));
  for (let i = 0; i < paths.length; i++) {
    for (let j = 0; j < paths.length; j++) {
      if (i === j) continue;
      const relative = path.relative(paths[i], paths[j]);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new CliError(t('overlappingTargets'), 2, 'overlapping_targets');
    }
  }
  const transactions = [];
  const staging = [];
  let committed = false;
  const warnings = [];
  try {
    for (const action of actions) {
      if (signal?.aborted) throw new CliError(t('canceled'), 1, 'cancelled');
      await mkdir(path.dirname(action.path), { recursive: true });
      const stage = await mkdtemp(path.join(path.dirname(action.path), '.hy-stage-'));
      staging.push(stage);
      const transaction = { ...action, stage, backup: path.join(stage, 'old'), incoming: path.join(stage, 'new'), movedOld: false, movedNew: false };
      transactions.push(transaction);
      if (action.source) await cp(action.source, transaction.incoming, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
    }
    for (const transaction of transactions) {
      if (signal?.aborted) throw new CliError(t('canceled'), 1, 'cancelled');
      await protect(transaction);
      const info = await exists(transaction.path);
      const current = info ? await inspectSkill(transaction.path, names) : null;
      if (current?.development) throw new CliError(t('developmentProtected', { path: transaction.path }), 1, 'development_directory', { path: transaction.path });
      if (info && (!current || current.name !== transaction.previousName)) throw new CliError(t('occupied', { path: transaction.path }), 1, 'occupied');
      if (!info && transaction.previousName) throw new CliError(t('changed', { path: transaction.path }), 1, 'changed');
      if (info) {
        await renameFile(transaction.path, transaction.backup);
        transaction.movedOld = true;
      }
      if (transaction.source) {
        transaction.incomingInfo = await lstat(transaction.incoming);
        await renameFile(transaction.incoming, transaction.path);
        transaction.movedNew = true;
      } else if (transaction.link) {
        await linkDirectory(path.resolve(transaction.link), transaction.path);
        transaction.incomingInfo = await lstat(transaction.path);
        transaction.movedNew = true;
      }
    }
    committed = true;
  } catch (error) {
    const recovery = [];
    for (const transaction of [...transactions].reverse()) {
      try {
        if (transaction.movedNew) {
          const current = await exists(transaction.path);
          if (current && (current.dev !== transaction.incomingInfo.dev || current.ino !== transaction.incomingInfo.ino)) throw new Error('destination changed');
          await rm(transaction.path, { recursive: true, force: true });
        }
        if (transaction.movedOld && await exists(transaction.path)) throw new Error('destination occupied');
        if (transaction.movedOld) await renameFile(transaction.backup, transaction.path);
      } catch { recovery.push(transaction.movedOld ? transaction.backup : transaction.path); }
    }
    if (recovery.length) {
      throw new CliError(t('rollbackFailed'), 1, 'rollback_failed', { recovery_paths: recovery });
    }
    if (error instanceof CliError) throw error;
    throw new CliError(t('replaceFailed'), 1, 'replace');
  } finally {
    for (const stage of staging) {
      // 回滚失败的备份绝不能在清理时删除。
      if (!committed && await exists(path.join(stage, 'old'))) continue;
      try { await rm(stage, { recursive: true, force: true }); }
      catch { warnings.push(t('cleanupWarning', { path: stage })); }
    }
  }
  return warnings;
}
