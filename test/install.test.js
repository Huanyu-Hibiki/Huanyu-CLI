import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { access, chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fixture, writeSkill, linkDirectory, readDirectoryLink, TOKEN, withPrivateTmp } from './fixture.js';
import { interruptBackups, invalidateAccount } from '../src/cli.js';
import { isSkillName } from '../src/skills.js';
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
      // 第一个目标已完全提交后、第二个动作失败前：第三方把目标换成了别的目录。
      // 用 rename 移走原目录再 mkdir：旧 inode 仍被占用、新目录 ino 必然不同——
      // 直接 rm+mkdir 在 Linux 上会立刻复用刚释放的 inode 号，dev/ino 防线就检测不到。
      await rename(first, `${first}-moved`);
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

// —— 付费下载路径（二期任务 3）：requireEntitlement 已购放行、未购 exit 3 inactive 引导 ——

// 种子发布物只覆盖免费 skill：付费版本先经 publish 落进商店，下载端点才有内容可发。
const publishPaid = async (f, version = '0.2.0') => {
  await writeSkill(f.cwd, 'ppt-design-pro', version);
  const result = await f.run(['publish', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
};
const downloadsOf = (f, name) => f.state.requests.filter((r) => r.path === `/api/store/download/${name}`);

test('已购付费 skill 一条命令安装（多宿主）：Bearer 直连 200、全程无 302 跳转', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  await threeHosts(f);
  const result = await f.run(['install', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const primary = path.join(f.home, '.zcode', 'skills', 'ppt-design-pro');
  const value = data(result);
  assert.deepEqual(value.installations, [{ name: 'ppt-design-pro', path: primary, previous: null, version: '0.2.0' }]);
  assert.equal(value.links.length, 2);
  assert.ok(value.links.every((item) => item.target === primary));
  assert.match(await readFile(path.join(primary, 'SKILL.md'), 'utf8'), /version: "0\.2\.0"/);
  // 付费下载：下载端点带 Bearer 直连拿 200；redirect:error 语义下没有 302→/releases 的跟随请求。
  assert.deepEqual(downloadsOf(f, 'ppt-design-pro').map((r) => r.token), [TOKEN]);
  assert.equal(downloadsOf(f, 'ppt-design-pro')[0].query.get('version'), '0.2.0');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/releases/')), '付费下载不得 302 到公开附件');
  // 权益判定经 /api/auth/me： subscriptions 含 ppt-design-pro（默认 grants）才放行。
  assert.ok(f.state.requests.some((r) => r.path === '/api/auth/me' && r.token === TOKEN));
});

test('X-Skill-Version 头不匹配注入 → version_mismatch 拒绝，目标不可达', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  f.state.badDownloadVersion = true;
  const result = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 1);
  const value = data(result);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'version_mismatch');
  assert.equal(await exists(path.join(f.home, '.zcode')), null, '头校验失败时目标不可达');
});

// 任务 5 语义改造：未购付费 skill 不再 exit 3 引导，而是内联进入购买流程（一条命令完成购买+安装）。
// 购买未完成（60 秒预算耗尽）才 exit 3 payment_pending，目标不可达且不发起下载。
test('未购付费 skill：install 内联进入购买（checkout+付款页），60 秒未付款 exit 3 payment_pending 且不下载；解锁后重跑一条命令完成', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  f.state.grants.set(TOKEN, []);
  f.state.checkoutActiveAfter = Infinity;
  const result = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 3);
  const output = result.stdout.trim().split('\n').map(JSON.parse);
  assert.deepEqual(output.map((event) => event.event), ['checkout', undefined]);
  const pending = output.at(-1);
  assert.equal(pending.ok, false);
  assert.equal(pending.error, 'payment_pending');
  assert.equal(pending.skill, 'ppt-design-pro');
  assert.equal(pending.purchase_url, output[0].url);
  assert.equal(pending.next_command, `${command('install', 'ppt-design-pro', '--to', 'zcode', '--json')}`);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '未完成购买不应进入下载');
  assert.equal(await exists(path.join(f.home, '.zcode')), null, '购买未完成时目标不可达');
  // 付款解锁（轮询到点）后重跑：权益闸门经 me 放行，一条命令完成安装。
  f.state.checkoutActiveAfter = 2;
  const second = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(second.code, 0, second.stdout + second.stderr);
  assert.deepEqual(data(second).installations, [{ name: 'ppt-design-pro', path: path.join(f.home, '.zcode', 'skills', 'ppt-design-pro'), previous: null, version: '0.2.0' }]);
});

test('订阅状态表驱动：五种有效状态逐一放行（不进购买）；未知/失效状态 fail-closed 视为未购进入内联购买', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  f.state.grants.set(TOKEN, ['ppt-design-pro']);
  for (const status of ['active', 'canceling', 'past_due', 'lifetime', 'trialing']) {
    f.state.subscriptionStatus = status;
    const result = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
    assert.equal(result.code, 0, `${status}: ${result.stdout + result.stderr}`);
    assert.equal(data(result).installations[0].version, '0.2.0', status);
  }
  assert.equal(f.state.checkoutRequests, 0, '已购状态不得进入购买流程');
  const downloadsAfterPositive = f.state.requests.filter((r) => r.path.startsWith('/api/store/download')).length;
  // 失效状态 = 未购：进入内联购买；注入让购买在 60 秒内无法完成（会话状态不履约），验证 fail-closed。
  f.state.checkoutActiveAfter = Infinity;
  f.state.checkoutStatusResponse = { status: 'open', paid: false, entitled: false };
  for (const status of ['canceled', 'expired', 'unknown-status']) {
    f.state.subscriptionStatus = status;
    const result = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
    assert.equal(result.code, 3, status);
    const pending = JSON.parse(result.stdout.trim().split('\n').at(-1));
    assert.equal(pending.error, 'payment_pending', status);
  }
  assert.equal(f.state.requests.filter((r) => r.path.startsWith('/api/store/download')).length, downloadsAfterPositive,
    '未完成购买不应进入付费下载');
});

test('me 订阅条目形状校验：null 条目/缺 status/非对象/空 skill → invalid_response（fail-closed）', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  // 残缺条目在 me() 处按 invalid_response 拒绝（security-L2）：requireEntitlement 消费端不再防御
  // null 条目（修复前 null 条目会在 subscriptions.some 里 TypeError 退化为通用 failed）。
  // 注意首个用例是"列表里含 null 条目"（[null]）——bare null 是 fixture 注入位的"未设置"哨兵。
  for (const entries of [[null], [undefined], [{ skill: 'ppt-design-pro' }], ['bogus'], [{ skill: '', status: 'active' }], [{ skill: 'ppt-design-pro', status: '' }]]) {
    f.state.rawSubscriptions = entries;
    const result = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
    assert.equal(result.code, 1, JSON.stringify(entries));
    const value = data(result);
    assert.equal(value.ok, false, JSON.stringify(entries));
    assert.equal(value.error, 'invalid_response', JSON.stringify(entries));
  }
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '形状残缺不应进入下载');
});

test('付费头摘要负例：X-Content-SHA256 错误 → checksum_mismatch；头缺失 → missing_checksum', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  f.state.badDownloadChecksum = true;
  const wrong = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(wrong.code, 1);
  assert.equal(data(wrong).error, 'checksum_mismatch');
  assert.equal(await exists(path.join(f.home, '.zcode')), null, '校验失败时目标不可达');
  f.state.badDownloadChecksum = false;
  f.state.dropDownloadChecksum = true;
  const missing = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(missing.code, 1);
  assert.equal(data(missing).error, 'missing_checksum');
  assert.equal(await exists(path.join(f.home, '.zcode')), null, '头缺失时目标不可达');
});

test('invalidateAccount 契约：清空 requireEntitlement 的订阅快照（任务 5 购买成功后失效缓存用）', () => {
  const ctx = { account: { subscriptions: [{ skill: 'ppt-design-pro', status: 'lifetime' }] } };
  invalidateAccount(ctx);
  assert.equal(ctx.account, null, '失效后下一次权益判定必须重新拉取 me()');
});

test('无令牌安装付费 skill：设备码登录引导 exit 3，不进入下载', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  f.state.requireApproval = true;
  const result = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], {}, { browserDelay: 100 });
  assert.equal(result.code, 3);
  const pending = result.stdout.trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(pending.error, 'authorization_pending');
  assert.equal(pending.next_command, 'npx github:Huanyu-Hibiki/Huanyu-CLI install ppt-design-pro --to zcode --json');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '登录完成前不应下载');
});

test('令牌失效（401）：exit 3 unauthorized 重新登录引导', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  f.state.revoked.add(TOKEN);
  const result = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 3);
  const value = data(result);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'unauthorized');
  assert.match(value.message, /登录已失效，请重新运行 npx github:Huanyu-Hibiki\/Huanyu-CLI login。/);
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

// 下载临时目录残留断言：系统 tmpdir 被并行测试文件的 CLI 子进程共享（它们同时在创建/清理
// hy-download-*，前后快照相等会竞态误报）。withPrivateTmp（fixture 共享助手）把 os.tmpdir
// 指到本测试私有目录，断言才是确定性的。
test('下载字节上限（与发布侧 100MB 对称）：超限即中止报 too_large，临时目录照常清理', async (t) => {
  const f = await fixture(t);
  await withClient(f, async (client) => {
    const release = await releaseOf(f);
    await withPrivateTmp(async () => {
      await assert.rejects(prepare(client, 'ppt-design', release, null, false, null, undefined, { sizeLimitBytes: 16 }), { error: 'too_large' });
      assert.deepEqual(await downloadLeftovers(), []);
    });
  });
});

test('解压失败注入缝：runner 抛错 → extract 失败且目标不可达、临时目录清理', async (t) => {
  const f = await fixture(t);
  await withClient(f, async (client) => {
    const release = await releaseOf(f);
    await withPrivateTmp(async () => {
      await assert.rejects(prepare(client, 'ppt-design', release, null, false, null, undefined,
        { runner: async () => { throw new Error('tar boom'); } }), { error: 'extract' });
      assert.deepEqual(await downloadLeftovers(), []);
    });
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

test('missingTarget：不带 --to → exit 2 + 推荐命令（保留 --json/--lang 等原始标志）与真实路径', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(result.code, 2);
  const value = data(result);
  assert.equal(value.error, 'missing_target');
  const expected = `${command('install', 'ppt-design', '--json')} --to zcode`;
  assert.equal(value.recommended_command, expected);
  assert.equal(value.next_command, expected);
  assert.equal(value.recommended_path, targetRoot('zcode', f.env));
  const human = await f.run(['install', 'ppt-design']);
  assert.equal(human.code, 2);
  assert.ok(human.stderr.includes(`${command('install', 'ppt-design')} --to zcode`), human.stderr);
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
  // 同名旧副本与改名副本都换成链接；旧副本位置标记 replaced_copy（显式按路径排序对齐两侧）。
  const byPath = (a, b) => a[0].localeCompare(b[0], 'en');
  assert.deepEqual(value.links.map((item) => [item.path, item.existing, item.replaced_copy]).sort(byPath),
    [[old, false, true], [renamed, false, true], [path.join(f.home, '.trae', 'skills', 'ppt-design'), false, false]].sort(byPath));
  for (const directory of [old, renamed]) assert.equal(await readDirectoryLink(directory), primary);
  // 任务 6 M1：被换成链接的两份旧副本保留为备份——status 改为提示备份位置（多副本警告消失）。
  const backupOf = async (directory) => path.join(directory, (await readdir(directory)).find((name) => name.startsWith('.hy-backup-')));
  const backupOld = await backupOf(path.dirname(old)), backupRenamed = await backupOf(path.dirname(renamed));
  status = data(await f.run(['status', '--json']));
  assert.equal(status.installations.length, 1);
  assert.equal(status.installations[0].path, primary);
  assert.deepEqual(status.warnings, [
    `旧版本备份保留在：${backupOld}（下次安装或更新时自动清理，也可手动删除）`,
    `旧版本备份保留在：${backupRenamed}（下次安装或更新时自动清理，也可手动删除）`,
  ]);
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
  // 纯链接路径（无实体动作）：连版本表都不打。
  assert.ok(!f.state.requests.some((r) => r.path === '/api/store/versions'), '纯链接路径不打版本表');
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

// 三路审查修复（任务 7 补丁轮）。

test('overlap 预检前移：--to 目标互相包含 → 下载之前报 overlappingTargets，目标不可达', async (t) => {
  const f = await fixture(t);
  const outer = path.join(f.cwd, 'skills'), nested = path.join(outer, 'ppt-design');
  const result = await f.run(['install', 'ppt-design', '--to', outer, '--to', nested, '--json']);
  assert.equal(result.code, 2);
  assert.equal(data(result).error, 'overlapping_targets');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '预检应在下载之前');
  assert.equal(await exists(nested), null, '不应创建嵌套目标');
  assert.deepEqual(await stageLeftovers(outer), []);
});

// 任务 6 M2 写穿白名单：主安装位置是用户自建链接时，实体动作只跟随到 CLI 管辖的根集合内
//（发现根/--to 显式根/各宿主用户级与项目级根）；指向管理范围之外的链接不写穿——不能借 CLI
// 之手改写任意目录。
test('M2 写穿白名单（正例）：主安装链接的真实目标在宿主根内 → 实体更新真实目标，自建链接保留', async (t) => {
  const f = await fixture(t);
  await threeHosts(f);
  const real = await writeSkill(path.join(f.home, '.claude', 'skills'), 'ppt-design', '0.0.1');
  const linked = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  await mkdir(path.dirname(linked), { recursive: true });
  await linkDirectory(real, linked);
  const result = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.installations.map((item) => [item.path, item.previous, item.version]), [[real, '0.0.1', '0.1.0']]);
  assert.match(await readFile(path.join(real, 'SKILL.md'), 'utf8'), /0\.1\.0/);
  // 自建链接原样保留；claude 位与真实目标已是同一实体（existing 幂等跳过），最后一个宿主链到主安装位置。
  assert.ok((await lstat(linked)).isSymbolicLink());
  assert.equal(await readDirectoryLink(linked), real);
  assert.deepEqual(value.links.map((item) => [item.path, item.existing]), [
    [path.join(f.home, '.claude', 'skills', 'ppt-design'), true],
    [path.join(f.home, '.trae', 'skills', 'ppt-design'), false],
  ]);
  const status = data(await f.run(['status', '--json']));
  assert.equal(status.installations.length, 1);
  assert.equal(status.installations[0].real_path, await realpath(real));
});

test('M2 写穿白名单（反例）：主安装链接指向 CLI 管理范围之外的目录 → occupied 拒绝并解释，不安装不写穿', async (t) => {
  const f = await fixture(t);
  await threeHosts(f);
  const real = await writeSkill(path.join(f.temporary, 'store'), 'ppt-design', '0.0.1');
  const linked = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  await mkdir(path.dirname(linked), { recursive: true });
  await linkDirectory(real, linked);
  const result = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(result.code, 1);
  const value = data(result);
  assert.equal(value.error, 'occupied');
  assert.match(value.message, /CLI 管理范围之外的目录/);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '拒绝发生在下载之前');
  // 自建链接与其真实目标都原样保留：不写穿、整批不留安装、无暂存残留。
  assert.equal(await readDirectoryLink(linked), real);
  assert.match(await readFile(path.join(real, 'SKILL.md'), 'utf8'), /0\.0\.1/);
  assert.equal(await exists(path.join(f.home, '.claude', 'skills', 'ppt-design')), null);
  assert.equal(await exists(path.join(f.home, '.trae', 'skills', 'ppt-design')), null);
  assert.deepEqual(await stageLeftovers(path.dirname(real)), []);
  const english = await f.run(['install', 'ppt-design', '--to', 'zcode', '--lang', 'en']);
  assert.equal(english.code, 1);
  assert.match(english.stderr, /outside the directories this CLI manages/);
});

// 任务 6 M4：悬空链接从「occupied 阻塞整批」改为「跳过该宿主位 + skipped 解释」；实体目标位
// 仍 fail-closed（不能凭空装出一份来路不明的新内容顶掉用户的链接）。
test('M4 悬空链接在链接宿主位：跳过该宿主并解释（dangling_link），其余宿主照常安装，链接原样保留', async (t) => {
  const f = await fixture(t);
  await threeHosts(f);
  const dangling = path.join(f.home, '.claude', 'skills', 'ppt-design');
  const missing = path.join(f.temporary, 'missing');
  await mkdir(path.dirname(dangling), { recursive: true });
  await linkDirectory(missing, dangling);
  const result = await f.run(['install', 'ppt-design', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  const primary = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  assert.deepEqual(value.installations, [{ name: 'ppt-design', path: primary, previous: null, version: '0.1.0' }]);
  assert.deepEqual(value.skipped, [{ name: 'ppt-design', path: dangling, reason: 'dangling_link' }]);
  assert.deepEqual(value.links.map((item) => item.path), [path.join(f.home, '.trae', 'skills', 'ppt-design')]);
  assert.ok((await lstat(dangling)).isSymbolicLink(), '悬空链接应原样保留');
  assert.equal(await readDirectoryLink(dangling), missing);
  assert.equal(await exists(missing), null, '不凭空创建链接目标');
  const human = await f.run(['install', 'ppt-design']);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /链接目标不存在（悬空链接），跳过/);
  const english = await f.run(['install', 'ppt-design', '--lang', 'en']);
  assert.equal(english.code, 0, english.stdout + english.stderr);
  assert.match(english.stdout, /the link target does not exist/);
});

test('M4 悬空链接在主目标位（--to 单根）：occupied 整批拒绝（fail-closed 保持），不下载、链接保留', async (t) => {
  const f = await fixture(t);
  const dangling = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  const missing = path.join(f.temporary, 'missing');
  await mkdir(path.dirname(dangling), { recursive: true });
  await linkDirectory(missing, dangling);
  const result = await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'occupied');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '占用预检应在下载之前');
  assert.ok((await lstat(dangling)).isSymbolicLink(), '悬空链接应原样保留');
  assert.equal(await readDirectoryLink(dangling), missing);
});

// 任务 6 M1（方案 C·事务备份保留）：商店只存最新版发布物，无法与本地旧副本做内容差异比对来
// 识别「本地修改」——改为把「提交即销毁」降级为「提交后可恢复」：被替换目录的备份改名保留在
// 安装根（.hy-backup-<stamp>），status 提示位置与清理方法，下一次安装自动清过期备份（每根只留
// 本次事务留下的一份）。回滚失败备份绝不清理的既有守卫不受影响（见上组注入用例）。
test('M1 备份保留：替换提交后旧内容保留在 .hy-backup-*（含本地修改痕迹）；status 提示；下次安装清理过期备份', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.zcode', 'skills');
  const target = await writeSkill(root, 'ppt-design', '0.0.1');
  await writeFile(path.join(target, 'assets', 'local-edit.txt'), 'user change');
  const first = await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  assert.equal(first.code, 0, first.stdout + first.stderr);
  const backups = async () => (await readdir(root)).filter((name) => name.startsWith('.hy-backup-')).sort();
  let names = await backups();
  assert.equal(names.length, 1, '替换提交后保留一份备份');
  const backup = path.join(root, names[0]);
  // 备份含旧内容（含用户的本地修改痕迹——被替换销毁的内容可恢复）。
  assert.match(await readFile(path.join(backup, 'SKILL.md'), 'utf8'), /0\.0\.1/);
  assert.equal(await readFile(path.join(backup, 'assets', 'local-edit.txt'), 'utf8'), 'user change');
  // 备份目录不参与扫描：status 只报一份安装，提示备份位置与清理方法（中英文）。
  const status = data(await f.run(['status', '--json']));
  assert.equal(status.installations.length, 1);
  assert.equal(status.installations[0].current, '0.1.0');
  assert.deepEqual(status.warnings, [`旧版本备份保留在：${backup}（下次安装或更新时自动清理，也可手动删除）`]);
  const human = await f.run(['status']);
  assert.ok(human.stdout.includes(`旧版本备份保留在：${backup}`), human.stdout);
  const english = await f.run(['status', '--lang', 'en']);
  assert.match(english.stdout, /A previous version is backed up at:/);
  // 下次安装：新备份生成、旧备份清理，安装根下仍只有一份（保留最近一份）。
  const second = await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  names = await backups();
  assert.equal(names.length, 1, '过期备份在下次安装时自动清理，只保留最近一份');
  const fresh = path.join(root, names[0]);
  assert.notEqual(fresh, backup);
  assert.match(await readFile(path.join(fresh, 'SKILL.md'), 'utf8'), /0\.1\.0/, '新备份是本次被替换的 0.1.0 内容');
  await assert.rejects(access(path.join(backup, 'SKILL.md')), { code: 'ENOENT' }, '旧备份被清理');
});

test('M1：同根多处备份改名撞名（注入固定 stamp）→ 撞名的那份留在暂存目录并警告，绝不销毁旧内容', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hy-backup-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const first = await writeSkill(base, 'a-skill', '1.0.0'), second = await writeSkill(base, 'b-skill', '1.0.0');
  const incoming = await mkdtemp(path.join(tmpdir(), 'hy-incoming-'));
  t.after(() => rm(incoming, { recursive: true, force: true }));
  const sourceA = await writeSkill(incoming, 'a-skill', '2.0.0'), sourceB = await writeSkill(incoming, 'b-skill', '2.0.0');
  // 两个动作用同一个备份 stamp：第一份改名成功后，第二份撞名失败——必须走「保留暂存目录」路径。
  const warnings = await replaceAll([
    { name: 'a-skill', path: first, source: sourceA, previousName: 'a-skill', previousVersion: '1.0.0' },
    { name: 'b-skill', path: second, source: sourceB, previousName: 'b-skill', previousVersion: '1.0.0' },
  ], { names: ['a-skill', 'b-skill'], backupStamp: () => 'same' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /临时目录清理失败/);
  // 两处新内容照常提交；第一份备份改名成功，第二份完整留在暂存目录（可手动恢复）。
  assert.match(await readFile(path.join(first, 'SKILL.md'), 'utf8'), /2\.0\.0/);
  assert.match(await readFile(path.join(second, 'SKILL.md'), 'utf8'), /2\.0\.0/);
  assert.ok((await readdir(base)).includes('.hy-backup-same'), '第一份备份保留');
  const stages = (await readdir(base)).filter((name) => name.startsWith('.hy-stage-'));
  assert.equal(stages.length, 1, '撞名的暂存目录不清理');
  assert.match(await readFile(path.join(base, stages[0], 'old', 'SKILL.md'), 'utf8'), /name: b-skill/);
});

test('多目标事务（linkDirectory 注入失败）：旧副本完整还原、无链接残留、stage 清空', async (t) => {
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
  const linkDirectory = async () => { throw Object.assign(new Error('injected'), { code: 'EPERM' }); };
  const error = await replaceAll(actions, { linkDirectory, names: ['ppt-skill'] }).catch((error) => error);
  assert.equal(error.error, 'replace');
  assert.match(await readFile(path.join(primary, 'SKILL.md'), 'utf8'), /0\.0\.1/);
  assert.match(await readFile(path.join(copy, 'SKILL.md'), 'utf8'), /0\.0\.2/);
  assert.ok(!(await lstat(copy)).isSymbolicLink(), '旧副本位置不应残留链接');
  assert.deepEqual(await stageLeftovers(rootA), []);
  assert.deepEqual(await stageLeftovers(rootB), []);
});

test('askTarget 拼写提示：输入与宿主 id 编辑距离 1 → 提示建议 id，本次仍按路径处理', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['install', 'ppt-design'], {}, { interactive: true, answers: ['zcod', ''] });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /疑似宿主 zcode 的拼写误差/);
  assert.ok(result.stdout.includes('zcod'), '提示里带用户输入的原样路径');
  // 输入按路径语义处理：装到 ./zcod（不误当 zcode 宿主）。
  assert.match(await readFile(path.join(f.cwd, 'zcod', 'ppt-design', 'SKILL.md'), 'utf8'), /version: "0\.1\.0"/);
  assert.equal(await exists(path.join(f.home, '.zcode')), null, '不应误建 zcode 宿主目录');
});

test('replaceAll 观察位 onStage：事务期间上报暂存目录，供二次中断时定位备份', async (t) => {
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
  const stages = [];
  const warnings = await replaceAll(actions, { onStage: (stage) => stages.push(stage), names: ['ppt-skill'] });
  assert.deepEqual(warnings, []);
  assert.equal(stages.length, 2, '每个动作上报一个暂存目录');
  for (const stage of stages) assert.ok(path.basename(stage).startsWith('.hy-stage-'), stage);
  // 事务结束后暂存目录全部清理。
  for (const stage of stages) assert.equal(await exists(stage), null);
});

test('二次中断提示行：只列确实带有备份（old）的暂存目录；无备份不打行', async (t) => {
  const base = await mkdtemp(path.join(tmpdir(), 'hy-interrupt-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const withBackup = path.join(base, '.hy-stage-a'), without = path.join(base, '.hy-stage-b');
  await mkdir(path.join(withBackup, 'old'), { recursive: true });
  await mkdir(without, { recursive: true });
  const line = interruptBackups([without, withBackup]);
  assert.ok(line.includes(withBackup), line);
  assert.ok(!line.includes(without), '没有备份的暂存目录不上提示行');
  assert.equal(interruptBackups([]), null);
  assert.equal(interruptBackups([without]), null);
});

test('RESERVED 下沉进 isSkillName：保留设备名在参数解析与 catalog 契约校验处一致拒绝', async (t) => {
  const f = await fixture(t);
  // install <保留名>：用法错误（exit 2）。
  for (const reserved of ['con', 'nul', 'aux', 'com1', 'lpt9']) {
    const result = await f.run(['install', reserved, '--json']);
    assert.equal(result.code, 2, reserved);
    assert.equal(data(result).error, 'usage');
  }
  // 合法边界不受影响：com10、console 不是保留名。
  assert.equal(isSkillName('com10'), true);
  assert.equal(isSkillName('console'), true);
  // catalog 里出现保留名 skill → invalid_response（语义收紧：安装/目录消费端不再接受保留名）。
  f.state.catalog.push({ id: 'device', name: '设备名', summary: '保留名。', summaryEn: 'Reserved.',
    free: { skill: 'con' }, paid: null, offer: [], prices: {} });
  const result = await f.run(['status', '--json']);
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'invalid_response');
});
