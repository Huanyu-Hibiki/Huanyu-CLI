import { t, language, command, skillLabel } from './i18n.js';
import { CliError } from './io.js';
import { isSkillName, isVersion } from './skills.js';

// 规范名与 semver 校验随任务 4 的 skills.js 数据层收编；这里保留再导出以免调用方漂移。
export { isSkillName, isVersion };

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
  async request(route, { token, method = 'GET', body, headers = {}, download = false, skill, product, timeoutMs = 30_000 } = {}) {
    if (token && /[\r\n\0]/.test(token)) throw new CliError(t('invalidToken'), 3, 'unauthorized');
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (this.signal.aborted) abort();
    this.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, download ? 120_000 : timeoutMs);
    const dispose = () => { clearTimeout(timer); this.signal.removeEventListener('abort', abort); };
    // 二进制体（Uint8Array/Buffer）按原始字节发送；Web 流式体由调用方提供 Content-Type；
    // 其余按 JSON 编码。
    const binary = body instanceof Uint8Array;
    const streaming = typeof ReadableStream !== 'undefined' && body instanceof ReadableStream;
    let handedOff = false;
    try {
      const address = /^https?:\/\//.test(route) ? route : this.url(route);
      // API 不得重定向；免费发布物可以跳到公开附件，且不携带令牌。
      const response = await fetch(address, {
        method,
        headers: { 'Accept-Language': this.lang,
          ...(body !== undefined && !streaming ? { 'Content-Type': binary ? 'application/gzip' : 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
        ...(body !== undefined ? { body: streaming || binary ? body : JSON.stringify(body) } : {}), ...(streaming ? { duplex: 'half' } : {}),
        signal: controller.signal,
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
    // publisher 是设计契约字段（发布端鉴权）：缺字段按 invalid_response 拒绝（任务 3 审查登记）。
    if (typeof data?.email !== 'string' || !data.email || !Array.isArray(data.subscriptions) || typeof data.publisher !== 'boolean') throw invalid(t('invalidAccount'));
    // 订阅条目形状（二期任务 3 审查 security-L2）：skill/status 必须是非空字符串，残缺条目在传输层
    // 按 invalid_response 拒绝——消费端（权益判定/订阅展示）不再防御 null 条目。
    if (!data.subscriptions.every((item) => item && typeof item === 'object' && typeof item.skill === 'string' && item.skill && typeof item.status === 'string' && item.status)) throw invalid(t('invalidAccount'));
    return data;
  }
  // 付款会话状态（二期任务 4，设计「接口设计」）：status ∈ open/complete/expired，
  // paid（是否已收款）与 entitled（履约是否生效）必须是布尔——残缺响应按 invalid_response 拒绝。
  async checkoutStatus(id, token, options = {}) {
    const data = await this.request(`/api/store/checkout/status?id=${encodeURIComponent(id)}`, { token, ...options });
    if (!['open', 'complete', 'expired'].includes(data?.status) || typeof data.paid !== 'boolean' || typeof data.entitled !== 'boolean') throw invalid(t('invalidCheckoutStatus'));
    return data;
  }
  // 发布上传（设计「接口设计·发布端」）：体为 tar.gz 二进制（Web 流式，不整体驻留内存），
  // 名字/版本/摘要在 X- 头里；错误语义 409 version_exists / 403 not_a_publisher / 400 invalid_package /
  // 413 too_large 由调用方映射。size 用于响应复核（流式体没有可直接比对的字节数）。
  async publish(token, { name, version, sha256, size, body, notes }) {
    const data = await this.request('/api/store/publish', {
      token, method: 'POST', body, timeoutMs: 120_000,
      // 说明文本经百分号编码放进头：HTTP 头不接受非 ASCII 字节。
      headers: { 'Content-Type': 'application/gzip', 'X-Skill-Name': name, 'X-Skill-Version': version, 'X-Content-SHA256': sha256, ...(notes ? { 'X-Notes': encodeURIComponent(notes) } : {}) },
    });
    if (data?.skill !== name || data?.version !== version || data?.sha256 !== sha256
      || !Number.isSafeInteger(data?.size) || data.size !== size || typeof data?.url !== 'string' || !data.url) throw invalid(t('publishResponse'));
    return data;
  }
  // 商品注册/更新（二期任务 2，设计「接口设计·发布端」）：fields 只含调用方提供的键；
  // 响应为更新后的商品对象，形状校验复用目录归一化（id/name/free/paid/prices 全套检查）。
  async product(token, skill, fields) {
    const data = await this.request(`/api/store/products/${encodeURIComponent(skill)}`, { token, method: 'PUT', body: fields });
    try { return normalizeCatalog([data])[0]; }
    catch { throw invalid(t('productResponse')); }
  }
  // 版本下架（二期任务 2）：yank 幂等由服务端保证（重复下架仍 200），已装用户不受影响。
  async unpublish(token, skill, version) {
    const data = await this.request(`/api/store/releases/${encodeURIComponent(skill)}/${encodeURIComponent(version)}`, { token, method: 'DELETE' });
    if (data?.skill !== skill || data?.version !== version || data?.yanked !== true) throw invalid(t('unpublishResponse'));
    return data;
  }
}
