import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readlink, realpath, rm, symlink, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { validateArchive } from '../src/archive.js';
import { packSkill } from '../src/publish.js';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../bin/hy.js', import.meta.url));
const DRIVER = fileURLToPath(new URL('./driver.js', import.meta.url));
export const TOKEN = 'hy_Abcd0123456789abcdefghijklmnopqrstuvXYZ';
export const INVALID = 'hy_Bad0123456789abcdefghijklmnopqrstuvXYZ';
// 第二枚有效令牌：用 state.grants.set(TOKEN2, [...]) 注册后即可通过鉴权，用于多令牌场景。
export const TOKEN2 = 'hy_Other0123456789abcdefghijklmnopqrstuv';
export const EMAIL = 'test@example.com';
// Windows 的模式位不区分 owner/group/others；用户隔离由目录 ACL 提供。
export const configMode = process.platform === 'win32' ? 0o666 : 0o600;
// 测试侧造目录链接与读回目标（win32 junction 的 readlink 可能带 \\?\ 前缀，归一后再比）。
export const linkDirectory = (target, directory) => symlink(target, directory, process.platform === 'win32' ? 'junction' : 'dir');
export const readDirectoryLink = async (directory) => {
  const target = await readlink(directory);
  return process.platform === 'win32' ? path.resolve(target.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')) : target;
};

// 试点商品集（对齐设计「数据模型」）：ppt-design 免费版 + 付费配对预留（买断定价）；oracle-bone 纯免费。
// summaryEn 仅供假商店按 Accept-Language 切换文案，不作为字段下发。
export const CATALOG = [
  { id: 'ppt-design', name: 'PPT 设计', summary: '分步设计演示文稿的结构与版式。', summaryEn: 'Design presentation structure and layouts step by step.',
    free: { skill: 'ppt-design' }, paid: { skill: 'ppt-design-pro' }, offer: ['lifetime'], prices: { lifetime: { amount: 6900, currency: 'cny', interval: null } } },
  { id: 'oracle-bone', name: '甲骨文', summary: '识别与释读甲骨文字形。', summaryEn: 'Recognize and read oracle bone script.',
    free: { skill: 'oracle-bone' }, paid: null, offer: [], prices: {} },
];

// 测试侧落一个可被 scan/inspectSkill 识别的 Skill 目录；folder 允许目录名与规范名不同。
export async function writeSkill(root, name, version, folder = name) {
  const directory = path.join(root, folder);
  await mkdir(path.join(directory, 'assets'), { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: 测试 Skill\nmetadata:\n  version: "${version}"\n---\n\n# 测试\n`);
  await writeFile(path.join(directory, 'assets', 'example.txt'), `${name} ${version}\n`);
  return directory;
}

// 假浏览器脚本：HY_TEST_BROWSER=approve 时对设备授权页自动点“允许”；默认退出 1 模拟打开失败。
const browserScript = `(async () => {\nif (process.env.HY_TEST_BROWSER !== 'approve') process.exit(1);\nconst url = new URL(process.env.HY_BROWSER_URL || process.argv.at(-1));\nif (url.pathname.endsWith('/device/')) {\nconst response = await fetch(new URL('/api/cli/device/approve', url), {method: 'POST', headers: {'Content-Type': 'application/json', Cookie: 'hy_session=fake'}, body: JSON.stringify({user_code: url.searchParams.get('code'), approve: true})});\nif (!response.ok) process.exit(1);\n}\nprocess.exit(0);\n})().catch(() => process.exit(1));\n`;

// Windows 无法直接执行 shebang 脚本：复制 node.exe 冒充 cmd.exe（经 ComSpec 显式指定），
// 并用 NODE_OPTIONS --require 预加载 helper，识别 /v:off 参数后接管为假浏览器。
// node.exe 副本约 85MB，惰性准备：真正要打开浏览器前才复制，不开浏览器的测试零成本。
const browserExecutables = new Set();
export async function ensureBrowserExecutable(executable) {
  if (browserExecutables.has(executable)) return;
  await copyFile(process.execPath, executable, constants.COPYFILE_EXCL)
    .catch((error) => { if (error.code !== 'EEXIST') throw error; });
  browserExecutables.add(executable);
}

export async function mockCommandProcessor(directory) {
  const helper = path.join(directory, 'browser-helper.cjs');
  // 异步授权完成前不能让 Node 把 cmd 的 /d 当作主脚本加载。
  await writeFile(helper, `if (process.argv.includes('/v:off') && process.env.HY_BROWSER_URL) {\nrequire('node:module').runMain = () => {};\n${browserScript}}\n`);
  return { executable: path.join(directory, 'cmd.exe'), nodeOptions: `--require "${helper.replaceAll('\\', '/')}"` };
}

// 语义化版本比较：versions 合并已发布内容时提升 latest（任务 4）。
const compareVersions = (a, b) => {
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
  return 0;
};

// 默认免费发布物（任务 6 前置，任务 2 审查登记）：给试点免费 skill 各备一个 0.1.0 的
// tar.gz + sha256，versions 据此下发 download_url/sha256（免费版摘要必填）。
// 与 state.published 分开存放，不影响 publish 幂等/409 语义；进程级缓存避免每个 fixture 重复打包。
let seedCache = null;
async function defaultReleases() {
  if (seedCache) return seedCache;
  seedCache = new Map();
  const scratch = await mkdtemp(path.join(tmpdir(), 'hy-seed-'));
  try {
    for (const product of CATALOG) {
      const name = product.free?.skill;
      if (!name) continue;
      const source = await writeSkill(scratch, name, '0.1.0');
      const packed = await packSkill(source, name, '0.1.0', {});
      try { seedCache.set(`${name}:0.1.0`, { body: await readFile(packed.archive), sha256: packed.sha256, size: packed.size, notes: '', published_at: '2026-10-15T08:00:00Z' }); }
      finally { await packed.cleanup(); }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return seedCache;
}

// 假商店：绑定 127.0.0.1 随机端口，提供 catalog/versions/publish/releases 与 device/token/me/logout/approve 端点（契约见设计「接口设计」）；
// 请求全部记入 state.requests，目录与设备流数据可直接改写用于错误注入。
export async function fixture(t) {
  let temporary = await mkdtemp(path.join(tmpdir(), 'hy-test-'));
  // macOS 的 /var 是 /private/var 的别名、Windows 有 8.3 短路径：一律 realpath，
  // 让 f.* 派生路径与产品内部的 canonical 解析一致（否则期望值与 real_path 断言会差一个别名前缀）。
  temporary = await realpath(temporary);
  const home = path.join(temporary, 'home'), cwd = path.join(temporary, 'project'), config = path.join(temporary, 'config'), mockBin = path.join(temporary, 'bin');
  for (const directory of [home, cwd, config, mockBin]) await mkdir(directory);
  // 真 CLI 也使用假浏览器。Windows 不能执行 shebang，使用 Node 的 exe 和预加载脚本。
  let nodeOptions = process.env.NODE_OPTIONS || '';
  let commandProcessor = process.env.ComSpec;
  if (process.platform === 'win32') {
    const mock = await mockCommandProcessor(mockBin);
    // 用 ComSpec 显式指定模拟程序，避免依赖可执行文件搜索和硬链接名称。
    commandProcessor = mock.executable;
    nodeOptions += ` ${mock.nodeOptions}`;
  } else {
    for (const name of ['open', 'xdg-open']) await writeFile(path.join(mockBin, name), `#!${process.execPath}\n${browserScript}`, { mode: 0o755 });
  }
  const state = { catalog: structuredClone(CATALOG), catalogShape: 'products', latest: '0.1.0', history: null, badVersions: false, failWith: null, requests: [],
    deviceStatuses: ['authorization_pending', 'success'], deviceStatusesByRequest: null, devicePolls: 0, deviceRequests: 0,
    interval: 5, expiresIn: 600, deviceApproved: false, requireApproval: false, deviceToken: null, deviceErrorMessage: null,
    deviceCode: null, userCode: null, logoutFailure: false, revoked: new Set(), grants: new Map(),
    // 发布端（任务 4）：publishers 为有发布角色的令牌集合（TOKEN 默认在内，TOKEN2 需 grants 注册后仍不在）；
    // published 按 `name:version` 存 {body, sha256, size, notes, published_at}；publishStatus 强制注入错误；dropPublisher 让 me 缺字段。
    publishers: new Set([TOKEN]), published: new Map(), publishStatus: null, dropPublisher: false,
    // 下载端（任务 6）：releases 为免费默认发布物（每 fixture 浅拷贝一层 Map，防跨用例可变共享）；
    // dropChecksum 让 versions 省略摘要（fail-closed 测试）、badChecksum 让 versions 下发错误摘要、
    // corruptBody 让 /releases 截断正文（客户端读到不完整流）、releaseDelay 压住发布物响应模拟慢下载、
    // versionsDelay 压住版本表响应（构造 scan 之后、下载之前的目标变动窗口，update 预检测试用）。
    releases: new Map(await defaultReleases()), dropChecksum: false, badChecksum: false, corruptBody: false, releaseDelay: 0, versionsDelay: 0 };
  let base;
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const error = (res, status, code, message) => json(res, status, { error: code, message });
  // 登录账号的订阅列表按 grants 生成；默认把目录里的全部付费 Skill 授予 TOKEN。
  const subscriptions = (token) => {
    const names = state.grants.get(token) || (token === TOKEN ? state.catalog.flatMap((p) => p.paid ? [p.paid.skill] : []) : []);
    return names.map((skill) => {
      const product = state.catalog.find((p) => p.paid?.skill === skill);
      const plan = product?.offer?.[0] || 'lifetime';
      return { skill, name: product?.name || skill, plan, status: plan === 'lifetime' ? 'lifetime' : 'active', renews: plan === 'lifetime' ? null : 1793664000, ends: null };
    });
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base);
      // 请求体按原始字节收集：publish 上传的是 gzip 二进制，JSON 只对 JSON 端点解析。
      let raw = Buffer.alloc(0);
      for await (const chunk of req) raw = Buffer.concat([raw, chunk]);
      let body = null;
      if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const english = req.headers['accept-language'] === 'en';
      state.requests.push({ method: req.method, path: url.pathname, query: url.searchParams, token, body, headers: req.headers });
      const authenticate = () => { if ((token !== TOKEN && !state.grants.has(token)) || state.revoked.has(token)) { error(res, 401, 'unauthorized', `令牌无效：${token || ''}`); return false; } return true; };
      if (req.method === 'GET' && url.pathname === '/api/store/catalog') {
        // 通用错误注入：failWith 命中 catalog/versions 时按它返回错误 JSON（error/message 可省略）。
        if (state.failWith) return error(res, state.failWith.status, state.failWith.error, state.failWith.message);
        // 外层形状可切换：{products}（默认）/ 裸数组 / {catalog} / 无法识别，客户端前三种都要接受。
        const products = state.catalog.map(({ summaryEn, ...product }) => ({ ...product, summary: english ? summaryEn : product.summary }));
        if (state.catalogShape === 'array') return json(res, 200, products);
        if (state.catalogShape === 'catalog') return json(res, 200, { catalog: products });
        if (state.catalogShape === 'none') return json(res, 200, { weird: true });
        return json(res, 200, { products });
      }
      if (req.method === 'GET' && url.pathname === '/api/store/versions') {
        if (state.failWith) return error(res, state.failWith.status, state.failWith.error, state.failWith.message);
        if (state.versionsDelay) await new Promise((resolve) => setTimeout(resolve, state.versionsDelay));
        // state.history 可覆盖默认两条版本（条目为字符串或 {version, notes}），供 status 的更新/截断测试改写。
        const entry = (item) => typeof item === 'string' ? { version: item, notes: null } : item;
        const history = (state.history || ['0.1.0', '0.0.9']).map((item) => {
          const { version, notes } = entry(item);
          return { version, published_at: '2026-10-15T08:00:00Z', notes: notes ?? (english ? `${version}: First pilot release.` : `${version}：首个试点版本。`) };
        });
        const skills = {};
        for (const product of state.catalog) for (const type of ['free', 'paid']) {
          const name = typeof product[type] === 'string' ? product[type] : product[type]?.skill;
          if (!name) continue;
          // 免费默认发布物：latest 对上种子版本时下发 download_url + sha256（设计「数据模型」：免费版摘要必填）。
          const seed = state.releases.get(`${name}:${state.latest}`);
          const checksum = seed ? (state.dropChecksum ? null : state.badChecksum ? '0'.repeat(64) : seed.sha256) : null;
          skills[name] = { latest: state.badVersions ? 'oops' : state.latest, published_at: '2026-10-15T08:00:00Z', history,
            ...(checksum ? { download_url: `${base}/releases/${name}-${state.latest}.tar.gz`, sha256: checksum } : {}) };
        }
        // 已发布版本合并进版本表：latest 按语义版本提升、history 追加（供 --repo 对账与任务 6/7 安装闭环消费）。
        for (const [key, entry] of state.published) {
          const [name, version] = key.split(':');
          const current = skills[name] ?? { latest: '0.0.0', published_at: entry.published_at, history: [] };
          const latest = compareVersions(version, current.latest) > 0 ? version : current.latest;
          const merged = [...current.history.filter((item) => item.version !== version),
            { version, published_at: entry.published_at, notes: entry.notes || (english ? `${version}: Published with hy CLI.` : `${version}：经 hy CLI 发布。`) }]
            .sort((a, b) => -compareVersions(a.version, b.version));
          // latest 仍是目录默认版本（发布的版本更低）时回退到种子发布物；两者都没有才省略摘要。
          const top = state.published.get(`${name}:${latest}`);
          const seed = state.releases.get(`${name}:${latest}`);
          const checksum = top ? top.sha256 : seed ? (state.dropChecksum ? null : state.badChecksum ? '0'.repeat(64) : seed.sha256) : null;
          skills[name] = { latest, published_at: entry.published_at, history: merged,
            download_url: `${base}/releases/${name}-${latest}.tar.gz`, ...(checksum ? { sha256: checksum } : {}) };
        }
        return json(res, 200, { skills });
      }
      if (req.method === 'POST' && url.pathname === '/api/store/publish') {
        if (!authenticate()) return;
        // publishStatus 注入：数字为持续生效；数组按请求顺序消耗（模拟对账后、上传前被别人抢先发布的 409 等）。
        const status = Array.isArray(state.publishStatus) ? state.publishStatus.shift() : state.publishStatus;
        const injected = status ? { 400: 'invalid_package', 403: 'not_a_publisher', 409: 'version_exists', 413: 'too_large' }[status] : null;
        if (injected) return error(res, status, injected, '注入的发布失败。');
        if (!state.publishers.has(token)) return error(res, 403, 'not_a_publisher', '没有发布权限。');
        const name = req.headers['x-skill-name'], version = req.headers['x-skill-version'], sha256 = req.headers['x-content-sha256'];
        // Windows 保留设备名不能当安装目录：服务端同样拒绝（客户端 canonicalName 已拦，这里是最终验证）。
        if (!/^[a-z0-9][a-z0-9-]*$/.test(String(name || '')) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(String(name || ''))
          || !/^\d+\.\d+\.\d+$/.test(String(version || ''))
          || !/^[0-9a-f]{64}$/.test(String(sha256 || '')) || !String(req.headers['content-type'] || '').startsWith('application/gzip')) return error(res, 400, 'invalid_package', '发布头不完整。');
        if (createHash('sha256').update(raw).digest('hex') !== sha256) return error(res, 400, 'invalid_package', '摘要不一致。');
        // 服务端是最终验证者：对上传的归档复跑安装侧同一验证器。
        const scratch = await mkdtemp(path.join(tmpdir(), 'hy-fixture-'));
        try {
          const upload = path.join(scratch, 'upload.tar.gz');
          await writeFile(upload, raw);
          try { await validateArchive(upload, String(name)); }
          catch { return error(res, 400, 'invalid_package', '包未通过服务端验证。'); }
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
        const existing = state.published.get(`${name}:${version}`);
        if (existing) {
          // 设计「假设清单」#1：同 sha256 重传幂等成功；内容不同才是版本冲突。
          if (existing.sha256 === sha256) return json(res, 200, { skill: name, version, sha256, size: existing.size, url: `${base}/releases/${name}-${version}.tar.gz`, existing: true });
          return error(res, 409, 'version_exists', '该版本已发布。');
        }
        state.published.set(`${name}:${version}`, { body: raw, sha256, size: raw.length, notes: decodeURIComponent(req.headers['x-notes'] || ''), published_at: new Date().toISOString() });
        return json(res, 200, { skill: name, version, sha256, size: raw.length, url: `${base}/releases/${name}-${version}.tar.gz` });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/store/download/')) {
        // 下载端（契约：免费 302→公开附件不带令牌；付费 200 + X-Content-SHA256 + X-Skill-Version 走订阅鉴权）。
        // 一期客户端对付费前置拦截不会走到这里，端点先备齐供任务 7/二期。
        const name = decodeURIComponent(url.pathname.slice('/api/store/download/'.length));
        const version = url.searchParams.get('version');
        const product = state.catalog.find((p) => [p.free?.skill, p.paid?.skill].includes(name));
        const entry = state.releases.get(`${name}:${version}`) || state.published.get(`${name}:${version}`);
        if (!product || !entry || url.searchParams.get('format') !== 'tar.gz') return error(res, 404, 'not_found', '没有该版本。');
        if (product.paid?.skill === name) {
          if (!authenticate()) return;
          if (!subscriptions(token).some((subscription) => subscription.skill === name)) return error(res, 402, 'inactive', '尚未购买。');
          res.writeHead(200, { 'Content-Type': 'application/gzip', 'X-Content-SHA256': entry.sha256, 'X-Skill-Version': version });
          return res.end(entry.body);
        }
        res.writeHead(302, { Location: `${base}/releases/${name}-${version}.tar.gz` });
        return res.end();
      }
      if (req.method === 'GET' && url.pathname.startsWith('/releases/')) {
        const match = url.pathname.match(/^\/releases\/(.+)-(\d+\.\d+\.\d+)\.tar\.gz$/);
        const name = match?.[1];
        const entry = match ? state.releases.get(`${name}:${match[2]}`) || state.published.get(`${name}:${match[2]}`) : null;
        if (!entry) return error(res, 404, 'not_found', '没有该版本。');
        // 付费 skill 的发布物走订阅鉴权（与下载端语义一致，任务 6/7 铺垫）；免费与未入目录的保持公开。
        if (state.catalog.some((product) => product.paid?.skill === name)) {
          if (!authenticate()) return;
          if (!subscriptions(token).some((subscription) => subscription.skill === name)) return error(res, 402, 'inactive', '尚未购买。');
        }
        if (state.releaseDelay) await new Promise((resolve) => setTimeout(resolve, state.releaseDelay));
        if (state.corruptBody) {
          // 截断正文后断开：Content-Length 与实际字节不符，客户端读到不完整流（download 失败）。
          // 等半截数据真正写进 socket 再 destroy，保证响应头先于连接重置到达客户端。
          res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': String(entry.body.length) });
          res.write(entry.body.subarray(0, Math.max(1, Math.floor(entry.body.length / 2))), () => res.destroy());
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/gzip' });
        return res.end(entry.body);
      }
      if (req.method === 'POST' && url.pathname === '/api/cli/device') {
        state.deviceRequests++;
        state.devicePolls = 0;
        state.deviceApproved = false;
        const suffix = state.deviceRequests === 1 ? '' : `_${state.deviceRequests}`;
        state.deviceCode = `device_secret_0123456789${suffix}`;
        state.userCode = `KDQW-7RTF${suffix}`;
        const devicePath = body.lang ? `/${body.lang}/device/` : '/device/';
        return json(res, 200, { device_code: state.deviceCode, user_code: state.userCode, verification_uri: `${base}${devicePath}`, verification_uri_complete: `${base}${devicePath}?code=${state.userCode}`, expires_in: state.expiresIn, interval: state.interval });
      }
      if (req.method === 'POST' && url.pathname === '/api/cli/device/approve') {
        if (req.headers.cookie !== 'hy_session=fake' || body.user_code !== state.userCode) return error(res, 403, 'forbidden', '确认失败。');
        state.deviceApproved = body.approve;
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/cli/token') {
        if (body.device_code !== state.deviceCode) return error(res, 400, 'expired_token', '设备码不存在。');
        const statuses = state.deviceStatusesByRequest?.[state.deviceRequests - 1] ?? state.deviceStatuses;
        const status = state.requireApproval ? state.deviceApproved ? 'success' : 'authorization_pending' : statuses[Math.min(state.devicePolls, statuses.length - 1)];
        state.devicePolls++;
        if (status === 'upstream') return error(res, 502, 'upstream', '服务连接失败');
        if (status !== 'success') return error(res, 400, status, state.deviceErrorMessage ?? status);
        return json(res, 200, { token: state.deviceToken ?? TOKEN, email: EMAIL });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/me') {
        if (!authenticate()) return;
        // publisher 是契约字段（设计「接口设计」）；dropPublisher 用于缺字段的 invalid_response 测试。
        return json(res, 200, { email: EMAIL, subscriptions: subscriptions(token), ...(state.dropPublisher ? {} : { publisher: state.publishers.has(token) }) });
      }
      if (req.method === 'POST' && url.pathname === '/api/cli/logout') {
        if (state.logoutFailure) return error(res, 503, 'unavailable', '模拟网络失败。');
        if (!authenticate()) return;
        state.revoked.add(token);
        return json(res, 200, { ok: true });
      }
      return error(res, 404, 'not_found', '未知接口。');
    } catch (err) { error(res, 500, 'fixture_error', err.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // 环境隔离：home/config 指向临时目录；语言固定默认中文（extraEnv 可覆盖）；CI 交互关闭。
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, APPDATA: config, CODEX_HOME: '',
    HY_LANG: '', LC_ALL: 'C', LC_MESSAGES: '', LANG: '', HY_API: base, HY_TOKEN: '', CI: '', HY_TEST_BROWSER: '',
    NODE_OPTIONS: nodeOptions, PATH: `${mockBin}${path.delimiter}${process.env.PATH || ''}`,
    ...(commandProcessor ? { ComSpec: commandProcessor, ...(process.platform === 'win32' ? { HY_TEST_BROWSER_EXE: commandProcessor } : {}) } : {}) };
  // Windows 的 env 键大小写不敏感，spawn 展开后可能同时出现 PATH/Path、ComSpec/comspec；只保留显式写入的这一份。
  for (const key of Object.keys(env)) if (key !== 'PATH' && key.toLowerCase() === 'path') delete env[key];
  for (const key of Object.keys(env)) if (key !== 'ComSpec' && key.toLowerCase() === 'comspec') delete env[key];
  const configFile = path.join(config, 'huanyu', 'config.json');
  let runNumber = 0;
  // 真 CLI 子进程会自己经 ComSpec 启动假浏览器，得先确保 node.exe 副本存在；driver 路径由 driver 惰性准备。
  const run = async (args, extraEnv = {}, runtime = {}) => {
    if (runtime.real && process.platform === 'win32') await ensureBrowserExecutable(commandProcessor);
    return await new Promise((resolve, reject) => {
      const traceFile = path.join(temporary, `trace-${runNumber++}.json`);
      const child = spawn(process.execPath, [runtime.real ? CLI : DRIVER, ...args], { cwd, env: { ...env, ...extraEnv, HY_TEST_RUNTIME: JSON.stringify(runtime), HY_TEST_TRACE: traceFile }, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        // 设备码显示后立即杀死进程，模拟 Agent 中断；待领取记录已先行落盘。
        if (runtime.killOnDevice && (stdout.includes('授权码：') || stdout.includes('"event":"device"'))) child.kill('SIGKILL');
      });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', async (code, signal) => {
        clearTimeout(timer);
        let trace = null;
        try { trace = JSON.parse(await readFile(traceFile, 'utf8')); } catch {}
        resolve({ code, signal, stdout, stderr, trace });
      });
    });
  };
  const close = async () => {
    await new Promise((resolve, reject) => { server.close((err) => err ? reject(err) : resolve()); server.closeAllConnections(); });
    await rm(temporary, { recursive: true, force: true });
  };
  t?.after(close);
  return { temporary, home, cwd, config, configFile, mockBin, env, base, state, run, close };
}
