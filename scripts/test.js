import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// cmd.exe 不展开通配符，Node 18 也不展开测试 glob；直接传入全部测试文件。
const files = readdirSync(new URL('../test/', import.meta.url)).filter((name) => name.endsWith('.test.js')).sort();
const result = spawnSync(process.execPath, ['--test', ...files.map((name) => `test/${name}`)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
