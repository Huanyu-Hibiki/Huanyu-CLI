import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLanguage, withLanguage, t, helpLines, formatCommand, command, COMMAND } from '../src/i18n.js';
import { CliError, Output } from '../src/io.js';

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
