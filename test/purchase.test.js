import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fixture, writeSkill, readDirectoryLink, TOKEN, TOKEN2, EMAIL, configMode } from './fixture.js';
import { command, withLanguage } from '../src/i18n.js';
import { isPendingCheckout, readPendingCheckout } from '../src/config.js';
import { requirePurchase } from '../src/purchase.js';
import { CliError } from '../src/io.js';

// 二期任务 4（安全敏感：支付·密钥）：hy subscribe 的 checkout 会话状态机。
// 契约见设计「接口设计」/api/store/checkout(+status) 与「错误处理」：会话先落盘再开浏览器、
// 可跨进程恢复（重跑不重复收费、不重复建会话）、已付未确认重跑等确认、超时 exit 3 带付款 URL
// 与原命令。TOKEN2 经 grants 注册为「已登录、未购买」令牌（fixture 的 inactive 注入位）。

const events = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line));
};
const totalWait = (result) => result.trace.delays.reduce((sum, ms) => sum + ms, 0);
const inactive = (f) => f.state.grants.set(TOKEN2, []);
// 种子发布物只覆盖免费 skill：付费版要先经 publish 落进商店，购买后的接续安装才有内容可下载。
const publishPaid = async (f, version = '0.2.0') => {
  await writeSkill(f.cwd, 'ppt-design-pro', version);
  const result = await f.run(['publish', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
};
const threeHosts = async (f) => {
  for (const host of ['.zcode', '.claude', '.trae']) await mkdir(path.join(f.home, host), { recursive: true });
};
// 进程内直连单元用：把配置目录指到本测试私有目录（APPDATA/XDG 双通道），并摘掉 CI 真值
// （requirePurchase 的 CI 分支会跳过会话创建）。结束恢复环境并清理。
const withIsolatedConfig = async (fn) => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'hy-purchase-unit-'));
  const names = ['APPDATA', 'XDG_CONFIG_HOME', 'CI'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.APPDATA = scratch;
  process.env.XDG_CONFIG_HOME = scratch;
  delete process.env.CI;
  try { return await fn(path.join(scratch, 'huanyu', 'config.json')); }
  finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(scratch, { recursive: true, force: true });
  }
};

test('同一条 subscribe 命令：登录 → 创建付款会话（落盘）→ 浏览器付款页 → 3 秒轮询解锁 → 自动安装（多宿主链接共享）', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  await threeHosts(f);
  f.state.requireApproval = true;
  f.state.deviceToken = TOKEN2;
  inactive(f);
  const result = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TEST_BROWSER: 'approve' });
  assert.equal(result.code, 0, result.stdout);
  const output = events(result);
  assert.deepEqual(output.map((event) => event.event), ['device', 'login', 'checkout', 'subscribed', undefined]);
  // 付款事件：会话形状（契约 { id, url, reused, amount, currency }）、非交互 60 秒预算、真实打开了浏览器。
  const checkout = output[2];
  assert.equal(checkout.id, 'cs_test_1');
  assert.equal(checkout.url, `${f.base}/checkout?session=1`);
  assert.equal(checkout.opened, true);
  assert.deepEqual(checkout.warnings, []);
  assert.equal(checkout.reused, false);
  assert.equal(checkout.resumed, false);
  assert.equal(checkout.max_wait_seconds, 60);
  assert.equal(checkout.plan, 'lifetime');
  assert.equal(checkout.amount, 6900);
  assert.equal(checkout.currency, 'cny');
  assert.equal(checkout.purchase_type, 'one_time');
  assert.deepEqual(output[3].subscription, { skill: 'ppt-design-pro', name: 'PPT 设计', plan: 'lifetime', status: 'lifetime', renews: null, ends: null });
  // 浏览器先开授权页、再开付款页；轮询节奏 = 设备 5 秒 + 付款 3 秒×2，全程无终端提问。
  assert.deepEqual(result.trace.browserUrls, [output[0].verification_uri_complete, checkout.url]);
  assert.deepEqual(result.trace.delays, [5000, 3000, 3000]);
  assert.equal(result.trace.questions.length, 0);
  assert.equal(f.state.checkoutPolls, 2);
  assert.equal(f.state.checkoutRequests, 1);
  const created = f.state.requests.find((r) => r.path === '/api/store/checkout');
  assert.deepEqual(created.body, { skill: 'ppt-design-pro' });
  assert.equal(created.token, TOKEN2);
  assert.ok(f.state.requests.every((r) => !r.query.has('token')), '令牌不得进 URL 查询串');
  assert.ok(!result.stdout.includes(TOKEN2), '令牌不进输出');
  assert.ok(!result.stdout.includes('device_secret_0123456789'), '设备密钥不进输出');
  // 购买完成后清掉付款会话，只留登录凭据。
  assert.deepEqual(JSON.parse(await readFile(f.configFile, 'utf8')), { token: TOKEN2, email: EMAIL, api: f.base });
  // 接续安装：zcode 放实体，claude/trae 链接共享同一份（验收「多宿主链接共享」）。
  const primary = path.join(f.home, '.zcode', 'skills', 'ppt-design-pro');
  const installed = output.at(-1);
  assert.equal(installed.auto_confirmed, true, '非交互接续安装沿用 auto_confirmed 警示');
  assert.deepEqual(installed.installations, [{ name: 'ppt-design-pro', path: primary, previous: null, version: '0.2.0' }]);
  assert.equal(installed.links.length, 2);
  assert.ok(installed.links.every((item) => item.target === primary));
  for (const host of ['.claude', '.trae']) {
    assert.equal(await readDirectoryLink(path.join(f.home, host, 'skills', 'ppt-design-pro')), primary, host);
  }
  assert.match(await readFile(path.join(primary, 'SKILL.md'), 'utf8'), /version: "0\.2\.0"/);
});

test('付款页一出现即 SIGKILL：会话已先行落盘，第二进程沿用同一会话不重复创建，付款后完成安装', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  await threeHosts(f);
  inactive(f);
  f.state.checkoutActiveAfter = Infinity;
  const first = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 }, { killOnCheckout: true });
  assert.equal(first.signal, 'SIGKILL');
  assert.ok(first.stdout.includes('"event":"checkout"'), '应在输出付款事件后才被杀死');
  const saved = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.equal(saved.token, undefined, '环境令牌不写进配置');
  assert.equal(saved.pending_checkout.id, 'cs_test_1');
  assert.equal(saved.pending_checkout.url, `${f.base}/checkout?session=1`);
  assert.equal(saved.pending_checkout.skill, 'ppt-design-pro');
  assert.equal(saved.pending_checkout.plan, 'lifetime');
  assert.equal(saved.pending_checkout.api, f.base);
  assert.match(saved.pending_checkout.token_hash, /^[a-f0-9]{64}$/, '只存令牌摘要，不存明文');
  // 第二进程：恢复会话（不新建），轮询解锁后接续安装。
  f.state.checkoutActiveAfter = 2;
  const second = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(second.code, 0, second.stdout);
  const output = events(second);
  assert.deepEqual(output.map((event) => event.event), ['checkout', 'subscribed', undefined]);
  assert.equal(output[0].id, 'cs_test_1');
  assert.equal(output[0].resumed, true);
  assert.equal(output[0].reused, true);
  assert.equal(f.state.checkoutRequests, 2);
  assert.equal(f.state.checkoutCreated, 1, '恢复语义：不得创建第二个会话');
  assert.equal(output.at(-1).installations[0].name, 'ppt-design-pro');
});

test('已付未确认（processing）：超时报「确认中」文案，重跑不再建会话，确认后直接安装', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  await mkdir(path.join(f.home, '.zcode', 'skills'), { recursive: true });
  inactive(f);
  f.state.checkoutStatusActiveAfter = 1; // 首次状态查询即“已付款”
  f.state.checkoutActiveAfter = Infinity; // me 轮询不解锁：履约完全由 status 端点的 fulfillment 门控
  f.state.fulfillmentPending = true;    // 但履约未生效：entitled 仍为 false
  f.state.meSubscriptions = [];         // me 侧也尚未列出授权
  const first = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(first.code, 3);
  const [checkout, pending] = events(first);
  assert.equal(pending.error, 'payment_pending');
  assert.equal(pending.message, '付款结果还在确认中，稍后再运行一次刚才的命令。重新运行不会重复收费。');
  const saved = JSON.parse(await readFile(f.configFile, 'utf8')).pending_checkout;
  assert.equal(saved.id, checkout.id);
  assert.equal(saved.amount, 6900);
  assert.equal(saved.currency, 'cny');
  // 履约仍挂起时重跑：沿用确认中的会话（不再建会话、不再开浏览器），继续等确认后仍超时。
  const second = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(second.code, 3);
  const [resumed] = events(second);
  assert.equal(resumed.id, checkout.id);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.opened, false, '已付款等待确认时不再打开浏览器');
  assert.deepEqual(resumed.warnings, []);
  assert.equal(events(second).at(-1).message, '付款结果还在确认中，稍后再运行一次刚才的命令。重新运行不会重复收费。');
  assert.equal(f.state.checkoutRequests, 1, '确认中的会话不得重复创建');
  // 履约生效后重跑：状态查询即确认已解锁，直接接续安装（不再输出付款事件）。
  f.state.fulfillmentPending = false;
  f.state.meSubscriptions = null;
  const third = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(third.code, 0, third.stdout);
  const output = events(third);
  assert.deepEqual(output.map((event) => event.event), [undefined]);
  assert.equal(output[0].installations[0].name, 'ppt-design-pro');
});

test('checkout 409 already_active 当作已购：subscribed 带 already_active，me 未列授权也直接接续安装', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  await threeHosts(f);
  inactive(f);
  f.state.checkoutAlreadyActive = true;
  f.state.meSubscriptions = [];
  const result = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(result.code, 0, result.stdout);
  const output = events(result);
  assert.deepEqual(output.map((event) => event.event), ['subscribed', undefined]);
  assert.equal(output[0].already_active, true);
  assert.equal(output[0].subscription, undefined);
  assert.equal(output.at(-1).installations[0].name, 'ppt-design-pro');
  // 本进程已确认购买（unlockedSkills）：接续安装不再复查 me（publish 的 publisher 前置用的是 TOKEN，另计）。
  assert.equal(f.state.requests.filter((r) => r.path === '/api/auth/me' && r.token === TOKEN2).length, 1);
  assert.equal(f.state.checkoutRequests, 1);
  assert.deepEqual(result.trace.browserUrls, []);
  assert.deepEqual(result.trace.delays, []);
});

test('恢复时发现会话已过期未付：清除本地记录换新会话，不沿用旧付款页', async (t) => {
  const f = await fixture(t);
  inactive(f);
  f.state.checkoutActiveAfter = Infinity;
  const first = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(first.code, 3);
  const [checkout] = events(first);
  // 模拟服务端把会话置为过期（未付）。
  f.state.sessions.get(checkout.id).status = 'expired';
  const second = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(second.code, 3);
  const [next] = events(second);
  assert.notEqual(next.id, checkout.id);
  assert.equal(next.resumed, false);
  assert.equal(next.reused, false);
  assert.equal(f.state.checkoutCreated, 2);
  assert.equal(f.state.checkoutRequests, 2);
  assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).pending_checkout.id, next.id, '本地记录换成新会话');
});

test('轮询中发现会话过期未付：expiredCheckout 文案 exit 3，本地记录清除', async (t) => {
  const f = await fixture(t);
  inactive(f);
  f.state.checkoutStatusResponse = { status: 'expired', paid: false, entitled: false };
  const result = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(result.code, 3);
  const [checkout, error] = events(result);
  assert.equal(error.error, 'payment_pending');
  assert.equal(error.message, '付款页面已过期，请重新运行刚才的命令。');
  assert.equal(error.id, checkout.id);
  // 只剩 pending_checkout 的配置在清除后整体删除（无凭据可保留）。
  await assert.rejects(readFile(f.configFile), { code: 'ENOENT' });
});

test('subscribe 拒绝免费 Skill 与未知方案：usage exit 2，发生在登录与账号查询之前', async (t) => {
  const f = await fixture(t);
  for (const [args, message] of [
    [['subscribe', 'ppt-design'], 'ppt-design 是免费 Skill，无需购买。'],
    [['subscribe', 'oracle-bone'], 'oracle-bone 是免费 Skill，无需购买。'],
    [['subscribe', 'ppt-design-pro', '--plan', 'yearly'], '这个产品没有 yearly 方案。'],
  ]) {
    const result = await f.run([...args, '--json'], { HY_TOKEN: TOKEN2 });
    assert.equal(result.code, 2, args.join(' '));
    const value = JSON.parse(result.stdout);
    assert.equal(value.error, 'usage', args.join(' '));
    assert.equal(value.message, message, args.join(' '));
  }
  assert.equal(f.state.requests.filter((r) => r.path === '/api/auth/me').length, 0, '拒绝先于账号查询');
  assert.equal(f.state.checkoutRequests, 0);
  assert.match((await f.run(['subscribe', 'ppt-design', '--lang', 'en'])).stderr, /is free; no purchase needed\./);
  assert.match((await f.run(['subscribe', 'ppt-design-pro', '--plan', 'yearly', '--lang', 'en'])).stderr, /This product has no yearly plan\./);
});

test('商店 notice 转告用户并附开源版安装命令：付款页前一行输出，JSON 事件与超时错误都携带', async (t) => {
  const f = await fixture(t);
  inactive(f);
  f.state.checkoutActiveAfter = Infinity;
  f.state.checkoutNotice = 'PPT 设计 Pro 提供的是分步设计方法。';
  const line = `付款前请转告用户：PPT 设计 Pro 提供的是分步设计方法。开源版的安装命令：${command('install', 'ppt-design')}`;
  const human = await f.run(['subscribe', 'ppt-design-pro'], { HY_TOKEN: TOKEN2 });
  assert.equal(human.code, 3);
  const lines = human.stdout.trim().split('\n');
  assert.equal(lines[lines.indexOf(line) + 1], `付款页面：${f.base}/checkout?session=1`);
  const result = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(result.code, 3);
  const [checkout, error] = events(result);
  assert.equal(checkout.event, 'checkout');
  assert.equal(checkout.notice, line);
  assert.equal(error.notice, line);
});

test('恢复未付会话按本次语言核对币种：zh 会话在 en 下不复用，新建 usd 会话（$9.99）', async (t) => {
  const f = await fixture(t);
  inactive(f);
  f.state.checkoutActiveAfter = Infinity;
  f.state.checkoutPrices = { zh: { amount: 6900, currency: 'cny' }, en: { amount: 999, currency: 'usd' } };
  const first = await f.run(['subscribe', 'ppt-design-pro', '--lang', 'zh', '--json'], { HY_TOKEN: TOKEN2 });
  const second = await f.run(['subscribe', 'ppt-design-pro', '--lang', 'en', '--json'], { HY_TOKEN: TOKEN2 });
  const a = events(first)[0], b = events(second)[0];
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.url, b.url);
  assert.equal(a.price_label, '69 元');
  assert.match(a.message, /69 元/);
  assert.equal(b.currency, 'usd');
  assert.equal(b.amount, 999);
  assert.equal(b.price_label, '$9.99');
  assert.match(b.message, /\$9\.99, one-time purchase/);
  assert.doesNotMatch(b.message, /69 元/);
  assert.equal(b.resumed, false);
  assert.equal(b.reused, false);
  assert.equal(f.state.checkoutCreated, 2);
});

test('非交互 60 秒预算耗尽：exit 3 带 purchase_url 与原命令，会话落盘；浏览器耗时计入预算', async (t) => {
  const f = await fixture(t);
  inactive(f);
  f.state.checkoutActiveAfter = Infinity;
  const result = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(result.code, 3);
  const [checkout, pending] = events(result);
  assert.equal(checkout.event, 'checkout');
  assert.equal(checkout.max_wait_seconds, 60);
  assert.equal(checkout.opened, false);
  assert.ok(checkout.warnings.some((warning) => warning.includes('没能自动打开浏览器')));
  assert.equal(pending.error, 'payment_pending');
  assert.equal(pending.skill, 'ppt-design-pro');
  assert.equal(pending.url, checkout.url);
  assert.equal(pending.purchase_url, checkout.url);
  assert.equal(pending.next_command, 'npx github:Huanyu-Hibiki/Huanyu-CLI subscribe ppt-design-pro --json');
  assert.equal(pending.message, `请用户在浏览器打开 ${checkout.url} 完成付款，付完后再运行一次刚才的命令。重新运行会沿用这个付款页面，不会重复收费。`);
  assert.equal(totalWait(result), 60000);
  assert.deepEqual(result.trace.delays, Array(20).fill(3000));
  const saved = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.equal(saved.pending_checkout.id, checkout.id);
  assert.equal(saved.pending_checkout.url, checkout.url);
  assert.equal(saved.token, undefined);
  assert.equal((await stat(f.configFile)).mode & 0o777, configMode);
  // 普通输出：付款页与等待提示在 stdout，重跑指引在 stderr。
  const human = await f.run(['subscribe', 'ppt-design-pro'], { HY_TOKEN: TOKEN2 });
  assert.equal(human.code, 3);
  assert(human.stdout.includes(`付款页面：${checkout.url}`));
  assert.match(human.stdout, /最长等待 60 秒/);
  assert.equal(human.stderr.trim(), `请用户在浏览器打开 ${checkout.url} 完成付款，付完后再运行一次刚才的命令。重新运行会沿用这个付款页面，不会重复收费。`);
  // 打开浏览器的耗时同样吃掉 60 秒预算：浏览器超时 5 秒封顶，剩余时间留给轮询。
  const budgeted = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 }, { browserDelay: 10000 });
  assert.equal(budgeted.code, 3);
  assert.deepEqual(budgeted.trace.browserTimeouts, [5000]);
  assert.equal(totalWait(budgeted) + budgeted.trace.browserTimeouts[0], 60000);
});

test('CI 真值：不创建会话、不打开浏览器，直接给网页购买入口 exit 3', async (t) => {
  const f = await fixture(t);
  inactive(f);
  for (const CI of ['true', '1', 'TRUE']) {
    const result = await f.run(['subscribe', 'ppt-design-pro', '--plan', 'lifetime', '--json'], { HY_TOKEN: TOKEN2, CI });
    assert.equal(result.code, 3, CI);
    const output = events(result);
    assert.equal(output.length, 1, CI);
    const pending = output[0];
    assert.equal(pending.error, 'payment_pending', CI);
    assert.equal(pending.purchase_url, `${f.base}/api/store/checkout?skill=ppt-design-pro&plan=lifetime`, CI);
    assert.equal(pending.ci, true, CI);
    assert.equal(pending.opened, false, CI);
    assert.equal(pending.next_command, 'npx github:Huanyu-Hibiki/Huanyu-CLI subscribe ppt-design-pro --plan lifetime --json', CI);
    assert.deepEqual(result.trace.browserUrls, [], CI);
    assert.deepEqual(result.trace.delays, [], CI);
  }
  assert.equal(f.state.checkoutRequests, 0);
  // 显式语言进入网页入口查询串。
  const english = await f.run(['subscribe', 'ppt-design-pro', '--lang', 'en', '--json'], { HY_TOKEN: TOKEN2, CI: 'true' });
  assert.equal(events(english)[0].purchase_url, `${f.base}/api/store/checkout?skill=ppt-design-pro&lang=en`);
  assert.equal(f.state.checkoutRequests, 0);
});

test('轮询中 status 5xx 与 me 5xx 都不中断等待，恢复后解锁并安装', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  await threeHosts(f);
  inactive(f);
  f.state.checkoutStatusErrors = [true];     // 首次状态查询 502
  f.state.checkoutPollErrors = [true, true]; // 前两次 me 502（轮询计数照常推进）
  f.state.checkoutActiveAfter = 3;           // 第 3 次 me 解锁
  const result = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(result.code, 0, result.stdout);
  assert.deepEqual(result.trace.delays, [3000, 3000, 3000]);
  assert.equal(f.state.checkoutPolls, 3);
  assert.equal(events(result).at(-1).installations[0].name, 'ppt-design-pro');
});

test('购买完成后交互询问“现在安装？”：答否给 install_hint；答是接续安装', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  await threeHosts(f);
  inactive(f);
  f.state.checkoutAlreadyActive = true;
  const result = await f.run(['subscribe', 'ppt-design-pro'], { HY_TOKEN: TOKEN2 }, { interactive: true, answers: [false] });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /已购买 ppt-design-pro。/);
  assert.match(result.stdout, new RegExp(`以后安装：${command('install', 'ppt-design-pro').replaceAll('.', '\\.')}`));
  assert.equal(result.trace.questions.length, 1);
  // 再问一次答是：installNow 确认后接续 install（第二次确认是 install 自己的 confirmInstall）。
  const yes = await f.run(['subscribe', 'ppt-design-pro'], { HY_TOKEN: TOKEN2 }, { interactive: true, answers: [true, true] });
  assert.equal(yes.code, 0, yes.stdout + yes.stderr);
  assert.equal(yes.trace.questions.length, 2);
  assert.match(yes.stdout, /已安装 ppt-design-pro 0\.2\.0：/);
});

test('pending_checkout 形状校验：坏 URL 协议/坏摘要 → 配置读取失败拒绝，不发起会话', async (t) => {
  const f = await fixture(t);
  const base = { id: 'cs_test_1', skill: 'ppt-design-pro', plan: 'lifetime', api: f.base, token_hash: 'a'.repeat(64) };
  for (const bad of [
    { ...base, url: 'file:///C:/Windows/system32' },
    { ...base, url: `${f.base}/checkout?session=1`, token_hash: 'zz'.repeat(32) },
    { ...base, url: `${f.base}/checkout?session=1`, token_hash: 'a'.repeat(63) },
  ]) {
    await mkdir(path.dirname(f.configFile), { recursive: true });
    await writeFile(f.configFile, JSON.stringify(bad));
    const result = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
    assert.equal(result.code, 1, JSON.stringify(bad));
    assert.equal(JSON.parse(result.stdout).error, 'config_read');
  }
  assert.equal(f.state.checkoutRequests, 0);
});

// —— 三路审查补缺与加固（spec 4 + quality 2 + security M1/L1/L2/L3）——

test('交互终端 15 分钟预算：terminal 超时总等待 900 秒、300 次 3 秒轮询', async (t) => {
  const f = await fixture(t);
  inactive(f);
  f.state.checkoutActiveAfter = Infinity;
  const result = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 }, { terminal: true });
  assert.equal(result.code, 3);
  const [checkout, pending] = events(result);
  assert.equal(checkout.max_wait_seconds, 900);
  assert.equal(pending.max_wait_seconds, 900);
  assert.equal(totalWait(result), 900000);
  assert.deepEqual(result.trace.delays, Array(300).fill(3000));
  const human = await f.run(['subscribe', 'ppt-design-pro'], { HY_TOKEN: TOKEN2 }, { terminal: true });
  assert.equal(human.code, 3);
  assert.match(human.stdout, /最长等待 15 分钟/);
});

test('恢复期 status 暂时 5xx：仍由商店重核本次语言与币种，换新会话不开旧人民币页', async (t) => {
  const f = await fixture(t);
  inactive(f);
  f.state.checkoutActiveAfter = Infinity;
  f.state.checkoutPrices = { zh: { amount: 6900, currency: 'cny' }, en: { amount: 999, currency: 'usd' } };
  const first = await f.run(['subscribe', 'ppt-design-pro', '--lang', 'zh', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(first.code, 3);
  const [zhCheckout] = events(first);
  // 让下一次 status 查询（第二进程的恢复查询）返回 502。
  f.state.checkoutStatusErrors = [];
  f.state.checkoutStatusErrors[f.state.checkoutStatusPolls] = true;
  const second = await f.run(['subscribe', 'ppt-design-pro', '--lang', 'en', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(second.code, 3);
  const [enCheckout] = events(second);
  assert.notEqual(enCheckout.id, zhCheckout.id);
  assert.equal(enCheckout.currency, 'usd');
  assert.equal(enCheckout.price_label, '$9.99');
  assert.equal(enCheckout.resumed, false);
  assert.equal(f.state.checkoutRequests, 2);
  assert.deepEqual(second.trace.browserUrls, [enCheckout.url], '只打开新会话的付款页');
});

test('CI 恢复：保留本地会话记录，给本次显式语言的网页入口', async (t) => {
  const f = await fixture(t);
  inactive(f);
  f.state.checkoutActiveAfter = Infinity;
  const first = await f.run(['subscribe', 'ppt-design-pro', '--lang', 'zh', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(first.code, 3);
  const [checkout] = events(first);
  const second = await f.run(['subscribe', 'ppt-design-pro', '--lang', 'en', '--json'], { HY_TOKEN: TOKEN2, CI: 'true' });
  assert.equal(second.code, 3);
  const pending = events(second)[0];
  assert.equal(pending.purchase_url, `${f.base}/api/store/checkout?skill=ppt-design-pro&lang=en`);
  assert.equal(pending.id, undefined);
  assert.equal(pending.ci, true);
  assert.equal(f.state.checkoutRequests, 1, 'CI 不创建会话');
  assert.deepEqual(second.trace.browserUrls, []);
  assert.deepEqual(second.trace.delays, []);
  assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).pending_checkout.id, checkout.id, '本地记录留待交互恢复');
});

test('saveAuth 保留付款进度：同令牌重登沿用会话；换令牌重登丢弃', async (t) => {
  const f = await fixture(t);
  inactive(f);
  f.state.checkoutActiveAfter = Infinity;
  const first = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(first.code, 3);
  const [checkout] = events(first);
  // 同令牌显式重登：付款进度存活。
  const login = await f.run(['login', '--token', TOKEN2, '--json']);
  assert.equal(login.code, 0, login.stdout);
  const kept = JSON.parse(await readFile(f.configFile, 'utf8'));
  assert.equal(kept.token, TOKEN2);
  assert.equal(kept.pending_checkout.id, checkout.id);
  // 重跑沿用同一会话（resumed），不新建。
  const resume = await f.run(['subscribe', 'ppt-design-pro', '--json']);
  assert.equal(resume.code, 3);
  assert.equal(events(resume)[0].id, checkout.id);
  assert.equal(events(resume)[0].resumed, true);
  assert.equal(f.state.checkoutCreated, 1);
  // 换令牌重登：旧令牌的付款记录不跨令牌继承。
  const relogin = await f.run(['login', '--token', TOKEN, '--json']);
  assert.equal(relogin.code, 0, relogin.stdout);
  assert.equal(JSON.parse(await readFile(f.configFile, 'utf8')).pending_checkout, undefined);
});

test('readPendingCheckout 绑定负例：换令牌或换 api origin 都不恢复会话', async (t) => {
  const f = await fixture(t);
  inactive(f);
  f.state.checkoutActiveAfter = Infinity;
  const first = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(first.code, 3);
  const [checkout] = events(first);
  // 换令牌（行为级）：token_hash 不匹配 → 不查原会话状态、直接新建自己的会话。
  const TOKEN3 = 'hy_Third0123456789abcdefghijklmnopqrstuv';
  f.state.grants.set(TOKEN3, []);
  const third = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN3 });
  assert.equal(third.code, 3);
  const [byToken] = events(third);
  assert.notEqual(byToken.id, checkout.id);
  assert.equal(byToken.resumed, false);
  assert.ok(!f.state.requests.some((r) => r.path === '/api/store/checkout/status' && r.token === TOKEN3 && r.query.get('id') === checkout.id),
    '换令牌不得查询原会话状态');
  assert.equal(f.state.checkoutCreated, 2);
  // 换 api origin（单元级，隔离配置目录）：同一记录只对创建它的 origin+令牌可见。
  await withIsolatedConfig(async (configFile) => {
    await mkdir(path.dirname(configFile), { recursive: true });
    await writeFile(configFile, JSON.stringify({ pending_checkout: { id: 'cs_1', url: `${f.base}/checkout?session=1`,
      skill: 'ppt-design-pro', plan: 'lifetime', api: f.base, token_hash: createHash('sha256').update(TOKEN2).digest('hex') } }));
    assert.equal((await readPendingCheckout('ppt-design-pro', TOKEN2, f.base))?.id, 'cs_1', '同令牌同 origin 可恢复');
    assert.equal(await readPendingCheckout('ppt-design-pro', TOKEN2, 'https://other.example'), null, '换 api origin 不恢复');
    assert.equal(await readPendingCheckout('ppt-design-pro', TOKEN, f.base), null, '换令牌不恢复');
  });
});

test('恢复时 status 404（会话已被服务端清理）：清除本地记录换新会话，不在坏记录上死锁', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  await mkdir(path.join(f.home, '.zcode', 'skills'), { recursive: true });
  inactive(f);
  f.state.checkoutActiveAfter = Infinity;
  const first = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(first.code, 3);
  const [gone] = events(first);
  f.state.sessions.delete(gone.id); // 服务端已无此会话：status 查询返回 404
  // 解锁走 status 端点的履约门控（me 轮询钩子保持关闭，避免恢复前的 me 顺带授权）。
  f.state.checkoutStatusActiveAfter = 1;
  const second = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(second.code, 0, second.stdout);
  const output = events(second);
  assert.deepEqual(output.map((event) => event.event), ['checkout', 'subscribed', undefined]);
  assert.notEqual(output[0].id, gone.id);
  assert.equal(output[0].resumed, false);
  assert.equal(f.state.checkoutCreated, 2, '404 后新建会话');
  assert.equal(output.at(-1).installations[0].name, 'ppt-design-pro');
});

test('notice 消毒：剥离 \\r\\n\\t 之外的控制字符，500 字封顶超长截断附省略号', async (t) => {
  const f = await fixture(t);
  inactive(f);
  f.state.checkoutActiveAfter = Infinity;
  // X/Y/Z 与 \t\r\n 保留；\u0000、\u0007、\x7F 剥离；总长 608 → 截到 500 + …。
  f.state.checkoutNotice = `X\u0000Y\u0007Z\t\r\n W\x7F${'x'.repeat(600)}`;
  const result = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(result.code, 3);
  const [checkout] = events(result);
  const sanitized = 'XYZ\t\r\n W' + 'x'.repeat(492) + '…';
  assert.equal(checkout.notice, `付款前请转告用户：${sanitized}开源版的安装命令：${command('install', 'ppt-design')}`);
});

test('checkout 付款页协议与 API 对齐（L2）：https API 拒绝 http 付款页，存储记录同规', async (t) => {
  // 存储侧：isPendingCheckout 对 https api + http 付款页的记录按坏记录拒绝（http API 不受限）。
  const record = { id: 'cs_1', skill: 'ppt-design-pro', plan: 'lifetime', token_hash: 'a'.repeat(64) };
  assert.equal(isPendingCheckout({ ...record, url: 'http://pay.example/x', api: 'https://store.example' }), false);
  assert.equal(isPendingCheckout({ ...record, url: 'https://pay.example/x', api: 'https://store.example' }), true);
  assert.equal(isPendingCheckout({ ...record, url: 'http://pay.example/x', api: 'http://store.example' }), true);
  // 创建侧（进程内桩，不发网络）：https API 返回 http 付款页 → invalid_response，不开浏览器不落盘。
  await withIsolatedConfig(async () => {
    const ctx = { catalog: [{ id: 'ppt-design', name: 'PPT 设计', summary: '', free: { skill: 'ppt-design' }, paid: { skill: 'ppt-design-pro' },
        offer: ['lifetime'], prices: { lifetime: { amount: 6900, currency: 'cny', interval: null } } }],
      token: TOKEN2, output: { write() {} }, nextCommand: 'hy subscribe ppt-design-pro',
      client: { base: 'https://store.example', url: (route) => `https://store.example${route}`, lang: 'zh', explicitLanguage: false,
        me: async () => ({ subscriptions: [] }),
        request: async () => ({ id: 'cs_1', url: 'http://pay.example/session', reused: false, amount: 6900, currency: 'cny' }) },
      now: () => 0, sleep: async () => {}, openBrowser: async () => false, terminal: false, signal: new AbortController().signal };
    await assert.rejects(withLanguage({ lang: 'zh' }, () => requirePurchase(ctx, 'ppt-design-pro', {})),
      (error) => error instanceof CliError && error.error === 'invalid_response' && error.code === 1);
  });
});

test('付款金额校验（L3）：0/负数/非数字金额按 invalid_response 拒绝，不落盘不开浏览器', async (t) => {
  const f = await fixture(t);
  inactive(f);
  for (const amount of [0, -6900, '6900']) {
    // 注入响应只影响本次 POST：清掉服务端会话，避免下一轮踩进复用分支拿到正常价格。
    f.state.sessions = new Map();
    f.state.checkoutResponse = { id: 'cs_bad', url: `${f.base}/checkout?session=9`, reused: false, amount, currency: 'cny' };
    const result = await f.run(['subscribe', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN2 });
    assert.equal(result.code, 1, String(amount));
    const value = JSON.parse(result.stdout);
    assert.equal(value.error, 'invalid_response', String(amount));
    assert.match(value.message, /付款信息不完整，请重试。/, String(amount));
    assert.deepEqual(result.trace.browserUrls, [], String(amount));
  }
  await assert.rejects(readFile(f.configFile), { code: 'ENOENT' }, '被拒会话不得落盘');
});
