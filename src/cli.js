import { t, withLanguage, resolveLanguage, command, helpLines, skillLabel, planLabel, priceLabel as formatPrice } from './i18n.js';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { Output, CliError, ask, canPrompt, confirm } from './io.js';
import { Client, catalogNames, isSkillName } from './client.js';

// 14 个命令全部在参数解析层合法；help/version/list 之外的执行逻辑随后续任务落地。
const COMMANDS = ['status', 'list', 'install', 'update', 'login', 'logout', 'subscribe', 'manage', 'help', 'version', 'publish', 'product', 'unpublish', 'audit'];

export function parseArgs(argv) {
  const options = { command: null, json: false, yes: false, to: [], token: null, plan: null, path: null, skill: null, lang: null };
  const positions = [];
  let version = false, helpFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--version') version = true;
    else if (['--help', '-h'].includes(arg)) helpFlag = true;
    else if (/^--(to|token|plan|path|lang)(=|$)/.test(arg)) {
      const flag = arg.split('=')[0], field = flag.slice(2);
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i];
      if (!value || value.startsWith('-')) throw new CliError(t('missingArgument', { flag }), 2, 'missing_argument');
      if (field === 'to') options.to.push(value);
      else {
        if (options[field] !== null) throw new CliError(t('duplicateArgument', { flag }), 2, 'usage');
        options[field] = value;
      }
    } else if (arg.startsWith('-')) throw new CliError(t('unknownArgument'), 2, 'usage');
    else positions.push(arg);
  }
  options.command = positions.shift() || 'status';
  if (version) {
    if (positions.length || options.command !== 'status' || options.to.length || options.token || options.plan || options.path || helpFlag || argv.includes('status')) throw new CliError(t('versionUsage'), 2, 'usage');
    options.command = 'version';
  } else if (helpFlag) { options.command = 'help'; positions.length = 0; }
  if (!COMMANDS.includes(options.command)) throw new CliError(t('unknownCommand'), 2, 'usage');
  if (['install', 'update', 'subscribe'].includes(options.command)) {
    options.skill = positions.shift() || null;
    if (!options.skill && options.command !== 'update') throw new CliError(t('missingSkill', { action: command(options.command) }), 2, 'missing_skill');
    if (options.skill && !isSkillName(options.skill)) throw new CliError(t('invalidSkill'), 2, 'usage');
  }
  if (positions.length || (options.to.length && options.command !== 'install') || (options.token !== null && options.command !== 'login') || (options.plan !== null && options.command !== 'subscribe') || (options.path !== null && options.command !== 'update')) throw new CliError(t('wrongArgument'), 2, 'usage');
  return options;
}

function priceLabel(prices) {
  return Object.entries(prices).map(([plan, price]) => t('pricePlan', { price: formatPrice(price), plan: planLabel(plan) })).join('; ') || t('priceUnavailable');
}

// list 展示目录里每个商品的免费/付费 Skill：名称、类型、价格与摘要。
async function list(ctx) {
  const skills = ctx.catalog.flatMap((product) => ['free', 'paid'].filter((type) => product[type]).map((type) => ({
    skill: product[type].skill, name: product.name, summary: product.summary || '', type, prices: type === 'paid' ? product.prices : {}, page: ctx.client.subscriptionUrl(product[type].skill, product),
  })));
  ctx.output.write({ skills }, skills.length ? skills.map((s) => t('catalogLine', { name: skillLabel(s.skill), type: s.type === 'free' ? t('free') : t('paid', { price: priceLabel(s.prices) }), summary: s.summary ? t('summary', { summary: s.summary }) : '' })) : [t('emptyCatalog')]);
  return 0;
}

// runtime 用于测试时注入时钟和终端交互；可执行入口不传测试选项。
export const run = (argv, runtime = {}) => withLanguage(resolveLanguage(argv), () => runCommand(argv, runtime));

async function runCommand(argv, runtime) {
  const tokenValues = argv.flatMap((arg, i) => arg === '--token' ? [argv[i + 1]] : arg.startsWith('--token=') ? [arg.slice(8)] : []);
  const output = new Output(argv.includes('--json'), 'unknown', [process.env.HY_TOKEN, ...tokenValues]);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const options = parseArgs(argv);
    output.command = options.command;
    if (options.command === 'help') { const help = helpLines(); output.write({ usage: help }, help); return 0; }
    if (options.command === 'version') {
      const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
      output.write({ version }, [`hy ${version}`]); return 0;
    }
    // ctx 是后续命令（登录、安装、发布等）的依赖注入位；任务 1 先立骨架。
    const ctx = { options, output, token: null,
      interactive: runtime.interactive ?? canPrompt(options.json),
      terminal: runtime.terminal ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
      nextCommand: command(...argv), signal: controller.signal,
      client: new Client(controller.signal),
      // 真实 openBrowser 随登录命令（任务 3）引入；此前占位为不打开。
      openBrowser: runtime.openBrowser || (async () => false),
      sleep: runtime.sleep || delay, now: runtime.now || Date.now,
      confirm: runtime.confirm || confirm, ask: runtime.ask || ask };
    if (options.command === 'list') {
      // catalog 拉取一次并缓存进 ctx；status/install/update 等后续命令复用。
      ctx.catalog = await ctx.client.catalog();
      ctx.names = catalogNames(ctx.catalog);
      return await list(ctx);
    }
    throw new CliError(t('notImplemented', { name: options.command }), 2, 'not_implemented');
  } catch (error) {
    if (controller.signal.aborted) return output.fail(new CliError(t('canceled'), 1, 'cancelled'));
    return output.fail(error);
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
