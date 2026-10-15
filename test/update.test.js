import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { fixture, writeSkill, linkDirectory, readDirectoryLink, TOKEN } from './fixture.js';
import { command } from '../src/i18n.js';

const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};
const exists = async (file) => { try { return await lstat(file); } catch { return null; } };
const stageLeftovers = async (root) => (await readdir(root, { recursive: false }).catch((error) => error.code === 'ENOENT' ? [] : (() => { throw error; })())).filter((name) => name.startsWith('.hy-stage-'));
const versionOf = async (directory) => ((await readFile(path.join(directory, 'SKILL.md'), 'utf8')).match(/version: "([^"]+)"/) || [])[1];

// 二期任务 1：hy update 全量更新——链接只更新实体、整批事务、定点/过滤/开发目录/回滚/up_to_date。

test('链接种：链接宿主里的旧版本只更新真实目录，链接保持指向且新版本即刻生效（status 复核）', async (t) => {
  const f = await fixture(t);
  const real = await writeSkill(path.join(f.temporary, 'store'), 'ppt-design', '0.0.9');
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
  // 链接原样保留且指向不变；透过链接读到的已是新版本（更新一次全部生效）。
  assert.ok((await lstat(linked)).isSymbolicLink(), '链接不应被换成独立副本');
  assert.equal(await readDirectoryLink(linked), real);
  assert.equal(await versionOf(linked), '0.1.0');
  // status 复核：一份实体、real_path 与版本正确、无多副本警告。
  const status = data(await f.run(['status', '--json']));
  assert.equal(status.installations.length, 1);
  assert.equal(status.installations[0].path, linked);
  assert.equal(status.installations[0].real_path, await realpath(real));
  assert.equal(status.installations[0].current, '0.1.0');
  assert.deepEqual(status.warnings, []);
  // 文本通道：updated 行（previous → version）与非交互自动确认提示（先把实体降回旧版本再跑一次）。
  await writeSkill(path.join(f.temporary, 'store'), 'ppt-design', '0.0.9');
  const human = await f.run(['update']);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, new RegExp(`已更新 ppt-design：0\\.0\\.9 → 0\\.1\\.0（${real.replaceAll('\\', '\\\\')}）`));
  assert.match(human.stdout, /非交互模式：已自动确认更新。/);
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

test('conflicts 复扫判别例：同宿主根装 ppt-design + ppt-design-pro 跑 update → warnings 含 conflict 行', async (t) => {
  const f = await fixture(t);
  const free = await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design', '0.0.9');
  // 付费版已最新（0.1.0）：不进 pending，也就不触发付费闸门，纯当冲突警告的另一半存在。
  await writeSkill(path.join(f.home, '.zcode', 'skills'), 'ppt-design-pro', '0.1.0');
  const result = await f.run(['update', '--json']);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const value = data(result);
  assert.equal(await versionOf(free), '0.1.0');
  assert.equal(value.warnings.length, 1);
  assert.match(value.warnings[0], /ppt-design 和 ppt-design-pro 两个版本同时装/);
  // up_to_date 的复扫同样报告冲突（警告不依赖是否有动作发生）。
  const human = await f.run(['update']);
  assert.equal(human.code, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /已安装的 Skill 无需更新。/);
  assert.match(human.stdout, /ppt-design 和 ppt-design-pro 两个版本同时装/);
});

test('--path 指向链接安装：动作落真实目标，链接不动', async (t) => {
  const f = await fixture(t);
  const real = await writeSkill(path.join(f.temporary, 'store'), 'ppt-design', '0.0.9');
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

test('混合批量：免费过期 + 未购付费过期 → exit 3 指向未购付费 skill，免费未被安装（整批原子）', async (t) => {
  const f = await fixture(t);
  const paid = await publishPaid(f);
  const free = await writeSkill(path.join(f.home, '.claude', 'skills'), 'ppt-design', '0.0.9');
  f.state.grants.set(TOKEN, []);
  const result = await f.run(['update', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 3);
  const value = data(result);
  assert.equal(value.ok, false);
  assert.equal(value.error, 'inactive');
  assert.equal(value.subscribe_command, command('subscribe', 'ppt-design-pro'));
  assert.equal(value.subscription_url, `${f.base}/store/ppt-design-pro/`);
  assert.match(value.message, /尚未购买 ppt-design-pro/);
  // 整批未开始：付费与免费目标都保持原版本，且没有发生任何下载。
  assert.equal(await versionOf(paid), '0.0.9', '付费目标不应被更新');
  assert.equal(await versionOf(free), '0.0.9', '免费目标不应装一半');
  assert.ok(!f.state.requests.some((r) => r.path.startsWith('/api/store/download')), '权益拦截不应进入下载');
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
