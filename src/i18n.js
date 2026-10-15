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
  helpPublish: ['{command} publish [<目录>|--repo <路径> [--all|--check]]  发布 Skill', '{command} publish [<directory>|--repo <path> [--all|--check]]  Publish a skill'],
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
  notImplemented: ['{name} 将在二期实现，请运行 {command} help 查看当前可用的命令。', '{name} will be implemented in phase 2. Run {command} help for available commands.'],
  canceled: ['操作已取消。', 'Operation canceled.'],
  failed: ['操作失败，请检查网络和目录权限。', 'Operation failed. Check your network and directory permissions.'],
  recovery: ['原目录保留在：{path}', 'Original directory preserved at: {path}'],
  hidden: ['[已隐藏]', '[hidden]'],
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
