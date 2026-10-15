import { t } from './i18n.js';
import path from 'node:path';
import { mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CliError } from './io.js';
import { pathsFor, userHome, restrictPermissions } from './platform.js';
import { DEFAULT_API } from './client.js';

export function configPath(env = process.env, platform = process.platform) {
  const paths = pathsFor(platform);
  if (platform === 'win32') {
    if (!env.APPDATA) throw new CliError(t('missingAppdata'));
    return paths.join(env.APPDATA, 'huanyu', 'config.json');
  }
  return paths.join(env.XDG_CONFIG_HOME || paths.join(userHome(env, platform), '.config'), 'huanyu', 'config.json');
}

export function isPendingDevice(device) {
  return device && ['device_code', 'user_code', 'verification_uri', 'verification_uri_complete'].every((key) => typeof device[key] === 'string' && device[key])
    && Number.isFinite(device.expires_at) && device.expires_at > 0 && Number.isFinite(device.interval) && device.interval > 0;
}

async function readConfig() {
  try {
    const file = configPath();
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid config');
    const hasAuth = data.token !== undefined || data.email !== undefined;
    if (hasAuth && (typeof data.token !== 'string' || !data.token || typeof data.email !== 'string' || !data.email)) throw new Error('invalid config');
    if (data.api !== undefined && typeof data.api !== 'string') throw new Error('invalid config');
    if (data.pending_device !== undefined && !isPendingDevice(data.pending_device)) throw new Error('invalid config');
    if (!hasAuth && !data.pending_device) throw new Error('invalid config');
    await restrictPermissions(file);
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // 坏配置必须显式报错，交给用户处理，绝不静默重置。
    throw new CliError(t('configRead'), 1, 'config_read');
  }
}

const origin = (value) => { try { return new URL(value).origin; } catch { return null; } };

// 保存的令牌只发给签发它的服务器：HY_API 指向别处时当作没有登录。
// 旧配置没有记录服务器，视为默认服务器。HY_TOKEN 是用户显式提供的，不受限制。
export async function readAuth(api) {
  if (process.env.HY_TOKEN) return { token: process.env.HY_TOKEN, email: null };
  const data = await readConfig();
  if (!data?.token) return null;
  if (origin(data.api || DEFAULT_API) !== origin(api)) return null;
  return { token: data.token, email: data.email };
}

export async function readPendingDevice() {
  return (await readConfig())?.pending_device ?? null;
}

async function saveConfig(data) {
  const file = configPath();
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(data) + '\n');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await restrictPermissions(temp);
    await rename(temp, file);
  } catch {
    throw new CliError(t('configWrite'), 1, 'config_write');
  } finally {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
  return file;
}

// 保存令牌时一并清掉待领取记录；saveConfig 不读旧文件，显式令牌登录也能修复坏配置。
export async function saveAuth(token, email, api) {
  return await saveConfig({ token, email, api });
}

export async function savePendingDevice(device) {
  return await saveConfig({ ...await readConfig(), pending_device: device });
}

export async function clearPendingDevice() {
  const data = await readConfig();
  if (!data?.pending_device) return;
  delete data.pending_device;
  if (data.token) await saveConfig(data);
  else await logout();
}

export async function logout() {
  try { await rm(configPath(), { force: true }); }
  catch { throw new CliError(t('configDelete'), 1, 'config_write'); }
}
