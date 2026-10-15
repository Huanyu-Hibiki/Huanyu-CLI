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
  helpPublish: ['{command} publish <目录> [--notes <说明>]  发布；--repo <路径> --all 批量、--check 只对账', '{command} publish <directory> [--notes <text>]  Publish; --repo <path> --all batch, --check audit only'],
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
  // 认证族（任务 3）
  expiredDevice: ['授权码已过期，请重新运行 {command} login。', 'The device code has expired. Run {command} login again.'],
  invalidDevice: ['授权码信息不完整，请重试。', 'Device code details are incomplete. Please retry.'],
  browserWarning: ['没能自动打开浏览器，请手动打开上面的链接。', 'Could not open the browser automatically. Open the link above.'],
  openDevice: ['请打开：{url}', 'Open: {url}'],
  deviceCode: ['授权码：{code}', 'Device code: {code}'],
  deviceWait: ['在浏览器里核对授权码并允许登录；最长等待 {duration}，按 Ctrl+C 取消。', 'Check the device code in the browser and allow sign-in. Waiting up to {duration}; press Ctrl+C to cancel.'],
  tenMinutes: ['10 分钟', '10 minutes'],
  sixtySeconds: ['60 秒', '60 seconds'],
  pendingDevice: ['在浏览器打开 {url}，确认授权码 {code} 后点“允许”，然后再运行一次刚才的命令。', 'Open {url}, check the device code {code}, and click Allow. Then run the same command again.'],
  invalidLogin: ['登录信息不完整，请重试。', 'Sign-in details are incomplete. Please retry.'],
  deniedDevice: ['你拒绝了这次登录，请重新运行 {command} login。', 'You denied this sign-in. Run {command} login again.'],
  ciLogin: ['CI 环境需要设置 HY_TOKEN，或先运行 {command} login --token <令牌>。', 'Set HY_TOKEN in CI, or first run {command} login --token <access-token>.'],
  tokenPriority: ['HY_TOKEN 优先于本机配置；使用新保存的令牌时请取消该环境变量。', 'HY_TOKEN takes priority over local configuration. Unset it to use the newly saved access token.'],
  loggedIn: ['已登录：{email}', 'Signed in: {email}'],
  loginSaved: ['登录信息已保存。', 'Sign-in saved.'],
  // 账号族
  account: ['账号：{email}', 'Account: {email}'],
  notLoggedIn: ['尚未登录，开源版可以直接安装。', 'Not signed in. Open source skills can be installed directly.'],
  noPurchases: ['尚未购买付费 Skill。', 'No paid skills purchased yet.'],
  subscription: ['{name}：{status}（{plan}）', '{name}: {status} ({plan})'],
  purchaseStatus: ['{name}：{status}', '{name}: {status}'],
  renews: ['，续费 {date}', '; renews {date}'],
  ends: ['，到期 {date}', '; expires {date}'],
  active: ['有效', 'Active'],
  canceling: ['已取消，到期前可用', 'Canceled; available until expiry'],
  past_due: ['扣款失败，仍可用', 'Payment failed; still available'],
  lifetime: ['已买断，永久更新', 'Purchased · Lifetime updates'],
  trialing: ['试用中', 'Trial'],
  unknownDate: ['日期未知', 'unknown date'],
  noInstallations: ['未发现已安装的商店 Skill。', 'No installed store skills found.'],
  // 安装状态族（任务 5）
  unknownVersion: ['版本未知', 'unknown version'],
  versionCurrent: ['{name}：{version}（最新版）', '{name}: {version} (latest)'],
  versionNewer: ['{name}：{version}（高于最新发布的版本 {latest}）', '{name}: {version} (newer than the latest release, {latest})'],
  versionUpdate: ['{name}：{version} → {latest}（可更新）', '{name}: {version} → {latest} (update available)'],
  versionSkipped: ['{name}：{version}（开发目录，跳过）', '{name}: {version} (development directory, skipped)'],
  location: ['位置：{path}', 'Location: {path}'],
  releaseNotes: ['{version} 更新说明：', '{version} release notes:'],
  noReleaseNotes: ['未提供更新说明。', 'No release notes available.'],
  historyWarning: ['{path}：只能查看最近 20 条更新说明，可能缺少更早版本。', '{path}: only the latest 20 release notes are available; earlier versions may be missing.'],
  conflict: ['{prefix}{free} 和 {paid} 两个版本同时装会抢着接同一类请求', '{prefix}{free} and {paid} both handle the same requests when installed together.'],
  duplicateCopies: ['{name} 在本机有 {count} 份独立副本，更新时容易漏掉。运行 {next} 合并成一份，其余 Agent 改用链接。', '{name} has {count} separate copies on this machine, which can fall out of date. Run {next} to keep one copy and link the other agents to it.'],
  agentRead: ['无法检测宿主目录：{path}', 'Could not detect host directory: {path}'],
  scanRead: ['无法扫描目录：{path}', 'Could not scan directory: {path}'],
  invalidAccount: ['账号信息不完整，请重试。', 'Account details are incomplete. Please retry.'],
  // 配置与退出登录族
  missingAppdata: ['未设置 APPDATA，无法定位配置文件。', 'APPDATA is not set; cannot locate the configuration file.'],
  configRead: ['无法读取配置，请检查 config.json 和文件权限。', 'Could not read configuration. Check config.json and file permissions.'],
  configWrite: ['无法保存配置，请检查配置目录权限。', 'Could not save configuration. Check configuration directory permissions.'],
  configDelete: ['无法删除配置，请检查文件权限。', 'Could not remove configuration. Check file permissions.'],
  revokeWarning: ['未能撤销服务端令牌：{message} 可到 {url} 撤销。', 'Could not revoke the access token: {message} Revoke it at {url}.'],
  tokenEnvWarning: ['HY_TOKEN 仍在环境里，请取消该环境变量。', 'HY_TOKEN is still set. Unset it to finish signing out.'],
  revoked: ['已撤销令牌，并删除本机配置。', 'Access token revoked and local configuration removed.'],
  configRemoved: ['已删除本机配置。', 'Local configuration removed.'],
  invalidBrowser: ['浏览器链接无效，请重试。', 'Invalid browser link. Please retry.'],
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
  // 安装族（任务 6）
  missingTarget: ['未指定安装位置，请用 --to 指定，例如：{next}', 'No install location specified. Use --to, for example: {next}'],
  confirmInstall: ['安装 {name}？', 'Install {name}?'],
  installCanceled: ['已取消安装。', 'Installation canceled.'],
  installed: ['已安装 {name} {version}：{path}', 'Installed {name} {version}: {path}'],
  updated: ['已更新 {name}：{previous} → {version}（{path}）', 'Updated {name}: {previous} → {version} ({path})'],
  occupied: ['目标目录里有其他文件，已保留：{path}', 'The target directory contains other files and has been preserved: {path}'],
  changed: ['原目录已变化，请重试：{path}', 'The original directory changed. Please retry: {path}'],
  developmentProtected: ['开发目录，跳过：{path}', 'Development directory, skipped: {path}'],
  skippedSymbolicLink: ['{name}：符号链接指向的目录，跳过（{path}）', '{name}: directory referenced by a symbolic link, skipped ({path})'],
  overlappingTargets: ['安装目标互相包含，请分别执行或调整 --to。', 'Install targets overlap. Run them separately or adjust --to.'],
  rollbackFailed: ['替换失败，部分目录无法自动还原，请从备份恢复。', 'Replacement failed. Some directories could not be restored; recover them from the backups.'],
  replaceFailed: ['替换失败，原目录已还原，请检查目录权限。', 'Replacement failed. Original directories restored; check directory permissions.'],
  checksumMismatch: ['安装包校验失败，请重试。', 'Package verification failed. Please retry.'],
  missingChecksum: ['安装包无法校验，请稍后重试。', 'Could not verify the package. Please retry later.'],
  versionMismatch: ['下载的版本不一致，请重试。', 'The downloaded version does not match. Please retry.'],
  downloadFailed: ['安装包下载失败，请重试。', 'Package download failed. Please retry.'],
  extractFailed: ['解压失败，请确认系统已安装 tar。', 'Extraction failed. Check that tar is installed.'],
  installPackageMismatch: ['安装包的 Skill 名称或版本不匹配，请重试。', 'The package skill name or version does not match. Please retry.'],
  loginRequired: ['请先运行 {command} login。', 'First run {command} login.'],
  purchaseUnavailable: ['{name} 暂未开放购买：购买功能二期上线，可先到 {url} 查看商品页。', '{name} is not available for purchase yet. Purchasing arrives in phase 2; see the product page at {url}.'],
  autoConfirmedInstall: ['非交互模式：已自动确认安装。', 'Non-interactive mode: installation was auto-confirmed.'],
  // 发布族（任务 4）
  skillRead: ['无法读取 {path}，请检查目录和文件权限。', 'Could not read {path}. Check the directory and file permissions.'],
  developmentRead: ['无法检查 {path}，请检查目录权限。', 'Could not check {path}. Check directory permissions.'],
  invalidArchive: ['归档没有通过安全预检。', 'The archive failed safety pre-checks.'],
  publishUsage: ['publish 需要一个 Skill 目录，或用 --repo <路径> 指向仓库。', 'publish requires a skill directory, or --repo <path> for a repository.'],
  publishNotSkill: ['{path} 不是包含 SKILL.md 的 Skill 目录。', '{path} is not a skill directory containing SKILL.md.'],
  repoEmpty: ['{path} 里没有发现含 SKILL.md 的子目录。', 'No subdirectories containing SKILL.md were found under {path}.'],
  missingNameOrVersion: ['{path} 缺少可用的 name 或 metadata.version（版本需为 x.y.z 语义化版本）。', '{path} is missing a usable name or metadata.version (the version must be x.y.z semver).'],
  invalidName: ['无法从目录名 {directory} 推导规范名：需以小写字母开头，只含小写字母、数字和连字符。', 'Cannot derive a canonical name from {directory}: it must start with a lowercase letter and contain only lowercase letters, digits, and hyphens.'],
  reservedName: ['规范名 {name} 是 Windows 保留设备名，不能作为安装目录，请改名后重试。', 'The canonical name {name} is a reserved Windows device name and cannot be an install directory. Rename it and retry.'],
  nameMismatch: ['{path} 的 frontmatter name "{name}" 与规范名 {canonical} 不一致：请把 name 修正为规范名，或删掉 name 字段改用目录名推导。', 'The frontmatter name "{name}" in {path} does not match the canonical name {canonical}. Fix name to the canonical name, or remove the name field to derive it from the directory.'],
  nameConflict: ['多个目录映射到同一规范名：{conflicts}', 'Multiple directories map to the same canonical names: {conflicts}'],
  packFailed: ['打包失败，请检查目录权限和磁盘空间。', 'Packing failed. Check directory permissions and disk space.'],
  tarMissing: ['未找到系统 tar，请先安装 tar（Windows 10 及以上自带）再重试。', 'System tar was not found. Install tar first (bundled with Windows 10+) and retry.'],
  packTooLarge: ['源目录共 {size} 字节，超过 400MB 打包上限（压缩后还须低于 100MB），请精简 assets 后重试。', 'The source directory holds {size} bytes, over the 400MB packing limit (the compressed size must also stay under 100MB). Trim assets and retry.'],
  skillTooLarge: ['{path} 超过 1MB，无法读取，请精简后重试。', '{path} is larger than 1MB and cannot be read. Trim it and retry.'],
  junkExcluded: ['已从包中排除无关文件：{path}', 'Excluded a non-package file: {path}'],
  cleanupWarning: ['临时目录清理失败，可手动删除：{path}', 'Could not clean up the temporary directory; remove it manually: {path}'],
  autoConfirmed: ['非交互模式：已自动确认发布。', 'Non-interactive mode: publishing was auto-confirmed.'],
  notesTooLong: ['--notes 不能超过 2000 字符。', '--notes must not exceed 2000 characters.'],
  invalidPackage: ['打包内容未通过发布前校验：符号链接、路径越界或 Windows 保留名都会被拒绝。', 'The package failed pre-publish validation: symbolic links, path escapes, and Windows reserved names are rejected.'],
  packageMismatch: ['打包后的 Skill 信息与发布声明不一致，请重试。', 'The packaged skill details do not match the publish declaration. Please retry.'],
  tooLarge: ['包体 {size} 字节超过 100MB 上限，请精简后重试。', 'The package is {size} bytes, over the 100MB limit. Trim it and retry.'],
  versionExists: ['{name} {version} 已发布且内容不同；请先提升版本号。（跨机器或重新检出源码后重新打包，字节可能不同，属正常现象。）', '{name} {version} was already published with different content. Bump the version first. (Bytes may differ after repacking on another machine or from a fresh checkout; that is expected.)'],
  notPublisher: ['当前账号没有发布权限：请先在商店开通发布者角色，再运行 {command} login。', 'This account cannot publish. Enable the publisher role in the store, then run {command} login.'],
  publishResponse: ['发布结果不完整，请重试。', 'The publish response is incomplete. Please retry.'],
  published: ['已发布：{name} {version}', 'Published: {name} {version}'],
  publishSummary: ['大小：{size} 字节；SHA-256：{sha256}', 'Size: {size} bytes; SHA-256: {sha256}'],
  nameMapping: ['规范名：{source} → {name}（{origin}）', 'Canonical name: {source} → {name} ({origin})'],
  nameFromFrontmatter: ['取自 frontmatter name', 'from the frontmatter name'],
  nameFromDirectory: ['由目录名推导', 'derived from the directory name'],
  publishIdempotent: ['内容与已发布版本一致，按幂等处理。', 'Content matches the published version; treated as idempotent.'],
  publishNext: ['提示：发布新版本时可附 --notes "<更新说明>"。', 'Tip: attach --notes "<release notes>" when publishing a new version.'],
  publishConfirm: ['发布以上 {count} 个版本？', 'Publish the {count} versions above?'],
  nothingToPublish: ['没有需要发布的版本。', 'Nothing to publish.'],
  auditMissing: ['商店缺：{name}（本地 {version}）', 'Missing from store: {name} (local {version})'],
  auditBehind: ['待发布：{name} 本地 {local}，商店 {latest}', 'To publish: {name} local {local}, store {latest}'],
  auditLocalBehind: ['本地落后：{name} 本地 {local}，商店 {latest}', 'Local behind: {name} local {local}, store {latest}'],
  auditCurrent: ['一致：{name} {version}', 'Up to date: {name} {version}'],
  auditStoreOnly: ['商店多：{name}（本地仓库没有）', 'Store only: {name} (not in this repository)'],
  auditSummary: ['共 {total} 个 Skill：待发布 {publishable}，一致 {current}。', '{total} skills: {publishable} to publish, {current} up to date.'],
  publishBatchSummary: ['批量发布完成：成功 {published} 个，跳过 {skipped} 个。', 'Batch publish finished: {published} published, {skipped} skipped.'],
  skippedVersionExists: ['跳过 {name} {version}：该版本已发布。', 'Skipped {name} {version}: already published.'],
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
