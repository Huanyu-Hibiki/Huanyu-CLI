import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fixture, writeSkill } from './fixture.js';
import { HOSTS, targetRoot } from '../src/hosts.js';
import { command } from '../src/i18n.js';

const exec = promisify(execFile);
const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};
// fixture 的环境把 HOME/USERPROFILE/XDG_CONFIG_HOME 都指进临时目录；宿主根按同一份数据解析。
const userRoot = (f, id) => targetRoot(id, f.env);

test('九宿主自动发现：用户级目录全部上报，项目级目录不进默认扫描', async (t) => {
  const f = await fixture(t);
  const roots = HOSTS.map((host) => userRoot(f, host.id));
  assert.equal(roots.length, 9);
  assert.deepEqual(HOSTS.map((host) => host.id), ['zcode', 'agents', 'claude', 'codex', 'cursor', 'opencode', 'trae', 'qwenwork', 'workbuddy']);
  // opencode 实测数据：全局根在 XDG 配置目录（fixture 隔离为 f.config）下的 opencode/skill。
  assert.equal(userRoot(f, 'opencode'), path.join(f.config, 'opencode', 'skill'));
  for (const root of roots) await writeSkill(root, 'ppt-design', '0.1.0');
  // 项目级目录有意不扫：写了也不出现在结果里。
  await writeSkill(path.join(f.cwd, '.claude', 'skills'), 'oracle-bone', '0.1.0');
  const result = await f.run(['status', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.equal(value.account, null);
  assert.equal(value.installations.length, 9);
  assert.deepEqual(value.installations.map((item) => item.path), roots.map((root) => path.join(root, 'ppt-design')));
  assert.ok(value.installations.every((item) => item.current === '0.1.0' && item.latest === '0.1.0' && !item.development && !item.update_available && item.updates.length === 0));
  assert.ok(!value.installations.some((item) => item.name === 'oracle-bone'));
  // 九个用户级宿主里的独立副本同时构成多副本警告。
  assert.equal(value.warnings.length, 1);
  assert.ok(value.warnings[0].startsWith('ppt-design 在本机有 9 份独立副本'));
  const human = await f.run(['status']);
  assert.match(human.stdout, /ppt-design：0\.1\.0（最新版）\n位置：/);
  assert.ok(human.stdout.endsWith('尚未登录，开源版可以直接安装。\n'));
});

test('同一安装经链接宿主目录只报一次；含 .git 的开发目录标记 development 并跳过', async (t) => {
  const f = await fixture(t);
  const zcode = path.join(f.home, '.zcode', 'skills');
  const real = await writeSkill(zcode, 'ppt-design', '0.1.0');
  // .claude/skills 整体链到 .zcode/skills（Windows 用 junction 免管理员权限）：同一安装经两条路径只报一次。
  await mkdir(path.join(f.home, '.claude'));
  await symlink(zcode, path.join(f.home, '.claude', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  const development = await writeSkill(path.join(f.home, '.trae', 'skills'), 'oracle-bone', '0.1.0');
  await mkdir(path.join(development, '.git'));
  const result = await f.run(['status', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  const copies = value.installations.filter((item) => item.name === 'ppt-design');
  assert.equal(copies.length, 1);
  assert.equal(copies[0].path, real);
  assert.equal(copies[0].real_path, real);
  const dev = value.installations.find((item) => item.name === 'oracle-bone');
  assert.equal(dev.path, development);
  assert.equal(dev.development, true);
  assert.equal(dev.update_available, false);
  assert.deepEqual(value.warnings, []);
  const human = await f.run(['status']);
  assert.match(human.stdout, /oracle-bone：0\.1\.0（开发目录，跳过）\n位置：/);
});

test('8.3 短路径 HOME 与链接宿主一起扫到的安装只报一次', { skip: process.platform !== 'win32' }, async (t) => {
  const f = await fixture(t);
  const zcode = path.join(f.home, '.zcode', 'skills');
  await writeSkill(zcode, 'ppt-design', '0.1.0');
  await mkdir(path.join(f.home, '.agents'));
  await symlink(zcode, path.join(f.home, '.agents', 'skills'), 'junction');
  const result = await exec(process.env.ComSpec || 'cmd.exe', ['/d', '/v:off', '/s', '/c', '"for %I in ("%OIL_TEST_HOME%") do @echo %~sI"'], {
    windowsVerbatimArguments: true, windowsHide: true, timeout: 5000, env: { ...process.env, OIL_TEST_HOME: f.home },
  });
  const shortHome = result.stdout.trim();
  // 8.3 名称生成被禁用的机器上拿不到短路径，跳过而不是误报。
  if (!shortHome || path.resolve(shortHome).toLowerCase() === path.resolve(f.home).toLowerCase()) return;
  const status = await f.run(['status', '--json'], { HOME: shortHome, USERPROFILE: shortHome });
  assert.equal(status.code, 0, status.stdout + status.stderr);
  const copies = data(status).installations.filter((item) => item.name === 'ppt-design');
  assert.equal(copies.length, 1);
  assert.equal(copies[0].path, path.join(shortHome, '.zcode', 'skills', 'ppt-design'));
  assert.equal(copies[0].real_path.toLowerCase(), path.join(zcode, 'ppt-design').toLowerCase());
});

test('本地落后显示可更新与更新说明；本地更新未发布时不提示', async (t) => {
  const f = await fixture(t);
  f.state.latest = '0.11.0';
  f.state.history = [{ version: '0.9.0' }, { version: '0.11.0', notes: '修复了版式问题。' }];
  await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.10.0');
  const result = await f.run(['status']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ppt-design：0\.10\.0 → 0\.11\.0（可更新）\n位置：/);
  assert.match(result.stdout, /0\.11\.0 更新说明：\n修复了版式问题。/);
  assert.doesNotMatch(result.stdout, /0\.9\.0 更新说明/);
  const value = data(await f.run(['status', '--json']));
  assert.equal(value.installations[0].update_available, true);
  assert.deepEqual(value.installations[0].updates, [{ version: '0.11.0', published_at: '2026-10-15T08:00:00Z', notes: '修复了版式问题。' }]);
  const english = await f.run(['status', '--lang', 'en']);
  assert.match(english.stdout, /ppt-design: 0\.10\.0 → 0\.11\.0 \(update available\)/);
  assert.match(english.stdout, /0\.11\.0 release notes:/);
});

test('本地版本高于 latest 时标记 versionNewer，不算可更新', async (t) => {
  const f = await fixture(t);
  await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.12.0');
  const result = await f.run(['status']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /ppt-design：0\.12\.0（高于最新发布的版本 0\.1\.0）\n位置：/);
  const value = data(await f.run(['status', '--json']));
  assert.equal(value.installations[0].update_available, false);
});

test('同宿主同时装了免费与付费配对 → 冲突警告；分宿主安装不警告', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.claude', 'skills');
  await writeSkill(root, 'ppt-design', '0.1.0');
  await writeSkill(root, 'ppt-design-pro', '0.1.0');
  const result = await f.run(['status']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`${root}: ppt-design 和 ppt-design-pro 两个版本同时装会抢着接同一类请求`));
  const value = data(await f.run(['status', '--json']));
  assert.deepEqual(value.warnings, [`${root}: ppt-design 和 ppt-design-pro 两个版本同时装会抢着接同一类请求`]);
  // 免费与付费分处不同宿主：同一商品不算冲突。
  const other = await fixture(t);
  await writeSkill(path.join(other.home, '.zcode', 'skills'), 'ppt-design', '0.1.0');
  await writeSkill(path.join(other.home, '.claude', 'skills'), 'ppt-design-pro', '0.1.0');
  const apart = await other.run(['status', '--json']);
  assert.equal(apart.code, 0, apart.stdout + apart.stderr);
  assert.deepEqual(data(apart).warnings, []);
});

test('多副本警告：同名 skill 在多个用户级宿主有独立副本，附建议命令', async (t) => {
  const f = await fixture(t);
  const first = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'oracle-bone', '0.1.0');
  const second = await writeSkill(path.join(f.home, '.claude', 'skills'), 'oracle-bone', '0.1.0');
  const expected = `oracle-bone 在本机有 2 份独立副本，更新时容易漏掉。运行 ${command('install', 'oracle-bone')} 合并成一份，其余 Agent 改用链接。`;
  const result = await f.run(['status']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(expected));
  const value = data(await f.run(['status', '--json']));
  assert.deepEqual(value.warnings, [expected]);
  assert.deepEqual(value.installations.map((item) => item.path), [first, second]);
});

test('history 截断：history≥20 且本地版早于最早可得版时警告', async (t) => {
  const f = await fixture(t);
  f.state.history = Array.from({ length: 22 }, (_, i) => `0.0.${22 - i}`);
  const installed = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.0');
  const value = data(await f.run(['status', '--json']));
  assert.deepEqual(value.warnings, [`${installed}：只能查看最近 20 条更新说明，可能缺少更早版本。`]);
  assert.equal(value.installations[0].update_available, true);
});

test('无安装时输出 noInstallations，宿主目录存在但为空也一样', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.home, '.zcode', 'skills'), { recursive: true });
  const result = await f.run(['status']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, '未发现已安装的商店 Skill。\n尚未登录，开源版可以直接安装。\n');
  const value = data(await f.run(['status', '--json']));
  assert.deepEqual(value.installations, []);
  assert.deepEqual(value.warnings, []);
});
