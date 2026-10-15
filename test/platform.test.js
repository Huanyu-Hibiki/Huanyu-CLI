import test from 'node:test';
import assert from 'node:assert/strict';
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
