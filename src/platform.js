import path from 'node:path';
import { homedir } from 'node:os';
import { chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';

export const pathsFor = (platform = process.platform) => platform === 'win32' ? path.win32 : path.posix;
export const userHome = (env = process.env, platform = process.platform) =>
  (platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) || homedir();

// 绝对目录判定：环境变量给相对路径时视为无效，位置不随 cwd 漂移（config.js 的凭据目录与 hosts.js 的宿主根共用）。
export const absoluteDirectory = (value, paths = pathsFor()) =>
  typeof value === 'string' && value.trim() && paths.isAbsolute(value) ? value : null;

// 路径解析：~ 与 ~/ 展开，其余按当前目录（或显式 cwd）解析为绝对路径。
export function resolveDirectory(value, env = process.env, platform = process.platform, cwd = process.cwd()) {
  const home = userHome(env, platform), paths = pathsFor(platform);
  if (value === '~') return home;
  if (/^~[/\\]/.test(value)) return paths.resolve(home, value.slice(2));
  return paths.resolve(cwd, value);
}

// Windows 的路径比较忽略大小写、分隔符和 Win32 扩展路径前缀。
// resolvePath 只在「以 win32 语义比较且本机真是 win32」时默认启用 8.3 还原；跨平台测试可注入或置空。
export function directoryKey(value, platform = process.platform, resolvePath = platform === 'win32' && process.platform === 'win32' ? realpathSync.native : null) {
  const paths = pathsFor(platform);
  if (platform === 'win32') {
    value = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
    value = paths.resolve(value);
    // 8.3 短路径与长路径必须比较为同一实体；新目标从最近存在的父目录解析。
    if (resolvePath) {
      const suffix = [];
      for (;;) {
        try { value = paths.join(resolvePath(value), ...suffix); break; }
        catch (error) {
          const parent = paths.dirname(value);
          if (!['ENOENT', 'ENOTDIR'].includes(error.code) || parent === value) throw error;
          suffix.unshift(paths.basename(value));
          value = parent;
        }
      }
    }
    return paths.resolve(value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')).toLowerCase();
  }
  return paths.resolve(value);
}
export const sameDirectory = (a, b) => directoryKey(a) === directoryKey(b);

// Windows chmod 不能表达 owner/group/others；凭据权限继承 APPDATA 的 ACL。
export async function restrictPermissions(file, platform = process.platform, changeMode = chmod) {
  if (platform !== 'win32') await changeMode(file, 0o600);
}

export function tarInvocation(archive, destination, platform = process.platform, env = process.env) {
  const paths = pathsFor(platform);
  const windows = env.SystemRoot || env.WINDIR;
  return {
    command: platform === 'win32' ? windows ? paths.join(windows, 'System32', 'tar.exe') : 'tar.exe' : 'tar',
    // 归档名不带盘符，兼容 bsdtar 和 GNU tar；不使用 GNU 专有的 --force-local。
    args: ['-xzf', paths.basename(archive), '-C', destination],
    cwd: paths.dirname(archive),
  };
}
