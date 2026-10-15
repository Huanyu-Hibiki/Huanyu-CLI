import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../bin/hy.js', import.meta.url));
const DRIVER = fileURLToPath(new URL('./driver.js', import.meta.url));
export const TOKEN = 'hy_Abcd0123456789abcdefghijklmnopqrstuvXYZ';
export const EMAIL = 'test@example.com';

// 试点商品集（对齐设计「数据模型」）：ppt-design 免费版 + 付费配对预留（买断定价）；oracle-bone 纯免费。
// summaryEn 仅供假商店按 Accept-Language 切换文案，不作为字段下发。
export const CATALOG = [
  { id: 'ppt-design', name: 'PPT 设计', summary: '分步设计演示文稿的结构与版式。', summaryEn: 'Design presentation structure and layouts step by step.',
    free: { skill: 'ppt-design' }, paid: { skill: 'ppt-design-pro' }, offer: ['lifetime'], prices: { lifetime: { amount: 6900, currency: 'cny', interval: null } } },
  { id: 'oracle-bone', name: '甲骨文', summary: '识别与释读甲骨文字形。', summaryEn: 'Recognize and read oracle bone script.',
    free: { skill: 'oracle-bone' }, paid: null, offer: [], prices: {} },
];

// 假商店：绑定 127.0.0.1 随机端口，提供 catalog/versions 两端点（契约见设计「接口设计」）；
// 请求全部记入 state.requests，目录数据可直接改写用于错误注入。
export async function fixture(t) {
  let temporary = await mkdtemp(path.join(tmpdir(), 'hy-test-'));
  if (process.platform === 'win32') temporary = await realpath(temporary);
  const home = path.join(temporary, 'home'), cwd = path.join(temporary, 'project'), config = path.join(temporary, 'config'), mockBin = path.join(temporary, 'bin');
  // bin 为任务 3 的假浏览器 helper 预留；任务 2 尚不注入。
  for (const directory of [home, cwd, config, mockBin]) await mkdir(directory);
  const state = { catalog: structuredClone(CATALOG), catalogShape: 'products', latest: '0.1.0', badVersions: false, requests: [] };
  let base;
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const error = (res, status, code, message) => json(res, status, { error: code, message });
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, base);
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : null;
      const token = req.headers.authorization?.replace(/^Bearer /, '');
      const english = req.headers['accept-language'] === 'en';
      state.requests.push({ method: req.method, path: url.pathname, query: url.searchParams, token, body, headers: req.headers });
      if (req.method === 'GET' && url.pathname === '/api/store/catalog') {
        // 外层形状可切换：{products}（默认）/ 裸数组 / {catalog} / 无法识别，客户端前三种都要接受。
        const products = state.catalog.map(({ summaryEn, ...product }) => ({ ...product, summary: english ? summaryEn : product.summary }));
        if (state.catalogShape === 'array') return json(res, 200, products);
        if (state.catalogShape === 'catalog') return json(res, 200, { catalog: products });
        if (state.catalogShape === 'none') return json(res, 200, { weird: true });
        return json(res, 200, { products });
      }
      if (req.method === 'GET' && url.pathname === '/api/store/versions') {
        const history = ['0.1.0', '0.0.9'].map((version) => ({ version, published_at: '2026-10-15T08:00:00Z', notes: english ? `${version}: First pilot release.` : `${version}：首个试点版本。` }));
        const skills = {};
        for (const product of state.catalog) for (const type of ['free', 'paid']) {
          const name = typeof product[type] === 'string' ? product[type] : product[type]?.skill;
          if (name) skills[name] = { latest: state.badVersions ? 'oops' : state.latest, published_at: '2026-10-15T08:00:00Z', history };
        }
        return json(res, 200, { skills });
      }
      return error(res, 404, 'not_found', '未知接口。');
    } catch (err) { error(res, 500, 'fixture_error', err.message); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // 环境隔离：home/config 指向临时目录；语言固定默认中文（extraEnv 可覆盖）；CI 交互关闭。
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: config, APPDATA: config, CODEX_HOME: '',
    HY_LANG: '', LC_ALL: 'C', LC_MESSAGES: '', LANG: '', HY_API: base, HY_TOKEN: '', CI: '', NODE_OPTIONS: process.env.NODE_OPTIONS || '',
    PATH: process.env.PATH || '', ...(process.env.ComSpec ? { ComSpec: process.env.ComSpec } : {}) };
  // Windows 的 env 键大小写不敏感，spawn 展开后可能同时出现 PATH/Path、ComSpec/comspec；只保留显式写入的这一份。
  for (const key of Object.keys(env)) if (key !== 'PATH' && key.toLowerCase() === 'path') delete env[key];
  for (const key of Object.keys(env)) if (key !== 'ComSpec' && key.toLowerCase() === 'comspec') delete env[key];
  const configFile = path.join(config, 'huanyu', 'config.json');
  let runNumber = 0;
  const run = (args, extraEnv = {}, runtime = {}) => new Promise((resolve, reject) => {
    const traceFile = path.join(temporary, `trace-${runNumber++}.json`);
    const child = spawn(process.execPath, [runtime.real ? CLI : DRIVER, ...args], { cwd, env: { ...env, ...extraEnv, HY_TEST_RUNTIME: JSON.stringify(runtime), HY_TEST_TRACE: traceFile }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
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
  const close = async () => {
    await new Promise((resolve, reject) => { server.close((err) => err ? reject(err) : resolve()); server.closeAllConnections(); });
    await rm(temporary, { recursive: true, force: true });
  };
  t?.after(close);
  return { temporary, home, cwd, config, configFile, mockBin, env, base, state, run, close };
}
