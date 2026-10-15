import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { fixture, writeSkill, readDirectoryLink, TOKEN, TOKEN2, EMAIL, configMode } from './fixture.js';
import { command } from '../src/i18n.js';

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
