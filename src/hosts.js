import { stat } from 'node:fs/promises';
import { t } from './i18n.js';
import { CliError } from './io.js';
import { pathsFor, userHome, absoluteDirectory, resolveDirectory } from './platform.js';

// 宿主表（设计「宿主表」，zcode 优先序）数据化：user 是相对基目录的路径段，project 是项目级目录的完整段
// （点前缀目录名也入数据，不由 id 推导——qwenwork 的用户级 .qwenworkcn 即是目录名≠id 的先例），
// env 声明整体替换宿主目录的环境变量（CODEX_HOME 覆盖 .codex）。
// opencode 实测（2026-10-15，本机 @opencode 1.17.x 二进制反查）：skill 目录在 {skill,skills} 通配下都被扫描，
// 全局根为 $XDG_CONFIG_HOME|~/.config 的 opencode/（跨平台一致，Windows 下不用 APPDATA；官方文档用单数 skill），项目级 .opencode/skill。
export const HOSTS = [
  { id: 'zcode', user: ['.zcode', 'skills'], project: ['.zcode', 'skills'] },
  { id: 'agents', user: ['.agents', 'skills'], project: ['.agents', 'skills'] },
  { id: 'claude', user: ['.claude', 'skills'], project: ['.claude', 'skills'] },
  { id: 'codex', user: ['.codex', 'skills'], project: ['.codex', 'skills'], env: 'CODEX_HOME' },
  { id: 'cursor', user: ['.cursor', 'skills'] },
  { id: 'opencode', user: ['opencode', 'skill'], project: ['.opencode', 'skill'], base: 'config' },
  { id: 'trae', user: ['.trae', 'skills'], project: ['.trae', 'skills'] },
  { id: 'qwenwork', user: ['.qwenworkcn', 'skills'] },
  { id: 'workbuddy', user: ['.workbuddy', 'skills'] },
];

const hostById = (value) => HOSTS.find((host) => host.id === value);

// base 决定 user 段相对哪个根展开：默认用户主目录；opencode 自身走 XDG 配置目录约定。
function hostBase(host, env, platform, cwd) {
  if (host.base === 'config') {
    const home = userHome(env, platform), paths = pathsFor(platform);
    // 相对 XDG_CONFIG_HOME 忽略并回落 ~/.config（与 config.js 的绝对目录判定共用），宿主根不随 cwd 漂移。
    return absoluteDirectory(env.XDG_CONFIG_HOME, paths) || paths.join(home, '.config');
  }
  return userHome(env, platform);
}

// 宿主 id → 用户级根；宿主 id 之外的值当作路径解析（--to/--path 的自由位置）。
export function targetRoot(value, env = process.env, platform = process.platform, cwd = process.cwd()) {
  const paths = pathsFor(platform);
  const host = hostById(value);
  if (!host) return resolveDirectory(value, env, platform, cwd);
  // 环境覆盖整体替换宿主目录（如 CODEX_HOME 指到别处），只保留 skills 段。
  if (host.env && env[host.env]) return paths.join(resolveDirectory(env[host.env], env, platform, cwd), host.user[host.user.length - 1]);
  return paths.join(hostBase(host, env, platform, cwd), ...host.user);
}

// 默认扫描范围：九个用户级根。与 template 的刻意差异：项目级目录不进默认扫描——
// 项目里的安装是有意的局部安装，只有显式 --to/--path 才触及（projectRootsOf）。
export function discoveryRoots(env = process.env, platform = process.platform, cwd = process.cwd()) {
  return [...new Set(HOSTS.map((host) => targetRoot(host.id, env, platform, cwd)))];
}

// 安装侧的候选根：按优先序只挑宿主目录已存在的用户级根，只检测不创建。
export async function installationRoots(env = process.env, platform = process.platform, cwd = process.cwd()) {
  const roots = [], paths = pathsFor(platform);
  for (const host of HOSTS) {
    const root = targetRoot(host.id, env, platform, cwd);
    const directory = paths.dirname(root);
    try {
      if ((await stat(directory)).isDirectory()) roots.push(root);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw new CliError(t('agentRead', { path: directory }), 1, 'skill_read');
    }
  }
  return roots;
}

// 项目级根：供 --to/--path 显式解析与宿主归属判断（任务 6 安装用）；无项目目录的宿主返回空。
export function projectRootsOf(hostId, env = process.env, platform = process.platform, cwd = process.cwd()) {
  const host = hostById(hostId), paths = pathsFor(platform);
  return host?.project ? [paths.resolve(cwd, ...host.project)] : [];
}

// CLI 管辖根全集（任务 6 M2 写穿白名单）：已存在的用户级宿主根（installationRoots）+ 各宿主项目级根
// + 调用方显式提供的根（--to 显式根或自动发现根）。realInstallation 解析出的真实目标必须落在其中
// 之一才允许写穿跟随——用户自建链接指向管理范围之外的目录时按占用拒绝，不借 CLI 之手改写任意目录。
export async function managedRoots(extra = [], env = process.env, platform = process.platform, cwd = process.cwd()) {
  return [...new Set([...extra, ...(await installationRoots(env, platform, cwd)), ...HOSTS.flatMap((host) => projectRootsOf(host.id, env, platform, cwd))])];
}

// 编辑距离（小 DP；宿主 id 最长 8 字符，无需剪枝）。
function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return rows[a.length][b.length];
}

// askTarget 的拼写提示：与某个宿主 id 编辑距离恰为 1 的输入视为手滑，返回该 id；否则 null。
// 输入本身仍按路径语义处理，提示不改变行为（比较前先 trim，生产端 ask 已 trim、测试端未 trim）。
export function nearestHostId(value, ids = HOSTS.map((host) => host.id)) {
  const typed = String(value ?? '').trim().toLowerCase();
  if (!typed || ids.includes(typed)) return null;
  return ids.find((id) => editDistance(typed, id) === 1) ?? null;
}
