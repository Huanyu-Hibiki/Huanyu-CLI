import { CliError } from './io.js';
import { isCI } from './auth.js';
import { readPendingCheckout, savePendingCheckout, clearPendingCheckout } from './config.js';
import { findSkill } from './client.js';
import { t, command, skillLabel, planLabel, priceLabel } from './i18n.js';

// 已购状态与订阅展示共用同一口径（cli.js 的 SUBSCRIPTION_STATUSES）：处于这些状态视为已解锁。
const entitlement = (account, name) => account?.subscriptions.find((s) =>
  s.skill === name && ['active', 'canceling', 'past_due', 'lifetime', 'trialing'].includes(s.status));
// 轮询期抖动语义（设计「错误处理」）：网络故障与服务端 5xx 不中断等待，重试至期限。
const retryable = (error) => error instanceof CliError && (error.error === 'network' || error.details.http_status >= 500);
// 金额出现即须为正的有限数（L3）：0/负数/非数字的“价格”按付款信息不完整拒绝，不进输出与落盘。
const validAmount = (amount) => amount === undefined || amount === null || (Number.isFinite(amount) && amount > 0);

function purchaseDetails(product, name, plan, checkout) {
  // 付款响应里的金额币种优先于目录（恢复会话时保住实际成交价），否则回落目录价格。
  const price = Number.isFinite(checkout?.amount) && typeof checkout.currency === 'string' && checkout.currency
    ? checkout : product.prices[plan];
  const amount = price?.amount ?? price?.unit_amount ?? null;
  if (!validAmount(amount)) throw new CliError(t('invalidCheckout'), 1, 'invalid_response');
  return { product_name: skillLabel(name), plan, amount,
    currency: price?.currency ?? null, purchase_type: plan === 'lifetime' ? 'one_time' : 'subscription',
    purchase_description: planLabel(plan), price_label: priceLabel(price) };
}

export async function requirePurchase(ctx, name, { plan, force = false } = {}) {
  // 同进程解锁缓存：一条命令里重复判定（install 的闸门、402 重试）不再走网络与付款流程。
  const unlocked = ctx.unlockedSkills ??= new Set();
  if (!force && unlocked.has(name)) return;
  const { product } = findSkill(ctx.catalog, name);
  const selectedPlan = plan || product.offer?.[0] || Object.keys(product.prices)[0] || 'lifetime';
  let details = purchaseDetails(product, name, selectedPlan);
  let checkout = await readPendingCheckout(name, ctx.token, ctx.client.base);
  let state;
  // 恢复时先查原会话；未付或状态未知时，再由商店核对本次语言和币种。
  if (checkout) {
    try { state = await ctx.client.checkoutStatus(checkout.id, ctx.token); }
    catch (error) {
      // 404：服务端已无此会话（过期清理/数据更替）——本地记录不可恢复，清掉后走新建会话，
      // 不让用户死锁在每跑必报错的坏记录上（M1 纵深防御；其余非抖动错误照常 fail-closed）。
      if (error instanceof CliError && error.details.http_status === 404) {
        await clearPendingCheckout(checkout.id);
        checkout = null;
      } else if (!retryable(error)) throw error;
    }
  }
  if (!force) {
    let account;
    try { account = await ctx.client.me(ctx.token); }
    catch (error) { if (!state?.entitled) throw error; }
    if (state?.entitled || entitlement(account, name)) {
      unlocked.add(name);
      if (checkout) await clearPendingCheckout(checkout.id);
      return;
    }
  }
  if (state?.entitled) {
    unlocked.add(name);
    await clearPendingCheckout(checkout.id);
    return;
  }
  if (checkout && state && !state.paid && (state.status === 'expired' || (state.status === 'open' && checkout.plan !== selectedPlan))) {
    await clearPendingCheckout(checkout.id);
    checkout = null;
  }
  if (checkout) details = purchaseDetails(product, name, checkout.plan, checkout);
  const pending = (url, extra = {}) => new CliError(
    t(state?.paid || state?.status === 'complete' ? 'paymentProcessing' : 'pendingPayment', { url }),
    3, 'payment_pending', { skill: name, url, purchase_url: url, next_command: ctx.nextCommand, ...details,
      ...(checkout ? { id: checkout.id } : {}), ...extra });
  if (isCI()) {
    const query = new URLSearchParams({ skill: name, ...(plan ? { plan } : {}), ...(ctx.client.explicitLanguage ? { lang: ctx.client.lang } : {}) });
    // CI 不创建会话，给本次语言的网页入口；本地记录留待下次交互恢复。
    checkout = null;
    details = purchaseDetails(product, name, selectedPlan);
    throw pending(ctx.client.url(`/api/store/checkout?${query}`), { ci: true, opened: false });
  }

  // 交互终端给足 15 分钟（人在浏览器里付款），非交互 60 秒（Agent 轮询预算）。
  const waitMs = ctx.terminal ? 900_000 : 60_000;
  const deadline = ctx.now() + waitMs;
  const complete = async (subscription, extra = {}) => {
    unlocked.add(name);
    if (checkout) await clearPendingCheckout(checkout.id);
    ctx.output.write({ event: 'subscribed', skill: name, ...(subscription ? { subscription } : {}), ...extra }, [t('purchased', { name: skillLabel(name) })]);
  };
  const previousId = checkout?.id;
  let notice = null;
  if (!checkout || !state || (state.status === 'open' && !state.paid)) {
    try {
      checkout = await ctx.client.request('/api/store/checkout', { method: 'POST', token: ctx.token,
        body: { skill: name, ...(plan ? { plan } : {}), ...(ctx.client.explicitLanguage ? { lang: ctx.client.lang } : {}) }, timeoutMs: Math.min(30_000, waitMs) });
    } catch (error) {
      // 与服务端保持一致：409 已代表履约完成。
      if (error instanceof CliError && error.error === 'already_active' && error.details.http_status === 409) {
        await complete(null, { already_active: true });
        return;
      }
      throw error;
    }
    try {
      const url = new URL(checkout?.url);
      if (typeof checkout.id !== 'string' || !checkout.id || typeof checkout.reused !== 'boolean'
        || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
        // 付款页协议与 API 对齐（L2）：https API 只接受 https 付款页，防止服务端把用户引到明文信道。
        || (new URL(ctx.client.base).protocol === 'https:' && url.protocol !== 'https:')
        // 金额出现即须合法（L3），拒绝 0/负数/非数字。
        || !validAmount(checkout.amount)) throw new Error();
    } catch { throw new CliError(t('invalidCheckout'), 1, 'invalid_response'); }
    // 商店给的购买前提醒：让 Agent 在用户付款前转告，并附上免费开源版的安装命令。
    // 提醒是服务端文本、会进终端与 JSON 输出：先消毒（L1）——剥离 \r\n\t 之外的控制字符
    // （终端转义/注入面），500 字封顶，超长截断附省略号。
    if (typeof checkout.notice === 'string') {
      const clean = checkout.notice.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
      if (clean) notice = t('purchaseNotice', { notice: (clean.length > 500 ? `${clean.slice(0, 500)}…` : clean)
        + (product.free ? t('freeInstall', { next: command('install', product.free.skill) }) : '') });
    }
    // 先落盘，再打开浏览器；中断和超时后都能恢复。
    await savePendingCheckout({ id: checkout.id, url: checkout.url, skill: name, plan: selectedPlan, ...(Number.isFinite(checkout.amount) && checkout.currency ? { amount: checkout.amount, currency: checkout.currency } : {}) }, ctx.token, ctx.client.base);
  }
  const resumed = previousId === checkout.id;
  details = purchaseDetails(product, name, checkout.plan || selectedPlan, checkout);
  const processing = state?.paid || state?.status === 'complete';
  const browserBudget = Math.min(5000, deadline - ctx.now());
  const opened = !processing && browserBudget > 0 && await ctx.openBrowser(checkout.url, browserBudget);
  const warnings = opened || processing ? [] : [t('browserWarning')];
  const message = t('checkoutSummary', { name: details.product_name, price: t('pricePlan', { price: details.price_label, plan: details.purchase_description }) });
  ctx.output.write({ event: 'checkout', skill: name, id: checkout.id, url: checkout.url, reused: resumed || checkout.reused, resumed, opened, warnings, ...details, message,
    ...(notice ? { notice } : {}), max_wait_seconds: waitMs / 1000, next_command: ctx.nextCommand },
    [message, notice, processing ? t('paymentProcessing') : t('paymentPage', { url: checkout.url }), ...warnings,
      t('paymentWait', { duration: t(ctx.terminal ? 'fifteenMinutes' : 'sixtySeconds') })]);
  while (ctx.now() < deadline) {
    await ctx.sleep(Math.min(3000, deadline - ctx.now()), undefined, { signal: ctx.signal });
    if (ctx.now() >= deadline) break;
    try { state = await ctx.client.checkoutStatus(checkout.id, ctx.token, { timeoutMs: Math.min(30_000, deadline - ctx.now()) }); }
    catch (error) { if (!retryable(error)) throw error; }
    if (ctx.now() >= deadline) break;
    let account;
    try { account = await ctx.client.me(ctx.token, { timeoutMs: Math.min(30_000, deadline - ctx.now()) }); }
    catch (error) { if (!retryable(error) && !state?.entitled) throw error; }
    const subscription = entitlement(account, name);
    if (ctx.now() < deadline && (state?.entitled || subscription)) { await complete(subscription); return; }
    if (state?.status === 'expired' && !state.paid) {
      await clearPendingCheckout(checkout.id);
      throw new CliError(t('expiredCheckout'), 3, 'payment_pending', { skill: name, id: checkout.id, url: checkout.url, purchase_url: checkout.url, next_command: ctx.nextCommand, ...details });
    }
  }
  throw pending(checkout.url, { opened, max_wait_seconds: waitMs / 1000, ...(notice ? { notice } : {}) });
}
