import assert from 'node:assert/strict';

/**
 * requestDeadline 的空闲超时语义回归脚本。
 *
 * 为什么单独立一个文件：2026-11-10 把「请求超时」的生命周期从「只覆盖到响应头」
 * 延后到「覆盖整个流」之后，立刻炸出一个回归 —— 那个定时器从**请求发起**就开始
 * 倒数，模型正常流式输出超过 60 秒（写长代码、长回答）就会被 abort，用户看到
 * 「回答说到一半断了」。超时表达的是「多久没动静才算卡死」，不是「一次请求最多
 * 花多久」，所以必须在收到每个 chunk 时 touch() 重置。
 * 这个脚本把该语义钉死，防止以后又被改回总时长超时。
 *
 * 跑法（插件仓库根目录）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     --import ./test/runtime.mjs ./test/timeout.test.mjs
 */

const { requestDeadline } = await import('../lib/timeout.js');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A. 持续有数据（每 150ms touch 一次，总时长超过阈值 3 倍）不应超时。
{
  const deadline = requestDeadline(undefined, 400);
  for (let i = 0; i < 8; i += 1) {
    await sleep(150);
    deadline.touch();
  }
  assert.equal(deadline.timedOut(), false, '持续有数据时不能被空闲超时掐断（总时长 1.2s > 阈值 400ms）');
  deadline.dispose();
}

// B. 有进展后停手 → 阈值到点触发。
{
  const deadline = requestDeadline(undefined, 400);
  deadline.touch();
  await sleep(600);
  assert.equal(deadline.timedOut(), true, '空闲超过阈值后必须触发超时');
  deadline.dispose();
}

// C. 外部取消信号透传。
{
  const external = new AbortController();
  const deadline = requestDeadline(external.signal, 5_000);
  external.abort();
  assert.equal(deadline.signal.aborted, true, '外部取消必须透传到组合信号');
  deadline.dispose();
}

// D. dispose 之后不再触发（不留下悬挂定时器）。
{
  const deadline = requestDeadline(undefined, 300);
  deadline.dispose();
  await sleep(400);
  assert.equal(deadline.timedOut(), false, 'dispose 后不得再触发');
}

// E. 非正超时表示不设限。
{
  const deadline = requestDeadline(undefined, 0);
  await sleep(300);
  assert.equal(deadline.timedOut(), false, '非正超时值表示不设超时');
  deadline.dispose();
}

// F. 已触发之后 touch 不能复活。
{
  const deadline = requestDeadline(undefined, 200);
  await sleep(300);
  deadline.touch();
  assert.equal(deadline.timedOut(), true, '已触发的超时不能被 touch 复活');
  deadline.dispose();
}

console.log('timeout.test.mjs: 全部断言通过（空闲超时语义 6 项）');
