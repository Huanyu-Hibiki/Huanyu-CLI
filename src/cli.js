import { t, withLanguage, resolveLanguage, command, helpLines, skillLabel, planLabel, priceLabel as formatPrice } from './i18n.js';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { lstat, readFile } from 'node:fs/promises';
import { Output, CliError, ask, canPrompt, confirm } from './io.js';
import { readSavedAuth, logout as deleteConfig } from './config.js';
import { Client, catalogNames, findSkill, isSkillName, isVersion } from './client.js';
import { login, loadAuth, requireLogin } from './auth.js';
import { openBrowser } from './browser.js';
import { publishSkill, publishRepo } from './publish.js';
import { scan, compare, updates, conflicts, duplicateCopies, inspectSkill, isDevelopmentDirectory, uniqueDirectories, canonicalDirectory } from './skills.js';
import { targetRoot, installationRoots } from './hosts.js';
import { directoryKey, sameDirectory } from './platform.js';
import { prepare, replaceAll } from './install.js';

// 14 个命令全部在参数解析层合法；help/version/list/login/logout/status/publish 之外的执行逻辑随后续任务落地。
const COMMANDS = ['status', 'list', 'install', 'update', 'login', 'logout', 'subscribe', 'manage', 'help', 'version', 'publish', 'product', 'unpublish', 'audit'];

export function parseArgs(argv) {
  const options = { command: null, json: false, yes: false, to: [], token: null, plan: null, path: null, skill: null, lang: null, repo: null, notes: null, all: false, check: false };
  const positions = [];
  let version = false, helpFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--check') options.check = true;
    else if (arg === '--version') version = true;
    else if (['--help', '-h'].includes(arg)) helpFlag = true;
    else if (/^--(to|token|plan|path|lang|repo|notes)(=|$)/.test(arg)) {
      const flag = arg.split('=')[0], field = flag.slice(2);
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value || value.startsWith('-')) throw new CliError(t('missingArgument', { flag }), 2, 'missing_argument');
      if (field === 'to') options.to.push(value);
      else {
        if (options[field] !== null) throw new CliError(t('duplicateArgument', { flag }), 2, 'usage');
        options[field] = value;
      }
    } else if (arg.startsWith('-')) throw new CliError(t('unknownArgument'), 2, 'usage');
    else positions.push(arg);
  }
  options.command = positions.shift() || 'status';
  if (version) {
    if (positions.length || options.command !== 'status' || options.to.length || options.token || options.plan || options.path || options.repo || options.notes || options.all || options.check || helpFlag || argv.includes('status')) throw new CliError(t('versionUsage'), 2, 'usage');
    options.command = 'version';
  } else if (helpFlag) { options.command = 'help'; positions.length = 0; }
  if (!COMMANDS.includes(options.command)) throw new CliError(t('unknownCommand'), 2, 'usage');
  if (['install', 'update', 'subscribe'].includes(options.command)) {
    options.skill = positions.shift() || null;
    if (!options.skill && options.command !== 'update') throw new CliError(t('missingSkill', { action: command(options.command) }), 2, 'missing_skill');
    if (options.skill && !isSkillName(options.skill)) throw new CliError(t('invalidSkill'), 2, 'usage');
  }
  // publish：一个位置参数（Skill 目录）或 --repo <路径>（可加 --all/--check），二者互斥。
  if (options.command === 'publish') {
    options.directory = positions.shift() || null;
    if (!options.directory && options.repo === null) throw new CliError(t('publishUsage'), 2, 'usage');
    if (options.directory && options.repo !== null) throw new CliError(t('wrongArgument'), 2, 'usage');
    if ((options.all || options.check) && options.repo === null) throw new CliError(t('wrongArgument'), 2, 'usage');
    if (options.all && options.check) throw new CliError(t('wrongArgument'), 2, 'usage');
    // 说明文本经 HTTP 头上传，长度有硬上限。
    if (options.notes !== null && options.notes.length > 2000) throw new CliError(t('notesTooLong'), 2, 'usage');
  }
  if (positions.length || (options.to.length && options.command !== 'install') || (options.token !== null && options.command !== 'login') || (options.plan !== null && options.command !== 'subscribe') || (options.path !== null && options.command !== 'update') || (options.repo !== null && options.command !== 'publish') || (options.notes !== null && options.command !== 'publish') || ((options.all || options.check) && options.command !== 'publish')) throw new CliError(t('wrongArgument'), 2, 'usage');
  return options;
}

function priceLabel(prices) {
  return Object.entries(prices).map(([plan, price]) => t('pricePlan', { price: formatPrice(price), plan: planLabel(plan) })).join('; ') || t('priceUnavailable');
}

const subscriptionLabel = (status) => ['active', 'canceling', 'past_due', 'lifetime', 'trialing'].includes(status) ? t(status) : status;
function localDate(seconds) {
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return t('unknownDate');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
const subscriptionLines = (subscriptions) => subscriptions.length ? subscriptions.map((s) =>
  t(s.status === 'lifetime' || s.plan === 'lifetime' ? 'purchaseStatus' : 'subscription', {
    name: s.name || skillLabel(s.skill), status: subscriptionLabel(s.status), plan: planLabel(s.plan),
  }) + (s.renews != null ? t('renews', { date: localDate(s.renews) }) : '') + (s.ends != null ? t('ends', { date: localDate(s.ends) }) : '')) : [t('noPurchases')];

function installationLines(installed) {
  return installed.flatMap((item) => {
    const key = item.development ? 'versionSkipped' : item.current === item.latest ? 'versionCurrent' : item.current && compare(item.current, item.latest) > 0 ? 'versionNewer' : 'versionUpdate';
    return [t(key, { name: skillLabel(item.name), version: item.current || t('unknownVersion'), latest: item.latest }),
      t('location', { path: item.path }), ...item.updates.flatMap((entry) => [t('releaseNotes', { version: entry.version }), entry.notes || t('noReleaseNotes')])];
  });
}
const duplicateLines = (copies) => copies.map((item) => t('duplicateCopies', { name: skillLabel(item.name), count: item.paths.length, next: command('install', item.name) }));
// 服务端 versions.history 的截断长度：超过后更早版本不可见，本地版早于最早可得版要提醒
// （与词条 historyWarning 文案里的「20 条」耦合，改动需同步）。
const HISTORY_LIMIT = 20;

// install/update 共用的输出小件（任务 7）：跳过原因行与链接行。
const skippedInstallation = (item) => ({ name: item.name, path: item.path, reason: 'development_directory' });
const skippedLines = (skipped) => skipped.map((item) => t(({ symbolic_link: 'skippedSymbolicLink' })[item.reason] || 'skipped', { name: skillLabel(item.name), path: item.path }));
const linkedLines = (links) => links.map((item) => t('linked', { name: skillLabel(item.name), path: item.path, target: item.target }));
async function lstatOrNull(file) {
  try { return await lstat(file); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}
// 安装本身是链接时，更新它指向的真实目录，不把链接换成一份独立副本。
const realInstallation = async (item) => (await lstatOrNull(item.path))?.isSymbolicLink() ? item.real_path : item.path;

// 扫描九宿主的用户级目录报告已装商店 skill：版本、可更新、警告（配对冲突/多副本/历史截断）；未登录也可用。
async function status(ctx) {
  await loadAuth(ctx);
  const found = await scan(ctx.names);
  // 没有安装就不打版本表：空场景省一次网络请求。
  const versions = found.length ? await ctx.client.versions(ctx.catalog) : {};
  const installations = found.map((item) => ({ name: item.name, path: item.path, current: item.version, latest: versions[item.name].latest, development: item.development, real_path: item.real_path,
    update_available: !item.development && (!item.version || compare(item.version, versions[item.name].latest) < 0), updates: updates(item.version, versions[item.name]) }));
  const warnings = await conflicts(found, ctx.catalog);
  warnings.push(...duplicateLines(duplicateCopies(found)));
  for (const item of found) {
    const history = versions[item.name].history;
    const oldest = history.filter((entry) => isVersion(entry.version)).sort((a, b) => compare(a.version, b.version))[0];
    if (history.length >= HISTORY_LIMIT && item.version && oldest && compare(item.version, oldest.version) < 0) warnings.push(t('historyWarning', { path: item.path }));
  }
  const lines = installations.length ? installationLines(installations) : [t('noInstallations')];
  let account = null;
  if (ctx.token) {
    try {
      account = { ...await ctx.client.me(ctx.token), token_prefix: ctx.token };
      lines.push(t('account', { email: account.email }), ...subscriptionLines(account.subscriptions));
    } catch (error) {
      // 账号读取失败不掩盖已收集的信息：连同错误一起透出并返回错误退出码。
      if (!(error instanceof CliError)) throw error;
      ctx.output.write({ installations, warnings, account: null, error: error.error, message: error.message, ...error.details }, [...lines, ...warnings, error.message], false);
      return error.code;
    }
  }
  ctx.output.write({ installations, warnings, account }, [...lines, ...warnings, ...(!ctx.token ? [t('notLoggedIn')] : [])]);
  return 0;
}

async function logout(ctx) {
  const warnings = [];
  let revoked = false;
  const revoke = async (token) => {
    if (!token) return;
    ctx.output.remember(token);
    try { await ctx.client.request('/api/cli/logout', { method: 'POST', token }); }
    catch (error) {
      // 失效令牌已经无法使用；网络和其他错误只警告，仍要清除本机配置。
      if (!(error instanceof CliError && error.details.http_status === 401)) {
        warnings.push(t('revokeWarning', { message: error.message, url: ctx.client.url('/account/') }));
        return;
      }
    }
    revoked = true;
  };
  try {
    // 本机配置里的令牌只撤销签发给当前服务器的那一枚，不跨域发送。
    const saved = await readSavedAuth(ctx.client.base);
    if (saved?.token && saved.token !== process.env.HY_TOKEN) await revoke(saved.token);
  } catch (error) {
    warnings.push(t('revokeWarning', { message: error.message, url: ctx.client.url('/account/') }));
  }
  // 环境令牌是用户显式提供的；与配置里的不同也要一并撤销，不留半撤销。
  await revoke(process.env.HY_TOKEN);
  await deleteConfig();
  if (process.env.HY_TOKEN) warnings.push(t('tokenEnvWarning'));
  ctx.output.write({ logged_out: true, revoked, warnings }, [revoked ? t('revoked') : t('configRemoved'), ...warnings]);
  return 0;
}

// list 展示目录里每个商品的免费/付费 Skill：名称、类型、价格与摘要。
async function list(ctx) {
  const skills = ctx.catalog.flatMap((product) => ['free', 'paid'].filter((type) => product[type]).map((type) => ({
    skill: product[type].skill, name: product.name, summary: product.summary || '', type, prices: type === 'paid' ? product.prices : {}, page: ctx.client.subscriptionUrl(product[type].skill, product),
  })));
  ctx.output.write({ skills }, skills.length ? skills.map((s) => t('catalogLine', { name: skillLabel(s.skill), type: s.type === 'free' ? t('free') : t('paid', { price: priceLabel(s.prices) }), summary: s.summary ? t('summary', { summary: s.summary }) : '' })) : [t('emptyCatalog')]);
  return 0;
}

// 批量应用：按 Skill 名去重只准备（下载校验）一次，replaceAll 单事务覆盖全部目标——
// 多动作共享备份与整批回滚（设计「错误处理」）。remove/link 动作不需要下载源。
// 二期的付费清理（addFreeReplacements）在此接入 remove 动作；一期付费只有入口拦截。
async function apply(ctx, actions, versions) {
  const prepared = new Map();
  try {
    for (const name of new Set(actions.filter((action) => !action.remove && !action.link).map((action) => action.name))) {
      const { product, paid } = findSkill(ctx.catalog, name);
      prepared.set(name, await prepare(ctx.client, name, versions[name], ctx.token, paid, product, ctx.signal));
    }
    return await replaceAll(actions.map((action) => ({ ...action, source: action.remove || action.link ? undefined : prepared.get(action.name).source })),
      { signal: ctx.signal, names: ctx.names });
  } finally {
    for (const item of prepared.values()) await item.cleanup().catch(() => {});
  }
}

// 多目标安装（任务 7 完整版，机制对齐 template）：--to 可多次（第一个目标放实体，其余链接）；
// 无 --to 时按宿主表优先序自动发现已存在的宿主（zcode 最先）。其他目标里的同名/改名独立旧副本
// 自动换成链接，已有正确链接幂等跳过；被保护位置跳过并解释原因。
async function install(ctx, name = ctx.options.skill) {
  const { product, paid } = findSkill(ctx.catalog, name);
  // 付费前置拦截（设计「分期计划」：一期付费=引导非购买）：不进 402/checkout 流程，exit 3 附商品页。
  // 闸门先于 --to 校验：一期语义下付费 skill 无论参数对错都应先得到购买引导，而不是用法报错。
  if (paid) {
    const url = ctx.client.subscriptionUrl(name, product);
    throw new CliError(t('purchaseUnavailable', { name: skillLabel(name), url }), 3, 'purchase_unavailable', { url, phase2: true });
  }
  let roots = ctx.options.to.length ? [...new Set(ctx.options.to.map((value) => targetRoot(value)))] : await installationRoots();
  if (!roots.length) {
    const next = command('install', name, '--to', 'zcode');
    const details = { recommended_path: targetRoot('zcode'), recommended_command: next, next_command: next };
    if (!ctx.interactive) throw new CliError(t('missingTarget', { next }), 2, 'missing_target', details);
    const answer = await ctx.ask(t('askTarget'), ctx.signal);
    if (!answer) throw new CliError(t('noTarget', { next }), 2, 'missing_target', details);
    roots = [targetRoot(answer)];
  }
  roots = await uniqueDirectories(roots);
  const found = (await scan(ctx.names, roots)).filter((item) => item.name === name);
  // 第一个能放下这个 Skill 的目录放真实的一份，其余宿主用链接共享，更新一次全部生效。
  // 同名位置被别的东西占着（例如用户自建的链接指向别处）时顺延，不让其他宿主链到错误的内容上。
  let primaryIndex = 0;
  for (let i = 0; i < roots.length; i++) {
    const directory = path.join(roots[i], name);
    if (found.some((item) => sameDirectory(item.root, roots[i])) || !await lstatOrNull(directory) || (await inspectSkill(directory, ctx.names))?.name === name) { primaryIndex = i; break; }
  }
  const primaryRoot = roots[primaryIndex], linkRoots = roots.filter((root, index) => index !== primaryIndex);
  const auto = !ctx.options.yes && !ctx.interactive;
  if (ctx.interactive) ctx.output.write({ event: 'targets', paths: roots, primary: primaryRoot, links: linkRoots },
    [t('targets'), primaryRoot, ...linkRoots.map((root) => t('targetLink', { path: root }))]);
  if (!await ctx.confirm(t('confirmInstall', { name: skillLabel(name) }), ctx.options.yes, ctx.interactive, ctx.signal, true)) {
    ctx.output.write({ cancelled: true }, [t('installCanceled')]);
    return 0;
  }
  const actions = [], skipped = [], links = [];
  const primaries = found.filter((item) => sameDirectory(item.root, primaryRoot));
  const candidates = primaries.length ? primaries : [{ name, path: path.join(primaryRoot, name), version: null }];
  const target = path.resolve((candidates.find((item) => path.basename(item.path) === name) || candidates[0]).path);
  for (const item of candidates) {
    // 暂存前的第一重开发目录保护：跳过并解释，不动内容、不发起下载。
    if (await isDevelopmentDirectory(item.path)) { skipped.push(skippedInstallation(item)); continue; }
    actions.push({ name, path: primaries.length ? await realInstallation(item) : item.path, previousName: primaries.length ? name : null, previousVersion: item.version });
  }
  const targetKey = directoryKey(await canonicalDirectory(target));
  for (const root of linkRoots) {
    // 同名文件夹之外，别的文件夹名里装着同一个 Skill 的独立副本也换成链接。
    const directories = [...new Set([path.join(root, name), ...found.filter((item) => sameDirectory(item.root, root)).map((item) => item.path)])];
    for (const directory of directories) {
      const info = await lstatOrNull(directory);
      // 已是正确的链接（解析到同一实体）→ 幂等跳过，不重建。
      if (info && directoryKey(await canonicalDirectory(directory)) === targetKey) { links.push({ name, path: directory, target, existing: true }); continue; }
      if (info && await isDevelopmentDirectory(directory)) { skipped.push(skippedInstallation({ name, path: directory })); continue; }
      const current = info ? await inspectSkill(directory, ctx.names) : null;
      actions.push({ name, path: directory, link: target, previousName: current?.name === name ? name : null, previousVersion: current?.version || null });
    }
  }
  if (!actions.length) {
    ctx.output.write({ installations: [], links, removed: [], skipped, warnings: [] }, [...linkedLines(links), ...skippedLines(skipped)]);
    return 0;
  }
  // 占用预检前移（任务 6 审查语义在多目标下延续）：整批任一目标被无关内容占用时，下载整包之前
  // 就失败，不给重定向目标任何被请求的机会；replaceAll 内的同名双检保留，作下载期间的竞态防线。
  for (const action of actions) {
    const info = await lstatOrNull(action.path);
    const current = info ? await inspectSkill(action.path, ctx.names) : null;
    if (info && (!current || current.name !== action.previousName)) throw new CliError(t('occupied', { path: action.path }), 1, 'occupied', { path: action.path });
    if (!info && action.previousName) throw new CliError(t('changed', { path: action.path }), 1, 'changed', { path: action.path });
  }
  const versions = await ctx.client.versions(ctx.catalog);
  const warnings = await apply(ctx, actions, versions);
  // 复扫全部根：报告配对冲突/多副本等需要全目录视角的警告（多副本提示带精确的合并命令）。
  const installed = await scan(ctx.names, roots);
  warnings.push(...await conflicts(installed, ctx.catalog));
  warnings.push(...duplicateLines(duplicateCopies(installed)));
  const installations = actions.filter((action) => !action.remove && !action.link).map((action) => ({ name, path: action.path,
    previous: action.previousName === name ? action.previousVersion : null, version: versions[name].latest }));
  links.push(...actions.filter((action) => action.link).map((action) => ({ name, path: action.path, target: action.link, existing: false, replaced_copy: action.previousName === name })));
  ctx.output.write({ installations, links, removed: [], skipped, warnings, ...(auto ? { auto_confirmed: true } : {}) },
    [...installations.map((item) => item.previous && item.previous !== item.version
      ? t('updated', { name: skillLabel(item.name), previous: item.previous, version: item.version, path: item.path })
      : t('installed', { name: skillLabel(item.name), version: item.version, path: item.path })),
      ...linkedLines(links), ...skippedLines(skipped), ...warnings, ...(auto ? [t('autoConfirmedInstall')] : [])]);
  return 0;
}

// runtime 用于测试时注入时钟和终端交互；可执行入口不传测试选项。
export const run = (argv, runtime = {}) => withLanguage(resolveLanguage(argv), () => runCommand(argv, runtime));

async function runCommand(argv, runtime) {
  const tokenValues = argv.flatMap((arg, i) => arg === '--token' ? [argv[i + 1]] : arg.startsWith('--token=') ? [arg.slice(8)] : []);
    const output = new Output(argv.includes('--json'), 'unknown', [process.env.HY_TOKEN, ...tokenValues]);
    const controller = new AbortController();
    let interrupts = 0;
    const cancel = () => {
      // 第二次中断直接退出：清理与取消提示不该把用户扣住。
      if (++interrupts > 1) process.exit(130);
      controller.abort();
    };
    process.on('SIGINT', cancel);
    process.on('SIGTERM', cancel);
  try {
    const options = parseArgs(argv);
    output.command = options.command;
    if (options.command === 'help') { const help = helpLines(); output.write({ usage: help }, help); return 0; }
    if (options.command === 'version') {
      const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      output.write({ version }, [`hy ${version}`]); return 0;
    }
    // ctx 是后续命令（安装、发布等）的依赖注入位。
    const ctx = { options, output, token: null,
      interactive: runtime.interactive ?? canPrompt(options.json),
      terminal: runtime.terminal ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
      nextCommand: command(...argv), signal: controller.signal,
      client: new Client(controller.signal),
      openBrowser: runtime.openBrowser || ((url, timeoutMs) => openBrowser(url, undefined, undefined, timeoutMs)),
      sleep: runtime.sleep || delay, now: runtime.now || Date.now,
      confirm: runtime.confirm || confirm, ask: runtime.ask || ask };
    if (options.command === 'logout') return await logout(ctx);
    if (options.command === 'login') return await login(ctx, options.token);
    if (options.command === 'status' || options.command === 'list' || options.command === 'install') {
      // catalog 拉取一次并缓存进 ctx；status 扫描与 install/update 等后续命令复用。
      ctx.catalog = await ctx.client.catalog();
      ctx.names = catalogNames(ctx.catalog);
      if (options.command === 'status') return await status(ctx);
      if (options.command === 'install') return await install(ctx);
      return await list(ctx);
    }
    if (options.command === 'publish') {
      // 发布是鉴权操作：先完成登录，再确认账号有 publisher 角色（无角色 → 退出码 3 登录引导）。
      await requireLogin(ctx);
      const account = await ctx.client.me(ctx.token);
      if (account.publisher !== true) throw new CliError(t('notPublisher'), 3, 'not_a_publisher', { next_command: command('login') });
      if (options.repo !== null) return await publishRepo(ctx, options.repo, { all: options.all, check: options.check, notes: options.notes });
      await publishSkill(ctx, options.directory, { notes: options.notes });
      return 0;
    }
    throw new CliError(t('notImplemented', { name: options.command }), 2, 'not_implemented');
  } catch (error) {
    if (controller.signal.aborted) return output.fail(new CliError(t('canceled'), 1, 'cancelled'));
    return output.fail(error);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
