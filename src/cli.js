import { t, withLanguage, resolveLanguage, command, helpLines, skillLabel, planLabel, priceLabel as formatPrice } from './i18n.js';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, writeSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { Output, CliError, ask, canPrompt, confirm } from './io.js';
import { readSavedAuth, logout as deleteConfig } from './config.js';
import { Client, catalogNames, findSkill, isSkillName, isVersion } from './client.js';
import { login, loadAuth, requireLogin } from './auth.js';
import { openBrowser } from './browser.js';
import { publishSkill, publishRepo, reconcileRepo } from './publish.js';
import { scan, compare, updates, conflicts, duplicateCopies, inspectSkill, isDevelopmentDirectory, uniqueDirectories, canonicalDirectory, logicalDirectory, latestYanked } from './skills.js';
import { targetRoot, installationRoots, nearestHostId } from './hosts.js';
import { directoryKey, sameDirectory, resolveDirectory } from './platform.js';
import { prepare, replaceAll } from './install.js';

// 14 个命令全部在参数解析层合法；help/version/list/login/logout/status/publish/install/update 之外的执行逻辑随后续任务落地。
const COMMANDS = ['status', 'list', 'install', 'update', 'login', 'logout', 'subscribe', 'manage', 'help', 'version', 'publish', 'product', 'unpublish', 'audit'];

export function parseArgs(argv) {
  const options = { command: null, json: false, yes: false, to: [], token: null, plan: null, path: null, skill: null, lang: null, repo: null, notes: null, all: false, check: false, set: [] };
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
    } else if (/^--set(=|$)/.test(arg)) {
      // --set 可多次出现（product 专用）；值本身含 '='，只在第一个 '=' 处拆分。
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value || value.startsWith('-')) throw new CliError(t('missingArgument', { flag: '--set' }), 2, 'missing_argument');
      options.set.push(value);
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
  // product（二期任务 2）：位置参数 skill + 至少一个 --set；字段值属纯参数校验，登录与网络之前拒绝。
  if (options.command === 'product') {
    options.skill = positions.shift() || null;
    if (!options.skill || !options.set.length) throw new CliError(t('productUsage'), 2, 'usage');
    if (!isSkillName(options.skill)) throw new CliError(t('invalidSkill'), 2, 'usage');
    parseProductFields(options.set);
  }
  // unpublish（二期任务 2）：位置参数 skill + version（x.y.z）。
  if (options.command === 'unpublish') {
    options.skill = positions.shift() || null;
    options.version = positions.shift() || null;
    if (!options.skill || !options.version || !isVersion(options.version)) throw new CliError(t('unpublishUsage'), 2, 'usage');
    if (!isSkillName(options.skill)) throw new CliError(t('invalidSkill'), 2, 'usage');
  }
  if (positions.length || (options.to.length && options.command !== 'install') || (options.token !== null && options.command !== 'login') || (options.plan !== null && options.command !== 'subscribe') || (options.path !== null && options.command !== 'update') || (options.repo !== null && !['publish', 'audit'].includes(options.command)) || (options.notes !== null && options.command !== 'publish') || (options.set.length && options.command !== 'product') || ((options.all || options.check) && options.command !== 'publish')) throw new CliError(t('wrongArgument'), 2, 'usage');
  return options;
}

// --set 字段解析（product 专用，二期任务 2）：发布者可编辑面 = name/summary 文本、prices.<方案>=<分>,<币种>、
// free/paid 配对声明（设计「数据模型」Product 结构）。纯本地校验给快速反馈；服务端仍是最终验证者（400）。
// 金额上限 10^9 分（=1 千万元，M 审查 L4）：防单位弄错出的天价；重复键显式报错（M3），不静默覆盖。
function parseProductFields(sets) {
  const fields = {}, seen = new Set();
  for (const entry of sets) {
    const separator = entry.indexOf('=');
    const key = separator > 0 ? entry.slice(0, separator) : '', value = separator > 0 ? entry.slice(separator + 1) : '';
    if (seen.has(key)) throw new CliError(t('productDuplicate', { key }), 2, 'usage');
    seen.add(key);
    const invalidField = () => new CliError(t('productFields'), 2, 'usage');
    if (key === 'summary' || key === 'name') {
      if (!value.trim() || value.length > 500) throw invalidField();
      fields[key] = value;
    } else if (key.startsWith('prices.')) {
      const plan = key.slice('prices.'.length), match = value.match(/^(\d+),([A-Za-z]{3})$/), amount = Number(match?.[1]);
      if (!/^[a-z][a-z0-9_-]*$/.test(plan) || !match || !(amount > 0) || !Number.isSafeInteger(amount) || amount > 1_000_000_000) throw invalidField();
      fields.prices = { ...fields.prices, [plan]: { amount, currency: match[2].toLowerCase(), interval: null } };
    } else if (key === 'free' || key === 'paid') {
      if (!isSkillName(value)) throw invalidField();
      fields[key] = value;
    } else throw invalidField();
  }
  if (fields.free && fields.paid && fields.free === fields.paid) throw new CliError(t('productFields'), 2, 'usage');
  return fields;
}

function priceLabel(prices) {
  return Object.entries(prices).map(([plan, price]) => t('pricePlan', { price: formatPrice(price), plan: planLabel(plan) })).join('; ') || t('priceUnavailable');
}

// 订阅有效状态（订阅展示与付费权益判定共用）：处于这些状态视为已购。
const SUBSCRIPTION_STATUSES = ['active', 'canceling', 'past_due', 'lifetime', 'trialing'];
const subscriptionLabel = (status) => SUBSCRIPTION_STATUSES.includes(status) ? t(status) : status;
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
    // 全下架（M1）优先于版本比较：占位 latest 本身已下架，不能显示为「可更新 → 已下架版本」。
    const key = item.development ? 'versionSkipped' : item.all_yanked ? 'versionYanked' : item.current === item.latest ? 'versionCurrent' : item.current && compare(item.current, item.latest) > 0 ? 'versionNewer' : 'versionUpdate';
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
const skippedLines = (skipped) => skipped.map((item) => t(({ symbolic_link: 'skippedSymbolicLink', all_yanked: 'skippedYanked' })[item.reason] || 'skipped', { name: skillLabel(item.name), path: item.path }));
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
  const installations = found.map((item) => {
    // 全下架（M1）：latest 是占位（本身已下架）→ 不报可更新，打 all_yanked 标记，文本走专门词条。
    const yanked = latestYanked(versions[item.name]);
    return { name: item.name, path: item.path, current: item.version, latest: versions[item.name].latest, development: item.development, real_path: item.real_path,
      update_available: !item.development && !yanked && (!item.version || compare(item.version, versions[item.name].latest) < 0),
      ...(yanked ? { all_yanked: true } : {}), updates: updates(item.version, versions[item.name]) };
  });
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

// 商品展示词条（list 与 product 输出共用，二期任务 2 抽取）：名称 + 免费/付费（价格）+ 摘要。
const catalogLineOf = (skill, type, product) => t('catalogLine', {
  name: skillLabel(skill), type: type === 'free' ? t('free') : t('paid', { price: priceLabel(product.prices) }),
  summary: product.summary ? t('summary', { summary: product.summary }) : '',
});

// list 展示目录里每个商品的免费/付费 Skill：名称、类型、价格与摘要。
async function list(ctx) {
  const skills = ctx.catalog.flatMap((product) => ['free', 'paid'].filter((type) => product[type]).map((type) => ({
    skill: product[type].skill, name: product.name, summary: product.summary || '', type, prices: type === 'paid' ? product.prices : {}, page: ctx.client.subscriptionUrl(product[type].skill, product),
  })));
  ctx.output.write({ skills }, skills.length ? skills.map((s) => catalogLineOf(s.skill, s.type, s)) : [t('emptyCatalog')]);
  return 0;
}

// 批量应用：按 Skill 名去重只准备（下载校验）一次，replaceAll 单事务覆盖全部目标——
// 多动作共享备份与整批回滚（设计「错误处理」）。remove/link 动作不需要下载源。
// 付费 skill 在入口已过 requireEntitlement，这里的令牌下载（200 直连 + 响应头校验）得以激活；
// 二期的付费清理（addFreeReplacements，任务 5）在此接入 remove 动作。
async function apply(ctx, actions, versions) {
  const prepared = new Map();
  try {
    for (const name of new Set(actions.filter((action) => !action.remove && !action.link).map((action) => action.name))) {
      const { product, paid } = findSkill(ctx.catalog, name);
      prepared.set(name, await prepare(ctx.client, name, versions[name], ctx.token, paid, product, ctx.signal));
    }
    return await replaceAll(actions.map((action) => ({ ...action, source: action.remove || action.link ? undefined : prepared.get(action.name).source })),
      { signal: ctx.signal, names: ctx.names, onStage: ctx.observeStage, renameFile: ctx.renameFile });
  } finally {
    for (const item of prepared.values()) await item.cleanup().catch(() => {});
  }
}

// roots 解析：--to 多值（第一个目标放实体、其余链接）或按宿主表优先序自动发现已存在宿主（zcode 最先）；
// 都没有时非交互报 missing_target（推荐命令沿用 nextCommand，保留 --json/--lang 等原始标志，
// Agent 重跑不丢通道），交互询问回落——输入似宿主 id 拼写错（编辑距离 1）给提示，仍按路径处理。
async function resolveRoots(ctx) {
  let roots = ctx.options.to.length ? [...new Set(ctx.options.to.map((value) => targetRoot(value)))] : await installationRoots();
  if (!roots.length) {
    const next = `${ctx.nextCommand} --to zcode`;
    const details = { recommended_path: targetRoot('zcode'), recommended_command: next, next_command: next };
    if (!ctx.interactive) throw new CliError(t('missingTarget', { next }), 2, 'missing_target', details);
    const answer = await ctx.ask(t('askTarget'), ctx.signal);
    if (!answer) throw new CliError(t('noTarget', { next }), 2, 'missing_target', details);
    const suggestion = nearestHostId(answer);
    if (suggestion) ctx.output.write({ typo_hint: { typed: answer, suggestion } }, [t('askTargetTypo', { typed: answer, suggestion })]);
    roots = [targetRoot(answer)];
  }
  return uniqueDirectories(roots);
}

// 动作规划（只读，不动文件系统）：primary 选举 + 实体/链接双循环。第一个能放下这个 Skill 的根
// 放真实的一份，其余宿主用链接共享，更新一次全部生效；同名位置被别的东西占着（例如用户自建的
// 链接指向别处）时顺延，不让其他宿主链到错误的内容上。链接根下的同名目录与改名独立副本换成链接；
// 已是正确链接（解析到同一实体）幂等跳过；开发目录跳过并解释。安装本身是链接时更新其真实目标。
async function planActions(ctx, name, roots) {
  const found = (await scan(ctx.names, roots)).filter((item) => item.name === name);
  let primaryIndex = 0;
  for (let i = 0; i < roots.length; i++) {
    const directory = path.join(roots[i], name);
    if (found.some((item) => sameDirectory(item.root, roots[i])) || !await lstatOrNull(directory) || (await inspectSkill(directory, ctx.names))?.name === name) { primaryIndex = i; break; }
  }
  const primaryRoot = roots[primaryIndex], linkRoots = roots.filter((root, index) => index !== primaryIndex);
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
      if (info && directoryKey(await canonicalDirectory(directory)) === targetKey) { links.push({ name, path: directory, target, existing: true }); continue; }
      if (info && await isDevelopmentDirectory(directory)) { skipped.push(skippedInstallation({ name, path: directory })); continue; }
      const current = info ? await inspectSkill(directory, ctx.names) : null;
      actions.push({ name, path: directory, link: target, previousName: current?.name === name ? name : null, previousVersion: current?.version || null });
    }
  }
  return { actions, skipped, links, primaryRoot, linkRoots };
}

// 付费权益闸门（install/update 共用，二期任务 3）：免费 skill 直接放行；付费先 requireLogin，
// 再以 me().subscriptions 判定——已购（状态有效）放行令牌下载，未购 exit 3 'inactive' 附
// subscribe_command/subscription_url（与下载端 402 同语义、同词条，任务 5 在此接内联购买）。
// 订阅快照缓存在 ctx.account：混合批量逐 skill 判定只查一次账号。
async function requireEntitlement(ctx, name) {
  const { product, paid } = findSkill(ctx.catalog, name);
  if (!paid) return true;
  await requireLogin(ctx);
  if (!ctx.account) ctx.account = await ctx.client.me(ctx.token);
  if (ctx.account.subscriptions.some((item) => item.skill === name && SUBSCRIPTION_STATUSES.includes(item.status))) return true;
  const url = ctx.client.subscriptionUrl(name, product);
  const next = command('subscribe', name);
  throw new CliError(t('inactive', { name: skillLabel(name), next, url }), 3, 'inactive', { subscribe_command: next, subscription_url: url });
}

// hy manage（二期任务 3，template 移植）：登录后向商店要账号门户 URL 并打开浏览器；
// 打不开时给可复制链接。响应形状校验：缺/空 url 按 invalid_response 拒绝（openBrowser 内另有 URL 语法校验）。
async function manage(ctx) {
  await requireLogin(ctx);
  const portal = await ctx.client.request('/api/account/portal', { method: 'POST', token: ctx.token });
  if (typeof portal?.url !== 'string' || !portal.url) throw new CliError(t('invalidPortal'), 1, 'invalid_response');
  const opened = await ctx.openBrowser(portal.url);
  ctx.output.write({ url: portal.url, opened }, [opened ? t('portalOpened', { url: portal.url }) : t('browserManual', { url: portal.url })]);
  return 0;
}

// 下载前占用/变更预检（install/update 共用）：整批任一目标被无关内容占用（含悬空链接——
// lstat 存在但读不出 Skill）或凭空消失时，下载整包之前就失败，不给重定向目标任何被请求的机会；
// replaceAll 内的同名双检保留，作下载期间的竞态防线（任务 6 审查语义在多目标下延续）。
async function assertReplaceable(ctx, actions) {
  for (const action of actions) {
    const info = await lstatOrNull(action.path);
    const current = info ? await inspectSkill(action.path, ctx.names) : null;
    if (info && (!current || current.name !== action.previousName)) throw new CliError(t('occupied', { path: action.path }), 1, 'occupied', { path: action.path });
    if (!info && action.previousName) throw new CliError(t('changed', { path: action.path }), 1, 'changed', { path: action.path });
  }
}

// 多目标安装（任务 7 完整版，机制对齐 template）：resolveRoots 选根 → planActions 只读规划 →
// 交互列目标并确认 → 预检（互相包含/占用/变化全部在下载之前）→ apply 批量事务 → 复扫与输出。
async function install(ctx, name = ctx.options.skill) {
  // 权益闸门先于 --to 校验（quality-M2 抽取自此处与 update）：付费 skill 无论参数对错都先得到
  // 登录/购买引导（未登录走设备码、未购 exit 3 inactive），而不是用法报错；免费 skill 直接放行。
  await requireEntitlement(ctx, name);
  const roots = await resolveRoots(ctx);
  const { actions, skipped, links, primaryRoot, linkRoots } = await planActions(ctx, name, roots);
  // --yes 是用户显式确认（不再提问）；auto_confirmed 只标记「非交互静默确认」——两者都不提问，
  // 但静默确认需要提示行维持可见性，显式 --yes 是用户自己的决定，不需要提示。
  const auto = !ctx.options.yes && !ctx.interactive;
  if (ctx.interactive) ctx.output.write({ event: 'targets', paths: roots, primary: primaryRoot, links: linkRoots },
    [t('targets'), primaryRoot, ...linkRoots.map((root) => t('targetLink', { path: root }))]);
  if (!await ctx.confirm(t('confirmInstall', { name: skillLabel(name) }), ctx.options.yes, ctx.interactive, ctx.signal, true)) {
    ctx.output.write({ cancelled: true }, [t('installCanceled')]);
    return 0;
  }
  if (!actions.length) {
    ctx.output.write({ installations: [], links, removed: [], skipped, warnings: [] }, [...linkedLines(links), ...skippedLines(skipped)]);
    return 0;
  }
  // 目标互相包含（如 --to X --to X/<skill>）：与 replaceAll 内的检查同源，前移到下载之前报用法错误；
  // replaceAll 内的检查保留，作规划与执行之间的竞态防线。
  const actionPaths = await Promise.all(actions.map(async (action) => directoryKey(await logicalDirectory(action.path))));
  for (let i = 0; i < actionPaths.length; i++) {
    for (let j = 0; j < actionPaths.length; j++) {
      if (i === j) continue;
      const relative = path.relative(actionPaths[i], actionPaths[j]);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new CliError(t('overlappingTargets'), 2, 'overlapping_targets');
    }
  }
  // 占用预检（quality-M1 抽取为 assertReplaceable，update 复用）：整批任一目标被无关内容
  // 占用时，下载整包之前就失败；replaceAll 内的同名双检保留，作下载期间的竞态防线。
  await assertReplaceable(ctx, actions);
  // 纯链接路径（无实体动作，如主安装是开发目录）：不下载，也不打版本表。
  const downloads = actions.some((action) => !action.remove && !action.link);
  const versions = downloads ? await ctx.client.versions(ctx.catalog) : {};
  const warnings = await apply(ctx, actions, versions);
  // 复扫全部根：报告配对冲突/多副本等需要全目录视角的警告（多副本提示带精确的合并命令）。
  // 与 update 的复扫段成对语义（quality-M3）：update 按发现根复扫、--path 定点不报多副本；
  // 两段需同步改动，抽取窗口留任务 7 收尾。
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

// 全量更新（二期任务 1）：扫描九宿主的全部已装商店 Skill → 过滤过期（version < latest）→
// 按 real_path 去重（链接安装只更新真实目标一次，链接保持指向、新版本即刻生效）→ apply 整批
// 事务替换 → 复扫冲突/多副本警告。`update <skill>` 只更新指定；`--path <目录>` 定点（拒绝未知
// 目录/与 --skill 不匹配）。开发目录跳过并解释；交互确认更新数量，非交互 auto_confirmed 警示沿用。
// 付费 Skill 逐个过权益闸门（二期任务 3）：已购令牌下载更新；批量里任一未购付费 skill
// exit 3 指向该 skill——整批原子，免费目标也不装一半。
async function update(ctx) {
  if (ctx.options.skill) findSkill(ctx.catalog, ctx.options.skill);
  let all;
  if (ctx.options.path) {
    const directory = resolveDirectory(ctx.options.path);
    const item = await inspectSkill(directory, ctx.names);
    if (!item) throw new CliError(t('unknownInstallation', { path: directory }), 2, 'unknown_installation');
    if (ctx.options.skill && item.name !== ctx.options.skill) throw new CliError(t('installationMismatch', { name: skillLabel(item.name), expected: skillLabel(ctx.options.skill) }), 2, 'skill_mismatch');
    all = [item];
  } else all = await scan(ctx.names);
  const found = all.filter((item) => !ctx.options.skill || item.name === ctx.options.skill);
  const skipped = found.filter((item) => item.development).map(skippedInstallation);
  // 与 template 对齐的双重防线：scan 已按 real_path 折叠，这里再按真实目录去重一次——
  // 多宿主链接到同一实体时只更新真实目标，不重复动作。
  const seen = new Set();
  const eligible = found.filter((item) => {
    if (item.development || seen.has(directoryKey(item.real_path))) return false;
    seen.add(directoryKey(item.real_path)); return true;
  });
  // 计数口径（审查 LOW 补注）：eligible_count 是进入版本比对的非开发安装（已按 real_path
  // 去重，不含版本过滤——已最新的也计入）；updated_count 只计实际替换的过期安装。
  const counts = { found_count: found.length, eligible_count: eligible.length };
  if (!eligible.length) {
    const warnings = await conflicts(all, ctx.catalog);
    ctx.output.write({ installations: [], removed: [], skipped, warnings, ...counts, updated_count: 0, status: found.length ? 'skipped' : 'no_installations' },
      [...(found.length ? [] : [t('noInstallations')]), ...skippedLines(skipped), ...warnings]);
    return 0;
  }
  const versions = await ctx.client.versions(ctx.catalog);
  // 全下架（M1，与 status 的 all_yanked 口径一致）：占位 latest 本身已下架的 skill 不进 pending、
  // 不发起下载，跳过并解释——避免「报告可更新 → 下载 404」的前后矛盾。
  const updateDue = (item) => !item.version || compare(item.version, versions[item.name].latest) < 0;
  const pending = eligible.filter((item) => updateDue(item) && !latestYanked(versions[item.name]));
  skipped.push(...eligible.filter((item) => updateDue(item) && latestYanked(versions[item.name]))
    .map((item) => ({ name: item.name, path: item.path, reason: 'all_yanked' })));
  const actions = await Promise.all(pending.map(async (item) => ({ name: item.name, path: await realInstallation(item), previousName: item.name, previousVersion: item.version })));
  // 付费权益闸门（quality-M2 抽取，与 install 共用 requireEntitlement）：过期才有动作，已最新的
  // 付费安装不触发闸门；逐 skill 判定，任一未购即 exit 3——整批未开始，免费目标也不装一半。
  for (const action of actions) await requireEntitlement(ctx, action.name);
  // --yes 是用户显式确认；auto_confirmed 只标记「非交互静默确认」——与 install 同语义，
  // 但仅在实际有动作被静默确认时标记（up_to_date 无动作就不打提示行）。
  const auto = actions.length > 0 && !ctx.options.yes && !ctx.interactive;
  if (actions.length && !await ctx.confirm(t('confirmUpdate', { count: actions.length }), ctx.options.yes, ctx.interactive, ctx.signal, true)) {
    ctx.output.write({ cancelled: true, removed: [], skipped, ...counts, updated_count: 0, status: 'cancelled' }, [t('updateCanceled'), ...skippedLines(skipped)]);
    return 0;
  }
  // 下载前占用/变更预检（quality-M1，与 install 共用 assertReplaceable）：scan 与执行之间
  // 目标被第三方改动时，在下载整包之前失败。
  await assertReplaceable(ctx, actions);
  const warnings = await apply(ctx, actions, versions);
  // 复扫原发现范围（--path 定点只看那个根）：冲突警告需要全目录视角；多副本只在非定点时报告。
  // 与 install 的复扫段成对语义（quality-M3）：install 按 --to/发现根复扫、始终报多副本；
  // 两段需同步改动，抽取窗口留任务 7 收尾。
  const after = await scan(ctx.names, all.map((item) => item.root));
  warnings.push(...await conflicts(after, ctx.catalog));
  if (!ctx.options.path) warnings.push(...duplicateLines(duplicateCopies(after.filter((item) => !ctx.options.skill || item.name === ctx.options.skill))));
  const installations = actions.map((item) => ({ name: item.name, path: item.path, previous: item.previousVersion, version: versions[item.name].latest }));
  ctx.output.write({ installations, removed: [], skipped, warnings, ...counts, updated_count: installations.length,
    status: installations.length ? 'updated' : 'up_to_date', ...(auto ? { auto_confirmed: true } : {}) },
    [...(installations.length ? installations.map((item) => t('updated', { name: skillLabel(item.name), previous: item.previous || t('unknownVersion'), version: item.version, path: item.path })) : [t('upToDate')]),
      ...skippedLines(skipped), ...warnings, ...(auto ? [t('autoConfirmedUpdate')] : [])]);
  return 0;
}

// 认证·管理操作共用前置（publish/product/unpublish）：先完成登录，再确认账号有 publisher 角色
//（无角色 → 退出码 3 登录引导）。
async function requirePublisher(ctx) {
  await requireLogin(ctx);
  const account = await ctx.client.me(ctx.token);
  if (account.publisher !== true) throw new CliError(t('notPublisher'), 3, 'not_a_publisher', { next_command: command('login') });
}

// hy product（二期任务 2）：注册/更新商品元数据。--set 值已在参数层校验；未知 skill 与跨商品配对冲突
// 都用公开目录+版本表本地预检（此时手里已有 catalog，精确指明冲突，不发 PUT）；服务端 upsert 与版本
// 发布解耦（发布过或已在目录即可注册），本地无法预判的规则由服务端终审（400 独立词条透传原因）。
async function product(ctx) {
  const skill = ctx.options.skill;
  const fields = parseProductFields(ctx.options.set);
  const catalog = await ctx.client.catalog();
  const versions = await ctx.client.versions(catalog);
  const known = Boolean(versions[skill]) || catalog.some((item) => [item.id, item.free?.skill, item.paid?.skill].includes(skill));
  if (!known) throw new CliError(t('unknownSkill', { name: skillLabel(skill) }), 2, 'unknown_skill');
  // 跨商品冲突预判（M2）：free/paid 值若属于其他商品，目录的 skill 全局唯一契约会破坏——本地拒绝并指明归属。
  const target = catalog.find((item) => [item.id, item.free?.skill, item.paid?.skill].includes(skill));
  for (const field of ['free', 'paid']) {
    const value = fields[field];
    if (!value) continue;
    const owner = catalog.find((item) => item !== target && [item.id, item.free?.skill, item.paid?.skill].includes(value));
    if (owner) throw new CliError(t('productConflict', { skill: value, owner: owner.name || owner.id }), 2, 'product_conflict');
  }
  let updated;
  try {
    updated = await ctx.client.product(ctx.token, skill, fields);
  } catch (error) {
    if (error instanceof CliError) {
      // 404/400/403 语义映射（设计「接口设计·发布端」）：404 与本地预检同义，403 与未登录同走登录引导；
      // 400 是服务端终审拒绝（本地语法已过预检），用独立词条透传服务端原因，不复用本地语法提示（M2）。
      if (error.details.http_status === 404) throw new CliError(t('unknownSkill', { name: skillLabel(skill) }), 2, 'unknown_skill');
      if (error.error === 'invalid_field') throw new CliError(t('productRejected', { message: error.message }), 1, 'invalid_field');
      if (error.error === 'not_a_publisher') throw new CliError(t('notPublisher'), 3, 'not_a_publisher', { next_command: command('login') });
    }
    throw error;
  }
  ctx.output.write({ event: 'product', skill, product: updated, fields }, [
    t('productUpdated', { name: updated.name || updated.id }),
    ...['free', 'paid'].filter((type) => updated[type]).map((type) => catalogLineOf(updated[type].skill, type, updated)),
  ]);
  return 0;
}

// hy unpublish（二期任务 2）：下架某个版本（yank）。已装用户不受影响；新安装该版本 404（假设 #4）。
async function unpublishSkill(ctx) {
  const skill = ctx.options.skill, version = ctx.options.version;
  try {
    await ctx.client.unpublish(ctx.token, skill, version);
  } catch (error) {
    if (error instanceof CliError) {
      if (error.details.http_status === 404) throw new CliError(t('unpublishMissing', { name: skillLabel(skill), version }), 1, 'not_found', { skill, version });
      if (error.error === 'not_a_publisher') throw new CliError(t('notPublisher'), 3, 'not_a_publisher', { next_command: command('login') });
    }
    throw error;
  }
  ctx.output.write({ event: 'unpublish', skill, version, yanked: true },
    [t('unpublishDone', { name: skillLabel(skill), version }), t('unpublishEffect')]);
  return 0;
}

// hy audit（二期任务 2）：对账报告独立入口（publish.js 的 reconcileRepo 共享件）——
// 只读公开 catalog+versions，无需登录；--repo 缺省为当前目录。
async function audit(ctx) {
  const { repo, report, counts, lines } = await reconcileRepo(ctx.client, ctx.options.repo ?? '.');
  ctx.output.write({ repo, skills: report, counts }, lines);
  return 0;
}

// runtime 用于测试时注入时钟和终端交互；可执行入口不传测试选项。
export const run = (argv, runtime = {}) => withLanguage(resolveLanguage(argv), () => runCommand(argv, runtime));

// 二次中断的缓解（不改变「不完整回滚」的基线取舍，只补可见性）：同步落一行备份位置提示再强退，
// 让用户找得到保留在暂存目录里的备份。只列确实带有备份（old 子目录）的暂存目录。
export function interruptBackups(stages) {
  const backups = stages.filter((stage) => existsSync(path.join(stage, 'old')));
  return backups.length ? t('interruptBackups', { paths: backups.join('；') }) : null;
}

async function runCommand(argv, runtime) {
  const tokenValues = argv.flatMap((arg, i) => arg === '--token' ? [argv[i + 1]] : arg.startsWith('--token=') ? [argv.slice(8)] : []);
    const output = new Output(argv.includes('--json'), 'unknown', [process.env.HY_TOKEN, ...tokenValues]);
    const controller = new AbortController();
    // 事务期间经 ctx.observeStage 上报的暂存目录：二次中断时据此提示备份位置。
    const stages = [];
    let interrupts = 0;
    const cancel = () => {
      // 第二次中断直接退出：清理与取消提示不该把用户扣住。退出前同步（writeSync）打一行
      // 备份位置——此时回滚可能未完成，用户需要能找到备份（同步写保证强退前一定落盘）。
      if (++interrupts > 1) {
        const notice = interruptBackups(stages);
        if (notice) writeSync(2, `${notice}\n`);
        process.exit(130);
      }
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
      confirm: runtime.confirm || confirm, ask: runtime.ask || ask,
      // renameFile 仅供测试注入批量事务的中途失败（install/update 整批回滚验证）；生产路径为 undefined，replaceAll 内回落真实 rename。
      renameFile: runtime.renameFile,
      observeStage: (stage) => stages.push(stage) };
    if (options.command === 'logout') return await logout(ctx);
    if (options.command === 'login') return await login(ctx, options.token);
    // manage 只走登录 + 门户接口，不消费 catalog（template 同位）。
    if (options.command === 'manage') return await manage(ctx);
    if (options.command === 'status' || options.command === 'list' || options.command === 'install' || options.command === 'update') {
      // catalog 拉取一次并缓存进 ctx；status 扫描与 install/update 等后续命令复用。
      ctx.catalog = await ctx.client.catalog();
      ctx.names = catalogNames(ctx.catalog);
      if (options.command === 'status') return await status(ctx);
      if (options.command === 'install') return await install(ctx);
      if (options.command === 'update') return await update(ctx);
      return await list(ctx);
    }
    if (options.command === 'publish') {
      // 发布是鉴权操作：先完成登录，再确认账号有 publisher 角色（无角色 → 退出码 3 登录引导）。
      await requirePublisher(ctx);
      if (options.repo !== null) return await publishRepo(ctx, options.repo, { all: options.all, check: options.check, notes: options.notes });
      await publishSkill(ctx, options.directory, { notes: options.notes });
      return 0;
    }
    // 管理命令（二期任务 2）：与 publish 同样的登录 + publisher 前置；audit 只读公开接口，无需登录。
    if (options.command === 'product') {
      await requirePublisher(ctx);
      return await product(ctx);
    }
    if (options.command === 'unpublish') {
      await requirePublisher(ctx);
      return await unpublishSkill(ctx);
    }
    if (options.command === 'audit') return await audit(ctx);
    throw new CliError(t('notImplemented', { name: options.command }), 2, 'not_implemented');
  } catch (error) {
    if (controller.signal.aborted) return output.fail(new CliError(t('canceled'), 1, 'cancelled'));
    return output.fail(error);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
