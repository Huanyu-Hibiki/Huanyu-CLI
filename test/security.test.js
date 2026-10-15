import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fixture, TOKEN, EMAIL } from './fixture.js';

const absent = async (file) => await assert.rejects(access(file), { code: 'ENOENT' });
const data = (result) => JSON.parse(result.stdout);

test('保存的令牌只发给签发它的服务器，HY_API 指向别处时不带令牌', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  assert.equal((await f.run(['login', '--token', TOKEN, '--json'])).code, 0);
  assert(f.state.requests.some((request) => request.path === '/api/auth/me' && request.token === TOKEN));
  const result = await f.run(['status', '--json'], { HY_API: other.base });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(data(result).account, null);
  assert(other.state.requests.every((request) => request.token === undefined));
  assert(!result.stdout.includes(TOKEN));
});

test('HY_TOKEN 是用户显式提供的，可以发给 HY_API 指定的服务器', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['status', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(data(result).account.email, EMAIL);
  assert(f.state.requests.some((request) => request.path === '/api/auth/me' && request.token === TOKEN));
});

test('旧配置没有记录服务器时视为默认服务器，不发给 HY_API 指定的其他地址', async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.configFile), { recursive: true });
  await writeFile(f.configFile, JSON.stringify({ token: TOKEN, email: EMAIL }), { mode: 0o600 });
  const result = await f.run(['status', '--json']);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(data(result).account, null);
  assert(f.state.requests.every((request) => request.token === undefined));
});

test('logout 撤销令牌并删除配置；服务端 503 失败仍删配置并警告；HY_TOKEN 仍在环境时警告；坏配置也能登出', async (t) => {
  const f = await fixture(t);
  await f.run(['login', '--token', TOKEN, '--json']);
  let result = await f.run(['logout', '--json']);
  assert.equal(result.code, 0);
  assert.equal(data(result).logged_out, true);
  assert.equal(data(result).revoked, true);
  assert(f.state.revoked.has(TOKEN));
  await absent(f.configFile);

  f.state.revoked.delete(TOKEN);
  await f.run(['login', '--token', TOKEN, '--json']);
  result = await f.run(['logout', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0);
  assert.equal(data(result).revoked, true);
  assert(data(result).warnings.some((warning) => warning.includes('HY_TOKEN 仍在环境里，请取消该环境变量。')));
  await absent(f.configFile);

  f.state.revoked.delete(TOKEN);
  await f.run(['login', '--token', TOKEN, '--json']);
  f.state.logoutFailure = true;
  result = await f.run(['logout', '--json']);
  assert.equal(result.code, 0);
  assert.equal(data(result).revoked, false);
  assert.match(data(result).warnings[0], /未能撤销服务端令牌/);
  await absent(f.configFile);

  f.state.logoutFailure = false;
  await f.run(['login', '--token', TOKEN, '--json']);
  await writeFile(f.configFile, '{broken');
  result = await f.run(['logout', '--json']);
  assert.equal(result.code, 0);
  await absent(f.configFile);
});

test('损坏或形状非法的配置 → configRead 退出码 1，而非静默重置', async (t) => {
  const f = await fixture(t);
  await mkdir(path.dirname(f.configFile), { recursive: true });
  const cases = [
    ['JSON 损坏', '{broken'],
    ['空对象（既无令牌也无待领取记录）', '{}'],
    ['令牌缺邮箱', JSON.stringify({ token: TOKEN })],
    ['邮箱缺令牌', JSON.stringify({ email: EMAIL })],
    ['api 非字符串', JSON.stringify({ token: TOKEN, email: EMAIL, api: 42 })],
    ['待领取记录形状残缺', JSON.stringify({ token: TOKEN, email: EMAIL, pending_device: { device_code: 'x' } })],
  ];
  for (const [name, content] of cases) {
    await writeFile(f.configFile, content);
    const zh = await f.run(['status']);
    assert.equal(zh.code, 1, name);
    assert.equal(zh.stdout, '', name);
    assert.match(zh.stderr, /无法读取配置，请检查 config\.json 和文件权限。/, name);
    const value = data(await f.run(['status', '--json']));
    assert.equal(value.ok, false, name);
    assert.equal(value.error, 'config_read', name);
    // 坏配置必须显式报错，不能被静默重置或删除。
    assert.equal(await readFile(f.configFile, 'utf8'), content, name);
  }
  assert.match((await f.run(['status', '--lang', 'en'])).stderr, /Could not read configuration\. Check config\.json and file permissions\./);
});
