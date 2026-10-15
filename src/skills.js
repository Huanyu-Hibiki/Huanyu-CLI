import { t, skillLabel } from './i18n.js';
import { lstat, realpath, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from './io.js';
import { pathsFor, userHome, directoryKey } from './platform.js';
import { HOSTS, targetRoot, discoveryRoots, projectRootsOf } from './hosts.js';

// 规范名（设计「数据模型」）：^[a-z0-9][a-z0-9-]*$；语义化版本（无前缀/后缀）。
export const isSkillName = (value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(value);
export const isVersion = (value) => typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value);

function scalar(value) {
  value = value.trim();
  if (value.startsWith('"')) {
    const match = value.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    if (!match) return null;
    try { return JSON.parse(`"${match[1]}"`); } catch { return null; }
  }
  if (value.startsWith("'")) {
    const match = value.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    return match ? match[1].replaceAll("''", "'") : null;
  }
  return value.replace(/\s+#.*$/, '').trim();
}

function inlineVersion(value) {
  // 逗号只在引号和子容器外拆分；允许 metadata 的其他字段。
  const content = value.trim().replace(/\s+#.*$/, '');
  if (!content.startsWith('{') || !content.endsWith('}')) return { count: 0, version: null };
  const fields = [];
  let start = 1, quote = null, depth = 0;
  for (let i = 1; i < content.length - 1; i++) {
    const char = content[i];
    if (quote) {
      if (char === '\\' && quote === '"') { i++; continue; }
      if (char === quote) {
        if (quote === "'" && content[i + 1] === "'") { i++; continue; }
        quote = null;
      }
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '{' || char === '[') depth++;
    else if (char === '}' || char === ']') depth--;
    else if (char === ',' && !depth) { fields.push(content.slice(start, i)); start = i + 1; }
  }
  if (quote || depth) return { count: 0, version: null };
  fields.push(content.slice(start, -1));
  const versions = fields.map((field) => field.match(/^\s*(?:version|"version"|'version')\s*:\s*(.*?)\s*$/)).filter(Boolean);
  return { count: versions.length, version: versions.length === 1 ? scalar(versions[0][1]) : null };
}

// 只读取 frontmatter 的 name 和 metadata.version，不执行 YAML 标签。
export function parseSkill(text) {
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/);
  if (!match) return { name: null, version: null };
  let name = null, version = null, metadata = false, childIndent = null, nameCount = 0, metadataCount = 0, versionCount = 0;
  for (const line of match[1].split(/\r?\n/)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const nameLine = line.match(/^(?:name|"name"|'name')\s*:\s*(.*)$/);
    if (nameLine) { name = scalar(nameLine[1]); nameCount++; }
    const metaLine = line.match(/^(?:metadata|"metadata"|'metadata')\s*:\s*(.*)$/);
    if (metaLine) {
      metadata = !metaLine[1].trim() || metaLine[1].trim().startsWith('#'); metadataCount++; childIndent = null;
      const inline = inlineVersion(metaLine[1]);
      if (inline.count) { version = inline.version; versionCount += inline.count; }
    } else if (/^\S/.test(line)) metadata = false;
    else if (metadata) {
      const indent = line.match(/^ */)[0].length;
      if (childIndent === null) childIndent = indent;
      if (indent !== childIndent) continue;
      const versionLine = line.match(/^ +(?:version|"version"|'version')\s*:\s*(.*)$/);
      if (versionLine) { version = scalar(versionLine[1]); versionCount++; }
    }
  }
  return { name: nameCount === 1 ? name : null, version: metadataCount === 1 && versionCount === 1 && isVersion(version) ? version : null };
}

// .git 可以是目录、worktree 的文件或链接；先解析路径的软链接再判断是否开发目录。
export async function isDevelopmentDirectory(directory) {
  try {
    const resolved = await realpath(directory);
    if (!(await lstat(resolved)).isDirectory()) return false;
    const containsGit = async (current) => {
      const entries = await readdir(current, { withFileTypes: true });
      if (entries.some((entry) => (process.platform === 'win32' ? entry.name.toLowerCase() : entry.name) === '.git')) return true;
      for (const entry of entries) {
        // 内部软链接不属于会被整体删除的内容，不向外遍历。
        if (entry.isDirectory() && await containsGit(path.join(current, entry.name))) return true;
      }
      return false;
    };
    return await containsGit(resolved);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return false;
    throw new CliError(t('developmentRead', { path: directory }), 1, 'skill_read');
  }
}

export async function inspectSkill(directory, names) {
  try {
    const resolved = await realpath(directory);
    if (!(await lstat(resolved)).isDirectory()) return null;
    const file = path.join(resolved, 'SKILL.md');
    if (!(await lstat(file)).isFile()) return null;
    const skill = parseSkill(await readFile(file, 'utf8'));
    return names.includes(skill.name) ? { ...skill, path: directory, real_path: resolved, root: path.dirname(directory), development: await isDevelopmentDirectory(resolved) } : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    if (error instanceof CliError) throw error;
    throw new CliError(t('skillRead', { path: directory }), 1, 'skill_read');
  }
}

export function resolveDirectory(value, env = process.env, platform = process.platform, cwd = process.cwd()) {
  const home = userHome(env, platform), paths = pathsFor(platform);
  if (value === '~') return home;
  if (/^~[/\\]/.test(value)) return paths.resolve(home, value.slice(2));
  return paths.resolve(cwd, value);
}

// 目标可能还没创建，沿父目录解析软链接，用于重复/嵌套目标检查。
export async function canonicalDirectory(directory) {
  const absolute = path.resolve(directory);
  try { return await realpath(absolute); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code) || path.dirname(absolute) === absolute) throw error;
    return path.join(await canonicalDirectory(path.dirname(absolute)), path.basename(absolute));
  }
}

// 只解析父目录：Skill 目录本身可能是指向主安装的链接，不能和主安装算成同一路径。
export async function logicalDirectory(directory) {
  const absolute = path.resolve(directory);
  return path.join(await canonicalDirectory(path.dirname(absolute)), path.basename(absolute));
}

export async function uniqueDirectories(directories) {
  const seen = new Set(), result = [];
  for (const directory of directories) {
    const resolved = directoryKey(await canonicalDirectory(directory));
    if (!seen.has(resolved)) { result.push(directory); seen.add(resolved); }
  }
  return result;
}

// 保护 Skill 本身、skills 目录及其宿主目录上的软链接；不把系统路径别名当作安装链接。
const installationParents = (root) => [root, ...(path.basename(root).toLowerCase() === 'skills' ? [path.dirname(root)] : [])];
async function hasDirectoryLink(directories) {
  for (const current of directories) {
    try { if ((await lstat(current)).isSymbolicLink()) return true; }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw new CliError(t('skillRead', { path: current }), 1, 'skill_read');
    }
  }
  return false;
}
export const isLinkedInstallation = (directory) => hasDirectoryLink([directory, ...installationParents(path.dirname(directory))]);

function agentRootGroups(env = process.env, platform = process.platform, cwd = process.cwd()) {
  return HOSTS.map((host) => [targetRoot(host.id, env, platform, cwd), ...projectRootsOf(host.id, cwd, env, platform)]);
}

// 显式路径也按宿主识别；无法归属的自定义目录只算自身。
export async function sameAgentRoots(directory) {
  const groups = agentRootGroups();
  // 先按逻辑位置归属宿主，避免多个宿主的链接指向同一目录时误选宿主。
  const exact = groups.find((roots) => roots.some((root) => directoryKey(root, process.platform, null) === directoryKey(directory, process.platform, null)));
  if (exact) return [...new Set([directory, ...exact])];
  const resolved = directoryKey(await canonicalDirectory(directory));
  const matches = [];
  for (const roots of groups) {
    if ((await Promise.all(roots.map(async (root) => directoryKey(await canonicalDirectory(root))))).includes(resolved)) matches.push(roots);
  }
  return [...new Set([directory, ...(matches.length === 1 ? matches[0] : [])])];
}

export async function scan(names, roots = discoveryRoots()) {
  // 同一目录可能经由不同路径（符号链接、大小写变体、8.3 短路径）被扫到两次，按真实路径只保留一份。
  const found = [], seen = new Set();
  for (const root of [...new Set(roots)]) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) continue;
      throw new CliError(t('scanRead', { path: root }), 1, 'skill_read');
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const skill = await inspectSkill(path.join(root, entry.name), names);
      if (skill && !seen.has(directoryKey(skill.real_path))) { seen.add(directoryKey(skill.real_path)); found.push(skill); }
    }
  }
  return found;
}

// scan 已按真实路径去重，同名的多条记录就是多份互不相干的副本。
// 只看用户级宿主根（hosts 数据）：项目里的目录是有意的局部安装；开发目录也不算。
export function duplicateCopies(found, env = process.env, platform = process.platform) {
  const userRoots = new Set(HOSTS.map((host) => directoryKey(targetRoot(host.id, env, platform), platform, null)));
  const groups = new Map();
  for (const item of found.filter((item) => !item.development && userRoots.has(directoryKey(item.root, platform, null)))) groups.set(item.name, [...(groups.get(item.name) || []), item.path]);
  return [...groups].filter(([, paths]) => paths.length > 1).map(([name, paths]) => ({ name, paths }));
}

// 语义化版本逐段比较（BigInt），安装端与发布端对账共用。
export function compare(a, b) {
  const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}

// current 之后、latest 之前的可升级列表（含更新说明），按版本升序。
export function updates(current, release) {
  return release.history.filter((item) => isVersion(item.version) && (!current || compare(item.version, current) > 0) && compare(item.version, release.latest) <= 0)
    .sort((a, b) => compare(a.version, b.version))
    .map(({ version, published_at, notes }) => ({ version, published_at, notes: typeof notes === 'string' ? notes : '' }));
}

// 配对数据驱动（设计「领域层重组」③）：对每个 free+paid 齐备的商品，同宿主根同时装了两个版本即警告。
// 宿主归属用 sameAgentRoots（含项目级根），免费版经链接共享到付费版宿主也能识别。
export async function conflicts(installed, catalog) {
  const warnings = [];
  for (const product of catalog.filter((product) => product.free && product.paid)) {
    const seen = new Set();
    for (const pro of installed.filter((item) => item.name === product.paid.skill)) {
      const roots = await sameAgentRoots(pro.root);
      const canonical = [...new Set(await Promise.all(roots.map(async (root) => directoryKey(await canonicalDirectory(root)))))];
      const key = [...canonical].sort().join('\0');
      if (seen.has(key)) continue;
      seen.add(key);
      for (const free of installed.filter((item) => item.name === product.free.skill)) {
        if (!canonical.includes(directoryKey(await canonicalDirectory(free.root)))) continue;
        warnings.push(t('conflict', { prefix: `${pro.root}: `, free: skillLabel(product.free.skill), paid: skillLabel(product.paid.skill) }));
        break;
      }
    }
  }
  return warnings;
}
