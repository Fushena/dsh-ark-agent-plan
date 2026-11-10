import assert from 'node:assert/strict';

/**
 * 额度退避回归脚本（#5）：退避窗口内的重复调用不得把退避自我放大。
 *
 * 修前行为：面板约 30 秒轮询一次，每次命中退避窗口都会走 #fail →
 * #failures++ 且 nextAttemptAt 继续翻倍（60s→120s→240s…），几次轮询就顶到
 * 30 分钟上限，等于「越查越退不了」。
 *
 * 判定方式：冻结时钟，在退避窗口内连续轮询 10 次，然后把时钟只推进到
 * 「首次失败后 61 秒」——修后应立刻恢复一次真实重试；修前退避已被轮询推到
 * 30 分钟上限，同一时刻仍然不会发起请求。
 *
 * 跑法（插件仓库根目录）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     --import ./test/runtime.mjs ./test/quota.test.mjs
 */

const { ArkQuota } = await import('../lib/quota.js');
const { loadStoredCookie } = await import('../lib/quota.js');

// 只用「纯 Node 取数」路径（不碰浏览器）：本机若没有已保存的控制台凭据，
// 首次刷新会直接以「尚未保存控制台凭据」失败 —— 那种情况下根本不发请求，
// 测不出退避语义。所以这里先确认凭据存在，不存在就跳过（不伪造用户状态）。
if (!loadStoredCookie()) {
  console.log('quota.test.mjs: 跳过（本机没有已保存的控制台 Cookie，无法驱动纯 Node 取数路径）');
  process.exit(0);
}

const realNow = Date.now;
let fakeNow = realNow;
Date.now = () => fakeNow;

try {
  let requests = 0;
  const quota = new ArkQuota({
    logger: { info() {}, warn() {}, debug() {} },
    ttlMs: 60_000,
    // 注入 fetch：稳定失败但**不是** COOKIE_EXPIRED，避免走进浏览器收割分支。
    fetchImpl: async () => {
      requests += 1;
      throw new Error('network down');
    },
  });

  // 首次失败 → 进入退避（1 分钟）。
  const first = await quota.refresh({ force: true });
  assert.equal(first.ok, false, '首次失败应返回 ok:false');
  const requestsAfterFirst = requests;
  assert.ok(requestsAfterFirst >= 1, '首次失败应真的尝试过一次取数');

  // 时钟冻结在窗口内，模拟面板 30 秒轮询 × 10 次（现实中这些轮询都在退避窗口内）。
  for (let i = 0; i < 10; i += 1) {
    const result = await quota.refresh({ force: true });
    assert.equal(result.ok, false, '退避窗口内应继续返回失败');
  }
  assert.equal(requests, requestsAfterFirst, '退避窗口内不得发起任何真实请求');

  // 关键回归断言：只推进到「首次失败后 61 秒」，应恢复一次真实重试。
  // 修前：这 10 次轮询已把退避推到 30 分钟上限，61 秒时仍不会发请求 → 此断言失败。
  fakeNow = realNow + 61_000;
  const afterWindow = await quota.refresh({ force: true });
  assert.equal(requests, requestsAfterFirst + 1, '首次退避窗口结束后应恢复一次真实重试（修前会被轮询推到 30 分钟上限）');
  assert.equal(afterWindow.ok, false, '网关仍不可用时应继续返回失败');

  console.log('quota.test.mjs: 全部断言通过（#5 退避不会被轮询放大）');
} finally {
  Date.now = realNow;
}
