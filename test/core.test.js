import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolveLanguage, withLanguage, t, helpLines, formatCommand, command, COMMAND } from '../src/i18n.js';
import { CliError, Output } from '../src/io.js';
import { parseSkill, compare } from '../src/skills.js';
import { canonicalName } from '../src/publish.js';

const TOKEN = 'hy_Abcd0123456789abcdefghijklmnopqrstuvXYZ';
const COMMANDS = ['status', 'list', 'install', 'update', 'login', 'logout', 'subscribe', 'manage', 'help', 'version', 'publish', 'product', 'unpublish', 'audit'];

test('语言优先级 --lang > HY_LANG > LC_ALL > LC_MESSAGES > LANG', () => {
  assert.deepEqual(resolveLanguage(['--lang', 'en'], { HY_LANG: 'zh', LC_ALL: 'zh_CN' }), { lang: 'en', explicit: true });
  assert.deepEqual(resolveLanguage(['--lang=en'], {}), { lang: 'en', explicit: true });
  assert.deepEqual(resolveLanguage(['help', '--lang', 'en', 'extra'], {}), { lang: 'en', explicit: true });
  assert.deepEqual(resolveLanguage(['--lang'], { HY_LANG: 'en' }), { lang: 'en', explicit: true });
  assert.deepEqual(resolveLanguage(['--lang', '-x'], { HY_LANG: 'en' }), { lang: 'en', explicit: true });
  assert.deepEqual(resolveLanguage([], { HY_LANG: 'en' }), { lang: 'en', explicit: true });
  assert.deepEqual(resolveLanguage([], { LC_ALL: 'en_US.UTF-8' }), { lang: 'en', explicit: false });
  assert.deepEqual(resolveLanguage([], { LC_MESSAGES: 'en_US', LANG: 'zh_CN' }), { lang: 'en', explicit: false });
  assert.deepEqual(resolveLanguage([], { LC_MESSAGES: 'zh_CN', LANG: 'en_US' }), { lang: 'zh', explicit: false });
  assert.deepEqual(resolveLanguage([], { LANG: 'en' }), { lang: 'en', explicit: false });
});

test('默认中文，C/POSIX 与空白语言视为中文', () => {
  assert.deepEqual(resolveLanguage([], {}), { lang: 'zh', explicit: false });
  for (const locale of ['C', 'POSIX', 'C.UTF-8', 'posix.utf-8', 'c ', '']) {
    assert.deepEqual(resolveLanguage([], { LANG: locale }), { lang: 'zh', explicit: false }, locale);
  }
  assert.deepEqual(resolveLanguage([], { LC_ALL: 'C', HY_LANG: '' }), { lang: 'zh', explicit: false });
});

test('t() 按语言取词条；命令占位符指向 npx github:Huanyu-Hibiki/Huanyu-CLI；未知词条抛错', () => {
  assert.equal(withLanguage({ lang: 'zh' }, () => t('missingArgument', { flag: '--token' })), '--token 缺少值。');
  assert.equal(withLanguage({ lang: 'en' }, () => t('missingArgument', { flag: '--token' })), '--token requires a value.');
  assert.equal(withLanguage({ lang: 'zh' }, () => t('unknownCommand')), `未知命令，请运行 ${COMMAND} help。`);
  assert.equal(withLanguage({ lang: 'en' }, () => t('unknownCommand')), `Unknown command. Run ${COMMAND} help.`);
  assert.throws(() => withLanguage({ lang: 'zh' }, () => t('nonexistent')), /Unknown message/);
});

test('helpLines 双语覆盖全部 14 个命令', () => {
  for (const lang of ['zh', 'en']) {
    const text = withLanguage({ lang }, () => helpLines()).join('\n');
    for (const name of COMMANDS) assert.ok(text.includes(name), `${lang}: ${name}`);
    assert.ok(lang === 'zh' ? text.includes('用法：') : text.includes('Usage:'));
  }
});

test('command() 拼出可复制命令，特殊字符按平台引用', () => {
  assert.equal(COMMAND, 'npx github:Huanyu-Hibiki/Huanyu-CLI');
  assert.equal(command('help'), `${COMMAND} help`);
  assert.equal(formatCommand(['install', 'demo-skill']), `${COMMAND} install demo-skill`);
  assert.equal(formatCommand(['install', 'demo skill'], 'win32'), `${COMMAND} install 'demo skill'`);
  assert.equal(formatCommand(['install', "it's"], 'win32'), `${COMMAND} install 'it''s'`);
  assert.equal(formatCommand(['install', "it's"], 'linux'), `${COMMAND} install 'it'\\''s'`);
});

test('frontmatter 最小解析：引号、注释、CRLF、行内 metadata；重复 name 无效、不执行 YAML 标签', () => {
  assert.deepEqual(parseSkill('\uFEFF---\r\nname: "ppt-design" # 注释\r\nmetadata:\r\n  version: \'0.2.0\' # 注释\r\n---\r\n'), { name: 'ppt-design', version: '0.2.0' });
  assert.deepEqual(parseSkill('---\nname: ppt-design-pro\nmetadata: {version: "1.0.0"}\n---\n'), { name: 'ppt-design-pro', version: '1.0.0' });
  assert.equal(parseSkill('---\nname: ppt-design\nmetadata: {author: "a, b", version: "0.2.0", other: [a, b]} # 注释\n---\n').version, '0.2.0');
  assert.equal(parseSkill('---\nname: ppt-design\nmetadata:\n  other:\n    version: 9.9.9\n  version: 0.2.0\n---\n').version, '0.2.0');
  assert.equal(parseSkill('---\nname: ppt-design\nname: unrelated\n---\n').name, null);
  assert.equal(parseSkill('# 文档\nname: ppt-design\n').name, null);
  assert.equal(parseSkill('---\nname: ppt-design\nmetadata:\n  version: 01.0.0\n---\n').version, null);
  // YAML 标签不执行：字面量字符串不是语义化版本即无效。
  assert.equal(parseSkill('---\nname: ppt-design\nmetadata:\n  version: "{{ eval }}"\n---\n').version, null);
  assert.equal(parseSkill('---\nname: ppt-design\n---\n').version, null);
});

test('规范名映射：frontmatter 合法 name 优先；目录名小写化并去掉非法字符；数字开头或清理后为空拒绝', () => {
  withLanguage({ lang: 'zh' }, () => {
    assert.equal(canonicalName('PPT-design', null), 'ppt-design');
    assert.equal(canonicalName('My_Skill 2', null), 'myskill2');
    assert.equal(canonicalName('anything', 'oracle-bone'), 'oracle-bone');
    // frontmatter name 非法（大写/空格）时回落目录名推导。
    assert.equal(canonicalName('good-dir', 'Not Legal'), 'good-dir');
    assert.equal(canonicalName('good-dir', 'UPPER'), 'good-dir');
    for (const bad of ['1abc', '2024-notes', '中文', '-x', '___', '']) {
      assert.throws(() => canonicalName(bad, null), (error) => error instanceof CliError && error.error === 'invalid_skill_name', bad);
    }
  });
});

test('语义化版本比较：BigInt 逐段、跳版本可比', () => {
  assert.ok(compare('0.10.0', '0.9.0') > 0);
  assert.ok(compare('0.9.9', '0.10.0') < 0);
  assert.ok(compare('1.0.0', '1.0.0') === 0);
  assert.ok(compare('2.0.0', '1.99.99') > 0);
  assert.ok(compare('0.2.10', '0.2.9') > 0);
});

test('CliError 携带退出码、错误码与详情，默认 1/failed', () => {
  const error = new CliError('消息', 2, 'usage', { flag: '--x' });
  assert.equal(error.message, '消息');
  assert.equal(error.code, 2);
  assert.equal(error.error, 'usage');
  assert.deepEqual(error.details, { flag: '--x' });
  const fallback = new CliError('失败');
  assert.equal(fallback.code, 1);
  assert.equal(fallback.error, 'failed');
  assert.deepEqual(fallback.details, {});
});

test('Output 遮盖已记住的密钥与编码形式，只显示前 8 字符', () => {
  const malformed = 'key"\\中文_123456789012345';
  const output = new Output(true, 'login', [TOKEN, malformed]);
  const result = output.sanitize({ token: TOKEN, nested: [malformed, `错误：${malformed}`, encodeURIComponent(malformed)], server: `未注册的 hy_Testothersecretsignature` });
  assert.equal(result.token, `${TOKEN.slice(0, 8)}…`);
  assert.equal(result.nested[0], `${malformed.slice(0, 8)}…`);
  assert(!JSON.stringify(result).includes('123456789012345'));
  assert(!JSON.stringify(result).includes('othersecretsignature'));
});

test('长度不超过 8 的密钥整段隐藏，不显示任何前缀片段', () => {
  withLanguage({ lang: 'zh' }, () => {
    const short = 's3cr3t';
    const output = new Output(false, 'login', [short]);
    assert.equal(output.redact(`令牌 ${short} 尾`), '令牌 [已隐藏] 尾');
    assert(!output.redact(`x${short}x`).includes(short));
    const json = new Output(true, 'login', [short]);
    assert.equal(json.sanitize({ token: short }).token, '[已隐藏]');
  });
});

test('hy_ 前缀兜底：陌生令牌即使带省略号也只显示前 8 字符', () => {
  const output = new Output(false, 'status');
  assert.equal(output.redact('hy_UnrecognizedSecretToken123…'), 'hy_Unrec…');
  assert.equal(output.redact('plain text'), 'plain text');
  assert.equal(output.sanitize(5), 5);
});

test('Output.remember 补充登记密钥；hide 状态整段隐藏', () => {
  const hidden = 'hy_Plus0123456789abcdefghijklmnopqrstuv';
  withLanguage({ lang: 'zh' }, () => {
    const output = new Output(false, 'login');
    output.remember(TOKEN);
    assert.equal(output.redact(`令牌 ${TOKEN}`), `令牌 ${TOKEN.slice(0, 8)}…`);
    output.remember(hidden, { hide: true });
    assert.equal(output.redact(`x${hidden}x`), 'x[已隐藏]x');
  });
});

test('package.json 打包字段与仓库现状一致', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'huanyu-cli');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.bin?.hy, 'bin/hy.js');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.ok(typeof pkg.description === 'string' && /[\u4e00-\u9fff]/.test(pkg.description), 'description 应为非空中文');
  for (const entry of pkg.files) {
    assert.ok(!/^readme/i.test(entry), `files 不应包含尚不存在的条目：${entry}`);
    assert.ok(existsSync(new URL(`../${entry}`, import.meta.url)), `files 条目应存在：${entry}`);
  }
});
