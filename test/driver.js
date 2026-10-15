import { run } from '../src/cli.js';
import { writeFile } from 'node:fs/promises';
import { confirm } from '../src/io.js';
import { openBrowser } from '../src/browser.js';
import { ensureBrowserExecutable } from './fixture.js';

const options = JSON.parse(process.env.HY_TEST_RUNTIME || '{}');
let time = options.startTime ?? 0;
const trace = { delays: [], questions: [], browserUrls: [], browserTimeouts: [] };
const answers = [...(options.answers || [])];
const questioner = async (question) => {
  trace.questions.push(question);
  const answer = answers.shift();
  return answer === true ? 'yes' : answer === false ? 'no' : String(answer ?? '');
};
process.exitCode = await run(process.argv.slice(2), {
  terminal: options.terminal ?? options.interactive ?? false,
  interactive: options.interactive ?? false,
  now: () => time,
  // 无 browserDelay 时接真实 openBrowser：POSIX 走 PATH 里的假 open/xdg-open，Windows 走 ComSpec 劫持的假浏览器；
  // node.exe 副本在首次真正要打开浏览器前才惰性复制，不开浏览器的测试零成本。
  openBrowser: async (url, timeoutMs) => {
    trace.browserUrls.push(url);
    trace.browserTimeouts.push(timeoutMs);
    if (options.browserDelay === undefined) {
      if (process.env.HY_TEST_BROWSER_EXE && process.platform === 'win32') await ensureBrowserExecutable(process.env.HY_TEST_BROWSER_EXE);
      return await openBrowser(url, undefined, undefined, timeoutMs);
    }
    time += Math.min(options.browserDelay, timeoutMs);
    return false;
  },
  sleep: async (ms, unused, { signal }) => { if (signal.aborted) throw new Error('aborted'); trace.delays.push(ms); time += ms; },
  confirm: (question, yes, interactive, signal, defaultYes) => confirm(question, yes, interactive, signal, defaultYes, questioner),
  ask: questioner,
});
if (process.env.HY_TEST_TRACE) await writeFile(process.env.HY_TEST_TRACE, JSON.stringify(trace));
