import { run } from '../src/cli.js';
import { writeFile } from 'node:fs/promises';
import { confirm } from '../src/io.js';

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
  // 真实浏览器打开随登录命令（任务 3）接入；此前占位记录 URL 并返回未打开。
  openBrowser: async (url, timeoutMs) => {
    trace.browserUrls.push(url);
    trace.browserTimeouts.push(timeoutMs);
    if (options.browserDelay !== undefined) time += Math.min(options.browserDelay, timeoutMs);
    return false;
  },
  sleep: async (ms, unused, { signal }) => { if (signal.aborted) throw new Error('aborted'); trace.delays.push(ms); time += ms; },
  confirm: (question, yes, interactive, signal, defaultYes) => confirm(question, yes, interactive, signal, defaultYes, questioner),
  ask: questioner,
});
if (process.env.HY_TEST_TRACE) await writeFile(process.env.HY_TEST_TRACE, JSON.stringify(trace));
