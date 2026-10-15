import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { directoryKey, sameDirectory } from '../src/platform.js';

test('directoryKey：win32 归一大小写、分隔符、扩展路径与 UNC 前缀；POSIX 保留大小写', () => {
  assert.equal(directoryKey('C:/Users/Test/.Claude/SKILLS/../skills', 'win32', null), directoryKey('c:\\users\\test\\.claude\\skills', 'win32', null));
  assert.equal(directoryKey('\\\\?\\C:\\Users\\Test\\skills', 'win32', null), directoryKey('c:/users/test/skills', 'win32', null));
  assert.equal(directoryKey('\\\\?\\UNC\\Server\\Share\\Skills', 'win32', null), directoryKey('\\\\server\\share\\skills', 'win32', null));
  assert.notEqual(directoryKey('/tmp/Skills', 'linux'), directoryKey('/tmp/skills', 'linux'));
  assert.equal(directoryKey('/tmp/skills/../skills', 'linux'), '/tmp/skills');
});

test('directoryKey：8.3 短路径经注入的解析器从最近存在父目录还原，新目标也能比较', () => {
  const resolvePath = (value) => {
    if (value === 'C:\\Users\\RUNNER~1') return '\\\\?\\C:\\Users\\runneradmin\\';
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  assert.equal(directoryKey('C:\\Users\\RUNNER~1\\.claude\\skills', 'win32', resolvePath), 'c:\\users\\runneradmin\\.claude\\skills');
  assert.equal(directoryKey('C:\\Users\\RUNNER~1', 'win32', resolvePath), 'c:\\users\\runneradmin');
  assert.throws(() => directoryKey('C:\\locked', 'win32', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), { code: 'EACCES' });
});

test('sameDirectory：同一目录的各路径写法判等，不同目录不等', () => {
  if (process.platform === 'win32') assert.ok(sameDirectory('C:\\Users\\Test\\skills', 'c:/users/test/SKILLS'));
  else assert.ok(sameDirectory('/tmp/skills', '/tmp/./skills/'));
  assert.ok(!sameDirectory('/tmp/a', '/tmp/b'));
});

// —— 任务 6 ③：UNC/盘符同实体归一的现状钉住与已知限制定案 ——

test('directoryKey UNC 归一：\\\\?\\UNC\\ 前缀、大小写与分隔符变体稳定判等（同实体同形式访问去重正确）', () => {
  assert.equal(directoryKey('\\\\?\\UNC\\Server\\Share\\skills\\ppt', 'win32', null), directoryKey('\\\\server\\share\\skills\\ppt', 'win32', null));
  assert.equal(directoryKey('\\\\SERVER\\Share\\Skills\\', 'win32', null), directoryKey('\\\\server\\share\\skills', 'win32', null));
  assert.equal(directoryKey('Z:\\Share\\SKILLS\\ppt', 'win32', null), directoryKey('z:/share/skills/ppt', 'win32', null));
});

test('directoryKey 已知限制（钉住现状）：映射盘符与 UNC 两种形式不互转，同网络实体各得各的键', () => {
  // Node 标准库没有可靠的盘符映射查询 API（net use 属外部命令）：Z:\share 与 \\server\share
  // 指向同一实体时不判等。跨形式混排由链接规划的 targetKey 幂等跳过与扫描的 real_path 折叠自愈。
  assert.notEqual(directoryKey('Z:\\share\\skills\\ppt', 'win32', null), directoryKey('\\\\server\\share\\skills\\ppt', 'win32', null));
});

test('directoryKey 实体判等以 realpath 结果为键：同实体同形式访问判等（win32 本机大小写归一）', { skip: process.platform !== 'win32' ? 'win32 专属语义' : false }, async () => {
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'hy-key-')));
  try {
    // 大小写变体在 win32 不区分实体：realpath 还原磁盘上的真实大小写后判等。
    assert.equal(directoryKey(scratch.toUpperCase()), directoryKey(scratch));
    assert.equal(directoryKey(scratch + path.sep), directoryKey(scratch));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
