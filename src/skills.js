import { t } from './i18n.js';
import { lstat, realpath, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CliError } from './io.js';
import { pathsFor, userHome } from './platform.js';

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

// 语义化版本逐段比较（BigInt），安装端与发布端对账共用。
export function compare(a, b) {
  const aa = a.split('.').map(BigInt), bb = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
}
