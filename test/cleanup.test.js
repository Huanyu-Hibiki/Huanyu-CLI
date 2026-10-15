import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { access, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { fixture, writeSkill, linkDirectory, readDirectoryLink, TOKEN } from './fixture.js';

// 二期任务 5（安全敏感：支付·删除操作）：install/update 的 402 内联购买 + 免费版配对清理。
// 清理规则（设计「错误处理」免费版自动清理条款）：装任何 free+paid 配对商品的付费版时按 product
// 配对移除同宿主（sameAgentRoots 归属，含项目级根）的免费版——remove 动作并入整批事务、可回滚；
// 被保护链接指向的免费版真实目标、开发目录、无法识别的目录跳过并解释；跨宿主不误清。

const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};
// 带购买事件的运行输出是多行 JSON（checkout/subscribed/最终结果），逐行解析。
const events = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line));
};
const absent = (directory) => assert.rejects(access(directory), { code: 'ENOENT' });
const exists = async (file) => { try { return await lstat(file); } catch { return null; } };
const stageLeftovers = async (root) => (await readdir(root, { recursive: false }).catch((error) => error.code === 'ENOENT' ? [] : (() => { throw error; })())).filter((name) => name.startsWith('.hy-stage-'));
const sorted = (paths) => [...paths].sort();
const root = (f, host) => path.join(f.home, `.${host}`, 'skills');
const projectRoot = (f, host) => path.join(f.cwd, `.${host}`, 'skills');
const versionOf = async (directory) => ((await readFile(path.join(directory, 'SKILL.md'), 'utf8')).match(/version: "([^"]+)"/) || [])[1];
// 目录内容快照（类型 + 相对路径）：验证受保护的免费版逐字节保留。
const snapshot = async (directory) => {
  const files = [];
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      files.push(`${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}:${path.relative(directory, path.join(current, entry.name))}`);
      if (entry.isDirectory()) await walk(path.join(current, entry.name));
    }
  };
  await walk(directory);
  return [...files].sort().join('\n');
};
// 种子发布物只覆盖免费 skill：付费版本先经 publish 落进商店，下载端点才有内容可发。
const publishPaid = async (f, version = '0.2.0') => {
  await writeSkill(f.cwd, 'ppt-design-pro', version);
  const result = await f.run(['publish', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
};
const threeHosts = async (f) => {
  for (const host of ['.zcode', '.claude', '.trae']) await mkdir(path.join(f.home, host), { recursive: true });
};

test('未购付费 install 一条命令：内联购买（假浏览器+轮询解锁）→ 多宿主安装 → 同宿主用户与项目根的免费版移除', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  await threeHosts(f);
  const freeUser = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9', 'renamed-free');
  const freeProject = await writeSkill(projectRoot(f, 'zcode'), 'ppt-design', '0.1.0');
  f.state.grants.set(TOKEN, []);
  const result = await f.run(['install', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN, HY_TEST_BROWSER: 'approve' });
  assert.equal(result.code, 0, result.stdout);
  const output = events(result);
  // JSON 输出顺序可追溯：checkout 会话 → 购买完成 → 最终安装结果。
  assert.deepEqual(output.map((event) => event.event), ['checkout', 'subscribed', undefined]);
  assert.equal(output[0].opened, true, '假浏览器打开付款页');
  assert.deepEqual(result.trace.browserUrls, [output[0].url]);
  const value = output.at(-1);
  const primary = path.join(root(f, 'zcode'), 'ppt-design-pro');
  assert.deepEqual(value.installations, [{ name: 'ppt-design-pro', path: primary, previous: null, version: '0.2.0' }]);
  assert.equal(value.links.length, 2);
  assert.ok(value.links.every((item) => item.target === primary));
  assert.deepEqual(sorted(value.removed), sorted([freeUser, freeProject]));
  assert.deepEqual(value.skipped, []);
  assert.deepEqual(value.warnings, []);
  for (const directory of [freeUser, freeProject]) await absent(directory);
  assert.equal(await versionOf(primary), '0.2.0');
  assert.equal(f.state.checkoutRequests, 1);
  assert.equal(f.state.requests.filter((r) => r.path === '/api/store/download/ppt-design-pro').length, 1, '整条命令只下载一次付费包');
});

test('402 竞态：闸门放行（me 已列）→ 下载 402 → 内联购买确认 → 重试下载安装（一条命令）', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  f.state.downloadInactiveCount = 1; // 首次付费下载：清授权后 402（服务端履约竞态）
  const result = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  const output = events(result);
  assert.deepEqual(output.map((event) => event.event), ['checkout', 'subscribed', undefined]);
  assert.equal(f.state.requests.filter((r) => r.path === '/api/store/download/ppt-design-pro').length, 2, '402 后重试一次下载');
  assert.equal(f.state.checkoutRequests, 1);
  assert.deepEqual(output.at(-1).installations, [{ name: 'ppt-design-pro', path: path.join(root(f, 'zcode'), 'ppt-design-pro'), previous: null, version: '0.2.0' }]);
});

test('重复 402 不重复购买：购买后重试仍 402 → 原错误透出（exit 3 inactive），整个进程只购买一次', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  f.state.downloadInactiveCount = 2; // 购买履约后第二次下载仍 402：不再进入第二次购买
  const result = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 3);
  const output = events(result);
  assert.equal(output.at(-1).error, 'inactive');
  assert.equal(f.state.checkoutRequests, 1, '重试的 402 不再触发第二次购买');
  assert.equal(f.state.requests.filter((r) => r.path === '/api/store/download/ppt-design-pro').length, 2);
  assert.equal(await exists(path.join(f.home, '.zcode')), null, '目标不可达');
});

test('update 付费更新清理同宿主用户与项目根的免费版；跨宿主（qwenwork）不误清', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  const pro = await writeSkill(root(f, 'zcode'), 'ppt-design-pro', '0.0.9');
  const freeUser = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9', 'renamed-user');
  const freeProject = await writeSkill(projectRoot(f, 'zcode'), 'ppt-design', '0.1.0');
  const other = await writeSkill(root(f, 'qwenwork'), 'ppt-design', '0.1.0');
  const before = await snapshot(other);
  const result = await f.run(['update', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.equal(value.updated_count, 1);
  assert.deepEqual(value.installations, [{ name: 'ppt-design-pro', path: pro, previous: '0.0.9', version: '0.2.0' }]);
  assert.deepEqual(sorted(value.removed), sorted([freeUser, freeProject]));
  assert.deepEqual(value.warnings, []);
  for (const directory of [freeUser, freeProject]) await absent(directory);
  assert.equal(await versionOf(pro), '0.2.0');
  assert.deepEqual(await snapshot(other), before, 'qwenwork 的免费版不因 zcode 装付费版被清（sameAgentRoots 归属）');
});

// security-MEDIUM-2b 重写：纯清理批次（0 替换 >0 移除）交互要确认、非交互要 auto_confirmed
// 警示行；quality-LOW-7：纯清理批次打 cleanup_only 标记（status 仍 up_to_date）。
test('update 已最新也清理遗留免费版：交互确认「移除 N 个免费版？」，非交互打 auto_confirmed 警示 + cleanup_only', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  const pro = await writeSkill(root(f, 'zcode'), 'ppt-design-pro', '0.2.0');
  const before = await snapshot(pro);
  // 交互拒绝：纯清理批次同样要确认，拒绝则免费版保留。
  const free = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9');
  const declined = await f.run(['update', '--json'], { HY_TOKEN: TOKEN }, { interactive: true, answers: [false] });
  assert.equal(declined.code, 0, declined.stdout + declined.stderr);
  const cancelled = data(declined);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.removed, []);
  assert.ok(await exists(free), '拒绝确认时免费版不被移除');
  assert.match(declined.trace.questions[0], /移除 1 个免费版？ \[Y\/n\]/);
  // 交互接受：移除执行，纯清理批次打 cleanup_only（status 仍 up_to_date）。
  const accepted = await f.run(['update', '--json'], { HY_TOKEN: TOKEN }, { interactive: true, answers: [true] });
  assert.equal(accepted.code, 0, accepted.stdout + accepted.stderr);
  const value = data(accepted);
  assert.equal(value.status, 'up_to_date');
  assert.equal(value.updated_count, 0);
  assert.deepEqual(value.installations, []);
  assert.deepEqual(value.removed, [free]);
  assert.equal(value.cleanup_only, true, '纯清理批次打 cleanup_only 标记');
  await absent(free);
  assert.deepEqual(await snapshot(pro), before, '已最新的付费版不动');
  // 非交互：静默确认要有警示行。
  const again = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9');
  const human = await f.run(['update'], { HY_TOKEN: TOKEN });
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /非交互模式：已自动确认移除免费版。/);
  await absent(again);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '无更新不下载');
});

test('清理保护三态：免费版是链接、在开发目录、无法识别目录 → 跳过并解释（中英文）；可识别的照常移除', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  const user = root(f, 'zcode');
  const development = await writeSkill(user, 'ppt-design', '0.0.9', 'dev-free');
  await mkdir(path.join(development, 'nested', '.git'), { recursive: true });
  const external = await writeSkill(path.join(f.temporary, 'external'), 'ppt-design', '0.0.9');
  const linked = path.join(user, 'linked-free');
  await linkDirectory(external, linked);
  const unknown = path.join(user, 'ppt-design');
  await mkdir(unknown, { recursive: true });
  await writeFile(path.join(unknown, 'SKILL.md'), '# no frontmatter\n');
  const removable = await writeSkill(user, 'ppt-design', '0.0.9', 'removable-free');
  const before = await Promise.all([development, external].map(snapshot));
  const result = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.removed, [removable]);
  assert.deepEqual(value.skipped, [
    { name: 'ppt-design', path: development, reason: 'development_directory' },
    { name: 'ppt-design', path: linked, reason: 'symbolic_link' },
    { name: 'ppt-design', path: unknown, reason: 'unrecognized_skill' },
  ]);
  assert.equal(value.warnings.length, 1, '遗留免费版与付费版同宿主仍提示冲突');
  assert.match(value.warnings[0], /ppt-design 和 ppt-design-pro 两个版本同时装/);
  await absent(removable);
  assert.equal(await readDirectoryLink(linked), external, '被保护链接原样保留');
  assert.deepEqual(await Promise.all([development, external].map(snapshot)), before);
  const zh = await f.run(['install', 'ppt-design-pro', '--to', 'zcode'], { HY_TOKEN: TOKEN });
  assert.equal(zh.code, 0, zh.stdout + zh.stderr);
  assert.match(zh.stdout, /开发目录，跳过/);
  assert.match(zh.stdout, /符号链接指向的目录，跳过/);
  assert.match(zh.stdout, /SKILL\.md 无法识别为此 Skill，跳过/);
  const en = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--lang', 'en'], { HY_TOKEN: TOKEN });
  assert.equal(en.code, 0, en.stdout + en.stderr);
  assert.match(en.stdout, /development directory, skipped/);
  assert.match(en.stdout, /directory referenced by a symbolic link, skipped/);
  assert.match(en.stdout, /SKILL\.md does not identify this skill, skipped/);
});

test('链接指向的免费版真实目标受保护：实体与别名链接都跳过，不因扫描去重漏保护', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  const free = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9');
  await mkdir(projectRoot(f, 'zcode'), { recursive: true });
  const alias = path.join(projectRoot(f, 'zcode'), 'free-alias');
  await linkDirectory(free, alias);
  const before = await snapshot(free);
  const result = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.removed, []);
  assert.deepEqual(sorted(value.skipped.map((item) => item.path)), sorted([free, alias]));
  assert.ok(value.skipped.every((item) => item.reason === 'symbolic_link'));
  assert.equal(await readDirectoryLink(alias), free, '别名链接原样保留');
  assert.deepEqual(await snapshot(free), before, '链接的真实目标不受清理影响');
});

test('批量安装中某宿主的付费位被保护链接占用：该宿主不安装也不清理，其他宿主照常', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  const claude = root(f, 'claude');
  const external = await writeSkill(path.join(f.temporary, 'external'), 'ppt-design', '0.0.9');
  await mkdir(claude, { recursive: true });
  const linked = path.join(claude, 'ppt-design-pro');
  await linkDirectory(external, linked);
  const retained = await writeSkill(projectRoot(f, 'claude'), 'ppt-design', '0.1.0');
  const removed = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9');
  const before = await Promise.all([external, retained].map(snapshot));
  const result = await f.run(['install', 'ppt-design-pro', '--to', 'claude', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.removed, [removed]);
  assert.deepEqual(value.installations.map((item) => item.path), [path.join(root(f, 'zcode'), 'ppt-design-pro')]);
  assert.deepEqual(value.skipped, [{ name: 'ppt-design', path: linked, reason: 'symbolic_link' }]);
  assert.equal(await readDirectoryLink(linked), external);
  assert.deepEqual(await Promise.all([external, retained].map(snapshot)), before);
  await absent(removed);
});

test('update --path 自定义目录只清理同目录：无法归属宿主组的目录不外溢', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  const custom = path.join(f.cwd, 'custom-skills');
  const pro = await writeSkill(custom, 'ppt-design-pro', '0.0.9');
  const free = await writeSkill(custom, 'ppt-design', '0.0.9', 'custom-free');
  const other = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9');
  const before = await snapshot(other);
  const result = await f.run(['update', '--path', pro, '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.equal(value.updated_count, 1);
  assert.deepEqual(value.removed, [free]);
  await absent(free);
  assert.equal(await versionOf(pro), '0.2.0');
  assert.deepEqual(await snapshot(other), before, '定点目录之外的免费版不动');
});

test('反例：无配对的付费 skill 安装不清理任何东西', async (t) => {
  const f = await fixture(t);
  // paid-only 商品（无 free 配对）：清理逻辑对它不产生任何动作。
  f.state.catalog.push({ id: 'solo', name: 'Solo', summary: '', summaryEn: '', free: null, paid: { skill: 'solo-pro' },
    offer: ['lifetime'], prices: { lifetime: { amount: 1900, currency: 'cny', interval: null } } });
  await writeSkill(f.cwd, 'solo-pro', '0.1.0');
  const published = await f.run(['publish', 'solo-pro', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(published.code, 0, published.stdout + published.stderr);
  const free = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9');
  const result = await f.run(['install', 'solo-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.removed, []);
  assert.deepEqual(value.skipped, []);
  assert.deepEqual(value.installations, [{ name: 'solo-pro', path: path.join(root(f, 'zcode'), 'solo-pro'), previous: null, version: '0.1.0' }]);
  assert.ok(await exists(free), '无配对的付费安装不得动其他商品的免费版');
});

test('unlockedSkills 缓存：同批两处同 skill 只购买一次；同批已购的其他付费 skill 不再购买', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  // 第二个付费商品 other-pro（本令牌已购）；购买走 status 履约（grants 追加，不清空 other-pro 的授权）。
  f.state.catalog.push({ id: 'other', name: 'Other', summary: '', summaryEn: '', free: null, paid: { skill: 'other-pro' },
    offer: ['lifetime'], prices: { lifetime: { amount: 900, currency: 'cny', interval: null } } });
  await writeSkill(f.cwd, 'other-pro', '0.1.0');
  const published = await f.run(['publish', 'other-pro', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(published.code, 0, published.stdout + published.stderr);
  f.state.grants.set(TOKEN, ['other-pro']);
  f.state.checkoutActiveAfter = Infinity; // me 轮询不直接解锁
  f.state.checkoutStatusActiveAfter = 1;  // 首次 status 查询即付款完成+履约（grants 追加）
  const proA = await writeSkill(root(f, 'zcode'), 'ppt-design-pro', '0.0.9');
  const proB = await writeSkill(root(f, 'claude'), 'ppt-design-pro', '0.0.9', 'copy-b');
  const other = await writeSkill(root(f, 'claude'), 'other-pro', '0.0.9');
  const result = await f.run(['update', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const output = events(result);
  assert.deepEqual(output.map((event) => event.event), ['checkout', 'subscribed', undefined]);
  const value = output.at(-1);
  assert.equal(value.updated_count, 3);
  assert.deepEqual(sorted(value.installations.map((item) => item.path)), sorted([proA, proB, other]));
  assert.equal(f.state.checkoutRequests, 1, '同批两处 ppt-design-pro 只购买一次（unlockedSkills 缓存）');
  assert.equal(await versionOf(proA), '0.2.0');
  assert.equal(await versionOf(proB), '0.2.0');
  assert.equal(await versionOf(other), '0.1.0');
});

test('removedFree 双语文案：中文/英文安装输出列明被移除的免费版', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  const free = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9', 'custom-free');
  const zh = await f.run(['install', 'ppt-design-pro', '--to', 'zcode'], { HY_TOKEN: TOKEN });
  assert.equal(zh.code, 0, zh.stdout + zh.stderr);
  assert.ok(zh.stdout.includes(`已移除同一 Agent 里的 ppt-design：${free}`), zh.stdout);
  await absent(free);
  await writeSkill(root(f, 'zcode'), 'ppt-design', '0.1.0', 'custom-free');
  const en = await f.run(['install', 'ppt-design-pro', '--to', 'zcode', '--lang', 'en'], { HY_TOKEN: TOKEN });
  assert.equal(en.code, 0, en.stdout + en.stderr);
  assert.ok(en.stdout.includes(`Removed ppt-design from the same Agent: ${free}`), en.stdout);
  await absent(free);
});

// —— 三路审查修复（security HIGH-1 / MEDIUM-2/3、spec-MINOR、quality LOW）——

test('HIGH-1：订阅失效 + 付费版已最新 → 清理不越过权益闸门：免费版保留、冲突警告照报', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  await writeSkill(root(f, 'zcode'), 'ppt-design-pro', '0.2.0');
  const free = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.1.0');
  f.state.grants.set(TOKEN, []);
  const before = await snapshot(free);
  const result = await f.run(['update', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.equal(value.status, 'up_to_date');
  assert.deepEqual(value.removed, [], '无有效权益不得清理同宿主免费版');
  assert.deepEqual(value.skipped, []);
  assert.deepEqual(await snapshot(free), before);
  assert.equal(value.warnings.length, 1, '免费版保留 → 共存冲突警告照报');
  assert.match(value.warnings[0], /ppt-design 和 ppt-design-pro 两个版本同时装/);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')));
  // 未登录同样不清理，且不为清理决策发起设备码登录（fail-safe：跳过清理、保留警告）。
  const anonymous = await f.run(['update', '--json']);
  assert.equal(anonymous.code, 0, anonymous.stdout + anonymous.stderr);
  assert.deepEqual(data(anonymous).removed, []);
  assert.deepEqual(await snapshot(free), before);
  assert.ok(!f.state.requests.some((r) => r.path === '/api/cli/device'), '清理判定不得发起登录');
});

test('MEDIUM-3：用法校验先于付款——未购付费 install 无宿主 → missing_target exit 2，不创建付款会话', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  f.state.grants.set(TOKEN, []);
  const result = await f.run(['install', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 2);
  assert.equal(data(result).error, 'missing_target');
  assert.equal(f.state.checkoutRequests, 0, '用法校验失败不得进入付款');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')));
  // 已购（或购买完成）后的正常路径仍是一条命令完成购买+安装（前述用例覆盖），此处只钉顺序。
});

test('MEDIUM-2a：install 确认文案计入移除——「安装 X 并移除 N 个免费版？」；拒绝则安装与移除都不动', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  const free = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9');
  const yes = await f.run(['install', 'ppt-design-pro', '--to', 'zcode'], { HY_TOKEN: TOKEN }, { interactive: true, answers: [true] });
  assert.equal(yes.code, 0, yes.stdout + yes.stderr);
  assert.match(yes.trace.questions[0], /安装 ppt-design-pro 并移除 1 个免费版？ \[Y\/n\]/);
  await absent(free);
  // 拒绝：安装与移除都不发生。
  const again = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9');
  const no = await f.run(['install', 'ppt-design-pro', '--to', 'zcode'], { HY_TOKEN: TOKEN }, { interactive: true, answers: [false] });
  assert.equal(no.code, 0, no.stdout + no.stderr);
  assert.ok(no.stdout.endsWith('已取消安装。\n'), no.stdout);
  assert.ok(await exists(again), '拒绝确认时免费版不被移除');
  assert.equal(await versionOf(again), '0.0.9');
  assert.equal(await versionOf(path.join(root(f, 'zcode'), 'ppt-design-pro')), '0.2.0', '已装的付费版不动');
});

test('MEDIUM-2c：混合批次确认文案计入移除——「更新 N 处并移除 M 个免费版？」', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  const pro = await writeSkill(root(f, 'zcode'), 'ppt-design-pro', '0.0.9');
  const free = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9');
  const result = await f.run(['update'], { HY_TOKEN: TOKEN }, { interactive: true, answers: [true] });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.trace.questions[0], /更新 1 处安装并移除 1 个免费版？ \[Y\/n\]/);
  assert.equal(await versionOf(pro), '0.2.0');
  await absent(free);
});

test('spec：数据驱动正例——第二组配对商品的付费版安装同样清理其免费版（堵按名分支回归）', async (t) => {
  const f = await fixture(t);
  f.state.catalog.push({ id: 'other', name: 'Other', summary: '', summaryEn: '', free: { skill: 'other' }, paid: { skill: 'other-pro' },
    offer: ['lifetime'], prices: { lifetime: { amount: 900, currency: 'cny', interval: null } } });
  await writeSkill(f.cwd, 'other', '0.1.0');
  await writeSkill(f.cwd, 'other-pro', '0.2.0');
  for (const skill of ['other', 'other-pro']) {
    const published = await f.run(['publish', skill, '--json'], { HY_TOKEN: TOKEN });
    assert.equal(published.code, 0, published.stdout + published.stderr);
  }
  const otherFree = await writeSkill(root(f, 'zcode'), 'other', '0.0.9');
  const pptFree = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9');
  const result = await f.run(['install', 'other-pro', '--to', 'zcode', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.removed, [otherFree], '新配对商品的免费版被清理');
  assert.deepEqual(value.skipped, []);
  await absent(otherFree);
  assert.ok(await exists(pptFree), '其他商品的免费版不受影响');
  assert.deepEqual(value.installations, [{ name: 'other-pro', path: path.join(root(f, 'zcode'), 'other-pro'), previous: null, version: '0.2.0' }]);
});

test('spec：remove 动作并入整批事务——中途 rename 失败免费版完整还原（备份链实证）', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  const pro = await writeSkill(root(f, 'zcode'), 'ppt-design-pro', '0.0.9');
  const free = await writeSkill(root(f, 'zcode'), 'ppt-design', '0.0.9');
  const before = await snapshot(free);
  // 第 3 次 rename 是免费版挪备份时：付费更新已完全提交，回滚必须把两者都还原。
  const result = await f.run(['update', '--json'], { HY_TOKEN: TOKEN }, { failRenameAt: 3 });
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'replace');
  assert.equal(await versionOf(pro), '0.0.9', '已提交的付费更新要被整批回滚');
  assert.deepEqual(await snapshot(free), before, '免费版完整还原');
  assert.deepEqual(await stageLeftovers(root(f, 'zcode')), []);
});

test('spec：invalidateAccount 判别——第一个购买完成后 me 列出两个授权，第二个不再购买（checkoutRequests===1）', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  f.state.catalog.push({ id: 'other', name: 'Other', summary: '', summaryEn: '', free: null, paid: { skill: 'other-pro' },
    offer: ['lifetime'], prices: { lifetime: { amount: 900, currency: 'cny', interval: null } } });
  await writeSkill(f.cwd, 'other-pro', '0.2.0');
  const published = await f.run(['publish', 'other-pro', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(published.code, 0, published.stdout + published.stderr);
  f.state.grants.set(TOKEN, []);
  // 购买完成（me 轮询到点）时一次性授予两个 skill：模拟服务端把同账号既有授权一并列出。
  f.state.checkoutGrants = ['ppt-design-pro', 'other-pro'];
  const proA = await writeSkill(root(f, 'zcode'), 'ppt-design-pro', '0.0.9');
  const proB = await writeSkill(root(f, 'claude'), 'other-pro', '0.0.9');
  const result = await f.run(['update', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const output = events(result);
  assert.deepEqual(output.map((event) => event.event), ['checkout', 'subscribed', undefined]);
  assert.equal(output.at(-1).updated_count, 2);
  assert.equal(f.state.checkoutRequests, 1, '第二个未购付费 skill 经刷新后的快照直接放行，不再购买');
  assert.equal(await versionOf(proA), '0.2.0');
  assert.equal(await versionOf(proB), '0.2.0');
});

test('LOW-6：免费版恰好装在付费版位置 → 原位替换，removed 条目附 replaced_by 消歧', async (t) => {
  const f = await fixture(t);
  await publishPaid(f);
  const custom = path.join(f.cwd, 'custom-skills');
  // 目录名是付费版规范名，内容却是免费版：安装付费版时原位替换（replacesFree）。
  const free = await writeSkill(custom, 'ppt-design', '0.0.9', 'ppt-design-pro');
  const human = await f.run(['install', 'ppt-design-pro', '--to', custom], { HY_TOKEN: TOKEN });
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.ok(human.stdout.includes(`已移除同一 Agent 里的 ppt-design：${free}`), human.stdout);
  // 再造一次同场景验证 JSON：removed 条目附 replaced_by（与纯 remove 的字符串条目区分）。
  await writeSkill(custom, 'ppt-design', '0.0.9', 'ppt-design-pro');
  const result = await f.run(['install', 'ppt-design-pro', '--to', custom, '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.removed, [{ path: free, replaced_by: 'ppt-design-pro' }]);
  assert.deepEqual(value.installations, [{ name: 'ppt-design-pro', path: free, previous: null, version: '0.2.0' }]);
  assert.equal(await versionOf(free), '0.2.0');
});
