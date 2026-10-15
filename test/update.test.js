import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { access, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { fixture, writeSkill, linkDirectory, readDirectoryLink, TOKEN } from './fixture.js';
import { command } from '../src/i18n.js';

const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};
const exists = async (file) => { try { return await lstat(file); } catch { return null; } };
const absent = (directory) => assert.rejects(access(directory), { code: 'ENOENT' });
const stageLeftovers = async (root) => (await readdir(root, { recursive: false }).catch((error) => error.code === 'ENOENT' ? [] : (() => { throw error; })())).filter((name) => name.startsWith('.hy-stage-'));
const versionOf = async (directory) => ((await readFile(path.join(directory, 'SKILL.md'), 'utf8')).match(/version: "([^"]+)"/) || [])[1];

// 二期任务 1：hy update 全量更新——链接只更新实体、整批事务、定点/过滤/开发目录/回滚/up_to_date。

// 三审 HIGH-1：update 写穿白名单生效后，链接种的真实目标迁入宿主根内（合法多宿主共享形态）。
test('链接种：链接宿主里的旧版本只更新真实目录（真实目标在另一宿主根内→放行），链接保持指向且新版本即刻生效（status 复核）', async (t) => {
  const f = await fixture(t);
  const real = await writeSkill(path.join(f.home, '.claude', 'skills'), 'ppt-design', '0.0.9');
  const linked = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  await mkdir(path.dirname(linked), { recursive: true });
  await linkDirectory(real, linked);
  const result = await f.run(['update', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  // 只更新链接指向的真实目录：动作落在 real，链接本身不在动作列表里。
  assert.deepEqual(value.installations, [{ name: 'ppt-design', path: real, previous: '0.0.9', version: '0.1.0' }]);
  assert.equal(value.status, 'updated');
  assert.equal(value.found_count, 1);
  assert.equal(value.eligible_count, 1);
  assert.equal(value.updated_count, 1);
  assert.equal(value.auto_confirmed, true);
  assert.equal(await versionOf(real), '0.1.0');
  // update 成功输出附本次产生的备份路径（三审 spec-MINOR：JSON 字段双向）。
  assert.ok(Array.isArray(value.retained_backups) && value.retained_backups.length === 1, JSON.stringify(value.retained_backups));
  assert.ok(value.retained_backups[0].startsWith(path.dirname(real)), value.retained_backups[0]);
  // 链接原样保留且指向不变；透过链接读到的已是新版本（更新一次全部生效）。
  assert.ok((await lstat(linked)).isSymbolicLink(), '链接不应被换成独立副本');
  assert.equal(await readDirectoryLink(linked), real);
  assert.equal(await versionOf(linked), '0.1.0');
  // status 复核：一份实体、real_path 与版本正确、无多副本警告；被更新的旧副本留有备份提示（M1）。
  const status = data(await f.run(['status', '--json']));
  assert.equal(status.installations.length, 1);
  assert.equal(status.installations[0].path, linked);
  assert.equal(status.installations[0].real_path, await realpath(real));
  assert.equal(status.installations[0].current, '0.1.0');
  assert.equal(status.warnings.length, 1);
  assert.ok(status.warnings[0].startsWith(`旧版本备份保留在：${path.dirname(real)}`), status.warnings[0]);
  // 文本通道：updated 行（previous → version）与非交互自动确认提示（先把实体降回旧版本再跑一次）。
  await writeSkill(path.join(f.home, '.claude', 'skills'), 'ppt-design', '0.0.9');
  const human = await f.run(['update']);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, new RegExp(`已更新 ppt-design：0\\.0\\.9 → 0\\.1\\.0（${real.replaceAll('\\', '\\\\')}）`));
  assert.match(human.stdout, /非交互模式：已自动确认更新。/);
});

// —— 三审 HIGH-1：update 路径写穿白名单（与 install 规划期同一判定 + replaceAll 执行期复检） ——

test('M2：update 主位链接指向管辖范围之外 → occupied 拒绝并解释，不下载、链接与真实目标不动', async (t) => {
  const f = await fixture(t);
  const real = await writeSkill(path.join(f.temporary, 'store'), 'ppt-design', '0.0.9');
  const linked = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  await mkdir(path.dirname(linked), { recursive: true });
  await linkDirectory(real, linked);
  const result = await f.run(['update', '--json']);
  assert.equal(result.code, 1);
  const value = data(result);
  assert.equal(value.error, 'occupied');
  assert.match(value.message, /CLI 管理范围之外的目录/);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '拒绝发生在下载之前');
  // 链接与真实目标都原样保留，不写穿。
  assert.equal(await readDirectoryLink(linked), real);
  assert.equal(await versionOf(real), '0.0.9');
  const english = await f.run(['update', '--lang', 'en']);
  assert.equal(english.code, 1);
  assert.match(english.stderr, /outside the directories this CLI manages/);
});

test('M2：update --path 指向链接位同判定——真实目标在宿主根内放行；范围外 → occupied 拒绝不下载', async (t) => {
  const f = await fixture(t);
  // 放行侧：真实目标在 claude 宿主根内（合法多宿主共享），--path 定点更新真实目录。
  const real = await writeSkill(path.join(f.home, '.claude', 'skills'), 'ppt-design', '0.0.9');
  const linked = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  await mkdir(path.dirname(linked), { recursive: true });
  await linkDirectory(real, linked);
  const allowed = await f.run(['update', '--path', linked, '--json']);
  assert.equal(allowed.code, 0, allowed.stdout + allowed.stderr);
  assert.deepEqual(data(allowed).installations, [{ name: 'ppt-design', path: real, previous: '0.0.9', version: '0.1.0' }]);
  assert.equal(await versionOf(real), '0.1.0');
  // 拒绝侧：真实目标在管辖范围之外，--path 指向链接位同样按 occupied 拒绝。
  const outside = await writeSkill(path.join(f.temporary, 'store'), 'oracle-bone', '0.0.9');
  const linkedOutside = path.join(f.home, '.zcode', 'skills', 'oracle-bone');
  await linkDirectory(outside, linkedOutside);
  const rejected = await f.run(['update', '--path', linkedOutside, '--json']);
  assert.equal(rejected.code, 1);
  assert.equal(data(rejected).error, 'occupied');
  assert.match(data(rejected).message, /CLI 管理范围之外的目录/);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download/oracle-bone')), '拒绝侧的 skill 不下载（放行侧的 ppt-design 下载不计入）');
  assert.equal(await versionOf(outside), '0.0.9', '范围外真实目标不写穿');
});

test('M2：交互确认前透出写穿目标——链接位显示「→ 真实目录」，确认后更新落在真实目录', async (t) => {
  const f = await fixture(t);
  const real = await writeSkill(path.join(f.home, '.claude', 'skills'), 'ppt-design', '0.0.9');
  const linked = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  await mkdir(path.dirname(linked), { recursive: true });
  await linkDirectory(real, linked);
  const result = await f.run(['update'], {}, { interactive: true, answers: [true] });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes(`链接位 ${linked} → 真实目录：${real}`), result.stdout);
  assert.equal(result.trace.questions.length, 1, '确认提问照常一次');
  assert.equal(await versionOf(real), '0.1.0');
});

test('多副本种：多宿主多副本各自更新、同名只下载一次、多副本警告保留、counts 形状完整', async (t) => {
  const f = await fixture(t);
  const zcode = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.9');
  const claude = await writeSkill(path.join(f.home, '.claude', 'skills'), 'ppt-design', '0.0.8', 'my-ppt');
  const current = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'oracle-bone', '0.1.0');
  const result = await f.run(['update', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  // counts JSON 形状：found/eligible/updated + status。
  assert.equal(value.found_count, 3);
  assert.equal(value.eligible_count, 3);
  assert.equal(value.updated_count, 2);
  assert.equal(value.status, 'updated');
  // 两份独立副本各自更新到最新；未过期的 oracle-bone 不在 installations 里。
  assert.equal(await versionOf(zcode), '0.1.0');
  assert.equal(await versionOf(claude), '0.1.0');
  assert.equal(await versionOf(current), '0.1.0');
  assert.deepEqual(value.installations.map((item) => [item.path, item.previous, item.version]).sort(),
    [[zcode, '0.0.9', '0.1.0'], [claude, '0.0.8', '0.1.0']].sort());
  // 同名多副本共享一次下载（apply 按 Skill 名去重准备）。
  assert.equal(f.state.requests.filter((r) => r.path === '/api/store/download/ppt-design').length, 1);
  assert.equal(f.state.requests.filter((r) => r.path === '/api/store/download/oracle-bone').length, 0);
  // 副本仍是独立目录：复扫的多副本警告保留（提示合并成一份）。
  assert.equal(value.warnings.length, 1);
  assert.match(value.warnings[0], /2 份独立副本/);
});

test('定点种：--path 只更新指定目录；未知目录与 --skill 不匹配拒绝', async (t) => {
  const f = await fixture(t);
  const zcode = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.9');
  const claude = await writeSkill(path.join(f.home, '.claude', 'skills'), 'ppt-design', '0.0.8');
  const result = await f.run(['update', '--path', zcode, '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.installations, [{ name: 'ppt-design', path: zcode, previous: '0.0.9', version: '0.1.0' }]);
  assert.equal(value.found_count, 1);
  assert.equal(value.updated_count, 1);
  assert.equal(value.status, 'updated');
  // 定点不扫其他宿主：claude 旧副本原样保留，也不报多副本警告（单根视野）。
  assert.equal(await versionOf(claude), '0.0.8');
  assert.deepEqual(value.warnings, []);
  // 未知目录（存在但无可识别 Skill）→ exit 2 unknown_installation。
  const empty = path.join(f.cwd, 'empty-dir');
  await mkdir(empty);
  const unknown = await f.run(['update', '--path', empty, '--json']);
  assert.equal(unknown.code, 2);
  assert.equal(data(unknown).error, 'unknown_installation');
  assert.match((await f.run(['update', '--path', empty])).stderr, /没有可识别的 Skill/);
  // 目录里装的是 oracle-bone，与 --skill ppt-design 不符 → exit 2 skill_mismatch。
  const oracle = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'oracle-bone', '0.0.9');
  const mismatch = await f.run(['update', 'ppt-design', '--path', oracle, '--json']);
  assert.equal(mismatch.code, 2);
  assert.equal(data(mismatch).error, 'skill_mismatch');
  assert.match(data(mismatch).message, /与 ppt-design 不符/);
});

test('开发目录种：skipped 只报一次且内容不动；全部为开发目录 → skipped 状态且不打版本表', async (t) => {
  const f = await fixture(t);
  const dev = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.9');
  await mkdir(path.join(dev, '.git'));
  const normal = await writeSkill(path.join(f.home, '.claude', 'skills'), 'ppt-design', '0.0.8');
  const result = await f.run(['update', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.skipped, [{ name: 'ppt-design', path: dev, reason: 'development_directory' }]);
  assert.equal(value.found_count, 2);
  assert.equal(value.eligible_count, 1);
  assert.equal(value.updated_count, 1);
  assert.equal(await versionOf(dev), '0.0.9', '开发目录内容不动');
  assert.equal(await versionOf(normal), '0.1.0');
  assert.match((await f.run(['update'])).stdout, new RegExp(`ppt-design：开发目录，跳过（${dev.replaceAll('\\', '\\\\')}）`));
  // 全为开发目录：状态 skipped，不再打版本表也不发起下载。
  await rm(normal, { recursive: true, force: true });
  const versionsCalls = f.state.requests.filter((r) => r.path === '/api/store/versions').length;
  const downloads = f.state.requests.filter((r) => r.path.startsWith('/api/store/download')).length;
  const all = await f.run(['update', '--json']);
  assert.equal(all.code, 0);
  const allValue = data(all);
  assert.equal(allValue.status, 'skipped');
  assert.equal(allValue.found_count, 1);
  assert.equal(allValue.eligible_count, 0);
  assert.equal(allValue.updated_count, 0);
  assert.equal(f.state.requests.filter((r) => r.path === '/api/store/versions').length, versionsCalls, '全开发目录不打版本表');
  assert.equal(f.state.requests.filter((r) => r.path.startsWith('/api/store/download')).length, downloads);
  assert.equal(await versionOf(dev), '0.0.9');
});

test('注入回滚种：批量中途 rename 失败 → 整批回滚，两处旧版本完整保留且无暂存残留', async (t) => {
  const f = await fixture(t);
  const zcode = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.9');
  const claude = await writeSkill(path.join(f.home, '.claude', 'skills'), 'ppt-design', '0.0.8');
  // 第 3 次 rename 是第二处安装挪备份时：第一处已完全提交，回滚必须把它还原。
  const result = await f.run(['update', '--json'], {}, { failRenameAt: 3 });
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'replace');
  assert.equal(await versionOf(zcode), '0.0.9', '已提交的第一处要被整批回滚还原');
  assert.equal(await versionOf(claude), '0.0.8');
  assert.deepEqual(await stageLeftovers(path.dirname(zcode)), []);
  assert.deepEqual(await stageLeftovers(path.dirname(claude)), []);
});

test('下载前占用预检：scan 与执行之间目标被换成无关内容 → occupied 且不下载整包', async (t) => {
  const f = await fixture(t);
  const target = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.9');
  // 版本表响应被压住 500ms：scan 已完成（看到的还是旧版本），窗口内第三方把目标换成无关内容。
  f.state.versionsDelay = 500;
  const pending = f.run(['update', '--json']);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !f.state.requests.some((r) => r.path === '/api/store/versions')) await delay(20);
  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'unrelated.txt'), 'not ours');
  const result = await pending;
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'occupied');
  // 无关内容原样保留；整包尚未下载（预检在下载之前，不给重定向目标任何被请求的机会）。
  assert.equal(await readFile(path.join(target, 'unrelated.txt'), 'utf8'), 'not ours');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '占用预检应在下载之前');
  assert.deepEqual(await stageLeftovers(path.dirname(target)), []);
});

// 三审 LOW-9②：声明过 previousName 的位在预检期变成悬空链接 → occupied fail-closed
//（M4 的跳过语义只覆盖「无既有内容声明的链接位」，不因放宽误吞有内容声明的位）。
test('M4：声明过 previousName 的位变悬空链接（下载前竞态）→ occupied 拒绝且不下载', async (t) => {
  const f = await fixture(t);
  const target = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.9');
  f.state.versionsDelay = 500;
  const pending = f.run(['update', '--json']);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && !f.state.requests.some((r) => r.path === '/api/store/versions')) await delay(20);
  // 窗口内：原目录被换成悬空链接（有 previousName 声明的位）——不得按 dangling_link 跳过装过去。
  await rm(target, { recursive: true, force: true });
  await linkDirectory(path.join(f.temporary, 'missing'), target);
  const result = await pending;
  assert.equal(result.code, 1);
  assert.equal(data(result).error, 'occupied');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '不下载');
  assert.ok((await lstat(target)).isSymbolicLink(), '悬空链接原样保留');
});

// 三审 MEDIUM：过期备份只清「本批涉及 skill」的——无关 skill 的备份不受连带清理。
test('M1：同根 skill A 的备份在场 → 更新 skill B → A 备份保留、B 自己的旧备份清理', async (t) => {
  const f = await fixture(t);
  const root = path.join(f.home, '.zcode', 'skills');
  // A（oracle-bone）已最新但留有旧备份；B（ppt-design）装着旧版且留有自己的旧备份。
  await writeSkill(root, 'oracle-bone', '0.1.0');
  const backupA = path.join(root, '.hy-backup-1000');
  await writeSkill(root, 'oracle-bone', '0.0.1', '.hy-backup-1000');
  await writeSkill(root, 'ppt-design', '0.0.9');
  const backupB = path.join(root, '.hy-backup-1001');
  await writeSkill(root, 'ppt-design', '0.0.1', '.hy-backup-1001');
  const result = await f.run(['update', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  // B 更新（0.0.9 → 0.1.0）：B 的旧备份被清、新备份产生；A 的备份不是本批 skill，原样保留。
  assert.equal(await versionOf(path.join(root, 'ppt-design')), '0.1.0');
  assert.equal(await versionOf(backupA), '0.0.1', 'A 的备份不受 B 的更新连带清理');
  await absent(backupB);
  const fresh = (await readdir(root)).filter((name) => name.startsWith('.hy-backup-') && name !== '.hy-backup-1000');
  assert.equal(fresh.length, 1, 'B 的新备份在场');
  assert.equal(await versionOf(path.join(root, fresh[0])), '0.0.9');
});

// 任务 5 后同宿主的免费版会被配对清理（冲突随之消失）；冲突复扫的判别例改用受保护的开发目录
// 免费版——共存持续存在，update 前后都提示 conflict，且 up_to_date 复扫同样报告。
test('conflicts 复扫判别例：同宿主受保护的免费版与付费版共存 → update 后仍提示 conflict 行', async (t) => {
  const f = await fixture(t);
  const free = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.9');
  await mkdir(path.join(free, '.git'));
  // 付费版已最新（0.1.0）：不进 pending，也就不触发付费闸门，纯当冲突警告的另一半存在。
  await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design-pro', '0.1.0');
  const result = await f.run(['update', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.equal(await versionOf(free), '0.0.9', '开发目录内容不动');
  assert.deepEqual(value.skipped, [{ name: 'ppt-design', path: free, reason: 'development_directory' }]);
  assert.deepEqual(value.removed, [], '受保护的免费版不清理');
  assert.equal(value.status, 'up_to_date');
  assert.equal(value.warnings.length, 1);
  assert.match(value.warnings[0], /ppt-design 和 ppt-design-pro 两个版本同时装/);
  // up_to_date 的复扫同样报告冲突（警告不依赖是否有动作发生）。
  const human = await f.run(['update']);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /已安装的 Skill 无需更新。/);
  assert.match(human.stdout, /ppt-design 和 ppt-design-pro 两个版本同时装/);
});

test('--path 指向链接安装：动作落真实目标（目标在宿主根内→放行），链接不动', async (t) => {
  const f = await fixture(t);
  const real = await writeSkill(path.join(f.home, '.claude', 'skills'), 'ppt-design', '0.0.9');
  const linked = path.join(f.home, '.zcode', 'skills', 'ppt-design');
  await mkdir(path.dirname(linked), { recursive: true });
  await linkDirectory(real, linked);
  const result = await f.run(['update', '--path', linked, '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.installations, [{ name: 'ppt-design', path: real, previous: '0.0.9', version: '0.1.0' }]);
  assert.equal(value.found_count, 1);
  assert.equal(value.updated_count, 1);
  assert.ok((await lstat(linked)).isSymbolicLink(), '定点链接不应被换成独立副本');
  assert.equal(await readDirectoryLink(linked), real);
  assert.equal(await versionOf(real), '0.1.0');
});

test('交互确认接受：回答 yes → 继续更新且不打非交互提示', async (t) => {
  const f = await fixture(t);
  const target = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.9');
  const result = await f.run(['update'], {}, { interactive: true, answers: [true] });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.match(result.trace.questions[0], /更新 1 处安装？ \[Y\/n\]/);
  assert.match(result.stdout, new RegExp(`已更新 ppt-design：0\\.0\\.9 → 0\\.1\\.0（${target.replaceAll('\\', '\\\\')}）`));
  assert.ok(!result.stdout.includes('非交互模式'), '交互确认不是静默确认');
  assert.equal(await versionOf(target), '0.1.0');
});

test('本地版本高于 latest（0.2.0 > 0.1.0）：不降级，up_to_date 且不打下载请求', async (t) => {
  const f = await fixture(t);
  const target = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.2.0');
  const result = await f.run(['update', '--json']);
  assert.equal(result.code, 0);
  const value = data(result);
  assert.equal(value.status, 'up_to_date');
  assert.deepEqual(value.installations, []);
  assert.equal(value.found_count, 1);
  assert.equal(value.eligible_count, 1);
  assert.equal(value.updated_count, 0);
  assert.equal(await versionOf(target), '0.2.0', '高于 latest 的本地版本不降级');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')));
});

test('--path 指向开发目录：skipped 语义正确（跳过、不动内容、不打版本表）', async (t) => {
  const f = await fixture(t);
  const dev = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.9');
  await mkdir(path.join(dev, '.git'));
  const result = await f.run(['update', '--path', dev, '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.equal(value.status, 'skipped');
  assert.deepEqual(value.skipped, [{ name: 'ppt-design', path: dev, reason: 'development_directory' }]);
  assert.equal(value.found_count, 1);
  assert.equal(value.eligible_count, 0);
  assert.equal(value.updated_count, 0);
  assert.equal(await versionOf(dev), '0.0.9', '开发目录内容不动');
  assert.ok(!f.state.requests.some((r) => r.path === '/api/store/versions'), '开发目录定点不打版本表');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')));
  assert.match((await f.run(['update', '--path', dev])).stdout, /开发目录，跳过/);
});

test('up_to_date 种：全部最新 → 状态 up_to_date、空 installations、不打下载请求', async (t) => {
  const f = await fixture(t);
  await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.1.0');
  const result = await f.run(['update', '--json']);
  assert.equal(result.code, 0);
  const value = data(result);
  assert.equal(value.status, 'up_to_date');
  assert.deepEqual(value.installations, []);
  assert.equal(value.found_count, 1);
  assert.equal(value.eligible_count, 1);
  assert.equal(value.updated_count, 0);
  assert.equal('auto_confirmed' in value, false, '无动作被静默确认时不打 auto_confirmed');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '无可更新不应下载');
  assert.equal((await f.run(['update'])).stdout, '已安装的 Skill 无需更新。\n');
});

test('过滤种：update <skill> 只更新指定 Skill；未知 Skill 名拒绝', async (t) => {
  const f = await fixture(t);
  const ppt = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.9');
  const oracle = await writeSkill(path.join(f.home, '.claude', 'skills'), 'oracle-bone', '0.0.9');
  const result = await f.run(['update', 'oracle-bone', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.equal(value.found_count, 1);
  assert.deepEqual(value.installations, [{ name: 'oracle-bone', path: oracle, previous: '0.0.9', version: '0.1.0' }]);
  assert.equal(await versionOf(ppt), '0.0.9', '未指定的 Skill 不动');
  const unknown = await f.run(['update', 'bogus-skill', '--json']);
  assert.equal(unknown.code, 2);
  assert.equal(data(unknown).error, 'unknown_skill');
});

// —— 付费更新路径（二期任务 3）：逐 skill 权益判定，整批原子（未购付费拦截时免费也不装一半） ——

// 发布一个付费版本供下载端点消费（种子发布物只覆盖免费 skill），再装回旧版本制造过期。
const publishPaid = async (f, installed = '0.0.9') => {
  await writeSkill(f.cwd, 'ppt-design-pro', '0.2.0');
  const result = await f.run(['publish', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  return writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design-pro', installed);
};

test('已购付费 skill 过期：update 令牌直连下载更新成功，全程无 302', async (t) => {
  const f = await fixture(t);
  const target = await publishPaid(f);
  const result = await f.run(['update', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.deepEqual(value.installations, [{ name: 'ppt-design-pro', path: target, previous: '0.0.9', version: '0.2.0' }]);
  assert.equal(await versionOf(target), '0.2.0');
  const downloads = f.state.requests.filter((r) => r.path === '/api/store/download/ppt-design-pro');
  assert.deepEqual(downloads.map((r) => r.token), [TOKEN]);
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/releases/')), '付费下载不得 302 到公开附件');
});

// 任务 5 语义改造：未购付费 skill 不再 exit 3 指引 subscribe，而是内联购买（一条命令完成）。
// 购买未完成时整批原子（免费目标也不装一半、免费版不被清理）；解锁后重跑购买+全部更新+清理。
test('混合批量：免费过期 + 未购付费过期 → 内联购买后全部更新+清理同宿主免费版；购买未完成整批不动', async (t) => {
  const f = await fixture(t);
  const paid = await publishPaid(f);
  const paired = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.1.0');
  const free = await writeSkill(path.join(f.home, '.claude', 'skills'), 'oracle-bone', '0.0.9');
  f.state.grants.set(TOKEN, []);
  f.state.checkoutActiveAfter = Infinity;
  const blocked = await f.run(['update', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(blocked.code, 3);
  const pending = JSON.parse(blocked.stdout.trim().split('\n').at(-1));
  assert.equal(pending.error, 'payment_pending');
  assert.equal(pending.skill, 'ppt-design-pro');
  // 整批未开始：付费与免费目标都保持原版本，且没有发生任何下载。
  assert.equal(await versionOf(paid), '0.0.9', '付费目标不应被更新');
  assert.equal(await versionOf(free), '0.0.9', '免费目标不应装一半');
  assert.ok(await exists(paired), '购买未完成不应清理同宿主免费版');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '购买未完成不应进入下载');
  // 付款解锁后重跑：购买 + 全部更新 + 同宿主免费版清理，一条命令完成。
  f.state.checkoutActiveAfter = 2;
  const result = await f.run(['update', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.equal(value.updated_count, 2);
  assert.deepEqual(value.installations.map((item) => [item.name, item.path]).sort(),
    [['ppt-design-pro', paid], ['oracle-bone', free]].sort());
  assert.deepEqual(value.removed, [paired]);
  assert.equal(await versionOf(paid), '0.2.0');
  assert.equal(await versionOf(free), '0.1.0');
  await absent(paired);
});

test('交互确认更新数量；拒绝 → updateCanceled（exit 0）且未动目标', async (t) => {
  const f = await fixture(t);
  const target = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.9');
  const result = await f.run(['update'], {}, { interactive: true, answers: [false] });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.endsWith('已取消更新。\n'), result.stdout);
  assert.match(result.trace.questions[0], /更新 1 处安装？ \[Y\/n\]/);
  assert.equal(await versionOf(target), '0.0.9');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')));
  const json = await f.run(['update', '--json'], {}, { interactive: true, answers: [false] });
  assert.equal(json.code, 0);
  const value = data(json);
  assert.equal(value.status, 'cancelled');
  assert.equal(value.cancelled, true);
  assert.equal(value.updated_count, 0);
});

test('no_installations：本机没有任何商店 Skill → 状态 no_installations', async (t) => {
  const f = await fixture(t);
  const result = await f.run(['update', '--json']);
  assert.equal(result.code, 0);
  const value = data(result);
  assert.equal(value.status, 'no_installations');
  assert.equal(value.found_count, 0);
  assert.deepEqual(value.installations, []);
  assert.match((await f.run(['update'])).stdout, /未发现已安装的商店 Skill。/);
});
