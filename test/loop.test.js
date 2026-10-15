import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { fixture, writeSkill, TOKEN, readDirectoryLink } from './fixture.js';

const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};

// 任务 7 闭环集成（计划「任务 7」验收 3）：本地目录 → hy publish 上传 → versions 反映 →
// hy install 装回 ≥3 宿主（一份实体 + 链接共享）→ hy status 报告链接关系，包内容与发布源一致。
test('发布→安装全链路：publish 的包经 download 端点装回宿主矩阵，status 复核一份实体 + 链接', async (t) => {
  const f = await fixture(t);
  // 商店目录登记新商品：publish 不要求目录已有条目，install 消费端按目录找 skill。
  f.state.catalog.push({ id: 'loop-demo', name: '闭环演示', summary: '闭环验证。', summaryEn: 'Loop verification.',
    free: { skill: 'loop-demo' }, paid: null, offer: [], prices: {} });
  // 本地源目录（非 fixture 种子发布物），版本高于种子的 0.1.0。
  const source = await writeSkill(f.cwd, 'loop-demo', '0.2.0');
  // 1) publish：上传的是本地目录打出的包。
  const published = data(await f.run(['publish', 'loop-demo', '--json'], { HY_TOKEN: TOKEN }));
  assert.equal(published.ok, true);
  assert.equal(published.skill, 'loop-demo');
  assert.equal(published.version, '0.2.0');
  assert.ok(f.state.requests.some((r) => r.path === '/api/store/publish' && r.token === TOKEN));
  // 2) versions 反映：latest 提升为 0.2.0、history 追加、摘要来自上传内容。
  const versions = (await (await fetch(`${f.base}/api/store/versions`)).json()).skills['loop-demo'];
  assert.equal(versions.latest, '0.2.0');
  assert.equal(versions.sha256, published.sha256);
  assert.ok(versions.history.some((entry) => entry.version === '0.2.0'));
  // 3) install 装回 ≥3 宿主：zcode 放实体，claude/trae 链接共享。
  for (const host of ['.zcode', '.claude', '.trae']) await mkdir(path.join(f.home, host), { recursive: true });
  const install = data(await f.run(['install', 'loop-demo', '--json']));
  assert.equal(install.ok, true);
  const primary = path.join(f.home, '.zcode', 'skills', 'loop-demo');
  assert.deepEqual(install.installations, [{ name: 'loop-demo', path: primary, previous: null, version: '0.2.0' }]);
  assert.equal(install.links.length, 2);
  assert.ok(install.links.every((item) => item.target === primary && item.existing === false));
  // 下载走发布端上传的同一份发布物（302 → 公开附件，全程不带令牌）。
  const download = f.state.requests.find((r) => r.path === '/api/store/download/loop-demo');
  const release = f.state.requests.find((r) => r.path === '/releases/loop-demo-0.2.0.tar.gz');
  assert.ok(download, '应请求下载端点');
  assert.equal(download.query.get('version'), '0.2.0');
  assert.ok(release, '应跟随 302 到公开附件');
  assert.equal(download.token, undefined);
  assert.equal(release.token, undefined);
  // 4) status：一份实体（canonical real_path）+ 各宿主链接正确指向 + 无 duplicateCopies 警告。
  const status = data(await f.run(['status', '--json']));
  assert.equal(status.installations.length, 1);
  assert.equal(status.installations[0].name, 'loop-demo');
  assert.equal(status.installations[0].path, primary);
  assert.equal(status.installations[0].real_path, await realpath(primary));
  assert.equal(status.installations[0].current, '0.2.0');
  assert.equal(status.installations[0].update_available, false);
  assert.deepEqual(status.warnings, []);
  for (const host of ['.claude', '.trae']) {
    const link = path.join(f.home, host, 'skills', 'loop-demo');
    assert.ok((await lstat(link)).isSymbolicLink(), `${link} 应为目录链接`);
    assert.equal(await readDirectoryLink(link), primary);
  }
  // 5) 装回内容与发布源一致：SKILL.md 与 assets 逐字节相同。
  assert.equal(await readFile(path.join(primary, 'SKILL.md'), 'utf8'), await readFile(path.join(source, 'SKILL.md'), 'utf8'));
  assert.equal(await readFile(path.join(primary, 'assets', 'example.txt'), 'utf8'), await readFile(path.join(source, 'assets', 'example.txt'), 'utf8'));
});

// 幂等回路：再次安装同一版本，实体替换、链接 existing，商店侧 versions 不变。
test('闭环幂等：第二次安装同版本 → 实体替换、链接 existing 保持，versions 无新版本', async (t) => {
  const f = await fixture(t);
  f.state.catalog.push({ id: 'loop-demo', name: '闭环演示', summary: '闭环验证。', summaryEn: 'Loop verification.',
    free: { skill: 'loop-demo' }, paid: null, offer: [], prices: {} });
  await writeSkill(f.cwd, 'loop-demo', '0.2.0');
  assert.equal((await f.run(['publish', 'loop-demo', '--json'], { HY_TOKEN: TOKEN })).code, 0);
  for (const host of ['.zcode', '.claude', '.trae']) await mkdir(path.join(f.home, host), { recursive: true });
  const primary = path.join(f.home, '.zcode', 'skills', 'loop-demo');
  assert.equal((await f.run(['install', 'loop-demo', '--json'])).code, 0);
  const second = await f.run(['install', 'loop-demo', '--json']);
  assert.equal(second.code, 0, second.stdout + second.stderr);
  const value = data(second);
  assert.deepEqual(value.installations, [{ name: 'loop-demo', path: primary, previous: '0.2.0', version: '0.2.0' }]);
  assert.deepEqual(value.links, ['.claude', '.trae'].map((host) => ({ name: 'loop-demo', path: path.join(f.home, host, 'skills', 'loop-demo'), target: primary, existing: true })));
  const publishCount = f.state.requests.filter((r) => r.path === '/api/store/publish').length;
  assert.equal(publishCount, 1, '幂等回路不应再次发布');
});
