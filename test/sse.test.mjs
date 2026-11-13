import assert from 'node:assert/strict';

/**
 * 最小回归脚本：只覆盖两个「用真实解析器/真实目录类就能复现」的高价值缺陷
 * （1 = response.incomplete 被 STREAM_CLOSED 抢先；3 = 无 id 的内置工具活动
 *  项被重复计数）。两类都不需要网络与真实凭据，可在 CI/本地任意跑。
 *
 * 跑法（插件仓库根目录）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     --import ./test/runtime.mjs ./test/sse.test.mjs
 * （原理见 test/runtime.mjs：把 @deepseek-ai/* 解析到 DSH 运行时）
 */

const { responsesToDshChunks } = await import('../lib/responses-sse.js');

/** 把事件数组拼成 Ark 的 SSE 字节流（event: + data:，双换行分隔）。 */
function sseBody(events) {
  const text = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); },
  });
}

async function collect(events, options = {}, onHarnessUse = undefined) {
  const chunks = [];
  for await (const chunk of responsesToDshChunks(sseBody(events), undefined, onHarnessUse, options)) chunks.push(chunk);
  return chunks;
}

const finishOf = (chunks) => chunks.find((chunk) => chunk.type === 'finish')?.reason;
const textOf = (chunks) => chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('');
const blockEndsOf = (chunks) => chunks.filter((chunk) => chunk.type === 'block-end').map((chunk) => [chunk.index, chunk.block.type]);
const activityCount = (chunks) => (textOf(chunks).match(/\[内置工具：/g) ?? []).length;

const openText = [
  { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message' } },
  { type: 'response.output_text.delta', output_index: 0, delta: '被截断的文本' },
];

// ── #1 未闭合块 + incomplete(max_output_tokens)：不许抛 STREAM_CLOSED ──────
{
  const chunks = await collect([
    ...openText,
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 9, output_tokens: 3 } } },
  ]);
  assert.equal(finishOf(chunks)?.kind, 'max-tokens', 'incomplete(max_output_tokens) 必须报 max-tokens');
  assert.equal(textOf(chunks), '被截断的文本', '已生成的文本不能丢');
  assert.deepEqual(blockEndsOf(chunks), [[0, 'text']], '未闭合块要补发 block-end');
  const usageAt = chunks.findIndex((chunk) => chunk.type === 'usage');
  const finishAt = chunks.findIndex((chunk) => chunk.type === 'finish');
  assert.ok(usageAt >= 0 && usageAt < finishAt, 'usage 必须排在 finish 之前');
}

// ── #1 对照：已闭合块 + incomplete 仍然 max-tokens ──────────────────────────
{
  const chunks = await collect([
    ...openText,
    { type: 'response.output_item.done', output_index: 0, item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: '被截断的文本' }] } },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
  ]);
  assert.equal(finishOf(chunks)?.kind, 'max-tokens');
  assert.equal(textOf(chunks), '被截断的文本');
}

// ── #1 对照组：completed 里还有未闭合块，仍判定为协议损坏 ─────────────────
{
  await assert.rejects(
    () => collect([...openText, { type: 'response.completed', response: {} }]),
    (error) => error.code === 'STREAM_CLOSED',
    'completed 时未闭合块必须仍是 STREAM_CLOSED',
  );
}

// ── #1 deferToolCalls：未闭合 tool-call 仍在活动文本之后──────────────────
{
  const chunks = await collect([
    { type: 'response.output_item.added', output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'completed' } },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_a', name: 'search', arguments: '{"q":"x"}' } },
    { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } },
  ], { deferToolCalls: true });
  assert.equal(finishOf(chunks)?.kind, 'max-tokens');
  // 1000000 是工具调用专属索引段，必须排在活动说明文本（索引 0）之后。
  assert.deepEqual(blockEndsOf(chunks), [[0, 'text'], [1_000_000, 'tool-call']], 'tool-call 必须排在活动说明之后');
}

// ── #3 活动项去重：带 id / 无 id 都只渲染一次 ─────────────────────────────
{
  const withId = await collect([
    { type: 'response.output_item.added', output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'completed' } },
    { type: 'response.completed', response: {} },
  ]);
  assert.equal(activityCount(withId), 1, '带 id 的活动项出现一次');

  const withoutId = await collect([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', status: 'completed' } },
    { type: 'response.completed', response: {} },
  ]);
  assert.equal(activityCount(withoutId), 1, '无 id 的活动项也只出现一次（按 output_index 去重）');

  const twoCalls = await collect([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'web_search_call', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'web_search_call', status: 'completed' } },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'web_search_call', status: 'in_progress' } },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'web_search_call', status: 'completed' } },
    { type: 'response.completed', response: {} },
  ]);
  assert.equal(activityCount(twoCalls), 2, '两个不同 output_index 的真实调用出现两次');
}

// ── 审计#1 解析器层：工具进行中/心跳类事件必须产出续命信号（heartbeat），
//    但不得产生内容块、不得改变 finish 语义（adapter 靠它 touch 空闲超时）。
{
  const chunks = await collect([
    { type: 'response.output_item.added', output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'in_progress' } },
    { type: 'response.web_search_call.searching', output_index: 0, item_id: 'ws_1' },
    { type: 'response.web_search_call.searching', output_index: 0, item_id: 'ws_1' },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'ws_1', type: 'web_search_call', status: 'completed' } },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'msg_1', type: 'message' } },
    { type: 'response.output_text.delta', output_index: 1, delta: 'ok' },
    { type: 'response.output_item.done', output_index: 1, item: { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'ok' }] } },
    { type: 'response.completed', response: {} },
  ]);
  assert.equal(chunks.filter((chunk) => chunk.type === 'heartbeat').length, 2, '每个 searching 事件应 yield 一个 heartbeat 续命信号');
  assert.equal(activityCount(chunks), 1, 'heartbeat 不得影响活动项计数');
  assert.equal(finishOf(chunks)?.kind, 'stop', 'heartbeat 不得改变 finish 语义');
  assert.ok(textOf(chunks).includes('ok'), '正常文本不受影响');
}

console.log('sse.test.mjs: 全部断言通过（#1 未闭合块/终止事件 + #3 活动项去重 + 审计#1 进行中事件续命信号）');
