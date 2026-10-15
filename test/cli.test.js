import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/hy.js', import.meta.url));
const DRIVER = fileURLToPath(new URL('./driver.js', import.meta.url));
const { version: VERSION } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const COMMANDS = ['status', 'list', 'install', 'update', 'login', 'logout', 'subscribe', 'manage', 'help', 'version', 'publish', 'product', 'unpublish', 'audit'];
// 任务 4 起 publish、任务 6 起 install、二期任务 1 起 update、二期任务 2 起 product/unpublish/audit、
// 二期任务 3 起 manage 已实现；仍待实现的命令保持 not_implemented。
// update/product/unpublish/audit/manage 与 install 一样先做登录/网络前置，本测试不带假商店服务器，
// 不能再当 not_implemented 样本（行为测试见 test/update.test.js、test/admin.test.js、test/manage.test.js）。
const PENDING = [];

// 语言相关环境固定为确定值（默认中文）；extraEnv 在其后展开以便覆盖测试环境变量通道。
const BASE_ENV = { HY_LANG: '', LC_ALL: 'C', LC_MESSAGES: '', LANG: '', HY_TOKEN: '', CI: '' };

const data = (result) => {
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.stderr, '', result.stderr);
  return JSON.parse(result.stdout);
};

let runNumber = 0;
function run(args, extraEnv = {}, runtime = null) {
  return new Promise((resolve, reject) => {
    const traceFile = runtime ? path.join(tmpdir(), `hy-cli-trace-${process.pid}-${runNumber++}.json`) : null;
    const child = spawn(process.execPath, [runtime ? DRIVER : BIN, ...args], {
      env: { ...process.env, ...BASE_ENV, ...(runtime ? { HY_TEST_RUNTIME: JSON.stringify(runtime), HY_TEST_TRACE: traceFile } : {}), ...extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      let trace = null;
      if (traceFile) {
        try { trace = JSON.parse(await readFile(traceFile, 'utf8')); } catch {}
        await rm(traceFile, { force: true }).catch(() => {});
      }
      resolve({ code, signal, stdout, stderr, trace });
    });
  });
}

test('hy help 中英双语列出全部命令；--help 与 -h 同效', async () => {
  const zh = await run(['help']);
  assert.equal(zh.code, 0);
  assert.equal(zh.stderr, '');
  assert.match(zh.stdout, /用法：npx github:Huanyu-Hibiki\/Huanyu-CLI <命令>/);
  assert.match(zh.stdout, /status（默认）/);
  for (const name of COMMANDS) assert.ok(zh.stdout.includes(name), name);
  const en = await run(['help', '--lang', 'en']);
  assert.equal(en.code, 0);
  assert.match(en.stdout, /Usage: npx github:Huanyu-Hibiki\/Huanyu-CLI <command>/);
  assert.match(en.stdout, /status \(default\)/);
  for (const name of COMMANDS) assert.ok(en.stdout.includes(name), name);
  assert.ok(!en.stdout.includes('用法：'));
  // publish 参数面在任务 4 补全：目录位置参数 + --repo/--all/--check/--notes（任务 1 审查预留的回归点）。
  assert.ok(zh.stdout.includes('npx github:Huanyu-Hibiki/Huanyu-CLI publish <目录>'));
  assert.ok(zh.stdout.includes('--repo'));
  assert.ok(zh.stdout.includes('--all'));
  assert.ok(zh.stdout.includes('--check'));
  assert.ok(en.stdout.includes('npx github:Huanyu-Hibiki/Huanyu-CLI publish <directory>'));
  assert.equal((await run(['--help'])).stdout, zh.stdout);
  assert.equal((await run(['-h'])).stdout, zh.stdout);
});

test('HY_LANG 环境变量切换英文帮助', async () => {
  const result = await run(['help'], { HY_LANG: 'en' });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: npx github:Huanyu-Hibiki\/Huanyu-CLI <command>/);
  assert.ok(!result.stdout.includes('用法：'));
});

test('--version 单独使用输出包版本；--json 走结构化通道', async () => {
  const text = await run(['--version']);
  assert.equal(text.code, 0);
  assert.equal(text.stderr, '');
  assert.equal(text.stdout, `hy ${VERSION}\n`);
  const json = await run(['--version', '--json']);
  assert.equal(json.code, 0);
  assert.deepEqual(data(json), { ok: true, command: 'version', version: VERSION });
  const localized = await run(['--version', '--lang', 'en']);
  assert.equal(localized.stdout, `hy ${VERSION}\n`);
});

test('help --json 输出 {ok:true,command:"help"} 结构与全部命令行', async () => {
  const value = data(await run(['help', '--json']));
  assert.equal(value.ok, true);
  assert.equal(value.command, 'help');
  assert.ok(Array.isArray(value.usage) && value.usage.length >= 15);
  const text = value.usage.join('\n');
  for (const name of COMMANDS) assert.ok(text.includes(name), name);
});

test('未知命令退出码 2：文本走 stderr 双语提示，--json 走 stdout 结构化对象', async () => {
  const text = await run(['bogus']);
  assert.equal(text.code, 2);
  assert.equal(text.stdout, '');
  assert.match(text.stderr, /未知命令，请运行 npx github:Huanyu-Hibiki\/Huanyu-CLI help。/);
  const json = await run(['bogus', '--json']);
  assert.equal(json.code, 2);
  assert.equal(json.stderr, '');
  assert.equal(data(json).ok, false);
  assert.equal(data(json).error, 'usage');
  assert.equal(data(json).command, 'unknown');
  const english = await run(['bogus', '--lang', 'en']);
  assert.match(english.stderr, /Unknown command\. Run npx github:Huanyu-Hibiki\/Huanyu-CLI help\./);
});

test('未知参数拒绝并退出码 2', async () => {
  const text = await run(['status', '--wat']);
  assert.equal(text.code, 2);
  assert.equal(text.stdout, '');
  assert.match(text.stderr, /存在未知参数，请运行 npx github:Huanyu-Hibiki\/Huanyu-CLI help。/);
  const json = await run(['status', '--wat', '--json']);
  assert.equal(json.code, 2);
  assert.equal(data(json).error, 'usage');
  assert.match((await run(['status', '--wat', '--lang', 'en'])).stderr, /Unknown option\. Run npx github:Huanyu-Hibiki\/Huanyu-CLI help\./);
});

test('参数缺值与重复参数全部退出码 2', async () => {
  for (const [args, error, fragment] of [
    [['login', '--token'], 'missing_argument', '--token'],
    [['status', '--lang'], 'missing_argument', '--lang'],
    [['install', 'demo-skill', '--to'], 'missing_argument', '--to'],
    [['login', '--token', '--json'], 'missing_argument', '--token'],
    [['login', '--token', 'hy_first', '--token', 'hy_second'], 'usage', '--token'],
    [['status', '--lang', 'en', '--lang', 'zh'], 'usage', '--lang'],
  ]) {
    const result = await run([...args, '--json']);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(data(result).error, error, args.join(' '));
    assert.ok(data(result).message.includes(fragment), `${args.join(' ')}: ${data(result).message}`);
  }
  assert.match((await run(['status', '--lang'])).stderr, /--lang 缺少值。/);
  assert.match((await run(['login', '--token', 'hy_first', '--token', 'hy_second', '--lang', 'en'])).stderr, /--token can only be used once\./);
});

test('--version 与其他参数混用报用法错误并退出码 2', async () => {
  for (const args of [['--version', 'status'], ['status', '--version'], ['--version', '--help'], ['--version', 'list', '--json']]) {
    const result = await run([...args, '--json']);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(data(result).error, 'usage', args.join(' '));
    assert.ok(data(result).message.includes('--version'), args.join(' '));
  }
});

test('命令与参数不匹配报 wrongArgument 并退出码 2', async () => {
  for (const args of [
    ['status', '--token', 'hy_abc123'], ['list', '--to', 'codex'], ['status', 'extra'],
    ['update', '--plan', 'lifetime'], ['subscribe', 'demo-skill', '--path', 'x'],
  ]) {
    const result = await run([...args, '--json']);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(data(result).error, 'usage', args.join(' '));
  }
  assert.match((await run(['status', '--token', 'hy_abc123'])).stderr, /参数不适用于此命令/);
  assert.match((await run(['list', '--to', 'codex', '--lang', 'en'])).stderr, /This option does not apply to this command\./);
});

test('install/subscribe 缺 Skill 名或非法 Skill 名退出码 2', async () => {
  for (const [args, error] of [
    [['install'], 'missing_skill'],
    [['subscribe'], 'missing_skill'],
    [['install', 'Not-Valid!'], 'usage'],
    [['install', 'UPPER'], 'usage'],
  ]) {
    const result = await run([...args, '--json']);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(data(result).error, error, args.join(' '));
  }
  assert.match((await run(['install'])).stderr, /需要 Skill 名/);
});

test('publish 参数面：目录与 --repo 互斥、--all/--check 依赖 --repo 且互斥、其他命令不接受发布参数', async () => {
  for (const [args, error] of [
    [['publish'], 'usage'],
    [['publish', '--repo'], 'missing_argument'],
    [['publish', '--notes'], 'missing_argument'],
    [['publish', 'dir', '--repo', 'repo'], 'usage'],
    [['publish', 'dir', '--check'], 'usage'],
    [['publish', 'dir', '--all'], 'usage'],
    [['publish', 'dir', 'extra'], 'usage'],
    [['publish', '--repo', 'repo', '--all', '--check'], 'usage'],
    [['list', '--repo', 'x'], 'usage'],
    [['list', '--all'], 'usage'],
    [['status', '--check'], 'usage'],
    [['login', '--notes', '说明'], 'usage'],
    [['--version', '--repo', 'x'], 'usage'],
    [['publish', 'dir', '--notes', 'x'.repeat(2001)], 'usage'],
  ]) {
    const result = await run([...args, '--json']);
    assert.equal(result.code, 2, args.join(' '));
    assert.equal(data(result).error, error, args.join(' '));
  }
  assert.match((await run(['publish'])).stderr, /publish 需要一个 Skill 目录，或用 --repo <路径> 指向仓库。/);
  assert.match((await run(['publish', '--repo'], { HY_LANG: 'en' })).stderr, /--repo requires a value\./);
  assert.match((await run(['publish', 'dir', '--notes', 'x'.repeat(2001)])).stderr, /--notes 不能超过 2000 字符。/);
});

test('未实现命令执行时退出码 2，error 为 not_implemented 并使用中性文案', async () => {
  for (const name of PENDING) {
    const result = await run([name, '--json']);
    assert.equal(result.code, 2, name);
    assert.equal(data(result).error, 'not_implemented', name);
    assert.match(data(result).message, /尚未实现/, name);
    assert.ok(data(result).message.includes(name), name);
  }
  // install（任务 6 起）会先拉 catalog，本测试不带假商店服务器，不能再当 not_implemented 样本；
  // subscribe（二期任务 4）同理先走登录/catalog 前置，这里只钉住 not_implemented 文案本身。
  const result = await run(['subscribe', 'demo-skill', '--plan', 'lifetime', '--json']);
  assert.equal(result.code, 2);
  assert.equal(data(result).error, 'not_implemented');
  assert.match(data(result).message, /尚未实现/);
  const english = await run(['subscribe', 'demo-skill', '--lang', 'en']);
  assert.match(english.stderr, /not implemented yet/);
});

test('错误输出经过密钥遮盖：--token 值与 HY_TOKEN 环境变量都不出现在输出里', async () => {
  const secret = 'hy_SecretToken123456789';
  const flagged = await run(['status', '--token', secret, '--json']);
  assert.equal(flagged.code, 2);
  assert.ok(!flagged.stdout.includes(secret), flagged.stdout);
  assert.ok(!flagged.stderr.includes(secret), flagged.stderr);
  const envLeak = await run(['bogus'], { HY_TOKEN: secret });
  assert.equal(envLeak.code, 2);
  assert.ok(!envLeak.stderr.includes(secret), envLeak.stderr);
  assert.ok(!envLeak.stdout.includes(secret), envLeak.stdout);
});

test('driver 注入骨架：命令经 driver 运行并落盘 trace', async () => {
  const result = await run(['help'], {}, { interactive: false });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /用法：/);
  assert.deepEqual(result.trace, { delays: [], questions: [], browserUrls: [], browserTimeouts: [] });
});
