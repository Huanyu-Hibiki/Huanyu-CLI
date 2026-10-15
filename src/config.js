import { t } from './i18n.js';
import path from 'node:path';
import { mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { CliError } from './io.js';
import { pathsFor, userHome, restrictPermissions, absoluteDirectory } from './platform.js';
import { DEFAULT_API } from './client.js';

export function configPath(env = process.env, platform = process.platform) {
  const paths = pathsFor(platform);
  if (platform === 'win32') {
    // 相对路径的 APPDATA 不可信：凭证不能写进随 cwd 漂移的目录，等价于未设置。
    const appdata = absoluteDirectory(env.APPDATA, paths);
    if (!appdata) throw new CliError(t('missingAppdata'));
    return paths.join(appdata, 'huanyu', 'config.json');
  }
  // XDG 规范要求绝对路径；相对值忽略并回落 ~/.config。
  return paths.join(absoluteDirectory(env.XDG_CONFIG_HOME, paths) || paths.join(userHome(env, platform), '.config'), 'huanyu', 'config.json');
}

export function isPendingDevice(device) {
  return device && ['device_code', 'user_code', 'verification_uri', 'verification_uri_complete'].every((key) => typeof device[key] === 'string' && device[key])
    && Number.isFinite(device.expires_at) && device.expires_at > 0 && Number.isFinite(device.interval) && device.interval > 0;
}

// 付款会话只存非敏感字段 + 令牌摘要（sha256，64 位十六进制）：url 必须是 http(s) 且不带凭据，
// 恢复时才允许把会话 id 发给商店查询。明文令牌绝不落盘。
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
export function isPendingCheckout(checkout) {
  if (!checkout || !['id', 'url', 'skill', 'plan', 'api', 'token_hash'].every((key) => typeof checkout[key] === 'string' && checkout[key])) return false;
  try {
    const url = new URL(checkout.url), api = new URL(checkout.api);
    // 付款页协议与签发服务器对齐（L2）：https API 只接受 https 付款页记录，降级记录按坏配置拒绝。
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !(api.protocol === 'https:' && url.protocol !== 'https:')
      && /^[a-f0-9]{64}$/.test(checkout.token_hash);
  } catch { return false; }
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
    if (data.pending_checkout !== undefined && !isPendingCheckout(data.pending_checkout)) throw new Error('invalid config');
    if (!hasAuth && !data.pending_device && !data.pending_checkout) throw new Error('invalid config');
    await restrictPermissions(file);
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    // 自带的 CliError（如 missingAppdata）原样透出；其余读写故障统一转 configRead。
    if (error instanceof CliError) throw error;
    // 坏配置必须显式报错，交给用户处理，绝不静默重置。
    throw new CliError(t('configRead'), 1, 'config_read');
  }
}

const origin = (value) => { try { return new URL(value).origin; } catch { return null; } };

// 本机保存且签发给该服务器的令牌；不走 HY_TOKEN 短路（logout 两枚令牌都要撤销）。
export async function readSavedAuth(api) {
  const data = await readConfig();
  if (!data?.token || origin(data.api || DEFAULT_API) !== origin(api)) return null;
  return { token: data.token, email: data.email };
}

// 保存的令牌只发给签发它的服务器：HY_API 指向别处时当作没有登录。
// 旧配置没有记录服务器，视为默认服务器。HY_TOKEN 是用户显式提供的，不受限制。
export async function readAuth(api) {
  if (process.env.HY_TOKEN) return { token: process.env.HY_TOKEN, email: null };
  return await readSavedAuth(api);
}

export async function readPendingDevice() {
  return (await readConfig())?.pending_device ?? null;
}

// 会话只能由创建它的令牌（摘要比对）向同一服务器（origin 比对）恢复；换令牌/换服务器都不沿用。
export async function readPendingCheckout(skill, token, api) {
  const checkout = (await readConfig())?.pending_checkout;
  return checkout?.skill === skill && checkout.token_hash === tokenHash(token) && origin(checkout.api) === origin(api) ? checkout : null;
}

export async function savePendingCheckout(checkout, token, api) {
  return await saveConfig({ ...await readConfig(), pending_checkout: { ...checkout, api, token_hash: tokenHash(token) } });
}

export async function clearPendingCheckout(id) {
  const data = await readConfig();
  if (data?.pending_checkout?.id !== id) return;
  delete data.pending_checkout;
  if (data.token || data.pending_device) await saveConfig(data);
  else await logout();
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
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(t('configWrite'), 1, 'config_write');
  } finally {
    await handle?.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
  }
  return file;
}

// 保存令牌时一并清掉待领取记录；saveConfig 不读旧文件，显式令牌登录也能修复坏配置——
// 但同一令牌向同一服务器重新登录时保留付款进度（重跑不重复收费）。
export async function saveAuth(token, email, api) {
  let pending;
  try {
    const checkout = (await readConfig())?.pending_checkout;
    if (checkout && checkout.token_hash === tokenHash(token) && origin(checkout.api) === origin(api)) pending = checkout;
  } catch (error) {
    // 坏配置仍可被显式令牌登录修复；其余读写故障照常透出。
    if (!(error instanceof CliError) || error.error !== 'config_read') throw error;
  }
  return await saveConfig({ token, email, api, ...(pending ? { pending_checkout: pending } : {}) });
}

export async function savePendingDevice(device) {
  return await saveConfig({ ...await readConfig(), pending_device: device });
}

export async function clearPendingDevice() {
  const data = await readConfig();
  if (!data?.pending_device) return;
  delete data.pending_device;
  if (data.token || data.pending_checkout) await saveConfig(data);
  else await logout();
}

export async function logout() {
  try { await rm(configPath(), { force: true }); }
  catch { throw new CliError(t('configDelete'), 1, 'config_write'); }
}
