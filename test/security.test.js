import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fixture, TOKEN, TOKEN2, EMAIL } from './fixture.js';
import { configPath } from '../src/config.js';
import { openBrowser } from '../src/browser.js';
import { CliError } from '../src/io.js';
import { withLanguage } from '../src/i18n.js';

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

test('logout 同时撤销环境令牌与本机配置里另一枚令牌，不留半撤销', async (t) => {
  const f = await fixture(t);
  f.state.grants.set(TOKEN2, []);
  await f.run(['login', '--token', TOKEN, '--json']);
  const result = await f.run(['logout', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(result.code, 0);
  assert.equal(data(result).revoked, true);
  assert(f.state.revoked.has(TOKEN));
  assert(f.state.revoked.has(TOKEN2));
  await absent(f.configFile);
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

test('configPath 忽略相对的 XDG_CONFIG_HOME/APPDATA，回落安全默认或显式报错', async () => {
  await withLanguage({ lang: 'zh' }, async () => {
    // POSIX：XDG 规范要求绝对路径，相对值视同未设置并回落 ~/.config。
    assert.equal(configPath({ XDG_CONFIG_HOME: '.', HOME: '/home/tester' }, 'linux'), '/home/tester/.config/huanyu/config.json');
    assert.equal(configPath({ XDG_CONFIG_HOME: 'rel/dir', HOME: '/home/tester' }, 'linux'), '/home/tester/.config/huanyu/config.json');
    assert.equal(configPath({ HOME: '/home/tester' }, 'linux'), '/home/tester/.config/huanyu/config.json');
    assert.equal(configPath({ XDG_CONFIG_HOME: '/abs/cfg', HOME: '/home/tester' }, 'linux'), '/abs/cfg/huanyu/config.json');
    // win32：相对路径的 APPDATA 不可信（凭证可能写进随 cwd 漂移的目录），同样视同未设置。
    assert.equal(configPath({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'win32'), 'C:\\Users\\u\\AppData\\Roaming\\huanyu\\config.json');
    for (const appdata of [undefined, '', 'relative', '.']) {
      assert.throws(() => configPath({ APPDATA: appdata }, 'win32'),
        (error) => error instanceof CliError && error.message === '未设置 APPDATA，无法定位配置文件。', `APPDATA=${appdata}`);
    }
  });
});

test('相对 XDG_CONFIG_HOME 被忽略，登录凭证不落进当前工作目录', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['login', '--token', TOKEN, '--json'], { XDG_CONFIG_HOME: '.' });
  assert.equal(result.code, 0, result.stdout);
  await absent(path.join(f.cwd, 'huanyu', 'config.json'));
  if (process.platform === 'win32') {
    // win32 走 APPDATA，不受 XDG 影响。
    assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')), { token: TOKEN, email: EMAIL, api: f.base });
  } else {
    const fallback = path.join(f.home, '.config', 'huanyu', 'config.json');
    assert.deepEqual(JSON.parse(await readFile(fallback, 'utf8')), { token: TOKEN, email: EMAIL, api: f.base });
    // 回落位置可被后续命令读回，账号功能不受影响。
    assert.equal(data(await f.run(['status', '--json'], { XDG_CONFIG_HOME: '.' })).account.email, EMAIL);
  }
});

test('win32 缺 APPDATA 时读写路径都原样报 missingAppdata（不被转成 configRead/configWrite）', { skip: process.platform !== 'win32' ? 'win32 专属语义' : false }, async (t) => {
  const f = await fixture(t);
  const read = await f.run(['status'], { APPDATA: '' });
  assert.equal(read.code, 1);
  assert.match(read.stderr, /未设置 APPDATA，无法定位配置文件。/);
  const write = await f.run(['login', '--token', TOKEN], { APPDATA: '' });
  assert.equal(write.code, 1);
  assert.match(write.stderr, /未设置 APPDATA，无法定位配置文件。/);
  await absent(f.configFile);
});

test('假浏览器 node.exe 副本惰性准备：不打开浏览器的命令零复制，首次打开时才落盘', async (t) => {
  const f = await fixture(t);
  await f.run(['login', '--token', TOKEN, '--json']);
  await f.run(['status', '--json']);
  await f.run(['logout', '--json']);
  // 上述命令都不触达浏览器：win32 下只有 helper 脚本，POSIX 下只有两个假 open 脚本。
  const idle = (await readdir(f.mockBin)).sort();
  assert.deepEqual(idle, process.platform === 'win32' ? ['browser-helper.cjs'] : ['open', 'xdg-open']);
  // 设备码流程真正打开假浏览器后，副本才出现（大小与 node.exe 一致）。
  await f.run(['login', '--json'], { HY_TEST_BROWSER: 'approve' });
  if (process.platform === 'win32') {
    const copy = await stat(path.join(f.mockBin, 'cmd.exe'));
    assert.equal(copy.size, (await stat(process.execPath)).size);
  } else {
    assert.deepEqual((await readdir(f.mockBin)).sort(), ['open', 'xdg-open']);
  }
});

test('Windows 下 ComSpec 未设置时回落系统目录的 cmd.exe 绝对路径，不搜 PATH', async () => {
  const calls = [];
  const runner = async (command, args, options) => { calls.push({ command, args, url: options.env.HY_BROWSER_URL }); throw new Error('打不开'); };
  const saved = { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR };
  try {
    await withLanguage({ lang: 'zh' }, async () => {
      process.env.ComSpec = '';
      process.env.SystemRoot = 'C:\\Windows';
      delete process.env.WINDIR;
      assert.equal(await openBrowser('https://example.com/x?code=ABC', 'win32', runner, 100), false);
      delete process.env.SystemRoot;
      process.env.WINDIR = 'D:\\WinDir';
      assert.equal(await openBrowser('https://example.com/x?code=ABC', 'win32', runner, 100), false);
      delete process.env.WINDIR;
      assert.equal(await openBrowser('https://example.com/x?code=ABC', 'win32', runner, 100), false);
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  const args = ['/d', '/v:off', '/s', '/c', '"start "" "%HY_BROWSER_URL%""'];
  assert.deepEqual(calls.map((call) => call.command), ['C:\\Windows\\System32\\cmd.exe', 'D:\\WinDir\\System32\\cmd.exe', 'cmd.exe']);
  for (const call of calls) {
    assert.deepEqual(call.args, args);
    assert.equal(call.url, 'https://example.com/x?code=ABC');
  }
});
