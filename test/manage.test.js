import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, TOKEN } from './fixture.js';

// 二期任务 3（安全敏感：认证·付费下载）：hy manage 打开账号管理门户。
// 契约见设计「接口设计」：POST /api/account/portal 🔒 → { url }，浏览器打开失败时给可复制链接。

const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};
const events = (result) => result.stdout.trim().split('\n').map((line) => JSON.parse(line));
const portalRequests = (f) => f.state.requests.filter((request) => request.path === '/api/account/portal');

test('manage 已登录：POST portal 带 Bearer，假浏览器打开门户 URL（双语）', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['manage'], { HY_TOKEN: TOKEN, HY_TEST_BROWSER: 'approve' });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `已打开购买管理：${f.base}/account/\n`);
  assert.deepEqual(portalRequests(f).map((request) => [request.method, request.token]), [['POST', TOKEN]]);
  const value = data(await f.run(['manage', '--json'], { HY_TOKEN: TOKEN, HY_TEST_BROWSER: 'approve' }));
  assert.deepEqual(value, { ok: true, command: 'manage', url: `${f.base}/account/`, opened: true });
  const english = await f.run(['manage', '--lang', 'en'], { HY_TOKEN: TOKEN, HY_TEST_BROWSER: 'approve' });
  assert.equal(english.code, 0);
  assert.match(english.stdout, /Purchase management opened: /);
});

test('manage 浏览器打不开：opened:false 并给可复制链接；portalUrl 注入位透传服务端 URL', async (t) => {
  const f = await fixture(t);
  f.state.portalUrl = `${f.base}/account/session/abc123?from=cli`;
  // 默认假浏览器退出 1（HY_TEST_BROWSER 空），模拟系统打不开浏览器。
  const result = await f.run(['manage'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(result.stdout, `无法打开浏览器，请打开：${f.state.portalUrl}\n`);
  const value = data(await f.run(['manage', '--json'], { HY_TOKEN: TOKEN }));
  assert.deepEqual(value, { ok: true, command: 'manage', url: f.state.portalUrl, opened: false });
  const english = await f.run(['manage', '--lang', 'en'], { HY_TOKEN: TOKEN });
  assert.match(english.stdout, /Could not open the browser\. Open: /);
});

test('manage 未登录：不请求 portal，走设备码登录引导 exit 3 authorization_pending', async (t) => {
  const f = await fixture(t);
  f.state.requireApproval = true;
  const result = await f.run(['manage', '--json'], {}, { browserDelay: 100 });
  assert.equal(result.code, 3);
  const pending = events(result).at(-1);
  assert.equal(pending.error, 'authorization_pending');
  assert.equal(pending.next_command, 'npx github:Huanyu-Hibiki/Huanyu-CLI manage --json');
  assert.equal(portalRequests(f).length, 0, '登录完成前不应请求门户');
});

test('manage 令牌失效：portal 401 → exit 3 unauthorized 重新登录引导', async (t) => {
  const f = await fixture(t);
  f.state.revoked.add(TOKEN);
  const result = await f.run(['manage', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 3);
  const value = data(result);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'unauthorized');
  assert.match(value.message, /登录已失效，请重新运行 npx github:Huanyu-Hibiki\/Huanyu-CLI login。/);
});

test('manage 门户响应缺 url：invalid_response 拒绝，不打开浏览器', async (t) => {
  const f = await fixture(t);
  f.state.portalUrl = '';
  const result = await f.run(['manage', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 1);
  const value = data(result);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'invalid_response');
});

test('portal 恶意 URL（security-L4）：file:// 与带凭据 URL → invalid_response，绝不打开浏览器', async (t) => {
  const f = await fixture(t);
  for (const url of ['file:///C:/Windows/system32/config', 'http://user:secret@127.0.0.1/account/']) {
    f.state.portalUrl = url;
    const result = await f.run(['manage', '--json'], { HY_TOKEN: TOKEN });
    assert.equal(result.code, 1, url);
    const value = data(result);
    assert.equal(value.ok, false, url);
    // openBrowser 在 spawn 之前做协议/凭据校验，拒绝即证明没有浏览器进程被拉起。
    assert.equal(value.error, 'invalid_response', url);
    assert.equal('opened' in value, false, '不应走到打开结果输出');
    assert.equal('url' in value, false, '恶意 URL 不应透传到输出');
    assert.ok(!result.stdout.includes(url) && !result.stderr.includes(url), '恶意 URL 不出现在输出里');
  }
});
