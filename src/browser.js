import { t } from './i18n.js';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliError } from './io.js';

const exec = promisify(execFile);

export async function openBrowser(value, platform = process.platform, runner = exec, timeoutMs = 5000) {
  let url;
  try {
    url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
  } catch { throw new CliError(t('invalidBrowser'), 1, 'invalid_response'); }
  const options = { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024, env: process.env };
  let command;
  if (platform === 'darwin') command = 'open';
  else if (platform === 'win32') {
    // ComSpec 未设置时用系统目录的绝对路径，不从 PATH 搜索可被劫持的 cmd.exe。
    const root = process.env.SystemRoot || process.env.WINDIR;
    command = process.env.ComSpec || (root ? path.win32.join(root, 'System32', 'cmd.exe') : 'cmd.exe');
  } else command = 'xdg-open';
  // Windows 经环境变量传 URL，避免 & % ! ^ 等字符被 cmd 二次解释。
  const args = platform === 'win32'
    ? ['/d', '/v:off', '/s', '/c', '"start "" "%HY_BROWSER_URL%""']
    : [url.href];
  if (platform === 'win32') {
    options.env = { ...process.env, HY_BROWSER_URL: url.href };
    options.windowsVerbatimArguments = true;
  }
  try { await runner(command, args, options); return true; }
  catch { return false; }
}
