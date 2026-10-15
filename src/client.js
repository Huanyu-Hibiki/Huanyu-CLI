import { t, language, command, skillLabel } from './i18n.js';
import { CliError } from './io.js';

// 规范名与 semver 校验暂驻 client.js；任务 5 的 skills.js 数据层落地后统一收编。
export const isSkillName = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value);
export const isVersion = (value) => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);

const invalid = (message) => new CliError(message, 1, 'invalid_response');

// 契约（设计「数据模型」）规定了字段，但尚未规定目录的 JSON 外层和免费/付费字段的形状，这里做容错。
export function normalizeCatalog(data) {
  const products = Array.isArray(data) ? data : data?.products ?? data?.catalog;
  if (!Array.isArray(products)) throw invalid(t('catalogIncomplete'));
  const names = new Set(), ids = new Set();
  return products.map((product) => {
    if (!product || typeof product.id !== 'string' || !product.id || ids.has(product.id) || typeof product.name !== 'string' || !product.name) throw invalid(t('catalogDuplicate'));
    ids.add(product.id);
    const item = { ...product, prices: product.prices ?? {} };
    for (const type of ['free', 'paid']) {
      const variant = product[type];
      if (variant == null) { item[type] = null; continue; }
      const name = typeof variant === 'string' ? variant : variant.skill;
      if (!isSkillName(name) || names.has(name)) throw invalid(t('catalogInvalidSkill'));
      names.add(name);
      item[type] = { skill: name };
    }
    if (!item.free && !item.paid) throw invalid(t('catalogMissingSkill'));
    if (!item.prices || typeof item.prices !== 'object' || Array.isArray(item.prices)) throw invalid(t('catalogInvalidPrice'));
    return item;
  });
}

export const catalogNames = (catalog) => catalog.flatMap((p) => [p.free?.skill, p.paid?.skill].filter(Boolean));
export const findSkill = (catalog, name) => {
  const product = catalog.find((p) => p.free?.skill === name || p.paid?.skill === name);
  if (!product) throw new CliError(t('unknownSkill', { name: skillLabel(name) }), 2, 'unknown_skill');
  return { product, paid: product.paid?.skill === name };
};

// 占位常量：服务端另建后在一处替换（设计「假设清单」#6）。
export const DEFAULT_API = 'https://store.huanyu.example';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// 接口地址：只允许 HTTPS，HTTP 只留给本机调试，免得令牌明文发出去
export function apiBase(env = process.env) {
  let url;
  try {
    url = new URL(env.HY_API || DEFAULT_API);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new CliError(t('invalidApi'), 2, 'invalid_api'); }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) throw new CliError(t('insecureApi'), 2, 'invalid_api');
  return url.href.replace(/\/$/, '');
}

export class Client {
  constructor(signal = new AbortController().signal) {
    this.base = apiBase();
    this.signal = signal;
    this.lang = language().lang;
    this.explicitLanguage = language().explicit;
  }
  url(route) { return `${this.base}${route}`; }
  subscriptionUrl(skill, product) {
    const page = typeof product?.page === 'string' && /^\/(?!\/)/.test(product.page) ? product.page : `/store/${encodeURIComponent(skill)}/`;
    return this.url(page);
  }
  async request(route, { token, method = 'GET', body, download = false, skill, product, timeoutMs = 30_000 } = {}) {
    if (token && /[\r\n\0]/.test(token)) throw new CliError(t('invalidToken'), 3, 'unauthorized');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (this.signal.aborted) abort();
    this.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, download ? 120_000 : timeoutMs);
    const dispose = () => { clearTimeout(timer); this.signal.removeEventListener('abort', abort); };
    let handedOff = false;
    try {
      const address = /^https?:\/\//.test(route) ? route : this.url(route);
      // API 不得重定向；免费发布物可以跳到公开附件，且不携带令牌。
      const response = await fetch(address, {
        method,
        headers: { 'Accept-Language': this.lang, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal,
        redirect: download && !token ? 'follow' : 'error',
      });
      if (download && response.ok) { handedOff = true; return { response, dispose }; }
      let data;
      try { data = await response.json(); }
      catch { if (![401, 402].includes(response.status)) throw invalid(t('invalidJson')); }
      if (!response.ok) {
        const details = { http_status: response.status };
        let message = typeof data?.message === 'string' ? data.message : t('httpError', { status: response.status });
        if (response.status === 401) message = t('unauthorized');
        if (response.status === 402) {
          details.subscribe_command = command('subscribe', skill || '<skill>');
          details.subscription_url = this.subscriptionUrl(skill || '<skill>', product);
          message = t('inactive', { name: skillLabel(skill || t('thisSkill')), next: details.subscribe_command, url: details.subscription_url });
        }
        throw new CliError(message, [401, 402].includes(response.status) ? 3 : 1,
          response.status === 401 ? 'unauthorized' : response.status === 402 ? 'inactive' : typeof data?.error === 'string' ? data.error : 'http_error', details);
      }
      return data;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(this.signal.aborted ? t('canceled') : t('network'), 1, this.signal.aborted ? 'cancelled' : 'network');
    } finally {
      if (!handedOff) dispose();
    }
  }
  async catalog() { return normalizeCatalog(await this.request('/api/store/catalog')); }
  async versions(catalog) {
    const data = await this.request('/api/store/versions');
    const skills = data?.skills ?? data;
    for (const name of catalogNames(catalog)) {
      const release = skills?.[name];
      if (!release || !isVersion(release.latest) || !Array.isArray(release.history)) throw invalid(t('invalidVersions', { name: skillLabel(name) }));
    }
    return skills;
  }
  async me(token, options = {}) {
    const data = await this.request('/api/auth/me', { token, ...options });
    if (typeof data?.email !== 'string' || !data.email || !Array.isArray(data.subscriptions)) throw invalid(t('invalidAccount'));
    return data;
  }
}
