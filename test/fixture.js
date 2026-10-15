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

// 进程内直连组件的单元测试用：把 os.tmpdir 指到本测试私有目录（TMPDIR/TEMP/TMP 三通道覆盖
// POSIX 与 Windows 的解析顺序），临时目录残留断言不再与并行测试文件共享系统 tmpdir 竞态。
export async function withPrivateTmp(fn) {
  const scratch = await mkdtemp(path.join(tmpdir(), 'hy-unit-'));
  const names = ['TMPDIR', 'TEMP', 'TMP'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) process.env[name] = scratch;
  try { return await fn(); } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

// 假商店：绑定 127.0.0.1 随机端口，提供 catalog/versions/publish/releases 与 device/token/me/logout/approve 端点（契约见设计「接口设计」）；
// 请求全部记入 state.requests，目录与设备流数据可直接改写用于错误注入。
export async function fixture(t) {
  let temporary = await mkdtemp(path.join(tmpdir(), 'hy-test-'));
  // macOS 的 /var 是 /private/var 的别名、Windows 有 8.3 短路径：一律 realpath，
  // 让 f.* 派生路径与产品内部的 canonical 解析一致（否则期望值与 real_path 断言会差一个别名前缀）。
  temporary = await realpath(temporary);
  const home = path.join(temporary, 'home'), cwd = path.join(temporary, 'project'), config = path.join(temporary, 'config'), mockBin = path.join(temporary, 'bin'),
    // 子进程私有 tmpdir：全部 CLI/驱动子进程的下载/打包临时目录都落在 fixture 自己的地盘，
    // 残留断言扫描这里即可，根除并行测试文件共享系统 tmpdir 的竞态（二期任务 3 审查 MAJOR）。
    tmp = path.join(temporary, 'tmp');
  for (const directory of [home, cwd, config, mockBin, tmp]) await mkdir(directory);
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
    // 管理门户（二期任务 3）：portalUrl 注入门户响应 URL（null 走默认 /account/；空串模拟缺字段）；
    // subscriptionStatus 覆盖订阅状态、rawSubscriptions 整体替换订阅列表（条目形状残缺的正反例）。
    portalUrl: null, subscriptionStatus: null, rawSubscriptions: null,
    // 付款会话（二期任务 4）：sessions 按 id 存 {token, skill, plan, amount, currency, status, paid}；
    // checkoutActiveAfter=N 让 me 轮询第 N 次自动视为“用户已付款”（假浏览器无需真实动作——template
    // 同款语义：轮询到点即解锁）；checkoutStatusActiveAfter 同理作用于 status 端点（默认永不）；
    // checkoutPrices 按语言（zh/en）/checkoutPrice 单值覆盖价格（币种核对注入）；checkoutNotice 转告；
    // checkoutAlreadyActive 注入 409；meSubscriptions 整体替换 me 订阅列表（语义注入，与 rawSubscriptions
    // 的形状注入互补）；checkoutStatusErrors/checkoutPollErrors 按序注入 5xx；fulfillmentPending 让
    // status 已付但履约不生效（processing 态）；checkoutUrl/checkoutResponse/checkoutStatusResponse
    // 覆盖会话 URL/整包响应（形状校验负例）。
    checkoutPolls: 0, checkoutRequests: 0, checkoutCreated: 0, checkoutActiveAfter: 2, checkoutStatusPolls: 0,
    checkoutStatusActiveAfter: Infinity, sessions: new Map(), checkoutPrices: null, checkoutPrice: null,
    checkoutNotice: null, checkoutAlreadyActive: false, checkoutStatusErrors: null, checkoutPollErrors: null,
    checkoutToken: null, checkoutSkill: null, meSubscriptions: null, checkoutUrl: null,
    checkoutResponse: null, checkoutStatusResponse: null, fulfillmentPending: false,
    // 发布端（任务 4）：publishers 为有发布角色的令牌集合（TOKEN 默认在内，TOKEN2 需 grants 注册后仍不在）；
    // published 按 `name:version` 存 {body, sha256, size, notes, published_at}；publishStatus 强制注入错误；dropPublisher 让 me 缺字段。
    publishers: new Set([TOKEN]), published: new Map(), publishStatus: null, dropPublisher: false,
    // 管理端（二期任务 2）：yanked 按 `name:version` 记下架标记（history 保留 + latest 回落，假设 #4）；
    // productStatus/unpublishStatus 对 PUT products / DELETE releases 注入 400/403/404（数字持续、数组按序消耗）。
    yanked: new Set(), productStatus: null, unpublishStatus: null,
    // 下载端（任务 6）：releases 为免费默认发布物（每 fixture 浅拷贝一层 Map，防跨用例可变共享）；
    // dropChecksum 让 versions 省略摘要（fail-closed 测试）、badChecksum 让 versions 下发错误摘要、
    // corruptBody 让 /releases 截断正文（客户端读到不完整流）、releaseDelay 压住发布物响应模拟慢下载、
    // versionsDelay 压住版本表响应（构造 scan 之后、下载之前的目标变动窗口，update 预检测试用）。
    releases: new Map(await defaultReleases()), dropChecksum: false, badChecksum: false, corruptBody: false, releaseDelay: 0, versionsDelay: 0,
    // 付费下载（二期任务 3）：badDownloadVersion 让下载端点回错误的 X-Skill-Version（头校验正例）；
    // badDownloadChecksum 回错误的 X-Content-SHA256、dropDownloadChecksum 省略该头（摘要负例）。
    // downloadInactiveCount（二期任务 5）：前 N 次付费下载先清空授权再判权——模拟「me 已列但
    // 服务端扣款/履约竞态未生效」的 402 窗口（install/update 的内联购买重试路径，template 同款）。
    badDownloadVersion: false, badDownloadChecksum: false, dropDownloadChecksum: false, downloadInactiveCount: 0 };
  let base;
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const error = (res, status, code, message) => json(res, status, { error: code, message });
  // 登录账号的订阅列表按 grants 生成；默认把目录里的全部付费 Skill 授予 TOKEN。
  // subscriptionStatus 覆盖生成的状态（默认按方案给 lifetime/active），供权益判定的正反例注入。
  const subscriptions = (token) => {
    const names = state.grants.get(token) || (token === TOKEN ? state.catalog.flatMap((p) => p.paid ? [p.paid.skill] : []) : []);
    return names.map((skill) => {
      const product = state.catalog.find((p) => p.paid?.skill === skill);
      const plan = product?.offer?.[0] || 'lifetime';
      return { skill, name: product?.name || skill, plan, status: state.subscriptionStatus || (plan === 'lifetime' ? 'lifetime' : 'active'), renews: plan === 'lifetime' ? null : 1793664000, ends: null };
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
        const products = state.catalog.map(({ summaryEn, ...product }) => ({ ...product, summary: english ? summaryEn ?? product.summary : product.summary }));
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
        const baseHistory = (state.history || ['0.1.0', '0.0.9']).map((item) => {
          const { version, notes } = entry(item);
          return { version, published_at: '2026-10-15T08:00:00Z', notes: notes ?? (english ? `${version}: First pilot release.` : `${version}：首个试点版本。`) };
        });
        // yank 标记按 skill 分别落到 history 条目上（假设 #4：history 保留 + yanked 标记）。
        const markYanked = (name, items) => items.map((item) => state.yanked.has(`${name}:${item.version}`) ? { ...item, yanked: true } : item);
        const skills = {};
        for (const product of state.catalog) for (const type of ['free', 'paid']) {
          const name = typeof product[type] === 'string' ? product[type] : product[type]?.skill;
          if (!name) continue;
          // 免费默认发布物：latest 对上种子版本时下发 download_url + sha256（设计「数据模型」：免费版摘要必填）。
          const seed = state.releases.get(`${name}:${state.latest}`);
          const checksum = seed ? (state.dropChecksum ? null : state.badChecksum ? '0'.repeat(64) : seed.sha256) : null;
          skills[name] = { latest: state.badVersions ? 'oops' : state.latest, published_at: '2026-10-15T08:00:00Z', history: markYanked(name, baseHistory),
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
          skills[name] = { latest, published_at: entry.published_at, history: markYanked(name, merged),
            download_url: `${base}/releases/${name}-${latest}.tar.gz`, ...(checksum ? { sha256: checksum } : {}) };
        }
        // yank 回落（假设 #4）：有下架记录的 skill，latest 取候选（默认 latest + 已发布版本）中最高的
        // 未下架版本；全部下架时保留最高版本占位（下载端 404 挡住新安装），版本表形状保持完整。
        for (const name of Object.keys(skills)) {
          if (![...state.yanked].some((key) => key.startsWith(`${name}:`))) continue;
          const candidates = [...new Set([state.latest, ...[...state.published.keys()].filter((key) => key.startsWith(`${name}:`)).map((key) => key.split(':')[1])])];
          const standing = candidates.filter((version) => !state.yanked.has(`${name}:${version}`));
          const latest = (standing.length ? standing : candidates).sort(compareVersions).at(-1);
          const top = state.published.get(`${name}:${latest}`);
          const seed = state.releases.get(`${name}:${latest}`);
          const checksum = top ? top.sha256 : seed ? (state.dropChecksum ? null : state.badChecksum ? '0'.repeat(64) : seed.sha256) : null;
          skills[name] = { ...skills[name], latest, download_url: `${base}/releases/${name}-${latest}.tar.gz`, ...(checksum ? { sha256: checksum } : {}) };
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
      // 商品注册/更新（二期任务 2，设计「接口设计·发布端」）：与版本发布解耦——合法规范名可直接注册
      // （客户端对未知名预检引导，服务端保持 upsert）；字段白名单 = 发布者可编辑面，非法 400 invalid_field。
      if (req.method === 'PUT' && url.pathname.startsWith('/api/store/products/')) {
        if (!authenticate()) return;
        const injected = Array.isArray(state.productStatus) ? state.productStatus.shift() : state.productStatus;
        const injectedError = injected ? { 400: 'invalid_field', 403: 'not_a_publisher', 404: 'not_found' }[injected] : null;
        if (injectedError) return error(res, injected, injectedError, '注入的商品更新失败。');
        if (!state.publishers.has(token)) return error(res, 403, 'not_a_publisher', '没有发布权限。');
        const name = decodeURIComponent(url.pathname.slice('/api/store/products/'.length));
        const fields = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
        const fieldError = (message) => error(res, 400, 'invalid_field', message);
        if (!fields || !/^[a-z0-9][a-z0-9-]*$/.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return fieldError('Skill 名无效。');
        const priceShape = (price) => price && typeof price === 'object' && !Array.isArray(price)
          && Number.isSafeInteger(price.amount) && price.amount > 0
          && typeof price.currency === 'string' && /^[a-z]{3}$/i.test(price.currency);
        for (const [key, value] of Object.entries(fields)) {
          if (key === 'summary' || key === 'name') {
            if (typeof value !== 'string' || !value.trim() || value.length > 500) return fieldError(`${key} 无效。`);
          } else if (key === 'prices') {
            if (!value || typeof value !== 'object' || Array.isArray(value)
              || !Object.entries(value).every(([plan, price]) => /^[a-z][a-z0-9_-]*$/.test(plan) && priceShape(price))) return fieldError('prices 无效。');
          } else if (key === 'free' || key === 'paid') {
            if (!/^[a-z0-9][a-z0-9-]*$/.test(String(value)) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(String(value))) return fieldError(`${key} 无效。`);
          } else return fieldError(`未知字段 ${key}。`);
        }
        // upsert：id/free/paid 任一命中即更新，否则以该规范名注册新商品（free 缺省指向自身）。
        const product = state.catalog.find((item) => item.id === name || item.free?.skill === name || item.paid?.skill === name)
          ?? { id: name, name, summary: '', free: { skill: name }, paid: null, offer: [], prices: {} };
        const next = { ...product,
          ...(fields.name !== undefined ? { name: fields.name } : {}),
          ...(fields.summary !== undefined ? { summary: fields.summary, summaryEn: undefined } : {}),
          ...(fields.free !== undefined ? { free: { skill: fields.free } } : {}),
          ...(fields.paid !== undefined ? { paid: { skill: fields.paid } } : {}),
          ...(fields.prices !== undefined ? { prices: { ...product.prices, ...fields.prices } } : {}) };
        next.offer = Object.keys(next.prices);
        if (next.free && next.paid && next.free.skill === next.paid.skill) return fieldError('free 与 paid 不能相同。');
        if (!next.free && !next.paid) return fieldError('商品缺少 free/paid。');
        // 目录的 skill 名全局唯一是客户端 normalizeCatalog 的契约：配对值不得与其他商品冲突。
        for (const skillName of [next.free?.skill, next.paid?.skill]) {
          if (skillName && state.catalog.some((item) => item !== product && [item.id, item.free?.skill, item.paid?.skill].includes(skillName))) return fieldError(`${skillName} 已属于其他商品。`);
        }
        const index = state.catalog.indexOf(product);
        if (index === -1) state.catalog.push(next);
        else state.catalog[index] = next;
        const { summaryEn, ...clean } = next;
        return json(res, 200, clean);
      }
      // 版本下架（二期任务 2）：yank 幂等（重复下架仍 200）；history 保留 + latest 回落由 versions 端点体现。
      if (req.method === 'DELETE' && url.pathname.startsWith('/api/store/releases/')) {
        if (!authenticate()) return;
        const injected = Array.isArray(state.unpublishStatus) ? state.unpublishStatus.shift() : state.unpublishStatus;
        const injectedError = injected ? { 400: 'invalid_field', 403: 'not_a_publisher', 404: 'not_found' }[injected] : null;
        if (injectedError) return error(res, injected, injectedError, '注入的下架失败。');
        if (!state.publishers.has(token)) return error(res, 403, 'not_a_publisher', '没有发布权限。');
        const [name, version] = url.pathname.slice('/api/store/releases/'.length).split('/').map(decodeURIComponent);
        const key = `${name}:${version}`;
        if (!state.published.has(key) && !state.releases.has(key)) return error(res, 404, 'not_found', '没有该版本。');
        state.yanked.add(key);
        return json(res, 200, { skill: name, version, yanked: true });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/store/download/')) {
        // 下载端（契约：免费 302→公开附件不带令牌；付费 200 + X-Content-SHA256 + X-Skill-Version 走订阅鉴权）。
        // 一期客户端对付费前置拦截不会走到这里，端点先备齐供任务 7/二期。
        const name = decodeURIComponent(url.pathname.slice('/api/store/download/'.length));
        const version = url.searchParams.get('version');
        const product = state.catalog.find((p) => [p.free?.skill, p.paid?.skill].includes(name));
        const entry = state.releases.get(`${name}:${version}`) || state.published.get(`${name}:${version}`);
        if (!product || !entry || url.searchParams.get('format') !== 'tar.gz') return error(res, 404, 'not_found', '没有该版本。');
        // 已下架版本新安装不可达（yank 语义）：已装用户不经过这里，本地不受影响。
        if (state.yanked.has(`${name}:${version}`)) return error(res, 404, 'not_found', '该版本已下架。');
        if (product.paid?.skill === name) {
          if (!authenticate()) return;
          // 402 竞态注入：授权被清空后按订阅判定，本次下载返回 402（购买后重试即恢复）。
          if (state.downloadInactiveCount > 0) { state.downloadInactiveCount--; state.grants.set(token, []); }
          if (!subscriptions(token).some((subscription) => subscription.skill === name)) return error(res, 402, 'inactive', '尚未购买。');
          // X-Skill-Version 声明所发内容的版本：badDownloadVersion 注入不匹配值（客户端头校验正例）。
          // X-Content-SHA256 是付费信道的摘要权威：badDownloadChecksum 注入错误值、dropDownloadChecksum 省略头。
          res.writeHead(200, {
            'Content-Type': 'application/gzip',
            ...(state.dropDownloadChecksum ? {} : { 'X-Content-SHA256': state.badDownloadChecksum ? '0'.repeat(64) : entry.sha256 }),
            'X-Skill-Version': state.badDownloadVersion ? '9.9.9' : version,
          });
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
        // 已下架版本新安装不可达（yank 语义），公开附件同样拒绝。
        if (state.yanked.has(`${name}:${match[2]}`)) return error(res, 404, 'not_found', '该版本已下架。');
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
        // 付款轮询注入位：checkoutToken 匹配时第 N 次 me 视为用户已付款（grant 解锁）；
        // checkoutPollErrors 按序注入 5xx（轮询容错测试，计数照常推进）。
        if (state.checkoutToken === token) {
          state.checkoutPolls++;
          const pollError = state.checkoutPollErrors?.[state.checkoutPolls - 1];
          if (pollError) return error(res, 502, 'upstream', '服务连接失败');
          if (state.checkoutPolls >= state.checkoutActiveAfter) state.grants.set(token, [state.checkoutSkill]);
        }
        // publisher 是契约字段（设计「接口设计」）；dropPublisher 用于缺字段的 invalid_response 测试；
        // rawSubscriptions 整体替换订阅列表（security-L2 条目形状残缺的负例注入），
        // meSubscriptions 为任务 4 的语义注入（如 409 后 me 仍未列出授权）。
        return json(res, 200, { email: EMAIL, subscriptions: state.rawSubscriptions ?? state.meSubscriptions ?? subscriptions(token), ...(state.dropPublisher ? {} : { publisher: state.publishers.has(token) }) });
      }
      // 付款会话创建（二期任务 4，契约：POST 🔒 → { id, url, reused, amount, currency, notice? }）。
      // 复用语义：同令牌同 skill 同方案同币种的 open 会话原样返回（reused:true，不换付款页）；
      // 同令牌已有已付会话 → 409 already_active（履约完成）；注入位 checkoutAlreadyActive 强制 409。
      if (req.method === 'POST' && url.pathname === '/api/store/checkout') {
        if (!authenticate()) return;
        state.checkoutRequests++;
        if (state.checkoutAlreadyActive) {
          state.grants.set(token, [body.skill]);
          return error(res, 409, 'already_active', '已经解锁。');
        }
        state.checkoutToken = token;
        state.checkoutSkill = body.skill;
        const plan = body.plan || state.catalog.find((p) => p.paid?.skill === body.skill)?.offer?.[0] || 'lifetime';
        const price = state.checkoutPrices?.[body.lang || (english ? 'en' : 'zh')] || state.checkoutPrice || state.catalog.find((p) => p.paid?.skill === body.skill)?.prices[plan];
        const own = [...state.sessions.values()].filter((s) => s.token === token && s.skill === body.skill);
        if (own.some((s) => s.paid)) {
          state.grants.set(token, [...new Set([...(state.grants.get(token) || []), body.skill])]);
          for (const s of own) if (s.status === 'open' && !s.paid) s.status = 'expired';
          return error(res, 409, 'already_active', english ? 'Already purchased.' : '已经解锁。');
        }
        const reused = own.find((s) => s.status === 'open' && s.plan === plan && s.currency === price?.currency);
        const notice = state.checkoutNotice ? { notice: state.checkoutNotice } : {};
        if (reused) return json(res, 200, { id: reused.id, url: reused.url, reused: true, amount: reused.amount, currency: reused.currency, ...notice });
        state.checkoutPolls = 0;
        const id = `cs_test_${++state.checkoutCreated}`;
        const session = { id, url: state.checkoutUrl ?? `${base}/checkout?session=${state.checkoutCreated}`, token, skill: body.skill, plan, amount: price?.amount, currency: price?.currency, status: 'open', paid: false };
        state.sessions.set(id, session);
        return json(res, 200, state.checkoutResponse ?? { id, url: session.url, reused: false, amount: session.amount, currency: session.currency, ...notice });
      }
      // 付款会话状态（契约：GET 🔒 ?id= → { status, paid, entitled }）：会话归属校验（404/403）；
      // checkoutStatusActiveAfter=N 时第 N 次查询视为付款完成；fulfillmentPending 让已付但不履约
      // （paid:true + entitled:false 的 processing 态）；正常履约同时解锁并过期同令牌同 skill 的其他
      // open 会话（避免旧会话被恢复逻辑误判为可复用）。
      if (req.method === 'GET' && url.pathname === '/api/store/checkout/status') {
        if (!authenticate()) return;
        const session = state.sessions.get(url.searchParams.get('id'));
        if (!session) return error(res, 404, 'not_found', english ? 'Session not found.' : '没有这个会话。');
        if (session.token !== token) return error(res, 403, 'access_denied', english ? 'Access denied.' : '无权查询。');
        state.checkoutStatusPolls++;
        if (state.checkoutStatusErrors?.[state.checkoutStatusPolls - 1]) return error(res, 502, 'upstream', english ? 'Service unavailable.' : '服务连接失败');
        if (state.checkoutStatusPolls >= state.checkoutStatusActiveAfter && session.status === 'open') { session.paid = true; session.status = 'complete'; }
        if (session.paid && !state.fulfillmentPending) {
          state.grants.set(token, [...new Set([...(state.grants.get(token) || []), session.skill])]);
          for (const other of state.sessions.values()) if (other.id !== session.id && other.token === token && other.skill === session.skill && other.status === 'open') other.status = 'expired';
        }
        return json(res, 200, state.checkoutStatusResponse ?? { status: session.status, paid: session.paid, entitled: subscriptions(token).some((s) => s.skill === session.skill) });
      }
      // 账号管理门户（二期任务 3，契约：POST 🔒 → { url }）：portalUrl 注入响应 URL（空串模拟缺字段）。
      if (req.method === 'POST' && url.pathname === '/api/account/portal') {
        if (!authenticate()) return;
        return json(res, 200, { url: state.portalUrl ?? `${base}/account/` });
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
  // TMPDIR/TEMP/TMP 三通道把子进程的 os.tmpdir() 指到 fixture 私有目录（下载/打包临时目录
  // 全部落在那里，不再与并行测试文件共享系统 tmpdir 竞态）。
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, APPDATA: config, CODEX_HOME: '',
    HY_LANG: '', LC_ALL: 'C', LC_MESSAGES: '', LANG: '', HY_API: base, HY_TOKEN: '', CI: '', HY_TEST_BROWSER: '',
    NODE_OPTIONS: nodeOptions, PATH: `${mockBin}${path.delimiter}${process.env.PATH || ''}`,
    TMPDIR: tmp, TEMP: tmp, TMP: tmp,
    ...(commandProcessor ? { ComSpec: commandProcessor, ...(process.platform === 'win32' ? { HY_TEST_BROWSER_EXE: commandProcessor } : {}) } : {}) };
  // Windows 的 env 键大小写不敏感，spawn 展开后可能同时出现 PATH/Path、ComSpec/comspec、TEMP/temp；
  // 每组只保留显式写入的这一份，否则子进程读到的 tmpdir 取决于展开顺序。
  for (const [canonical, lower] of [['PATH', 'path'], ['ComSpec', 'comspec'], ['TMPDIR', 'tmpdir'], ['TEMP', 'temp'], ['TMP', 'tmp']]) {
    for (const key of Object.keys(env)) if (key !== canonical && key.toLowerCase() === lower) delete env[key];
  }
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
        // 付款页显示后立即杀死进程，模拟 Agent 中断；付款会话已先行落盘（任务 4 恢复语义）。
        if (runtime.killOnCheckout && (stdout.includes('付款页面：') || stdout.includes('"event":"checkout"'))) child.kill('SIGKILL');
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
  return { temporary, home, cwd, config, configFile, mockBin, tmp, env, base, state, run, close };
}
