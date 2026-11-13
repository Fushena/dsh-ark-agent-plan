import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * ark-agent-plan 回归测试入口（与 dsh-qwen-token-plan-full 的 test/run.mjs 同构）。
 *
 * 全部用例都不访问网络、不读取个人凭据，用注入式 fetch / 受控时钟驱动：
 *   sse.test.mjs     —— #1 未闭合块与终止事件、#3 内置工具活动项去重
 *   stream.test.mjs  —— 真实 SSE 服务器上的长流/卡死/取消（超时必须真的中止读取）
 *   timeout.test.mjs —— 空闲超时语义（防「长回答被总时长掐断」回归）
 *   catalog.test.mjs —— #2 探测状态三态、#7 初始快照应用 excludes/overrides
 *   quota.test.mjs   —— #5 退避不会被面板轮询放大
 *   client-badge.test.mjs —— 徽标示数固定取近 5 小时窗口（不是三窗口最高）
 *   proxy.test.mjs   —— 代理 undici 候选不得含 cwd（RCE 回归）+ home 兜底跨平台
 *   browser-discipline.test.mjs —— 浏览器只从手动入口开（2026-11-13 弹窗纪律）
 *
 * 每个用例单独起一个进程：`node a.mjs b.mjs` 只把 a.mjs 当作入口模块，
 * b.mjs 只会成为 argv —— 这是 Node 的语义，不是「跑两个文件」。
 *
 * 跑法：node test/run.mjs
 * （优先用本机 DeepSeek Harness 内置运行时；可用 DSH_TEST_NODE 覆盖）
 */
const electron = process.env.DSH_TEST_NODE ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const executable = existsSync(electron) ? electron : process.execPath;
const runtime = fileURLToPath(new URL('./runtime.mjs', import.meta.url));
const tests = ['sse.test.mjs', 'stream.test.mjs', 'timeout.test.mjs', 'catalog.test.mjs', 'quota.test.mjs', 'client-badge.test.mjs', 'proxy.test.mjs', 'browser-discipline.test.mjs']
  .map((name) => fileURLToPath(new URL(name, import.meta.url)));

let failed = 0;
for (const test of tests) {
  const result = spawnSync(executable, ['--import', runtime, test], {
    stdio: 'inherit',
    env: { ...process.env, ...(executable === process.execPath ? {} : { ELECTRON_RUN_AS_NODE: '1' }) },
  });
  if (result.error) console.error(result.error.message);
  if ((result.status ?? 1) !== 0) failed += 1;
}
if (failed > 0) {
  console.error(`\n${failed} 个测试文件失败`);
  process.exitCode = 1;
} else {
  console.log(`\n${tests.length} 个测试文件全部通过`);
}
