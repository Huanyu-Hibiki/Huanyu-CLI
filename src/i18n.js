import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
export const COMMAND = 'npx github:Huanyu-Hibiki/Huanyu-CLI';
// Windows 的可复制命令按 PowerShell 引用；POSIX shell 保持原来的单引号转义。
export const formatCommand = (args, platform = process.platform) => [COMMAND, ...args.map((value) => /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", platform === 'win32' ? "''" : "'\\''")}'`)].join(' ');
export const command = (...args) => formatCommand(args);

// 每个条目依次是中文、英文；占位符保留命令、路径和服务端数据。
export const dictionary = {
  helpIntro: ['安装、更新和管理环宇商店的 Skill。', 'Install, update, and manage Huanyu store skills.'],
  helpUsage: ['用法：{command} <命令> [--json] [--yes] [--lang zh|en]', 'Usage: {command} <command> [--json] [--yes] [--lang zh|en]'],
  helpStatus: ['{command} status（默认）  查看已安装的 Skill 和账号', '{command} status (default)  Show installed skills and account'],
  helpList: ['{command} list  查看 Skill 和价格', '{command} list  List skills and prices'],
  helpInstall: ['{command} install <skill> [--to <宿主>|<路径>]  安装到全部或指定宿主', '{command} install <skill> [--to <host>|<path>]  Install to all hosts or a chosen one'],
  helpUpdate: ['{command} update [<skill>] [--path <目录>]  更新', '{command} update [<skill>] [--path <directory>]  Update'],
  helpLogin: ['{command} login [--token <令牌>]  登录', '{command} login [--token <access-token>]  Sign in'],
  helpLogout: ['{command} logout  撤销令牌并退出登录', '{command} logout  Revoke the access token and sign out'],
  helpSubscribe: ['{command} subscribe <skill> [--plan <方案>]  购买并安装', '{command} subscribe <skill> [--plan <plan>]  Purchase and install'],
  helpManage: ['{command} manage  管理购买', '{command} manage  Manage purchases'],
  helpPublish: ['{command} publish  发布 Skill', '{command} publish  Publish a skill'],
  helpProduct: ['{command} product  管理商品信息', '{command} product  Manage product details'],
  helpUnpublish: ['{command} unpublish  下架某个版本', '{command} unpublish  Yank a release'],
  helpAudit: ['{command} audit  对账本地与商店', '{command} audit  Reconcile local skills with the store'],
  helpHelp: ['{command} help / {command} --version  帮助 / 版本', '{command} help / {command} --version  Help / version'],
  missingArgument: ['{flag} 缺少值。', '{flag} requires a value.'],
  duplicateArgument: ['{flag} 只能写一次。', '{flag} can only be used once.'],
  unknownArgument: ['存在未知参数，请运行 {command} help。', 'Unknown option. Run {command} help.'],
  versionUsage: ['--version 请单独使用，可加 --json、--yes 和 --lang。', 'Use --version on its own, with optional --json, --yes, and --lang.'],
  unknownCommand: ['未知命令，请运行 {command} help。', 'Unknown command. Run {command} help.'],
  missingSkill: ['{action} 需要 Skill 名，请运行 {command} list。', '{action} requires a skill name. Run {command} list.'],
  invalidSkill: ['Skill 名无效，请运行 {command} list。', 'Invalid skill name. Run {command} list.'],
  wrongArgument: ['参数不适用于此命令，请运行 {command} help。', 'This option does not apply to this command. Run {command} help.'],
  notImplemented: ['{name} 尚未实现，请运行 {command} help 查看当前可用的命令。', '{name} is not implemented yet. Run {command} help for available commands.'],
  canceled: ['操作已取消。', 'Operation canceled.'],
  failed: ['操作失败，请检查网络和目录权限。', 'Operation failed. Check your network and directory permissions.'],
  recovery: ['原目录保留在：{path}', 'Original directory preserved at: {path}'],
  hidden: ['[已隐藏]', '[hidden]'],
  priceUnavailable: ['价格暂不可用', 'price unavailable'],
  cnyPrice: ['{amount} 元', '¥{amount} (CNY)'],
  otherPrice: ['{amount} {currency}', '{amount} {currency}'],
  pricePlan: ['{price}，{plan}', '{price}, {plan}'],
  monthly: ['每月', 'monthly'],
  yearly: ['每年', 'yearly'],
  lifetimePlan: ['一次买断，永久更新', 'one-time purchase, lifetime updates'],
  free: ['免费', 'free'],
  paid: ['付费（{price}）', 'paid ({price})'],
  catalogLine: ['{name}：{type}{summary}', '{name}: {type}{summary}'],
  summary: ['，{summary}', '; {summary}'],
  emptyCatalog: ['商店里还没有 Skill。', 'No skills in the store yet.'],
  catalogIncomplete: ['Skill 列表不完整，请重试。', 'The skill list is incomplete. Please retry.'],
  catalogDuplicate: ['产品信息不完整或编号重复，请重试。', 'Product details are incomplete or IDs are duplicated. Please retry.'],
  catalogInvalidSkill: ['Skill 名无效或重复，请重试。', 'Skill names are invalid or duplicated. Please retry.'],
  catalogMissingSkill: ['产品缺少 Skill 名，请重试。', 'A product is missing its skill name. Please retry.'],
  catalogInvalidPrice: ['价格信息无法读取，请重试。', 'Could not read prices. Please retry.'],
  unknownSkill: ['没有找到 {name}，请运行 {command} list。', 'Could not find {name}. Run {command} list.'],
  invalidApi: ['HY_API 必须是 HTTP 或 HTTPS 基础地址。', 'HY_API must be an HTTP or HTTPS base URL.'],
  insecureApi: ['HY_API 必须使用 HTTPS（本机地址除外）。', 'HY_API must use HTTPS, except for localhost.'],
  invalidToken: ['令牌格式无效，请重新运行 {command} login。', 'Invalid access token format. Run {command} login again.'],
  invalidJson: ['服务返回的数据无法读取，请重试。', 'Could not read the server response. Please retry.'],
  httpError: ['请求失败（{status}）。', 'Request failed ({status}).'],
  unauthorized: ['登录已失效，请重新运行 {command} login。', 'Sign-in has expired. Run {command} login again.'],
  inactive: ['尚未购买 {name}。请运行 {next}，或打开 {url}', '{name} has not been purchased. Run {next}, or open {url}'],
  thisSkill: ['这个 Skill', 'this skill'],
  network: ['请求失败，请检查网络或 HY_API。', 'Request failed. Check your network or HY_API.'],
  invalidVersions: ['无法读取 {name} 的版本或更新说明，请重试。', 'Could not read versions or release notes for {name}. Please retry.'],
};

export function resolveLanguage(argv = [], env = process.env) {
  let option;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--lang') { const value = argv[++i]; if (value && !value.startsWith('-')) option ??= value; }
    else if (argv[i].startsWith('--lang=')) option ??= argv[i].slice(7);
  }
  const candidates = [[option, true], [env.HY_LANG, true], [env.LC_ALL, false], [env.LC_MESSAGES, false], [env.LANG, false]];
  const [value, explicit] = candidates.find(([value]) => typeof value === 'string' && value.trim()) || ['', false];
  const locale = value.trim().toLowerCase();
  const lang = !locale || /^(c|posix)(?:$|[.@])/.test(locale) || locale.startsWith('zh') ? 'zh' : 'en';
  return { lang, explicit };
}

export const withLanguage = (language, fn) => context.run(language, fn);
export const language = () => context.getStore() || resolveLanguage();
export function t(key, values = {}) {
  const pair = dictionary[key];
  if (!pair) throw new Error(`Unknown message: ${key}`);
  return pair[language().lang === 'zh' ? 0 : 1].replace(/\{(\w+)\}/g, (_, name) => String(({ command: COMMAND, ...values })[name]));
}
export const helpLines = () => Object.keys(dictionary).filter((key) => key.startsWith('help')).map((key) => t(key));
// 试点商品直接以规范名展示；后续有需要展示名的商品再在这里加映射。
export const skillLabel = (name) => name;
export const planLabel = (plan) => ({ monthly: t('monthly'), month: t('monthly'), yearly: t('yearly'), year: t('yearly'), lifetime: t('lifetimePlan') })[plan] || plan;
export function priceLabel(price) {
  const amount = price?.amount ?? price?.unit_amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || typeof price.currency !== 'string' || !price.currency) return t('priceUnavailable');
  if (price.currency.toLowerCase() === 'usd') return `$${(amount / 100).toFixed(2)}`;
  return t(price.currency.toLowerCase() === 'cny' ? 'cnyPrice' : 'otherPrice', { amount: amount / 100, currency: price.currency.toUpperCase() });
}
