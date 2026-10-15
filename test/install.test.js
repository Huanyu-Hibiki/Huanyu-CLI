import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fixture, writeSkill, linkDirectory, readDirectoryLink } from './fixture.js';
import { prepare, replaceAll } from '../src/install.js';
import { Client } from '../src/client.js';
import { targetRoot } from '../src/hosts.js';
import { command } from '../src/i18n.js';

const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};
const exists = async (file) => { try { return await lstat(file); } catch { return null; } };
const stageLeftovers = async (root) => (await readdir(root, { recursive: false }).catch((error) => error.code === 'ENOENT' ? [] : (() => { throw error; })())).filter((name) => name.startsWith('.hy-stage-'));
// prepare 的单元注入位（sizeLimitBytes/runner）：测试进程直连假商店，HY_API 临时指向 fixture。
const withClient = async (f, fn) => {
  const previous = process.env.HY_API;
  process.env.HY_API = f.base;
  try { return await fn(new Client()); } finally { process.env.HY_API = previous; }
};
const releaseOf = async (f, name = 'ppt-design') => {
  const response = await fetch(`${f.base}/api/store/versions`);
  return (await response.json()).skills[name];
};
const downloadLeftovers = async () => (await readdir(tmpdir())).filter((name) => name.startsWith('hy-download-')).sort();

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
  const value = data(result);
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
  assert.equal(data(result).error, 'download');
  assert.equal(await exists(path.join(f.home, '.zcode')), null);
});

test('目标是开发目录（含 .git）→ 跳过并解释，不覆盖不下载', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.zcode', 'skills');
  const target = await writeSkill(root, 'ppt-design', '0.0.1');
  await mkdir(path.join(target, '.git'));
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.installations, []);
  assert.deepEqual(value.skipped, [{ name: 'ppt-design', path: target, reason: 'development_directory' }]);
  assert.match(await readFile(path.join(target, 'SKILL.md'), 'utf8'), /0\.0\.1/);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '开发目录跳过时不应发起下载');
  const human = await f.run(['install', 'ppt-design', '--to', 'zcode']);
  assert.match(human.stdout, /ppt-design：开发目录，跳过（/);
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
  const value = data(result);
  assert.equal(value.error, 'purchase_unavailable');
  assert.equal(value.phase2, true);
  assert.equal(value.url, `${f.base}/store/ppt-design-pro/`);
  const human = await f.run(['install', 'ppt-design-pro', '--to', 'zcode']);
  assert.equal(human.code, 3);
  assert.match(human.stderr, /暂未开放购买/);
  assert.ok(human.stderr.includes(`${f.base}/store/ppt-design-pro/`));
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download') || r.path.startsWith('/releases/')), '一期不应进入付费下载');
});

test('occupied：目标目录被无关内容占用 → 占用预检前移（不下整包）且保留原样', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.zcode', 'skills');
  const target = path.join(root, 'ppt-design');
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'unrelated.txt'), 'keep me');
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'occupied');
  assert.equal(await readFile(path.join(target, 'unrelated.txt'), 'utf8'), 'keep me');
  assert.deepEqual(await readdir(target), ['unrelated.txt']);
  assert.deepEqual(await stageLeftovers(root), []);
  // 预检前移：无关内容占着目标时连下载都不该发起（不给重定向目标任何被请求的机会）。
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '占用预检应在下载之前');
});

test('occupied 前置同样拦截「目录名与内容不符：装着别的 skill」的目标', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.zcode', 'skills');
  const target = await writeSkill(root, 'ppt-design', '0.0.1');
  // 目录名是 ppt-design，里面装的却是另一个 skill。
  await writeFile(path.join(target, 'SKILL.md'), '---\nname: oracle-bone\nmetadata:\n  version: "0.1.0"\n---\n');
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'occupied');
  assert.match(await readFile(path.join(target, 'SKILL.md'), 'utf8'), /oracle-bone/);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')));
});

test('免费摘要 fail-closed：versions 缺 sha256 → missing_checksum，目标不可达', async (t) => {
  const f = await fixture(t);
  f.state.dropChecksum = true;
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'missing_checksum');
  assert.equal(await exists(path.join(f.home, '.zcode')), null);
});

test('下载字节上限（与发布侧 100MB 对称）：超限即中止报 too_large，临时目录照常清理', async (t) => {
  const f = await fixture(t);
  await withClient(f, async (client) => {
    const release = await releaseOf(f);
    const before = await downloadLeftovers();
    await assert.rejects(prepare(client, 'ppt-design', release, null, false, null, undefined, { sizeLimitBytes: 16 }), { error: 'too_large' });
    assert.deepEqual(await downloadLeftovers(), before);
  });
});

test('解压失败注入缝：runner 抛错 → extract 失败且目标不可达、临时目录清理', async (t) => {
  const f = await fixture(t);
  await withClient(f, async (client) => {
    const release = await releaseOf(f);
    const before = await downloadLeftovers();
    await assert.rejects(prepare(client, 'ppt-design', release, null, false, null, undefined,
      { runner: async () => { throw new Error('tar boom'); } }), { error: 'extract' });
    assert.deepEqual(await downloadLeftovers(), before);
  });
});

test('changed：下载期间目标被删除 → changed 保护，不误装新目录', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.zcode', 'skills');
  const target = await writeSkill(root, 'ppt-design', '0.0.1');
  // 前置预检时目标还在（同名旧版本），下载期间被第三方删除。
  f.state.releaseDelay = 500;
  const pending = f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !f.state.requests.some((r) => r.path === '/releases/ppt-design-0.1.0.tar.gz')) await delay(20);
  await rm(target, { recursive: true, force: true });
  const result = await pending;
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'changed');
  assert.equal(await exists(target), null, 'changed 保护下不应凭空装出新目录');
  assert.deepEqual(await stageLeftovers(root), []);
});

test('missingTarget：不带 --to → exit 2 + 推荐命令与真实路径', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(result.code, 2);
  const value = data(result);
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

test('--to 多值（重复值去重）：第一个目标放实体，其余链接', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode', '--to', 'claude', '--to', 'zcode', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const primary = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  const value = data(result);
  assert.deepEqual(value.installations, [{ name: 'ppt-design', path: primary, previous: null, version: '0.1.0' }]);
  assert.deepEqual(value.links, [{ name: 'ppt-design', path: path.join(f.home, '.claude', 'skills', 'ppt-design'), target: primary, existing: false, replaced_copy: false }]);
  assert.equal(await readDirectoryLink(path.join(f.home, '.claude', 'skills', 'ppt-design')), primary);
});

test('交互模式先列出目标再确认；拒绝确认 → installCanceled，退出码 0 且未动目标', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.zcode'), { recursive: true });
  const root = path.join(f.home, '.zcode', 'skills');
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode'], {}, { interactive: true, answers: [false] });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.endsWith('已取消安装。\n'), result.stdout);
  assert.match(result.stdout, /安装位置：/);
  assert.ok(result.stdout.includes(root));
  assert.equal(await exists(root), null);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')));
});

test('--to 显式路径（非宿主 id）：装到自定义目录', async (t) => {
  const f = await fixture(t);
  const custom = path.join(f.cwd, 'my-skills');
  const result = await f.run(['install', 'oracle-bone', '--to', custom, '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const target = path.join(custom, 'oracle-bone');
  assert.match(await readFile(path.join(target, 'SKILL.md'), 'utf8'), /version: "0\.1\.0"/);
  assert.deepEqual(data(result).installations, [{ name: 'oracle-bone', path: target, previous: null, version: '0.1.0' }]);
});

// 任务 7：多宿主链接共享安装。

// 三个宿主（zcode 最先），无 --to 自动发现。
const threeHosts = async (f) => {
  for (const host of ['.zcode', '.claude', '.trae']) await mkdir(path.join(f.home, host), { recursive: true });
};

test('多宿主自动发现：无 --to → 第一个宿主（zcode 优先）放实体，其余 junction/symlink 链接共享', async (t) => {
  const f = await fixture(t);
  await threeHosts(f);
  const result = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  const primary = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  assert.deepEqual(value.installations, [{ name: 'ppt-design', path: primary, previous: null, version: '0.1.0' }]);
  assert.deepEqual(value.links.map((item) => ({ path: item.path, target: item.target, existing: item.existing, replaced_copy: item.replaced_copy })),
    ['.claude', '.trae'].map((host) => ({ path: path.join(f.home, host, 'skills', 'ppt-design'), target: primary, existing: false, replaced_copy: false })));
  // 链接真实指向实体目录：win32 是 junction、POSIX 是目录 symlink，lstat/readlink 均可验。
  assert.match(await readFile(path.join(primary, 'SKILL.md'), 'utf8'), /version: "0\.1\.0"/);
  for (const host of ['.claude', '.trae']) {
    const link = path.join(f.home, host, 'skills', 'ppt-design');
    assert.ok((await lstat(link)).isSymbolicLink(), `${link} 应为目录链接`);
    assert.equal(await readDirectoryLink(link), primary);
    // 链接内容随实体：读到的就是实体里的新版本。
    assert.match(await readFile(path.join(link, 'SKILL.md'), 'utf8'), /0\.1\.0/);
  }
  // status 复核链接关系：多宿主折叠为一份实体，无多副本警告。
  const status = data(await f.run(['status', '--json']));
  assert.equal(status.installations.length, 1);
  assert.equal(status.installations[0].path, primary);
  assert.equal(status.installations[0].current, '0.1.0');
  assert.deepEqual(status.warnings, []);
});

test('其他宿主里的独立旧副本自动换成链接（replaced_copy），status 多副本警告消失', async (t) => {
  const f = await fixture(t);
  await threeHosts(f);
  const old = await writeSkill(path.join(f.home, '.claude', 'skills'), 'ppt-design', '0.0.9');
  const renamed = await writeSkill(path.join(f.home, '.trae', 'skills'), 'ppt-design', '0.0.8', 'my-ppt');
  let status = data(await f.run(['status', '--json']));
  assert.equal(status.warnings.length, 1);
  assert.match(status.warnings[0], /2 份独立副本/);
  const result = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const primary = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  const value = data(result);
  assert.deepEqual(value.installations, [{ name: 'ppt-design', path: primary, previous: null, version: '0.1.0' }]);
  // 同名旧副本与改名副本都换成链接；旧副本位置标记 replaced_copy。
  assert.deepEqual(value.links.map((item) => [item.path, item.existing, item.replaced_copy]).sort(),
    [[old, false, true], [renamed, false, true], [path.join(f.home, '.trae', 'skills', 'ppt-design'), false, false]].sort());
  for (const directory of [old, renamed]) assert.equal(await readDirectoryLink(directory), primary);
  status = data(await f.run(['status', '--json']));
  assert.deepEqual(status.warnings, []);
  assert.equal(status.installations.length, 1);
  assert.equal(status.installations[0].path, primary);
});

test('幂等：多宿主第二次安装 → 实体替换为同版本、已有链接 existing 保持、无错误', async (t) => {
  const f = await fixture(t);
  await threeHosts(f);
  const primary = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  assert.equal((await f.run(['install', 'ppt-design', '--json'])).code, 0);
  const second = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  const value = data(second);
  assert.equal(value.auto_confirmed, true);
  assert.deepEqual(value.installations, [{ name: 'ppt-design', path: primary, previous: '0.1.0', version: '0.1.0' }]);
  assert.deepEqual(value.links, ['.claude', '.trae'].map((host) => ({ name: 'ppt-design', path: path.join(f.home, host, 'skills', 'ppt-design'), target: primary, existing: true })));
  assert.deepEqual(value.warnings, []);
  assert.match(await readFile(path.join(primary, 'SKILL.md'), 'utf8'), /0\.1\.0/);
  assert.deepEqual(await stageLeftovers(path.dirname(primary)), []);
  assert.deepEqual(await stageLeftovers(path.join(f.home, '.claude', 'skills')), []);
});

test('保护与解释：用户自建链接指向别处（开发目录）→ 实体顺延到下一宿主，被保护位置跳过并说明', async (t) => {
  const f = await fixture(t);
  await threeHosts(f);
  const elsewhere = path.join(f.temporary, 'elsewhere');
  await mkdir(path.join(elsewhere, '.git'), { recursive: true });
  const protectedLink = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  await mkdir(path.dirname(protectedLink), { recursive: true });
  await linkDirectory(elsewhere, protectedLink);
  const result = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  const primary = path.join(f.home, '.claude', 'skills', 'ppt-design');
  assert.deepEqual(value.installations.map((item) => item.path), [primary]);
  assert.deepEqual(value.skipped, [{ name: 'ppt-design', path: protectedLink, reason: 'development_directory' }]);
  // 被保护的自建链接原样保留，指向不变；只有最后一个宿主得到新链接。
  assert.equal(await readDirectoryLink(protectedLink), elsewhere);
  assert.deepEqual(value.links.map((item) => item.path), [path.join(f.home, '.trae', 'skills', 'ppt-design')]);
  const human = await f.run(['install', 'ppt-design']);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /ppt-design：开发目录，跳过（/);
});

test('开发目录作为主安装 → 跳过并解释，其他宿主直接链到开发目录，不下载也不改动', async (t) => {
  const f = await fixture(t);
  await threeHosts(f);
  const repository = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.1');
  await mkdir(path.join(repository, '.git'));
  const before = await readFile(path.join(repository, 'SKILL.md'), 'utf8');
  const result = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.installations, []);
  assert.deepEqual(value.skipped, [{ name: 'ppt-design', path: repository, reason: 'development_directory' }]);
  for (const host of ['.claude', '.trae']) assert.equal(await readDirectoryLink(path.join(f.home, host, 'skills', 'ppt-design')), repository);
  assert.equal(await readFile(path.join(repository, 'SKILL.md'), 'utf8'), before);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '开发目录跳过时不应发起下载');
});

test('未知占用目录（链接宿主里无关内容占着同名位置）→ occupied 拒绝替换，已完成目标一并回滚', async (t) => {
  const f = await fixture(t);
  for (const host of ['.zcode', '.claude']) await mkdir(path.join(f.home, host), { recursive: true });
  const unknown = path.join(f.home, '.claude', 'skills', 'ppt-design');
  await mkdir(unknown, { recursive: true });
  await writeFile(path.join(unknown, 'unrelated.txt'), 'keep me');
  const result = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'occupied');
  assert.equal(await readFile(path.join(unknown, 'unrelated.txt'), 'utf8'), 'keep me');
  // 整批回滚：实体目标不留安装，无暂存残留。
  assert.equal(await exists(path.join(f.home, '.zcode', 'skills', 'ppt-design')), null);
  assert.deepEqual(await stageLeftovers(path.join(f.home, '.zcode', 'skills')), []);
  // 占用预检在下载之前（任务 6 审查语义在多目标下延续）。
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '占用预检应在下载之前');
});

test('检测不到宿主：非交互 exit 2；交互输入路径后装到该处，空回答 noTarget', async (t) => {
  const f = await fixture(t);
  const nonInteractive = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(nonInteractive.code, 2);
  assert.equal(data(nonInteractive).error, 'missing_target');
  assert.equal(nonInteractive.trace.questions.length, 0);
  const custom = path.join(f.cwd, 'custom-skills');
  const prompted = await f.run(['install', 'ppt-design'], {}, { interactive: true, answers: [custom, ''] });
  assert.equal(prompted.code, 0, prompted.stdout + prompted.stderr);
  assert.match(await readFile(path.join(custom, 'ppt-design', 'SKILL.md'), 'utf8'), /version: "0\.1\.0"/);
  assert.equal(prompted.trace.questions.length, 2);
  const empty = await f.run(['install', 'oracle-bone'], {}, { interactive: true, answers: [''] });
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /未选择安装位置/);
  assert.equal((await exists(path.join(f.cwd, 'custom-skills', 'oracle-bone'))), null);
});

test('交互模式列出自动发现的目标（实体 + 链接行）后回车确认安装', async (t) => {
  const f = await fixture(t);
  await threeHosts(f);
  const result = await f.run(['install', 'ppt-design'], {}, { interactive: true, answers: [''] });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /安装位置：/);
  assert.ok(result.stdout.includes(path.join(f.home, '.zcode', 'skills')));
  assert.ok(result.stdout.includes(`${path.join(f.home, '.claude', 'skills')}（链接到上面这份）`));
  assert.equal(result.trace.questions.length, 1);
  assert.match(result.trace.questions[0], /\[Y\/n\]/);
  assert.ok((await lstat(path.join(f.home, '.claude', 'skills', 'ppt-design'))).isSymbolicLink());
  assert.ok((await lstat(path.join(f.home, '.trae', 'skills', 'ppt-design'))).isSymbolicLink());
});

test('多目标事务（renameFile 注入第 2 动作失败）：实体与已换链接的旧副本全部还原', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hy-multi-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rootA = path.join(base, 'a'), rootB = path.join(base, 'b');
  await mkdir(rootA); await mkdir(rootB);
  const primary = await writeSkill(rootA, 'ppt-skill', '0.0.1');
  const copy = await writeSkill(rootB, 'ppt-skill', '0.0.2');
  const incoming = await mkdtemp(path.join(tmpdir(), 'hy-incoming-'));
  t.after(() => rm(incoming, { recursive: true, force: true }));
  const source = await writeSkill(incoming, 'ppt-skill', '0.1.0');
  const actions = [
    { name: 'ppt-skill', path: primary, source, previousName: 'ppt-skill', previousVersion: '0.0.1' },
    { name: 'ppt-skill', path: copy, link: primary, previousName: 'ppt-skill', previousVersion: '0.0.2' },
  ];
  let calls = 0;
  const renameFile = async (from, to) => { if (++calls === 3) throw new Error('injected'); return (await import('node:fs/promises')).rename(from, to); };
  const error = await replaceAll(actions, { renameFile, names: ['ppt-skill'] }).catch((error) => error);
  assert.equal(error.error, 'replace');
  assert.match(await readFile(path.join(primary, 'SKILL.md'), 'utf8'), /0\.0\.1/);
  assert.match(await readFile(path.join(copy, 'SKILL.md'), 'utf8'), /0\.0\.2/);
  assert.ok(!(await lstat(copy)).isSymbolicLink(), '旧副本不应残留半成品链接');
  assert.deepEqual(await stageLeftovers(rootA), []);
  assert.deepEqual(await stageLeftovers(rootB), []);
});

test('多目标事务（链接已创建后后续动作失败）：已创建链接被清理，实体与两个旧副本全部还原', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hy-multi-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rootA = path.join(base, 'a'), rootB = path.join(base, 'b'), rootC = path.join(base, 'c');
  for (const root of [rootA, rootB, rootC]) await mkdir(root);
  const primary = await writeSkill(rootA, 'ppt-skill', '0.0.1');
  const copy1 = await writeSkill(rootB, 'ppt-skill', '0.0.2');
  const copy2 = await writeSkill(rootC, 'ppt-skill', '0.0.3');
  const incoming = await mkdtemp(path.join(tmpdir(), 'hy-incoming-'));
  t.after(() => rm(incoming, { recursive: true, force: true }));
  const source = await writeSkill(incoming, 'ppt-skill', '0.1.0');
  const actions = [
    { name: 'ppt-skill', path: primary, source, previousName: 'ppt-skill', previousVersion: '0.0.1' },
    { name: 'ppt-skill', path: copy1, link: primary, previousName: 'ppt-skill', previousVersion: '0.0.2' },
    { name: 'ppt-skill', path: copy2, link: primary, previousName: 'ppt-skill', previousVersion: '0.0.3' },
  ];
  let calls = 0;
  // 第 4 次 rename 是第二个链接动作的旧副本挪备份：此时第一个链接已创建，回滚必须把它清掉。
  const renameFile = async (from, to) => { if (++calls === 4) throw new Error('injected'); return (await import('node:fs/promises')).rename(from, to); };
  const error = await replaceAll(actions, { renameFile, names: ['ppt-skill'] }).catch((error) => error);
  assert.equal(error.error, 'replace');
  for (const [directory, version] of [[primary, '0.0.1'], [copy1, '0.0.2'], [copy2, '0.0.3']]) {
    assert.match(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), new RegExp(version.replace(/\./g, '\\.')));
    assert.ok(!(await lstat(directory)).isSymbolicLink(), `${directory} 不应残留链接`);
  }
  for (const root of [rootA, rootB, rootC]) assert.deepEqual(await stageLeftovers(root), []);
});
