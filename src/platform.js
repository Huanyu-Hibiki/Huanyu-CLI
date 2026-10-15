import path from 'node:path';
import { homedir } from 'node:os';
import { chmod } from 'node:fs/promises';

export const pathsFor = (platform = process.platform) => platform === 'win32' ? path.win32 : path.posix;
export const userHome = (env = process.env, platform = process.platform) =>
  (platform === 'win32' ? env.USERPROFILE || env.HOME : env.HOME) || homedir();

// Windows chmod 不能表达 owner/group/others；凭据权限继承 APPDATA 的 ACL。
export async function restrictPermissions(file, platform = process.platform, changeMode = chmod) {
  if (platform !== 'win32') await changeMode(file, 0o600);
}
