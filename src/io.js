import { t } from './i18n.js';
import { createInterface } from 'node:readline/promises';

export class CliError extends Error {
  constructor(message, code = 1, error = 'failed', details = {}) {
    super(message);
    this.code = code;
    this.error = error;
    this.details = details;
  }
}

// 输出只经过这里，包括接口返回的文本和错误。也遮盖不符合格式的 --token。
export class Output {
  constructor(json, command, secrets = []) {
    this.json = json;
    this.command = command;
    this.secrets = new Set(secrets.filter(Boolean));
    this.hiddenSecrets = new Set();
  }
  remember(value, { hide = false } = {}) {
    if (value) {
      this.secrets.add(value);
      if (hide) this.hiddenSecrets.add(value);
    }
  }
  redact(value) {
    let result = value;
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length)) {
      for (const form of new Set([secret, encodeURIComponent(secret)])) {
        // 短密钥显示前 8 字符等于整段泄漏，一律整段隐藏。
        result = result.replaceAll(form, this.hiddenSecrets.has(secret) || secret.length <= 8 ? t('hidden') : `${secret.slice(0, 8)}…`);
      }
    }
    return result.replace(/hy_[A-Za-z0-9]+…?/g, (token) => `${token.slice(0, 8).replace(/…$/, '')}…`);
  }
  sanitize(value) {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [this.redact(key), this.sanitize(item)]));
    return value;
  }
  write(data, lines, ok = true) {
    const value = this.json
      ? JSON.stringify(this.sanitize({ ok, command: this.command, ...data }))
      : this.redact(lines.filter(Boolean).join('\n'));
    (ok || this.json ? process.stdout : process.stderr).write(`${value}\n`);
  }
  fail(error) {
    const known = error instanceof CliError;
    this.write({ error: known ? error.error : 'failed', message: known ? error.message : t('failed'), ...(known ? error.details : {}) },
      [known ? error.message : t('failed'), ...(error.details?.recovery_paths || []).map((p) => t('recovery', { path: p }))], false);
    return known ? error.code : 1;
  }
}

export function canPrompt(json) {
  return !json && Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export async function ask(question, signal) {
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await reader.question(question, { signal })).trim(); }
  finally { reader.close(); }
}

export async function confirm(question, yes, interactive, signal, defaultYes = false, questioner = ask) {
  if (yes) return true;
  if (!interactive) return true;
  const answer = (await questioner(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `, signal)).trim();
  return answer ? /^(y|yes|是)$/i.test(answer) : defaultYes;
}
