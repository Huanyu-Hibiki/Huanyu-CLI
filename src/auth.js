import { t } from './i18n.js';
import { hostname, platform } from 'node:os';
import { CliError } from './io.js';
import { readAuth, saveAuth, readPendingDevice, savePendingDevice, clearPendingDevice, isPendingDevice } from './config.js';

export const isCI = () => {
  const value = process.env.CI?.trim().toLowerCase();
  return Boolean(value && !['0', 'false', 'no', 'off'].includes(value));
};

const expired = () => new CliError(t('expiredDevice'), 1, 'expired_token');

const publicDevice = ({ user_code, verification_uri, verification_uri_complete, expires_at, interval }) =>
  ({ user_code, verification_uri, verification_uri_complete, expires_at, interval });

async function deviceLogin(ctx) {
  const waitDeadline = ctx.now() + (ctx.terminal ? 600_000 : 60_000);
  let device = await readPendingDevice();
  if (device) ctx.output.remember(device.device_code, { hide: true });
  if (device && device.expires_at <= ctx.now()) {
    await clearPendingDevice();
    device = null;
  }
  let resumed = Boolean(device);
  while (true) {
    if (!device) {
      const started = ctx.now();
      const result = await ctx.client.request('/api/cli/device', { method: 'POST', body: { client_name: hostname(), platform: platform(), ...(ctx.client.explicitLanguage ? { lang: ctx.client.lang } : {}) },
        timeoutMs: Math.max(1, Math.min(30_000, waitDeadline - started)) });
      // 无论响应是否完整，都先登记设备密钥，防止错误输出泄漏它。
      if (typeof result?.device_code === 'string') ctx.output.remember(result.device_code, { hide: true });
      device = { device_code: result?.device_code, user_code: result?.user_code, verification_uri: result?.verification_uri,
        verification_uri_complete: result?.verification_uri_complete, expires_at: started + result?.expires_in * 1000, interval: result?.interval };
      if (!Number.isFinite(result?.expires_in) || result.expires_in <= 0 || !isPendingDevice(device)) throw new CliError(t('invalidDevice'), 1, 'invalid_response');
      // 在浏览器授权和轮询之前落盘，Agent 提前结束进程也能继续领取。
      await savePendingDevice(device);
    }
    const browserBudget = Math.min(5000, waitDeadline - ctx.now());
    const opened = browserBudget > 0 && await ctx.openBrowser(device.verification_uri_complete, browserBudget);
    const warnings = opened ? [] : [t('browserWarning')];
    ctx.output.write({ event: 'device', ...publicDevice(device), opened, warnings },
      [t('openDevice', { url: device.verification_uri_complete }), t('deviceCode', { code: device.user_code }), ...warnings,
        t('deviceWait', { duration: t(ctx.terminal ? 'tenMinutes' : 'sixtySeconds') })]);

    try {
      while (true) {
        if (ctx.now() >= device.expires_at) throw expired();
        if (ctx.now() >= waitDeadline) {
          throw new CliError(t('pendingDevice', { url: device.verification_uri_complete, code: device.user_code }),
            3, 'authorization_pending', { ...publicDevice(device), next_command: ctx.nextCommand });
        }
        const deadline = Math.min(device.expires_at, waitDeadline);
        await ctx.sleep(Math.min(device.interval * 1000, deadline - ctx.now()), undefined, { signal: ctx.signal });
        if (ctx.now() >= deadline) continue;
        try {
          const result = await ctx.client.request('/api/cli/token', { method: 'POST', body: { device_code: device.device_code }, timeoutMs: Math.min(30_000, deadline - ctx.now()) });
          if (typeof result?.token !== 'string' || !result.token || /[\r\n\0]/.test(result.token) || typeof result.email !== 'string' || !result.email) throw new CliError(t('invalidLogin'), 1, 'invalid_response');
          return result;
        } catch (error) {
          if (error instanceof CliError && error.details.http_status === 400) {
            if (error.error === 'authorization_pending') continue;
            if (error.error === 'slow_down') {
              device.interval += 5;
              await savePendingDevice(device);
              continue;
            }
            if (error.error === 'access_denied') throw new CliError(t('deniedDevice'), 1, 'access_denied');
            if (error.error === 'expired_token') throw expired();
          }
          // 网络抖动或服务端 5xx 不打断登录，等到期限前继续轮询。
          if (error instanceof CliError && (error.error === 'network' || error.details.http_status >= 500)) continue;
          throw error;
        }
      }
    } catch (error) {
      if (error instanceof CliError && ['access_denied', 'expired_token'].includes(error.error)) {
        await clearPendingDevice();
        // 失效的待领取记录自动换新；新代码被拒绝或过期则交给用户重试。
        if (resumed && ctx.now() < waitDeadline) {
          device = null;
          resumed = false;
          continue;
        }
      }
      throw error;
    }
  }
}

export async function login(ctx, suppliedToken) {
  let token = suppliedToken, email;
  if (token) {
    ctx.output.remember(token);
    email = (await ctx.client.me(token)).email;
  } else {
    if (isCI()) throw new CliError(t('ciLogin'), 3, 'unauthorized', { token_environment: 'HY_TOKEN' });
    ({ token, email } = await deviceLogin(ctx));
  }
  ctx.output.remember(token);
  const file = await saveAuth(token, email, ctx.client.base);
  const warnings = process.env.HY_TOKEN && process.env.HY_TOKEN !== token ? [t('tokenPriority')] : [];
  ctx.token = token;
  ctx.output.write({ event: 'login', status: 'complete', token_prefix: token, email, config: file, warnings }, [t('loggedIn', { email }), t('loginSaved'), ...warnings]);
  return 0;
}

export async function loadAuth(ctx) {
  if (ctx.authLoaded) return;
  ctx.token = (await readAuth(ctx.client.base))?.token;
  ctx.output.remember(ctx.token);
  ctx.authLoaded = true;
}

export async function requireLogin(ctx) {
  await loadAuth(ctx);
  // 环境变量和 CI 沿用原有令牌规则；本机待领取登录优先完成。
  if (ctx.token && (process.env.HY_TOKEN || isCI() || !await readPendingDevice())) return;
  await login(ctx);
}
