import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fixture, TOKEN, TOKEN2 } from './fixture.js';
import { validateArchive } from '../src/archive.js';
import { packSkill } from '../src/publish.js';

const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};
const events = (result) => result.stdout.trim().split('\n').map((line) => JSON.parse(line));
const publishRequests = (f) => f.state.requests.filter((request) => request.path === '/api/store/publish');

async function makeSkill(parent, folder, { name, version } = {}) {
  const directory = path.join(parent, folder);
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  const frontmatter = ['---'];
  if (name !== undefined) frontmatter.push(`name: ${name}`);
  if (version !== undefined) frontmatter.push('metadata:', `  version: "${version}"`);
  await writeFile(path.join(directory, 'SKILL.md'), `${frontmatter.join('\n')}\n---\n\n# 测试 Skill\n`);
  await writeFile(path.join(directory, 'assets', 'example.txt'), `${folder} ${version ?? ''}\n`);
  return directory;
}

// 直接编码恶意 tar 条目，钉住安装侧验证器随 publish 移植后的既有分支。
function tarEntry(name, type = '0', content = '') {
  const header = Buffer.alloc(512), bytes = Buffer.from(content);
  header.write(name, 0, 100);
  for (const [offset, length, value] of [[100, 8, 0o775], [108, 8, 0], [116, 8, 0], [124, 12, bytes.length], [136, 12, 0]]) header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  header.fill(32, 148, 156);
  header.write(type, 156, 1);
  header.write('ustar\0', 257);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

test('前置（任务 3 审查登记）：me 端点带 publisher 字段——TOKEN 是发布者、TOKEN2 不是；缺字段按 invalid_response 拒绝', async (t) => {
  const f = await fixture(t);
  await f.run(['login', '--token', TOKEN, '--json']);
  const owner = data(await f.run(['status', '--json']));
  assert.equal(owner.account.publisher, true);
  f.state.grants.set(TOKEN2, []);
  const other = data(await f.run(['status', '--json'], { HY_TOKEN: TOKEN2 }));
  assert.equal(other.account.publisher, false);
  f.state.dropPublisher = true;
  const broken = await f.run(['status', '--json']);
  assert.equal(broken.code, 1);
  assert.equal(data(broken).error, 'invalid_response');
});

test('publish 单目录：frontmatter 读取、打包上传、摘要与请求头正确，versions 反映新版本且临时目录清理', async (t) => {
  const f = await fixture(t);
  await makeSkill(f.cwd, 'ppt-design', { name: 'ppt-design', version: '0.2.0' });
  const result = await f.run(['publish', 'ppt-design', '--notes', '修复若干问题', '--json'], { HY_TOKEN: TOKEN });
  const event = data(result);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(event.ok, true);
  assert.equal(event.command, 'publish');
  assert.equal(event.event, 'publish');
  assert.equal(event.skill, 'ppt-design');
  assert.equal(event.version, '0.2.0');
  assert.match(event.sha256, /^[0-9a-f]{64}$/);
  assert.equal(event.existing, false);
  assert.equal(event.url, `${f.base}/releases/ppt-design-0.2.0.tar.gz`);
  assert.deepEqual(event.name_mapping, { directory: 'ppt-design', frontmatter: 'ppt-design', canonical: 'ppt-design' });
  assert.ok(event.size > 0);
  assert.equal(publishRequests(f).length, 1);
  const sent = publishRequests(f)[0];
  assert.equal(sent.method, 'POST');
  assert.equal(sent.token, TOKEN);
  assert.equal(sent.headers['x-skill-name'], 'ppt-design');
  assert.equal(sent.headers['x-skill-version'], '0.2.0');
  assert.equal(sent.headers['x-content-sha256'], event.sha256);
  assert.equal(sent.headers['content-type'], 'application/gzip');
  // 说明文本在头里百分号编码传输（HTTP 头不接受非 ASCII 字节），服务端解码存储。
  assert.equal(decodeURIComponent(sent.headers['x-notes']), '修复若干问题');
  const stored = f.state.published.get('ppt-design:0.2.0');
  assert.equal(stored.sha256, event.sha256);
  assert.equal(stored.size, event.size);
  assert.equal(stored.notes, '修复若干问题');
  const versions = await (await fetch(`${f.base}/api/store/versions`)).json();
  assert.equal(versions.skills['ppt-design'].latest, '0.2.0');
  assert.deepEqual(versions.skills['ppt-design'].history.map((h) => h.version), ['0.2.0', '0.1.0', '0.0.9']);
  assert.equal(versions.skills['ppt-design'].sha256, event.sha256);
  assert.equal(versions.skills['ppt-design'].download_url, `${f.base}/releases/ppt-design-0.2.0.tar.gz`);
  assert.ok(versions.skills['ppt-design'].history[0].notes.includes('修复若干问题'));
  // 打包临时目录 finally 清理，不留残骸。
  assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith('hy-publish-')), []);
});

test('命名映射：目录名推导 PPT-design→ppt-design，文本摘要给出来源；frontmatter 合法 name 优先；非法 name 回落推导', async (t) => {
  const f = await fixture(t);
  await makeSkill(f.cwd, 'PPT-design', { version: '0.1.1' });
  const derived = await f.run(['publish', 'PPT-design'], { HY_TOKEN: TOKEN });
  assert.equal(derived.code, 0, derived.stderr);
  assert.match(derived.stdout, /已发布：ppt-design 0\.1\.1/);
  assert.match(derived.stdout, /规范名：PPT-design → ppt-design（由目录名推导）/);
  assert.match(derived.stdout, /大小：\d+ 字节；SHA-256：[0-9a-f]{64}/);
  assert.ok(f.state.published.has('ppt-design:0.1.1'));

  await makeSkill(f.cwd, 'slide-dir', { name: 'slide-helper', version: '0.1.0' });
  const frontmatter = await f.run(['publish', 'slide-dir'], { HY_TOKEN: TOKEN });
  assert.equal(frontmatter.code, 0, frontmatter.stderr);
  assert.match(frontmatter.stdout, /规范名：slide-dir → slide-helper（取自 frontmatter name）/);
  assert.ok(f.state.published.has('slide-helper:0.1.0'));

  // frontmatter 写了非法 name：规范名回落目录推导，但包内容与声明必然对不上 → name_mismatch 拒绝。
  await makeSkill(f.cwd, 'Weird_Dir', { name: 'Not Legal', version: '0.1.0' });
  const fallback = await f.run(['publish', 'Weird_Dir', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(fallback.code, 1);
  assert.equal(data(fallback).error, 'name_mismatch');
  assert.match(data(fallback).message, /与规范名 weirddir 不一致/);
  assert.ok(!f.state.published.has('weirddir:0.1.0'));
});

test('缺 name/version 拒绝：无版本号与不可推导的目录名都在上传前失败', async (t) => {
  const f = await fixture(t);
  await makeSkill(f.cwd, 'no-version', { name: 'no-version' });
  const noVersion = await f.run(['publish', 'no-version', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(noVersion.code, 1);
  assert.equal(data(noVersion).error, 'missing_skill_field');
  assert.match(data(noVersion).message, /缺少可用的 name 或 metadata\.version/);
  await makeSkill(f.cwd, '1abc', { version: '0.1.0' });
  const noName = await f.run(['publish', '1abc'], { HY_TOKEN: TOKEN });
  assert.equal(noName.code, 1);
  assert.match(noName.stderr, /无法从目录名 1abc 推导规范名/);
  assert.equal(publishRequests(f).length, 0);
});

test('目录没有 SKILL.md（或不存在）→ skill_read 拒绝', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.cwd, 'empty-dir'));
  const empty = await f.run(['publish', 'empty-dir', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(empty.code, 1);
  assert.equal(data(empty).error, 'skill_read');
  assert.match(data(empty).message, /不是包含 SKILL\.md 的 Skill 目录/);
  const missing = await f.run(['publish', 'missing-dir', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(missing.code, 1);
  assert.equal(data(missing).error, 'skill_read');
  assert.equal(publishRequests(f).length, 0);
});

test('打包自检：源目录含符号链接/junction 在打包阶段被拒，不上传且不碰源目录', async (t) => {
  const f = await fixture(t);
  const directory = await makeSkill(f.cwd, 'ppt-design', { name: 'ppt-design', version: '0.2.0' });
  const outside = path.join(f.temporary, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), '越界内容');
  await symlink(outside, path.join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = await readFile(path.join(directory, 'SKILL.md'), 'utf8');
  const result = await f.run(['publish', 'ppt-design'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /打包内容未通过发布前校验/);
  assert.equal(data(await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN })).error, 'invalid_package');
  assert.equal(publishRequests(f).length, 0);
  assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), before);
  assert.ok((await readdir(directory)).includes('linked'));
});

test('validateArchive 恶意归档用例：路径越界、链接条目、拼接 tar、Windows 保留名（对称验证钉住）', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hy-unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const good = [tarEntry('ppt-design/', '5'), tarEntry('ppt-design/SKILL.md', '0', 'name: ppt-design')];
  for (const [label, bad] of [
    ['绝对路径', tarEntry('/tmp/escape')],
    ['路径穿越', tarEntry('ppt-design/../../escape')],
    ['硬链接', tarEntry('ppt-design/hard', '1')],
    ['符号链接条目', tarEntry('ppt-design/link', '2')],
  ]) {
    const file = path.join(directory, 'bad.tar.gz');
    await writeFile(file, gzipSync(Buffer.concat([...good, bad, Buffer.alloc(1024)])));
    await assert.rejects(validateArchive(file, 'ppt-design'), { error: 'invalid_archive' }, label);
  }
  // Windows 分支（保留名/盘符/ADS/尾部点）通过 platform 参数在任意系统钉住。
  for (const name of ['ppt-design/con', 'ppt-design/com1.txt', 'ppt-design/C:aux', 'ppt-design/space.', 'ppt-design/trailing ']) {
    const file = path.join(directory, 'win.tar.gz');
    await writeFile(file, gzipSync(Buffer.concat([...good, tarEntry(name), Buffer.alloc(1024)])));
    await assert.rejects(validateArchive(file, 'ppt-design', 'win32'), { error: 'invalid_archive' }, name);
  }
  const appended = path.join(directory, 'appended.tar.gz');
  await writeFile(appended, gzipSync(Buffer.concat([...good, Buffer.alloc(1024), tarEntry('ppt-design/hidden'), Buffer.alloc(1024)])));
  await assert.rejects(validateArchive(appended, 'ppt-design'), { error: 'invalid_archive' });
  const clean = path.join(directory, 'clean.tar.gz');
  await writeFile(clean, gzipSync(Buffer.concat([...good, Buffer.alloc(1024)])));
  await validateArchive(clean, 'ppt-design');
});

test('409 version_exists：同版本不同内容单目录报错；同 sha256 重传幂等（两次 200、服务端只存一份）', async (t) => {
  const f = await fixture(t);
  const directory = await makeSkill(f.cwd, 'ppt-design', { name: 'ppt-design', version: '0.2.0' });
  assert.equal((await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN })).code, 0);
  await writeFile(path.join(directory, 'assets', 'example.txt'), '不同的内容\n');
  const conflict = await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(conflict.code, 1);
  assert.equal(data(conflict).error, 'version_exists');
  assert.match(data(conflict).message, /ppt-design 0\.2\.0 已发布且内容不同/);
  // 重新检出/跨机器重打包字节可能不同属正常：文案要解释这一点。
  assert.match(data(conflict).message, /重新检出.*属正常现象/);
  assert.equal(f.state.published.size, 1);

  // 内容未变：同 sha256 重传视为幂等成功（设计「假设清单」#1）。
  await makeSkill(f.cwd, 'oracle-bone', { name: 'oracle-bone', version: '0.2.0' });
  assert.equal((await f.run(['publish', 'oracle-bone'], { HY_TOKEN: TOKEN })).code, 0);
  const replay = await f.run(['publish', 'oracle-bone'], { HY_TOKEN: TOKEN });
  assert.equal(replay.code, 0, replay.stderr);
  assert.match(replay.stdout, /内容与已发布版本一致，按幂等处理。/);
  assert.equal(publishRequests(f).filter((request) => request.headers['x-skill-name'] === 'oracle-bone').length, 2);
  assert.equal(f.state.published.size, 2);
});

test('413 too_large 注入 → 本地语义文案退出 1；403 not_a_publisher 注入 → 退出 3 并给登录引导', async (t) => {
  const f = await fixture(t);
  await makeSkill(f.cwd, 'ppt-design', { name: 'ppt-design', version: '0.2.0' });
  f.state.publishStatus = 413;
  const large = await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(large.code, 1);
  assert.equal(data(large).error, 'too_large');
  assert.match(data(large).message, /超过 100MB 上限/);
  f.state.publishStatus = 403;
  const forbidden = await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(forbidden.code, 3);
  assert.equal(data(forbidden).error, 'not_a_publisher');
  assert.equal(data(forbidden).next_command, 'npx github:Huanyu-Hibiki/Huanyu-CLI login');
  assert.match(data(forbidden).message, /没有发布权限/);
  const english = await f.run(['publish', 'ppt-design', '--lang', 'en'], { HY_TOKEN: TOKEN });
  assert.match(english.stderr, /This account cannot publish\. Enable the publisher role in the store, then run npx github:Huanyu-Hibiki\/Huanyu-CLI login\./);
});

test('TOKEN2 已认证但无 publisher 角色：me 检查即拒，退出 3 且未发出上传', async (t) => {
  const f = await fixture(t);
  f.state.grants.set(TOKEN2, []);
  await makeSkill(f.cwd, 'ppt-design', { name: 'ppt-design', version: '0.2.0' });
  const result = await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN2 });
  assert.equal(result.code, 3);
  assert.equal(data(result).error, 'not_a_publisher');
  assert.equal(data(result).next_command, 'npx github:Huanyu-Hibiki/Huanyu-CLI login');
  assert.ok(f.state.requests.some((request) => request.path === '/api/auth/me'));
  assert.equal(publishRequests(f).length, 0);
});

test('未登录：设备码流程等待后退出 3，next_command 指向原 publish 命令且待领取记录落盘', async (t) => {
  const f = await fixture(t);
  f.state.requireApproval = true;
  await makeSkill(f.cwd, 'ppt-design', { name: 'ppt-design', version: '0.2.0' });
  const result = await f.run(['publish', 'ppt-design', '--json'], {}, { browserDelay: 100 });
  assert.equal(result.code, 3);
  const output = events(result).at(-1);
  assert.equal(output.error, 'authorization_pending');
  assert.equal(output.next_command, 'npx github:Huanyu-Hibiki/Huanyu-CLI publish ppt-design --json');
  assert.equal(publishRequests(f).length, 0);
  assert(JSON.parse(await readFile(f.configFile, 'utf8')).pending_device);
});

test('publish --repo --check 对账：商店缺/待发布/本地落后/一致/商店多分类正确，非 Skill 子目录忽略', async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.temporary, 'skills-repo');
  await mkdir(repo);
  await makeSkill(repo, 'ppt-design', { name: 'ppt-design', version: '0.3.0' });
  await makeSkill(repo, 'oracle-bone', { name: 'oracle-bone', version: '0.1.0' });
  await makeSkill(repo, 'new-skill', { name: 'new-skill', version: '0.2.0' });
  await mkdir(path.join(repo, 'docs'));
  await writeFile(path.join(repo, 'docs', 'readme.md'), '不是 Skill 目录');
  const value = data(await f.run(['publish', '--repo', repo, '--check', '--json'], { HY_TOKEN: TOKEN }));
  assert.equal(value.ok, true);
  assert.equal(value.mode, 'check');
  assert.deepEqual(value.skills.map((s) => [s.skill, s.status]), [
    ['new-skill', 'missing'], ['oracle-bone', 'current'], ['ppt-design', 'behind'], ['ppt-design-pro', 'store_only'],
  ]);
  assert.deepEqual(value.counts, { total: 4, publishable: 2, current: 1, local_behind: 0, store_only: 1 });
  assert.equal(publishRequests(f).length, 0);
  const human = await f.run(['publish', '--repo', repo, '--check'], { HY_TOKEN: TOKEN });
  assert.equal(human.code, 0, human.stderr);
  assert.ok(human.stdout.includes('商店缺：new-skill（本地 0.2.0）'));
  assert.ok(human.stdout.includes('一致：oracle-bone 0.1.0'));
  assert.ok(human.stdout.includes('待发布：ppt-design 本地 0.3.0，商店 0.1.0'));
  assert.ok(human.stdout.includes('商店多：ppt-design-pro（本地仓库没有）'));
  assert.ok(human.stdout.includes('共 4 个 Skill：待发布 2，一致 1。'));

  // 本地版本低于商店 latest：报告为本地落后，且不属于发布目标。
  const stale = path.join(f.temporary, 'stale-repo');
  await mkdir(stale);
  await makeSkill(stale, 'oracle-bone', { name: 'oracle-bone', version: '0.0.9' });
  const report = data(await f.run(['publish', '--repo', stale, '--check', '--json'], { HY_TOKEN: TOKEN }));
  assert.deepEqual(report.skills.map((s) => [s.skill, s.status]), [['oracle-bone', 'local_behind'], ['ppt-design', 'store_only'], ['ppt-design-pro', 'store_only']]);
  assert.equal(report.counts.publishable, 0);
});

test('publish --repo --all：确认后只发布商店缺与待发布，versions 反映且二次对账全一致', async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.temporary, 'skills-repo');
  await mkdir(repo);
  await makeSkill(repo, 'ppt-design', { name: 'ppt-design', version: '0.2.0' });
  await makeSkill(repo, 'oracle-bone', { name: 'oracle-bone', version: '0.1.0' });
  await makeSkill(repo, 'new-skill', { name: 'new-skill', version: '0.1.0' });
  await makeSkill(repo, 'ppt-design-pro', { name: 'ppt-design-pro', version: '0.0.9' });
  const result = await f.run(['publish', '--repo', repo, '--all', '--json'], { HY_TOKEN: TOKEN }, { interactive: true, answers: [true] });
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.trace.questions.length, 1);
  assert.match(result.trace.questions[0], /发布以上 2 个版本？/);
  const output = events(result);
  assert.equal(output[0].mode, 'all');
  // 目标按目录扫描顺序（字母序）逐个发布：new-skill（商店缺）在前、ppt-design（待发布）在后。
  assert.deepEqual(output.filter((event) => event.event === 'publish').map((event) => `${event.skill}:${event.version}`), ['new-skill:0.1.0', 'ppt-design:0.2.0']);
  const summary = output.at(-1);
  assert.deepEqual(summary.published.map((item) => `${item.skill}:${item.version}`), ['new-skill:0.1.0', 'ppt-design:0.2.0']);
  assert.deepEqual(summary.skipped, []);
  assert.equal(f.state.published.size, 2);
  assert.ok(!f.state.published.has('oracle-bone:0.1.0'));
  assert.ok(!f.state.published.has('ppt-design-pro:0.0.9'));
  const versions = await (await fetch(`${f.base}/api/store/versions`)).json();
  assert.equal(versions.skills['ppt-design'].latest, '0.2.0');
  assert.equal(versions.skills['new-skill'].latest, '0.1.0');
  const again = data(await f.run(['publish', '--repo', repo, '--check', '--json'], { HY_TOKEN: TOKEN }));
  assert.deepEqual(again.skills.map((s) => [s.skill, s.status]), [
    ['new-skill', 'current'], ['oracle-bone', 'current'], ['ppt-design', 'current'], ['ppt-design-pro', 'local_behind'],
  ]);
});

test('publish --repo --all 遇 409 跳过该版本并继续整批；裸 --repo 拒绝确认则取消', async (t) => {
  const f = await fixture(t);
  // 序列注入：第一个上传请求被服务端按 409 拒绝（模拟对账后被抢先发布），第二个正常。
  f.state.publishStatus = [409];
  const repo = path.join(f.temporary, 'skills-repo');
  await mkdir(repo);
  await makeSkill(repo, 'new-skill', { name: 'new-skill', version: '0.1.0' });
  await makeSkill(repo, 'ppt-design', { name: 'ppt-design', version: '0.2.0' });
  const batch = await f.run(['publish', '--repo', repo, '--all'], { HY_TOKEN: TOKEN });
  assert.equal(batch.code, 0, batch.stderr);
  assert.ok(batch.stdout.includes('跳过 new-skill 0.1.0：该版本已发布。'), batch.stdout);
  assert.ok(batch.stdout.includes('成功 1 个，跳过 1 个。'), batch.stdout);
  assert.ok(f.state.published.has('ppt-design:0.2.0'));
  assert.ok(!f.state.published.has('new-skill:0.1.0'));

  const declined = await f.run(['publish', '--repo', repo, '--json'], { HY_TOKEN: TOKEN }, { interactive: true, answers: [false] });
  assert.equal(declined.code, 1);
  const output = events(declined).at(-1);
  assert.equal(output.error, 'cancelled');
  assert.match(output.message, /操作已取消。/);
  assert.equal(publishRequests(f).length, 2);
});

test('目录推导规范名冲突：一次性列出全部冲突组', async (t) => {
  const f = await fixture(t);
  const repo = path.join(f.temporary, 'skills-repo');
  await mkdir(repo);
  // Windows 文件系统不区分大小写，同组冲突用下划线/大小写变体构造真实的不同目录。
  await makeSkill(repo, 'PPT-design', { version: '0.2.0' });
  await makeSkill(repo, 'P_P_T-design', { version: '0.2.0' });
  await makeSkill(repo, 'Group_A', { version: '0.1.0' });
  await makeSkill(repo, 'groupa', { version: '0.1.0' });
  const result = await f.run(['publish', '--repo', repo, '--check', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 1);
  const value = data(result);
  assert.equal(value.error, 'name_conflict');
  assert.deepEqual(value.conflicts.map((conflict) => conflict.name).sort(), ['groupa', 'ppt-design']);
  assert.deepEqual([...value.conflicts.find((conflict) => conflict.name === 'ppt-design').paths].sort(), ['PPT-design', 'P_P_T-design']);
  for (const name of ['PPT-design', 'P_P_T-design', 'Group_A', 'groupa']) assert.ok(value.message.includes(name), name);
  assert.equal(publishRequests(f).length, 0);
});

test('符号链接/junction 指向 Skill 目录：发布实体内容、规范名取真实目录名，--repo 扫描同样发现', async (t) => {
  const f = await fixture(t);
  const target = await makeSkill(f.temporary, 'PPT-design', { version: '0.1.0' });
  await symlink(target, path.join(f.cwd, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.run(['publish', 'alias', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  const event = data(result);
  assert.equal(event.skill, 'ppt-design');
  assert.equal(event.name_mapping.directory, 'PPT-design');
  assert.ok(f.state.published.has('ppt-design:0.1.0'));

  const repo = path.join(f.temporary, 'repo-links');
  await mkdir(repo);
  const other = await makeSkill(f.temporary, 'linked-skill', { name: 'linked-skill', version: '0.1.0' });
  await symlink(other, path.join(repo, 'pointer'), process.platform === 'win32' ? 'junction' : 'dir');
  await mkdir(path.join(repo, 'not-a-skill'));
  const report = data(await f.run(['publish', '--repo', repo, '--check', '--json'], { HY_TOKEN: TOKEN }));
  assert.ok(report.skills.some((item) => item.skill === 'linked-skill' && item.status === 'missing'), JSON.stringify(report.skills));
  assert.ok(!report.skills.some((item) => item.directory === 'pointer'));
});

test('跨平台不对称修复：保留设备名规范名拒绝；保留名文件按 win32 规则在打包阶段被拒', async (t) => {
  const f = await fixture(t);
  await makeSkill(f.cwd, 'device-skill', { name: 'con', version: '0.1.0' });
  const reserved = await f.run(['publish', 'device-skill', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(reserved.code, 1);
  assert.equal(data(reserved).error, 'reserved_name');
  assert.match(data(reserved).message, /Windows 保留设备名/);
  assert.equal(publishRequests(f).length, 0);
  // Windows 上无法创建保留名文件，该场景只能在 POSIX 构造。
  await t.test('保留名归档条目', { skip: process.platform === 'win32' ? 'Windows 无法创建保留名文件' : false }, async () => {
    await makeSkill(f.cwd, 'posix-skill', { name: 'posix-skill', version: '0.1.0' });
    await writeFile(path.join(f.cwd, 'posix-skill', 'aux.txt'), '辅助设备内容');
    const result = await f.run(['publish', 'posix-skill', '--json'], { HY_TOKEN: TOKEN });
    assert.equal(result.code, 1);
    assert.equal(data(result).error, 'invalid_package');
    assert.equal(publishRequests(f).length, 0);
  });
});

test('packSkill 资源预拒与 tar 缺失：原始字节/压缩输出超限本地拒绝；tar ENOENT 单独报 tar_missing', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'hy-pack-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const skill = await makeSkill(directory, 'demo-skill', { name: 'demo-skill', version: '0.1.0' });
  await assert.rejects(packSkill(skill, 'demo-skill', '0.1.0', { rawLimitBytes: 10 }), { error: 'too_large' });
  await assert.rejects(packSkill(skill, 'demo-skill', '0.1.0', { sizeLimitBytes: 10 }), { error: 'too_large' });
  await assert.rejects(packSkill(skill, 'demo-skill', '0.1.0', {
    runner: async () => { throw Object.assign(new Error('spawn tar ENOENT'), { code: 'ENOENT' }); },
  }), { error: 'tar_missing' });
  // 失败路径的临时目录同样清理干净。
  assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith('hy-publish-')), []);
});

test('打包排除开发与系统垃圾：.git/.DS_Store/Thumbs.db 警告输出且不进包', async (t) => {
  const f = await fixture(t);
  const directory = await makeSkill(f.cwd, 'ppt-design', { name: 'ppt-design', version: '0.1.0' });
  await mkdir(path.join(directory, '.git'));
  await writeFile(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await writeFile(path.join(directory, '.DS_Store'), 'junk');
  await writeFile(path.join(directory, 'Thumbs.db'), 'junk');
  const result = await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(result.code, 0, result.stdout);
  const event = data(result);
  assert.equal(event.warnings.length, 3);
  assert.ok(event.warnings.every((warning) => warning.startsWith('已从包中排除无关文件：')), JSON.stringify(event.warnings));
  const stored = f.state.published.get('ppt-design:0.1.0');
  const text = gunzipSync(stored.body).toString('latin1');
  assert.ok(!text.includes('.git'), '包内不应有 .git');
  assert.ok(!text.includes('.DS_Store'), '包内不应有 .DS_Store');
  assert.ok(!text.includes('Thumbs.db'), '包内不应有 Thumbs.db');
});

test('SKILL.md 是目录或超过 1MB：给出明确语义而非读取失败', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.cwd, 'weird', 'SKILL.md'), { recursive: true });
  const weird = await f.run(['publish', 'weird', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(weird.code, 1);
  assert.equal(data(weird).error, 'skill_read');
  assert.match(data(weird).message, /不是包含 SKILL\.md 的 Skill 目录/);
  const big = await makeSkill(f.cwd, 'big-skill', { name: 'big-skill', version: '0.1.0' });
  await writeFile(path.join(big, 'SKILL.md'), `---\nname: big-skill\nmetadata:\n  version: "0.1.0"\n---\n\n${'#'.repeat(1024 * 1024 + 10)}\n`);
  const oversized = await f.run(['publish', 'big-skill', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(oversized.code, 1);
  assert.equal(data(oversized).error, 'skill_too_large');
  assert.equal(publishRequests(f).length, 0);
});

test('非交互自动确认：无 --yes 时输出提示行与 auto_confirmed 标记，显式 --yes 不输出', async (t) => {
  const f = await fixture(t);
  const flagged = path.join(f.temporary, 'repo-auto');
  await mkdir(flagged);
  await makeSkill(flagged, 'ppt-design', { name: 'ppt-design', version: '0.2.0' });
  const auto = await f.run(['publish', '--repo', flagged, '--all', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(auto.code, 0, auto.stdout);
  assert.equal(events(auto)[0].auto_confirmed, true);
  const human = path.join(f.temporary, 'repo-human');
  await mkdir(human);
  await makeSkill(human, 'oracle-bone', { name: 'oracle-bone', version: '0.2.0' });
  const text = await f.run(['publish', '--repo', human, '--all']);
  assert.equal(text.code, 0, text.stderr);
  assert.match(text.stdout, /非交互模式：已自动确认发布。/);
  const explicit = path.join(f.temporary, 'repo-explicit');
  await mkdir(explicit);
  await makeSkill(explicit, 'new-skill', { name: 'new-skill', version: '0.1.0' });
  const quiet = await f.run(['publish', '--repo', explicit, '--all', '--yes', '--json'], { HY_TOKEN: TOKEN });
  assert.equal(quiet.code, 0, quiet.stdout);
  assert.equal(events(quiet)[0].auto_confirmed, undefined);
  assert.equal(f.state.published.size, 3);
});

test('服务端是最终验证者：无效归档 400 invalid_package；付费发布物需要令牌与购买，免费发布物公开', async (t) => {
  const f = await fixture(t);
  const body = Buffer.from('not a tarball');
  const response = await fetch(`${f.base}/api/store/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/gzip', 'X-Skill-Name': 'junk-skill', 'X-Skill-Version': '0.1.0', 'X-Content-SHA256': createHash('sha256').update(body).digest('hex') },
    body,
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_package');
  assert.ok(!f.state.published.has('junk-skill:0.1.0'));

  await makeSkill(f.cwd, 'ppt-design-pro', { name: 'ppt-design-pro', version: '0.2.0' });
  await makeSkill(f.cwd, 'ppt-design', { name: 'ppt-design', version: '0.2.0' });
  assert.equal((await f.run(['publish', 'ppt-design-pro', '--json'], { HY_TOKEN: TOKEN })).code, 0);
  assert.equal((await f.run(['publish', 'ppt-design', '--json'], { HY_TOKEN: TOKEN })).code, 0);
  const paid = `${f.base}/releases/ppt-design-pro-0.2.0.tar.gz`;
  assert.equal((await fetch(paid)).status, 401);
  f.state.grants.set(TOKEN2, []);
  assert.equal((await fetch(paid, { headers: { Authorization: `Bearer ${TOKEN2}` } })).status, 402);
  assert.equal((await fetch(paid, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await fetch(`${f.base}/releases/ppt-design-0.2.0.tar.gz`)).status, 200);
});
