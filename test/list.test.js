import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { fixture, CATALOG } from './fixture.js';
import { CliError } from '../src/io.js';

const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  return JSON.parse(result.stdout);
};

// 立即关闭的端口：拿一个已释放的临时端口，连接会被立刻拒绝而不是等到超时。
async function closedPort() {
  const server = createTcpServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(() => resolve()));
  return port;
}

test('hy list 展示试点商品：名称、免费/付费标记、买断价、摘要（中英双语；localhost HTTP 假商店可达）', async (t) => {
  const f = await fixture(t);
  const zh = await f.run(['list']);
  assert.equal(zh.code, 0);
  assert.equal(zh.stderr, '');
  assert.equal(zh.stdout, [
    'ppt-design：免费，分步设计演示文稿的结构与版式。',
    'ppt-design-pro：付费（69 元，一次买断，永久更新），分步设计演示文稿的结构与版式。',
    'oracle-bone：免费，识别与释读甲骨文字形。',
  ].join('\n') + '\n');
  const en = await f.run(['list', '--lang', 'en']);
  assert.equal(en.code, 0);
  assert.equal(en.stderr, '');
  assert.equal(en.stdout, [
    'ppt-design: free; Design presentation structure and layouts step by step.',
    'ppt-design-pro: paid (¥69 (CNY), one-time purchase, lifetime updates); Design presentation structure and layouts step by step.',
    'oracle-bone: free; Recognize and read oracle bone script.',
  ].join('\n') + '\n');
  // localhost 的 HTTP 是 HTTPS 强制的显式例外：上面的请求都发到了 127.0.0.1 假商店，且语言随 Accept-Language 协商。
  assert.ok(f.state.requests.some((r) => r.method === 'GET' && r.path === '/api/store/catalog'));
  assert.equal(f.state.requests.at(-1).headers['accept-language'], 'en');
});

test('hy list --json 输出 {ok:true,command:"list",skills:[...]} 结构化形状', async (t) => {
  const f = await fixture(t);
  const value = data(await f.run(['list', '--json']));
  assert.equal(value.ok, true);
  assert.equal(value.command, 'list');
  assert.deepEqual(value.skills.map((s) => s.skill), ['ppt-design', 'ppt-design-pro', 'oracle-bone']);
  const paid = value.skills.find((s) => s.skill === 'ppt-design-pro');
  assert.equal(paid.name, 'PPT 设计');
  assert.equal(paid.type, 'paid');
  assert.equal(paid.summary, '分步设计演示文稿的结构与版式。');
  assert.deepEqual(paid.prices, { lifetime: { amount: 6900, currency: 'cny', interval: null } });
  assert.equal(paid.page, `${f.base}/store/ppt-design-pro/`);
  const free = value.skills.find((s) => s.skill === 'ppt-design');
  assert.equal(free.type, 'free');
  assert.deepEqual(free.prices, {});
  assert.equal(free.page, `${f.base}/store/ppt-design/`);
});

test('catalog 外层三种形状（数组/{products}/{catalog}）都被接受，输出一致；空目录有提示', async (t) => {
  const f = await fixture(t);
  const reference = (await f.run(['list'])).stdout;
  for (const shape of ['array', 'catalog', 'products']) {
    f.state.catalogShape = shape;
    const result = await f.run(['list']);
    assert.equal(result.code, 0, shape);
    assert.equal(result.stdout, reference, shape);
  }
  f.state.catalog = [];
  assert.equal((await f.run(['list'])).stdout, '商店里还没有 Skill。\n');
  assert.equal((await f.run(['list', '--lang', 'en'])).stdout, 'No skills in the store yet.\n');
  assert.deepEqual(data(await f.run(['list', '--json'])).skills, []);
});

test('重复 id、非法 skill 名、缺 free+paid、prices 非对象、无法识别的外层 → invalid_response 退出码 1，双语提示', async (t) => {
  const f = await fixture(t);
  const cases = [
    ['重复 id', (catalog) => { catalog[1].id = catalog[0].id; }, /产品信息不完整或编号重复，请重试。/, /Product details are incomplete or IDs are duplicated\. Please retry\./],
    ['非法 skill 名', (catalog) => { catalog[0].free = '../escape'; }, /Skill 名无效或重复，请重试。/, /Skill names are invalid or duplicated\. Please retry\./],
    ['缺 free+paid', (catalog) => { catalog[0].free = null; catalog[0].paid = null; }, /产品缺少 Skill 名，请重试。/, /A product is missing its skill name\. Please retry\./],
    ['prices 非对象', (catalog) => { catalog[0].prices = 6900; }, /价格信息无法读取，请重试。/, /Could not read prices\. Please retry\./],
  ];
  for (const [name, inject, zhText, enText] of cases) {
    f.state.catalog = structuredClone(CATALOG);
    inject(f.state.catalog);
    const zh = await f.run(['list']);
    assert.equal(zh.code, 1, name);
    assert.equal(zh.stdout, '', name);
    assert.match(zh.stderr, zhText);
    const en = await f.run(['list', '--lang', 'en']);
    assert.equal(en.code, 1, name);
    assert.match(en.stderr, enText);
    const value = data(await f.run(['list', '--json']));
    assert.equal(value.ok, false);
    assert.equal(value.error, 'invalid_response');
    assert.equal(value.command, 'list');
  }
  f.state.catalogShape = 'none';
  const outer = await f.run(['list']);
  assert.equal(outer.code, 1);
  assert.match(outer.stderr, /Skill 列表不完整，请重试。/);
  assert.match((await f.run(['list', '--lang', 'en'])).stderr, /The skill list is incomplete\. Please retry\./);
});

test('HY_API 非 HTTPS 远程地址 → 退出码 2 invalid_api，且在任何请求发出前被拒绝', async (t) => {
  const f = await fixture(t);
  const remote = await f.run(['list'], { HY_API: 'http://example.com' });
  assert.equal(remote.code, 2);
  assert.equal(remote.stdout, '');
  assert.match(remote.stderr, /HY_API 必须使用 HTTPS（本机地址除外）。/);
  assert.match((await f.run(['list', '--lang', 'en'], { HY_API: 'http://example.com' })).stderr, /HY_API must use HTTPS, except for localhost\./);
  const value = data(await f.run(['list', '--json'], { HY_API: 'http://example.com' }));
  assert.equal(value.ok, false);
  assert.equal(value.error, 'invalid_api');
  // invalid_api 在 fetch 之前抛出：地址指向假商店但带禁止的 userinfo，fixture 不应收到任何请求。
  const port = new URL(f.base).port;
  const before = f.state.requests.length;
  const userinfo = await f.run(['list'], { HY_API: `http://user@127.0.0.1:${port}` });
  assert.equal(userinfo.code, 2);
  assert.match(userinfo.stderr, /HY_API 必须是 HTTP 或 HTTPS 基础地址。/);
  assert.equal(f.state.requests.length, before);
});

test('网络不可达 → network 错误退出码 1，双语提示', async (t) => {
  const f = await fixture(t);
  const address = { HY_API: `http://127.0.0.1:${await closedPort()}` };
  const zh = await f.run(['list'], address);
  assert.equal(zh.code, 1);
  assert.equal(zh.stdout, '');
  assert.match(zh.stderr, /请求失败，请检查网络或 HY_API。/);
  assert.match((await f.run(['list', '--lang', 'en'], address)).stderr, /Request failed\. Check your network or HY_API\./);
  const value = data(await f.run(['list', '--json'], address));
  assert.equal(value.ok, false);
  assert.equal(value.error, 'network');
});

test('versions 逐 skill 校验 latest semver 与 history 数组，非法 → invalid_response', async (t) => {
  const f = await fixture(t);
  const { Client, catalogNames } = await import('../src/client.js');
  const previous = process.env.HY_API;
  process.env.HY_API = f.base;
  try {
    const client = new Client();
    const catalog = await client.catalog();
    assert.deepEqual(catalogNames(catalog), ['ppt-design', 'ppt-design-pro', 'oracle-bone']);
    const versions = await client.versions(catalog);
    assert.equal(versions['ppt-design'].latest, '0.1.0');
    assert.ok(Array.isArray(versions['oracle-bone'].history));
    f.state.badVersions = true;
    await assert.rejects(() => client.versions(catalog), (error) => error instanceof CliError && error.code === 1 && error.error === 'invalid_response');
  } finally {
    process.env.HY_API = previous;
  }
});
