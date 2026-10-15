import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fixture, writeSkill } from './fixture.js';
import { replaceAll } from '../src/install.js';
import { targetRoot } from '../src/hosts.js';
import { command } from '../src/i18n.js';

const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};
const failure = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};
const exists = async (file) => { try { return await lstat(file); } catch { return null; } };
const stageLeftovers = async (root) => (await readdir(root, { recursive: false })).filter((name) => name.startsWith('.hy-stage-'));

test('install 免费 skill --to zcode：302 跟随下载落位、版本正确、全程不带令牌', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const target = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  assert.match(await readFile(path.join(target, 'SKILL.md'), 'utf8'), /version: "0\.1\.0"/);
  assert.ok((await readdir(target)).includes('assets'));
  assert.match(result.stdout, /已安装 ppt-design 0\.1\.0：/);
  assert.ok(result.stdout.includes(target));
  // 非交互模式沿用任务 4 语义：自动确认并给出 auto_confirmed 提示行。
  assert.match(result.stdout, /非交互模式：已自动确认安装。/);
  // status 能看到新安装。
  const status = await f.run(['status']);
  assert.match(status.stdout, /ppt-design：0\.1\.0（最新版）\n位置：/);
  // 免费下载：/api/store/download 收 302，跟随到 /releases 公开附件，两跳都不带 Authorization。
  const download = f.state.requests.find((r) => r.path === '/api/store/download/ppt-design');
  const release = f.state.requests.find((r) => r.path === '/releases/ppt-design-0.1.0.tar.gz');
  assert.ok(download, '应请求下载端点');
  assert.equal(download.query.get('version'), '0.1.0');
  assert.equal(download.query.get('format'), 'tar.gz');
  assert.ok(release, '应跟随 302 到公开附件');
  assert.equal(download.token, undefined);
  assert.equal(release.token, undefined);
  // JSON 形状：installations/removed/skipped/warnings。
  const value = data(await f.run(['install', 'oracle-bone', '--to', 'claude', '--json']));
  assert.equal(value.ok, true);
  assert.deepEqual(value.installations, [{ name: 'oracle-bone', path: path.join(f.home, '.claude', 'skills', 'oracle-bone'), previous: null, version: '0.1.0' }]);
  assert.deepEqual(value.removed, []);
  assert.deepEqual(value.skipped, []);
  assert.deepEqual(value.warnings, []);
});

test('replaceAll 注入 rename 失败：第一步成功第二步失败 → 逆序回滚，内容与权限完整恢复', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hy-replace-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const writeOld = async (name, marker) => {
    const directory = await writeSkill(base, name, '1.0.0');
    await writeFile(path.join(directory, 'marker.txt'), marker);
    return directory;
  };
  const first = await writeOld('a-skill', 'old-a'), second = await writeOld('b-skill', 'old-b');
  if (process.platform !== 'win32') await chmod(first, 0o700);
  const incoming = await mkdtemp(path.join(tmpdir(), 'hy-incoming-'));
  t.after(() => rm(incoming, { recursive: true, force: true }));
  const sourceA = await writeSkill(incoming, 'a-skill', '2.0.0'), sourceB = await writeSkill(incoming, 'b-skill', '2.0.0');
  const actions = [
    { name: 'a-skill', path: first, source: sourceA, previousName: 'a-skill', previousVersion: '1.0.0' },
    { name: 'b-skill', path: second, source: sourceB, previousName: 'b-skill', previousVersion: '1.0.0' },
  ];
  let calls = 0;
  const renameFile = async (from, to) => { if (++calls === 2) throw new Error('injected'); return (await import('node:fs/promises')).rename(from, to); };
  const error = await replaceAll(actions, { renameFile, names: ['a-skill', 'b-skill'] }).catch((error) => error);
  assert.equal(error.error, 'replace');
  // 两个原目录都完整恢复：内容与标记文件都在。
  assert.equal(await readFile(path.join(first, 'marker.txt'), 'utf8'), 'old-a');
  assert.equal(await readFile(path.join(second, 'marker.txt'), 'utf8'), 'old-b');
  assert.match(await readFile(path.join(first, 'SKILL.md'), 'utf8'), /1\.0\.0/);
  if (process.platform !== 'win32') assert.equal((await stat(first)).mode & 0o777, 0o700);
  // 暂存目录全部清理，无 .hy-stage- 残留。
  assert.deepEqual(await stageLeftovers(base), []);
});

test('回滚时目标被第三方改动（dev/ino 不符）→ rollback_failed + recovery_paths，备份绝不清理', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hy-replace-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const first = await writeSkill(base, 'a-skill', '1.0.0'), second = await writeSkill(base, 'b-skill', '1.0.0');
  const incoming = await mkdtemp(path.join(tmpdir(), 'hy-incoming-'));
  t.after(() => rm(incoming, { recursive: true, force: true }));
  const sourceA = await writeSkill(incoming, 'a-skill', '2.0.0'), sourceB = await writeSkill(incoming, 'b-skill', '2.0.0');
  const actions = [
    { name: 'a-skill', path: first, source: sourceA, previousName: 'a-skill', previousVersion: '1.0.0' },
    { name: 'b-skill', path: second, source: sourceB, previousName: 'b-skill', previousVersion: '1.0.0' },
  ];
  let calls = 0;
  const renameFile = async (from, to) => {
    if (++calls === 3) {
      // 第一个目标已完全提交后、第二个动作失败前：第三方把目标换成了别的目录（不同 inode）。
      await rm(first, { recursive: true, force: true });
      await mkdir(first);
      await writeFile(path.join(first, 'intruder.txt'), 'not ours');
      throw new Error('injected');
    }
    return (await import('node:fs/promises')).rename(from, to);
  };
  const error = await replaceAll(actions, { renameFile, names: ['a-skill', 'b-skill'] }).catch((error) => error);
  assert.equal(error.error, 'rollback_failed');
  assert.equal(error.details.recovery_paths.length, 1);
  const backup = error.details.recovery_paths[0];
  // 备份保留原目录内容，绝不清理。
  assert.ok(backup.startsWith(path.join(base, '.hy-stage-')), backup);
  assert.match(await readFile(path.join(backup, 'SKILL.md'), 'utf8'), /1\.0\.0/);
  // 被第三方改动的目录原样保留（不删不属于我们的内容）。
  assert.equal(await readFile(path.join(first, 'intruder.txt'), 'utf8'), 'not ours');
  // 未受影响的第二个动作的原目录也保持原样。
  assert.match(await readFile(path.join(second, 'SKILL.md'), 'utf8'), /1\.0\.0/);
});

test('badChecksum：versions 摘要与正文不符 → checksumMismatch，目标不可达', async (t) => {
  const f = await fixture(t);
  f.state.badChecksum = true;
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  assert.equal(result.code, 1);
  const value = failure(result);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'checksum_mismatch');
  const root = path.join(f.home, '.zcode', 'skills');
  assert.equal(await exists(root), null, '校验失败时连目标根目录都不该创建');
});

test('corruptBody：下载正文截断 → download 失败，目标不可达', async (t) => {
  const f = await fixture(t);
  f.state.corruptBody = true;
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  assert.equal(result.code, 1);
  assert.equal(failure(result).error, 'download');
  assert.equal(await exists(path.join(f.home, '.zcode')), null);
});

test('目标是开发目录（含 .git）→ developmentProtected 跳过，不覆盖不下载', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.zcode', 'skills');
  const target = await writeSkill(root, 'ppt-design', '0.0.1');
  await mkdir(path.join(target, '.git'));
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /开发目录，跳过：/);
  assert.match(await readFile(path.join(target, 'SKILL.md'), 'utf8'), /0\.0\.1/);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '开发目录跳过时不应发起下载');
});

test('下载期间目标变成开发目录 → rename 前双重保护拦截并回滚，原目录保留', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.zcode', 'skills');
  const target = await writeSkill(root, 'ppt-design', '0.0.1');
  // 服务端把发布物响应压住 500ms：测试在下载进行中把目标变成开发目录。
  f.state.releaseDelay = 500;
  const pending = f.run(['install', 'ppt-design', '--to', 'zcode']);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !f.state.requests.some((r) => r.path === '/releases/ppt-design-0.1.0.tar.gz')) await delay(20);
  await mkdir(path.join(target, '.git'));
  const result = await pending;
  assert.equal(result.code, 1);
  assert.match(result.stderr, /开发目录，跳过：/);
  // 原目录与旧版本完整保留，无暂存残留。
  assert.match(await readFile(path.join(target, 'SKILL.md'), 'utf8'), /0\.0\.1/);
  assert.deepEqual(await stageLeftovers(root), []);
});

test('付费 skill 一期前置拦截：exit 3 purchase_unavailable + 商品页 URL，未发下载请求', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json']);
  assert.equal(result.code, 3);
  const value = failure(result);
  assert.equal(value.error, 'purchase_unavailable');
  assert.equal(value.phase2, true);
  assert.equal(value.url, `${f.base}/store/ppt-design-pro/`);
  const human = await f.run(['install', 'ppt-design-pro', '--to', 'zcode']);
  assert.equal(human.code, 3);
  assert.match(human.stderr, /暂未开放购买/);
  assert.ok(human.stderr.includes(`${f.base}/store/ppt-design-pro/`));
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download') || r.path.startsWith('/releases/')), '一期不应进入付费下载');
});

test('occupied：目标目录被无关内容占用 → 保留原样', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.zcode', 'skills');
  const target = path.join(root, 'ppt-design');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'unrelated.txt'), 'keep me');
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  assert.equal(result.code, 1);
  assert.equal(failure(result).error, 'occupied');
  assert.equal(await readFile(path.join(target, 'unrelated.txt'), 'utf8'), 'keep me');
  assert.deepEqual(await readdir(target), ['unrelated.txt']);
  assert.deepEqual(await stageLeftovers(root), []);
});

test('missingTarget：不带 --to → exit 2 + 推荐命令与真实路径', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(result.code, 2);
  const value = failure(result);
  assert.equal(value.error, 'missing_target');
  const expected = command('install', 'ppt-design', '--to', 'zcode');
  assert.equal(value.recommended_command, expected);
  assert.equal(value.next_command, expected);
  assert.equal(value.recommended_path, targetRoot('zcode', f.env));
  const human = await f.run(['install', 'ppt-design']);
  assert.equal(human.code, 2);
  assert.ok(human.stderr.includes(expected), human.stderr);
});

test('幂等：同版本安装两次 → 第二次成功且结果一致', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  const first = await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  assert.equal(first.code, 0, first.stdout);
  const content = await readFile(path.join(target, 'SKILL.md'), 'utf8');
  const asset = path.join(target, 'assets', 'example.txt');
  const assetContent = await readFile(asset, 'utf8');
  const second = await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  const value = data(second);
  assert.equal(value.auto_confirmed, true);
  assert.deepEqual(value.installations, [{ name: 'ppt-design', path: target, previous: '0.1.0', version: '0.1.0' }]);
  assert.deepEqual(value.warnings, []);
  assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), content);
  assert.equal(await readFile(asset, 'utf8'), assetContent);
  assert.deepEqual(await stageLeftovers(path.dirname(target)), []);
});

test('重复 --to 属任务 7 的多目标语义：一期按用法错误拒绝，不静默忽略', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode', '--to', 'claude', '--json']);
  assert.equal(result.code, 2);
  assert.equal(failure(result).error, 'usage');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '不应发起下载');
});

test('交互模式拒绝确认 → installCanceled，退出码 0 且未动目标', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.zcode', 'skills');
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode'], {}, { interactive: true, answers: [false] });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, '已取消安装。\n');
  assert.equal(await exists(root), null);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')));
});
