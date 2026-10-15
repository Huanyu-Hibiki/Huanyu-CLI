import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, chmod, access } from 'node:fs/promises';
import { fixture, TOKEN, INVALID, EMAIL, configMode } from './fixture.js';

const config = async (f) => JSON.parse(await readFile(f.configFile, 'utf8'));
const events = (result) => {
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '', result.stderr);
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line));
};
// 设备密钥在任何输出（文本 + JSON、stdout + stderr）中完整隐藏，包括键名与前 8 字符。
const noDeviceSecret = (result, secret) => {
  const output = result.stdout + result.stderr;
  assert(!output.includes('device_code'), output);
  assert(!output.includes(secret), output);
  assert(!output.includes(secret.slice(0, 8)), output);
};

test('非交互设备码流程：按 interval 轮询满 60 秒预算后退出 3，待领取记录以 0600 落盘且设备密钥被隐藏', async (t) => {
  const f = await fixture(t);
  f.state.requireApproval = true;
  const result = await f.run(['login']);
  assert.equal(result.code, 3);
  assert.equal(result.signal, null);
  assert.deepEqual(result.trace.delays, Array(12).fill(5000));
  assert.equal(result.trace.delays.reduce((sum, ms) => sum + ms, 0), 60000);
  const saved = await config(f);
  assert.deepEqual(saved, { pending_device: {
    device_code: f.state.deviceCode, user_code: f.state.userCode,
    verification_uri: `${f.base}/device/`, verification_uri_complete: `${f.base}/device/?code=${f.state.userCode}`,
    expires_at: 600000, interval: 5,
  } });
  assert.equal((await stat(f.configFile)).mode & 0o777, configMode);
  assert.match(result.stdout, /没能自动打开浏览器/);
  assert(result.stdout.includes(`请打开：${saved.pending_device.verification_uri_complete}\n授权码：${saved.pending_device.user_code}\n`));
  assert.match(result.stdout, /最长等待 60 秒/);
  assert.equal(result.stderr.trim(), `在浏览器打开 ${saved.pending_device.verification_uri_complete}，确认授权码 ${saved.pending_device.user_code} 后点“允许”，然后再运行一次刚才的命令。`);
  noDeviceSecret(result, saved.pending_device.device_code);

  // pending-only 配置也是合法配置；读取时顺带修正权限。
  await chmod(f.configFile, 0o644);
  const status = await f.run(['status', '--json']);
  assert.equal(status.code, 0);
  assert.equal(JSON.parse(status.stdout).account, null);
  assert.equal((await stat(f.configFile)).mode & 0o777, configMode);
  const retried = await f.run(['login', '--json'], {}, { startTime: 60000 });
  assert.equal(retried.code, 3);
  assert.equal(f.state.deviceRequests, 1);
  const output = events(retried);
  const pending = output.at(-1);
  assert.equal(pending.error, 'authorization_pending');
  assert.equal(pending.next_command, 'npx github:Huanyu-Hibiki/Huanyu-CLI login --json');
  for (const key of ['user_code', 'verification_uri', 'verification_uri_complete', 'expires_at', 'interval']) {
    assert.equal(pending[key], saved.pending_device[key]);
    assert.equal(output[0][key], saved.pending_device[key]);
  }
  assert(output[0].warnings.some((warning) => warning.includes('没能自动打开浏览器')));
  noDeviceSecret(retried, saved.pending_device.device_code);
});

test('设备码轮询 pending→success：假浏览器自动批准后完成登录，令牌落盘并清掉待领取记录', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['login', '--json'], { HY_TEST_BROWSER: 'approve' });
  assert.equal(result.code, 0, result.stdout);
  const output = events(result);
  assert.deepEqual(output.map((event) => event.event), ['device', 'login']);
  assert.equal(output[0].opened, true);
  assert.deepEqual(output[0].warnings, []);
  assert.deepEqual(result.trace.delays, [5000, 5000]);
  assert.deepEqual(await config(f), { token: TOKEN, email: EMAIL, api: f.base });
  assert.equal((await stat(f.configFile)).mode & 0o777, configMode);
  assert(!result.stdout.includes(TOKEN));
});

test('轮询中服务端 5xx 不打断等待，恢复后完成登录', async (t) => {
  const f = await fixture(t);
  f.state.deviceStatuses = ['upstream', 'success'];
  const result = await f.run(['login', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.trace.delays, [5000, 5000]);
  assert.deepEqual(await config(f), { token: TOKEN, email: EMAIL, api: f.base });
});

test('slow_down 后轮询间隔 +5 秒并落盘；错误消息中的设备密钥及其编码形式被完整隐藏', async (t) => {
  const f = await fixture(t);
  f.state.deviceStatuses = ['slow_down', 'authorization_pending'];
  const first = await f.run(['login', '--json']);
  assert.equal(first.code, 3);
  const pending = (await config(f)).pending_device;
  assert.equal(pending.interval, 10);
  assert.equal(events(first).at(-1).interval, 10);
  f.state.deviceStatuses = ['failed'];
  f.state.deviceErrorMessage = `密钥 ${pending.device_code}，编码 ${encodeURIComponent(pending.device_code)}`;
  const second = await f.run(['login', '--json'], {}, { startTime: 65000 });
  assert.equal(second.code, 1);
  assert.deepEqual(second.trace.delays, [10000]);
  assert.equal(f.state.deviceRequests, 1);
  assert(events(second).at(-1).message.includes('[已隐藏]'));
  noDeviceSecret(second, pending.device_code);
});

test('待领取码被拒绝或服务端宣告过期，清掉旧记录并自动换新码一次', async (t) => {
  for (const failure of ['access_denied', 'expired_token']) {
    await t.test(failure, async (t) => {
      const f = await fixture(t);
      f.state.deviceStatuses = ['authorization_pending'];
      assert.equal((await f.run(['login', '--json'])).code, 3);
      const old = (await config(f)).pending_device;
      f.state.deviceStatusesByRequest = [[failure], ['authorization_pending']];
      const offset = f.state.requests.length;
      const result = await f.run(['login', '--json'], {}, { startTime: 60000 });
      assert.equal(result.code, 3);
      assert.equal(f.state.deviceRequests, 2);
      const fresh = (await config(f)).pending_device;
      assert.notEqual(fresh.device_code, old.device_code);
      assert.notEqual(fresh.user_code, old.user_code);
      assert.equal(fresh.expires_at, 665000);
      const requests = f.state.requests.slice(offset).filter((request) => request.path.startsWith('/api/cli/'));
      assert.deepEqual(requests.slice(0, 3).map((request) => request.path), ['/api/cli/token', '/api/cli/device', '/api/cli/token']);
      assert.equal(requests[0].body.device_code, old.device_code);
      assert(requests.slice(2).every((request) => request.body.device_code === fresh.device_code));
      const output = events(result);
      assert.equal(output[0].user_code, old.user_code);
      assert.equal(output[1].user_code, fresh.user_code);
      assert.equal(output.at(-1).user_code, fresh.user_code);
      assert.equal((await stat(f.configFile)).mode & 0o777, configMode);
      noDeviceSecret(result, old.device_code);
      noDeviceSecret(result, fresh.device_code);
    });
  }
});

test('本机待领取记录已到期时直接清掉并申请新码，不轮询旧设备码', async (t) => {
  const f = await fixture(t);
  f.state.deviceStatuses = ['authorization_pending'];
  assert.equal((await f.run(['login', '--json'])).code, 3);
  const old = (await config(f)).pending_device;
  f.state.deviceStatuses = ['success'];
  const offset = f.state.requests.length;
  const result = await f.run(['login', '--json'], {}, { startTime: old.expires_at });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(f.state.deviceRequests, 2);
  const requests = f.state.requests.slice(offset);
  assert.equal(requests[0].path, '/api/cli/device');
  assert(requests.filter((request) => request.path === '/api/cli/token').every((request) => request.body.device_code !== old.device_code));
  assert.deepEqual(await config(f), { token: TOKEN, email: EMAIL, api: f.base });
  noDeviceSecret(result, old.device_code);
  noDeviceSecret(result, f.state.deviceCode);
});

test('交互终端复用待领取码并等满 10 分钟；换新码被拒绝时删除新记录并退出', async (t) => {
  const f = await fixture(t);
  f.state.expiresIn = 3600;
  f.state.deviceStatuses = ['authorization_pending'];
  assert.equal((await f.run(['login', '--json'])).code, 3);
  const pending = (await config(f)).pending_device;
  const result = await f.run(['login'], {}, { interactive: true, startTime: 60000 });
  assert.equal(result.code, 3);
  assert.equal(result.trace.delays.reduce((sum, ms) => sum + ms, 0), 600000);
  assert.equal(f.state.deviceRequests, 1);
  assert.match(result.stdout, /最长等待 10 分钟/);
  assert(result.stdout.includes(`请打开：${pending.verification_uri_complete}\n授权码：${pending.user_code}`));
  assert.deepEqual((await config(f)).pending_device, pending);
  noDeviceSecret(result, pending.device_code);
  // 换新码也被拒绝时应删除新记录并退出，避免无限换码。
  f.state.deviceStatuses = ['access_denied'];
  const denied = await f.run(['login', '--json'], {}, { startTime: pending.expires_at });
  assert.equal(denied.code, 1);
  assert.equal(events(denied).at(-1).error, 'access_denied');
  assert.equal(f.state.deviceRequests, 2);
  await assert.rejects(access(f.configFile), { code: 'ENOENT' });
});

test('换新设备码时自动打开浏览器也受剩余预算限制，非交互总等待不超过 60 秒', async (t) => {
  const f = await fixture(t);
  f.state.interval = 54;
  f.state.deviceStatuses = ['authorization_pending'];
  assert.equal((await f.run(['login', '--json'])).code, 3);
  f.state.deviceStatusesByRequest = [['access_denied'], ['authorization_pending']];
  const result = await f.run(['login', '--json'], {}, { startTime: 60000, browserDelay: 10000 });
  assert.equal(result.code, 3);
  assert.equal(f.state.deviceRequests, 2);
  assert.deepEqual(result.trace.browserTimeouts, [5000, 1000]);
  assert.equal(result.trace.delays.reduce((sum, ms) => sum + ms, 0) + result.trace.browserTimeouts.reduce((sum, ms) => sum + ms, 0), 60000);
  assert.equal(events(result).at(-1).user_code, f.state.userCode);
  assert.equal((await config(f)).pending_device.device_code, f.state.deviceCode);
});

test('第二次运行领取同一设备码：不申请新码，令牌落盘并清掉待领取记录', async (t) => {
  const f = await fixture(t);
  f.state.requireApproval = true;
  const first = await f.run(['login', '--json']);
  assert.equal(first.code, 3);
  const pending = (await config(f)).pending_device;
  // 模拟第一进程退出后，用户才在浏览器里点“允许”。
  const response = await fetch(`${f.base}/api/cli/device/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'hy_session=fake' },
    body: JSON.stringify({ user_code: pending.user_code, approve: true }),
  });
  assert.equal(response.status, 200);
  const second = await f.run(['login', '--json'], {}, { startTime: 90000 });
  assert.equal(second.code, 0, second.stdout);
  const output = events(second);
  assert.deepEqual(output.map((event) => event.event), ['device', 'login']);
  assert.equal(output[0].user_code, pending.user_code);
  assert.equal(output[0].verification_uri_complete, pending.verification_uri_complete);
  assert.equal(f.state.deviceRequests, 1);
  assert(f.state.requests.filter((request) => request.path === '/api/cli/token').every((request) => request.body.device_code === pending.device_code));
  assert.deepEqual(await config(f), { token: TOKEN, email: EMAIL, api: f.base });
  noDeviceSecret(first, pending.device_code);
  noDeviceSecret(second, pending.device_code);
});

test('真实 CLI 在设备码显示后被 SIGKILL，浏览器随后允许，第二进程沿用旧码完成登录', async (t) => {
  const f = await fixture(t);
  f.state.requireApproval = true;
  const first = await f.run(['login'], {}, { real: true, killOnDevice: true });
  assert.equal(first.signal, 'SIGKILL');
  assert.notEqual(first.code, 0);
  assert.equal(f.state.devicePolls, 0);
  const pending = (await config(f)).pending_device;
  assert(pending.expires_at > Date.now());
  assert.equal((await stat(f.configFile)).mode & 0o777, configMode);
  const response = await fetch(`${f.base}/api/cli/device/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'hy_session=fake' },
    body: JSON.stringify({ user_code: pending.user_code, approve: true }),
  });
  assert.equal(response.status, 200);
  const second = await f.run(['login'], {}, { real: true });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(f.state.deviceRequests, 1);
  assert(second.stdout.includes(`授权码：${pending.user_code}`));
  assert.match(second.stdout, /已登录：test@example\.com/);
  assert.deepEqual(await config(f), { token: TOKEN, email: EMAIL, api: f.base });
  noDeviceSecret(first, pending.device_code);
  noDeviceSecret(second, pending.device_code);
});

test('CI 环境拒绝设备码流程并提示 HY_TOKEN（退出码 3）；显式令牌在 CI 仍可用', async (t) => {
  const f = await fixture(t);
  const zh = await f.run(['login'], { CI: 'true' });
  assert.equal(zh.code, 3);
  assert.equal(zh.stdout, '');
  assert.match(zh.stderr, /CI 环境需要设置 HY_TOKEN，或先运行 npx github:Huanyu-Hibiki\/Huanyu-CLI login --token <令牌>。/);
  const en = await f.run(['login', '--lang', 'en'], { CI: 'true' });
  assert.match(en.stderr, /Set HY_TOKEN in CI, or first run npx github:Huanyu-Hibiki\/Huanyu-CLI login --token <access-token>\./);
  const value = JSON.parse((await f.run(['login', '--json'], { CI: 'true' })).stdout);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'unauthorized');
  assert.equal(value.token_environment, 'HY_TOKEN');
  await assert.rejects(access(f.configFile), { code: 'ENOENT' });
  assert.equal((await f.run(['login', '--token', TOKEN], { CI: 'true' })).code, 0);
});

test('login --token 显式令牌非交互登录成功保存；无效令牌退出 3 且不覆盖已有配置', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['login', '--token', TOKEN, '--json']);
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.command, 'login');
  assert.equal(value.event, 'login');
  assert.equal(value.status, 'complete');
  assert.equal(value.token_prefix, `${TOKEN.slice(0, 8)}…`);
  assert.equal(value.email, EMAIL);
  assert.deepEqual(value.warnings, []);
  assert.equal((await stat(f.configFile)).mode & 0o777, configMode);
  assert.deepEqual(await config(f), { token: TOKEN, email: EMAIL, api: f.base });
  assert(!result.stdout.includes(TOKEN));
  const invalid = await f.run(['login', '--token', INVALID]);
  assert.equal(invalid.code, 3);
  assert(!invalid.stderr.includes(INVALID));
  assert(!invalid.stdout.includes(INVALID));
  assert.match(invalid.stderr, /登录已失效，请重新运行 npx github:Huanyu-Hibiki\/Huanyu-CLI login。/);
  assert.deepEqual(await config(f), { token: TOKEN, email: EMAIL, api: f.base });
});

test('--token=<令牌> 等号形式同样登记遮盖：token_prefix 走 secrets 前 8 字符截断，输出完好可解析', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['login', `--token=${TOKEN}`, '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  // 修复前（审查 quality-LOW 实 bug）：tokenValues 误用 argv.slice(8) 切出数组而非 arg.slice(8)
  // 切出令牌值，空数组混入 secrets 令 redact 在每个字符间插入占位，整段输出损坏、JSON 无法解析。
  const value = JSON.parse(result.stdout);
  assert.equal(value.ok, true);
  assert.equal(value.token_prefix, `${TOKEN.slice(0, 8)}…`);
  assert.ok(!result.stdout.includes(TOKEN));
  assert.ok(!result.stderr.includes(TOKEN));
});

test('status 未登录显示占位与开源版提示；登录后显示邮箱与订阅；令牌失效透出 unauthorized', async (t) => {
  const f = await fixture(t);
  const anon = await f.run(['status']);
  assert.equal(anon.code, 0);
  assert.equal(anon.stderr, '');
  assert.equal(anon.stdout, '未发现已安装的商店 Skill。\n尚未登录，开源版可以直接安装。\n');
  assert.deepEqual(JSON.parse((await f.run(['status', '--json'])).stdout), { ok: true, command: 'status', installations: [], warnings: [], account: null });
  assert.equal((await f.run(['login', '--token', TOKEN])).code, 0);
  const value = JSON.parse((await f.run(['status', '--json'])).stdout);
  assert.equal(value.ok, true);
  assert.equal(value.account.email, EMAIL);
  assert.equal(value.account.token_prefix, `${TOKEN.slice(0, 8)}…`);
  assert.deepEqual(value.account.subscriptions, [{ skill: 'ppt-design-pro', name: 'PPT 设计', plan: 'lifetime', status: 'lifetime', renews: null, ends: null }]);
  assert(!JSON.stringify(value).includes(TOKEN));
  const human = await f.run(['status']);
  assert(human.stdout.includes(`账号：${EMAIL}`));
  assert(human.stdout.includes('PPT 设计：已买断，永久更新'));
  // 令牌被服务端撤销后，status 按错误透出语义返回 unauthorized 的退出码。
  f.state.revoked.add(TOKEN);
  const expired = await f.run(['status', '--json']);
  assert.equal(expired.code, 3);
  const failure = JSON.parse(expired.stdout);
  assert.equal(failure.ok, false);
  assert.equal(failure.error, 'unauthorized');
  assert.equal(failure.account, null);
  assert.deepEqual(failure.installations, []);
});
