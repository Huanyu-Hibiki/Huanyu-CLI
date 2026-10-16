import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { fixture, writeSkill, TOKEN, TOKEN2 } from './fixture.js';

// 二期任务 2（安全敏感：认证·管理操作）：product 注册/更新商品元数据、unpublish 版本下架（yank）、
// audit 独立对账报告。契约见设计「接口设计·发布端」；yank 语义 = 假设清单 #4
// （history 保留 + yanked 标记；latest 回落到最高未下架版本）。

const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};
const events = (result) => result.stdout.trim().split('\n').map((line) => JSON.parse(line));
const putRequests = (f) => f.state.requests.filter((request) => request.method === 'PUT');
const deleteRequests = (f) => f.state.requests.filter((request) => request.method === 'DELETE');
const versionsOf = async (f, name) => (await (await fetch(`${f.base}/api/store/versions`)).json()).skills[name];

// —— product：注册/更新商品元数据 ——

test('product 更新摘要与价格：PUT 契约正确，catalog/list 立即反映', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['product', 'ppt-design', '--set', 'summary=全新摘要。', '--set', 'prices.lifetime=9900,cny', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  const value = data(result);
  assert.equal(value.ok, true);
  assert.equal(value.command, 'product');
  assert.equal(value.event, 'product');
  assert.equal(value.skill, 'ppt-design');
  assert.equal(value.product.id, 'ppt-design');
  assert.equal(value.product.summary, '全新摘要。');
  assert.deepEqual(value.product.prices, { lifetime: { amount: 9900, currency: 'cny', interval: null } });
  // PUT 契约：Bearer 令牌 + JSON 体只包含本次提供的键。
  assert.equal(putRequests(f).length, 1);
  assert.equal(putRequests(f)[0].path, '/api/store/products/ppt-design');
  assert.equal(putRequests(f)[0].token, TOKEN);
  assert.deepEqual(putRequests(f)[0].body, { summary: '全新摘要。', prices: { lifetime: { amount: 9900, currency: 'cny', interval: null } } });
  // catalog 端点反映更新；list 的免费/付费两行立即显示新摘要与新价格。
  const catalog = await (await fetch(`${f.base}/api/store/catalog`)).json();
  assert.equal(catalog.products.find((product) => product.id === 'ppt-design').summary, '全新摘要。');
  const list = await f.run(['list']);
  assert.ok(list.stdout.includes('ppt-design：免费，全新摘要。'), list.stdout);
  assert.ok(list.stdout.includes('ppt-design-pro：付费（99 元，一次买断，永久更新），全新摘要。'), list.stdout);
  // 文本通道：更新词条 + 复用 list 的商品展示词条。
  const human = await f.run(['product', 'ppt-design', '--set', 'summary=全新摘要。'], { HY_TOKEN: TOKEN });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /已更新商品：PPT 设计/);
  assert.ok(human.stdout.includes('ppt-design：免费，全新摘要。'));
  assert.ok(human.stdout.includes('ppt-design-pro：付费（99 元'));
});

test('product 注册新发布的 skill 并声明配对：catalog 增商品，list 出现配对两行', async (t) => {
  const f = await fixture(t);
  // 商品注册与版本发布解耦：先 publish（只进 versions），再 product 注册商品元数据。
  await writeSkill(f.cwd, 'new-skill', '0.1.0');
  assert.equal((await f.run(['publish', 'new-skill'], { HY_TOKEN: TOKEN })).code, 0);
  const result = await f.run(['product', 'new-skill', '--set', 'name=新技能', '--set', 'summary=说明文本。',
    '--set', 'free=new-skill', '--set', 'paid=new-skill-pro', '--set', 'prices.lifetime=1900,cny', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  const value = data(result);
  assert.equal(value.product.name, '新技能');
  assert.deepEqual(value.product.free, { skill: 'new-skill' });
  assert.deepEqual(value.product.paid, { skill: 'new-skill-pro' });
  const list = data(await f.run(['list', '--json']));
  assert.deepEqual(list.skills.map((skill) => skill.skill), ['ppt-design', 'ppt-design-pro', 'oracle-bone', 'new-skill', 'new-skill-pro']);
  const paid = list.skills.find((skill) => skill.skill === 'new-skill-pro');
  assert.equal(paid.type, 'paid');
  assert.equal(paid.name, '新技能');
  assert.equal(paid.summary, '说明文本。');
  assert.deepEqual(paid.prices, { lifetime: { amount: 1900, currency: 'cny', interval: null } });
  const free = list.skills.find((skill) => skill.skill === 'new-skill');
  assert.equal(free.type, 'free');
});

test('product 非法字段值本地拒绝：价格非数字/缺币种/负数/天价/未知字段/空摘要，未发出 PUT', async (t) => {
  const f = await fixture(t);
  await f.run(['login', '--token', TOKEN, '--json']);
  for (const bad of ['prices.lifetime=abc,cny', 'prices.lifetime=6900', 'prices.lifetime=-1,cny', 'prices.lifetime=0,cny',
    'prices.lifetime=6900,cnyx', 'prices.Lifetime=6900,cny', 'prices.lifetime=1000000001,cny', 'unknown=x', 'summary=']) {
    const result = await f.run(['product', 'ppt-design', '--set', bad, '--json'], { HY_TOKEN: TOKEN });
    assert.equal(result.code, 2, bad);
    assert.equal(data(result).error, 'usage', bad);
    assert.match(data(result).message, /--set 字段值无效/, bad);
  }
  // 重复键（M3）：顶层字段与 prices 方案名各只能设置一次，静默覆盖改为显式报错。
  const duplicateTop = await f.run(['product', 'ppt-design', '--set', 'summary=甲', '--set', 'summary=乙', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(duplicateTop.code, 2);
  assert.equal(data(duplicateTop).error, 'usage');
  assert.match(data(duplicateTop).message, /--set summary 重复：每个字段只能设置一次。/);
  const duplicatePlan = await f.run(['product', 'ppt-design', '--set', 'prices.lifetime=6900,cny', '--set', 'prices.lifetime=9900,cny', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(duplicatePlan.code, 2);
  assert.match(data(duplicatePlan).message, /--set prices\.lifetime 重复/);
  // 不同 prices 方案并存是合法的（不是重复键）。
  assert.equal((await f.run(['product', 'ppt-design', '--set', 'prices.lifetime=6900,cny', '--set', 'prices.yearly=12000,cny', '--json'], { HY_TOKEN: TOKEN })).code, 0);
  assert.equal(putRequests(f).length, 1);
  assert.match((await f.run(['product', 'ppt-design', '--set', 'prices.lifetime=abc,cny'])).stderr, /prices\.<方案>=<分>,<币种>/);
});

test('product 拒绝语义：未知 skill 退出 2 引导 list；非 publisher（TOKEN2）退出 3；未登录走设备码退出 3', async (t) => {
  const f = await fixture(t);
  // 不先 login：令牌经 HY_TOKEN 按次提供，未登录场景才能走真实的设备码引导。
  const unknown = await f.run(['product', 'no-such-skill', '--set', 'summary=x', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(unknown.code, 2);
  assert.equal(data(unknown).error, 'unknown_skill');
  assert.match(data(unknown).message, /没有找到 no-such-skill，请运行 npx github:Huanyu-Hibiki\/Huanyu-CLI list。/);
  assert.equal(putRequests(f).length, 0);

  f.state.grants.set(TOKEN2, []);
  const other = await f.run(['product', 'ppt-design', '--set', 'summary=x', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(other.code, 3);
  assert.equal(data(other).error, 'not_a_publisher');
  assert.equal(data(other).next_command, 'npx github:Huanyu-Hibiki/Huanyu-CLI login');
  assert.equal(putRequests(f).length, 0);

  f.state.requireApproval = true;
  const anonymous = await f.run(['product', 'ppt-design', '--set', 'summary=x', '--json'], {}, { browserDelay: 100 });
  assert.equal(anonymous.code, 3);
  assert.equal(events(anonymous).at(-1).error, 'authorization_pending');
  assert.equal(putRequests(f).length, 0);
});

test('product 服务端错误映射：400 invalid_field 退出 1、403 退出 3、404 退出 2；服务端对合法规范名直接注册（与版本发布解耦）', async (t) => {
  const f = await fixture(t);
  await f.run(['login', '--token', TOKEN, '--json']);
  f.state.productStatus = 400;
  const invalid = await f.run(['product', 'ppt-design', '--set', 'summary=x', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(invalid.code, 1);
  assert.equal(data(invalid).error, 'invalid_field');
  // 服务端拒绝用独立词条透传原因（M2），不再复用本地语法提示误导用户。
  assert.match(data(invalid).message, /商店拒绝了该商品元数据：注入的商品更新失败。/);
  assert.doesNotMatch(data(invalid).message, /--set 字段值无效/);
  f.state.productStatus = 403;
  const forbidden = await f.run(['product', 'ppt-design', '--set', 'summary=x', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(forbidden.code, 3);
  assert.equal(data(forbidden).error, 'not_a_publisher');
  assert.equal(data(forbidden).next_command, 'npx github:Huanyu-Hibiki/Huanyu-CLI login');
  f.state.productStatus = 404;
  const missing = await f.run(['product', 'ppt-design', '--set', 'summary=x', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(missing.code, 2);
  assert.equal(data(missing).error, 'unknown_skill');

  // 服务端字段白名单（最终验证者）：坏价格形状与 free=paid 都 400 且不落库。
  f.state.productStatus = null;
  const put = (body) => fetch(`${f.base}/api/store/products/ppt-design`, {
    method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await put({ prices: { lifetime: { amount: 'x' } } })).status, 400);
  assert.equal((await put({ free: 'ppt-design', paid: 'ppt-design' })).status, 400);
  const catalog = await (await fetch(`${f.base}/api/store/catalog`)).json();
  assert.equal(catalog.products.find((product) => product.id === 'ppt-design').prices.lifetime.amount, 6900);
  // 解耦语义：合法规范名即使尚无发布版本也可注册商品（客户端预检引导未知名，直连钉住服务端语义）。
  const created = await fetch(`${f.base}/api/store/products/future-skill`, {
    method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ summary: '预告。' }),
  });
  assert.equal(created.status, 200);
  assert.ok(catalog.products.some((product) => product.id === 'ppt-design' && product.free.skill === 'ppt-design'));
  const after = await (await fetch(`${f.base}/api/store/catalog`)).json();
  assert.ok(after.products.some((product) => product.id === 'future-skill' && product.free?.skill === 'future-skill'));
});

// —— unpublish：版本下架（yank）——

test('unpublish 下架：已装不受影响、新安装该版本 404、latest 回落、status 历史带 yanked、幂等', async (t) => {
  const f = await fixture(t);
  // 先装 0.1.0（种子），再发布 0.2.0/0.3.0，把中间的 0.2.0 下架。
  await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  const target = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  const before = await readFile(path.join(target, 'SKILL.md'), 'utf8');
  await writeSkill(f.cwd, 'ppt-design', '0.2.0');
  assert.equal((await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN })).code, 0);
  await writeSkill(f.cwd, 'ppt-design', '0.3.0');
  assert.equal((await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN })).code, 0);

  const result = await f.run(['unpublish', 'ppt-design', '0.2.0', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  const value = data(result);
  assert.equal(value.ok, true);
  assert.equal(value.command, 'unpublish');
  assert.equal(value.event, 'unpublish');
  assert.deepEqual([value.skill, value.version, value.yanked], ['ppt-design', '0.2.0', true]);
  assert.equal(deleteRequests(f).length, 1);
  assert.equal(deleteRequests(f)[0].path, '/api/store/releases/ppt-design/0.2.0');
  assert.equal(deleteRequests(f)[0].token, TOKEN);
  // 文本通道：下架词条 + 对已装用户的影响说明。
  const human = await f.run(['unpublish', 'ppt-design', '0.2.0'], { HY_TOKEN: TOKEN });
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /已下架：ppt-design 0\.2\.0/);
  assert.match(human.stdout, /已安装的用户不受影响；新安装该版本将返回 404。/);

  // versions：history 保留并带 yanked 标记，latest 回落到最高未下架版本（假设 #4）。
  const entry = await versionsOf(f, 'ppt-design');
  assert.equal(entry.latest, '0.3.0');
  assert.equal(entry.history.find((item) => item.version === '0.2.0').yanked, true);
  assert.equal(entry.history.find((item) => item.version === '0.3.0').yanked, undefined);
  // 新安装该版本 404：下载端与公开附件都拒绝（已装用户本地文件一字未动）。
  assert.equal((await fetch(`${f.base}/api/store/download/ppt-design?version=0.2.0&format=tar.gz`)).status, 404);
  assert.equal((await fetch(`${f.base}/releases/ppt-design-0.2.0.tar.gz`)).status, 404);
  assert.equal(await readFile(path.join(target, 'SKILL.md'), 'utf8'), before);
  // status：更新路径包含已下架的 0.2.0（带标记），最新为 0.3.0。
  const status = data(await f.run(['status', '--json']));
  const item = status.installations.find((installation) => installation.name === 'ppt-design');
  assert.equal(item.latest, '0.3.0');
  assert.deepEqual(item.updates.map((update) => [update.version, update.yanked ?? false]), [['0.2.0', true], ['0.3.0', false]]);
  // 重复下架幂等：仍 200。
  assert.equal((await f.run(['unpublish', 'ppt-design', '0.2.0', '--json'], { HY_TOKEN: TOKEN })).code, 0);

  // 全部已发布版本下架：latest 回落到未下架的种子 0.1.0；种子也下架后保留最高版本占位（下载 404 挡新装）。
  await f.run(['unpublish', 'ppt-design', '0.3.0', '--json'], { HY_TOKEN: TOKEN });
  assert.equal((await versionsOf(f, 'ppt-design')).latest, '0.1.0');
  await f.run(['unpublish', 'ppt-design', '0.1.0', '--json'], { HY_TOKEN: TOKEN });
  assert.equal((await versionsOf(f, 'ppt-design')).latest, '0.3.0');
  assert.equal((await fetch(`${f.base}/api/store/download/ppt-design?version=0.1.0&format=tar.gz`)).status, 404);
});

test('全下架占位一致（M1）：status 不报可更新并带 all_yanked 标记，update 跳过下载并解释', async (t) => {
  const f = await fixture(t);
  await f.run(['install', 'ppt-design', '--to', 'zcode', '--json']);
  const target = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  await writeSkill(f.cwd, 'ppt-design', '0.2.0');
  assert.equal((await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN })).code, 0);
  await writeSkill(f.cwd, 'ppt-design', '0.3.0');
  assert.equal((await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN })).code, 0);
  for (const version of ['0.1.0', '0.2.0', '0.3.0']) await f.run(['unpublish', 'ppt-design', version, '--json'], { HY_TOKEN: TOKEN });
  // 全部版本下架：latest 占位 0.3.0（本身已下架）——status/update 不得把它当可更新目标。
  const status = data(await f.run(['status', '--json']));
  const item = status.installations.find((installation) => installation.name === 'ppt-design');
  assert.equal(item.latest, '0.3.0');
  assert.equal(item.update_available, false);
  assert.equal(item.all_yanked, true);
  // history 仍可见（含 yanked 标记），只是不可作为更新目标。
  assert.deepEqual(item.updates.map((update) => [update.version, update.yanked ?? false]), [['0.2.0', true], ['0.3.0', true]]);
  assert.match((await f.run(['status'])).stdout, /ppt-design：0\.1\.0（商店全部版本已下架）/);
  // update：不进 pending、不下载，跳过并解释；本地版本不动；状态 up_to_date（无可更新动作）。
  const downloadsBefore = f.state.requests.filter((request) => request.path === '/api/store/download/ppt-design').length;
  const update = data(await f.run(['update', '--json']));
  assert.deepEqual(update.installations, []);
  assert.deepEqual(update.skipped, [{ name: 'ppt-design', path: target, reason: 'all_yanked' }]);
  assert.equal(update.updated_count, 0);
  assert.equal(update.status, 'up_to_date');
  const text = await f.run(['update']);
  assert.match(text.stdout, /已安装的 Skill 无需更新。/);
  assert.match(text.stdout, /ppt-design：商店全部版本已下架，跳过更新/);
  // update 没有发起新的下载（downloadsBefore 是准备阶段 install 的那一次）。
  assert.equal(f.state.requests.filter((request) => request.path === '/api/store/download/ppt-design').length, downloadsBefore);
  assert.match(await readFile(path.join(target, 'SKILL.md'), 'utf8'), /version: "0\.1\.0"/);
});

test('product 跨商品冲突本地预判（M2）：free/paid 属于其他商品时精确报错且未发 PUT；本地无法预判的交给服务端', async (t) => {
  const f = await fixture(t);
  const conflict = await f.run(['product', 'ppt-design', '--set', 'paid=oracle-bone', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(conflict.code, 2);
  assert.equal(data(conflict).error, 'product_conflict');
  assert.match(data(conflict).message, /oracle-bone 已属于商品 甲骨文，不能在该商品下声明配对。/);
  assert.equal(putRequests(f).length, 0);
  // 目标商品自己的另一面（swap 到已有 skill）本地不冲突：最终由服务端按 free=paid 规则拒绝（独立词条透传原因）。
  const swap = await f.run(['product', 'ppt-design', '--set', 'free=ppt-design-pro', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(swap.code, 1);
  assert.equal(data(swap).error, 'invalid_field');
  assert.match(data(swap).message, /商店拒绝了该商品元数据：free 与 paid 不能相同。/);
  assert.equal(putRequests(f).length, 1);
});

test('unpublish 拒绝语义：版本不存在 404 → 退出 1；非 publisher（TOKEN2 与服务端 403）退出 3；未登录退出 3', async (t) => {
  const f = await fixture(t);
  // 不先 login：令牌经 HY_TOKEN 按次提供，未登录场景才能走真实的设备码引导。
  const missing = await f.run(['unpublish', 'ppt-design', '9.9.9', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(missing.code, 1);
  assert.equal(data(missing).error, 'not_found');
  assert.match(data(missing).message, /没有 ppt-design 9\.9\.9 这个版本/);
  // 只有 9.9.9 这一次 DELETE（服务端 404 拒绝）；后续拒绝语义都不该再发。
  assert.equal(deleteRequests(f).length, 1);

  f.state.grants.set(TOKEN2, []);
  const other = await f.run(['unpublish', 'ppt-design', '0.1.0', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(other.code, 3);
  assert.equal(data(other).error, 'not_a_publisher');
  assert.equal(data(other).next_command, 'npx github:Huanyu-Hibiki/Huanyu-CLI login');
  assert.equal(deleteRequests(f).length, 1);

  // 服务端 403 注入：请求已发出（注入在鉴权后），语义映射为退出 3 的登录引导。
  f.state.unpublishStatus = 403;
  const forbidden = await f.run(['unpublish', 'ppt-design', '0.1.0', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(forbidden.code, 3);
  assert.equal(data(forbidden).error, 'not_a_publisher');
  assert.equal(deleteRequests(f).length, 2);

  f.state.unpublishStatus = null;
  f.state.requireApproval = true;
  const anonymous = await f.run(['unpublish', 'ppt-design', '0.1.0', '--json'], {}, { browserDelay: 100 });
  assert.equal(anonymous.code, 3);
  assert.equal(events(anonymous).at(-1).error, 'authorization_pending');
  assert.equal(deleteRequests(f).length, 2);
});

// —— audit：对账报告独立入口 ——

test('audit 对账四分类 + yanked 提示：无需登录，--json 结构化，与 publish --check 同源', async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.temporary, 'skills-repo');
  await mkdir(repo);
  await writeSkill(repo, 'ppt-design', '0.3.0');
  await writeSkill(repo, 'oracle-bone', '0.1.0');
  await writeSkill(repo, 'brand-new', '0.2.0');
  // 商店里制造一个已下架版本：发布 ppt-design 0.2.0 后下架。
  await writeSkill(f.cwd, 'ppt-design', '0.2.0');
  await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN });
  await f.run(['unpublish', 'ppt-design', '0.2.0', '--json'], { HY_TOKEN: TOKEN });

  // 只读公开接口：audit 全程不再新增 /api/auth/me 请求（前面的 publish/unpublish 属于准备阶段）。
  const authRequests = () => f.state.requests.filter((request) => request.path === '/api/auth/me').length;
  const authBefore = authRequests();
  const requestsBefore = f.state.requests.length;
  const result = await f.run(['audit', '--repo', repo, '--json']);
  assert.equal(result.code, 0, result.stdout);
  const value = data(result);
  assert.equal(value.ok, true);
  assert.equal(value.command, 'audit');
  assert.equal(value.repo, repo);
  assert.deepEqual(value.skills.map((skill) => [skill.skill, skill.status]), [
    ['brand-new', 'missing'], ['oracle-bone', 'current'], ['ppt-design', 'behind'], ['ppt-design-pro', 'store_only'],
  ]);
  // 商店 latest 已回落到 0.1.0（0.2.0 下架），本地 0.3.0 → 待发布；yanked 提示挂在对应条目上。
  assert.equal(value.skills.find((skill) => skill.skill === 'ppt-design').store_latest, '0.1.0');
  assert.deepEqual(value.skills.find((skill) => skill.skill === 'ppt-design').yanked, ['0.2.0']);
  assert.deepEqual(value.counts, { total: 4, publishable: 2, current: 1, local_behind: 0, store_only: 1, invalid: 0 });
  // 只读公开接口：audit 全程没有新增 /api/auth/me 请求，未登录可用。
  assert.equal(authRequests(), authBefore);
  // 零令牌保证（L5）：audit 触发的 catalog/versions 请求都不带 Authorization。
  const publicRequests = f.state.requests.slice(requestsBefore).filter((request) => ['/api/store/catalog', '/api/store/versions'].includes(request.path));
  assert.ok(publicRequests.length >= 2);
  assert.ok(publicRequests.every((request) => request.token === undefined));
  // 与 publish --check 同源（共享 reconcileRepo）：同一仓库两份报告一致。
  const check = data(await f.run(['publish', '--repo', repo, '--check', '--json'], { HY_TOKEN: TOKEN }));
  assert.deepEqual(check.skills, value.skills);
  assert.deepEqual(check.counts, value.counts);
  // 文本通道：四类词条 + 已下架提示 + 汇总。
  const human = await f.run(['audit', '--repo', repo]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /商店缺：brand-new（本地 0\.2\.0）/);
  assert.match(human.stdout, /待发布：ppt-design 本地 0\.3\.0，商店 0\.1\.0/);
  assert.match(human.stdout, /一致：oracle-bone 0\.1\.0/);
  assert.match(human.stdout, /商店多：ppt-design-pro（本地仓库没有）/);
  assert.match(human.stdout, /已下架：ppt-design 0\.2\.0（历史保留，新安装 404）/);
  assert.match(human.stdout, /共 4 个 Skill：待发布 2，一致 1。/);
  // 英文报告同样四类齐全。
  const english = await f.run(['audit', '--repo', repo, '--lang', 'en']);
  assert.match(english.stdout, /Missing from store: brand-new \(local 0\.2\.0\)/);
  assert.match(english.stdout, /Up to date: oracle-bone 0\.1\.0/);
  assert.match(english.stdout, /Store only: ppt-design-pro/);
  assert.match(english.stdout, /Yanked: ppt-design 0\.2\.0/);
});

test('audit 默认对账当前目录（--repo 缺省 = cwd），空仓库给 skill_read 语义', async (t) => {
  const f = await fixture(t);
  await writeSkill(f.cwd, 'oracle-bone', '0.1.0');
  const value = data(await f.run(['audit', '--json']));
  assert.equal(value.repo, f.cwd);
  assert.deepEqual(value.skills.map((skill) => [skill.skill, skill.status]),
    [['oracle-bone', 'current'], ['ppt-design', 'store_only'], ['ppt-design-pro', 'store_only']]);
  const empty = path.join(f.temporary, 'empty-repo');
  await mkdir(empty);
  const none = await f.run(['audit', '--repo', empty, '--json']);
  assert.equal(none.code, 1);
  assert.equal(data(none).error, 'skill_read');
});

// —— 参数面 ——

test('product/unpublish/audit 参数面：缺参/多参/参数误用全部退出码 2', async (t) => {
  const f = await fixture(t);
  for (const [args, error] of [
    [['product'], 'usage'],
    [['product', 'ppt-design'], 'usage'],
    [['product', 'Not-Valid', '--set', 'summary=x'], 'usage'],
    [['product', 'ppt-design', '--set'], 'missing_argument'],
    [['product', 'ppt-design', '--set', 'summary=x', 'extra'], 'usage'],
    [['product', 'ppt-design', '--set', 'summary=x', '--repo', 'y'], 'usage'],
    [['unpublish'], 'usage'],
    [['unpublish', 'ppt-design'], 'usage'],
    [['unpublish', 'ppt-design', '1.2'], 'usage'],
    [['unpublish', 'Not-Valid', '0.1.0'], 'usage'],
    [['unpublish', 'ppt-design', '0.1.0', 'extra'], 'usage'],
    [['unpublish', 'ppt-design', '0.1.0', '--set', 'summary=x'], 'usage'],
    [['audit', 'extra'], 'usage'],
    [['audit', '--set', 'summary=x'], 'usage'],
    [['list', '--repo', 'x'], 'usage'],
  ]) {
    const result = await f.run([...args, '--json']);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(data(result).error, error, args.join(' '));
  }
  assert.match((await f.run(['product'])).stderr, /product 需要一个 Skill 名和至少一个 --set/);
  assert.match((await f.run(['unpublish', 'ppt-design'])).stderr, /unpublish 需要 <skill> 和 <版本>/);
});
