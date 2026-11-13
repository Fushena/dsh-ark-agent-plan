import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFailure, retryAfterMs } from '../lib/errors.js';
import { chatToDshChunks } from '../lib/chat.js';

function sseBody(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } });
}
async function collect(gen) { const out = []; for await (const c of gen) out.push(c); return out; }

// 审计#6：QUOTA 关键词抢在 429/5xx 之前 → 可重试的限流/网关故障被误判成
// 不可重试的 QUOTA。必须先按 HTTP 状态码分类，状态码无法判定时再看 body 关键词。

test('审计#6：429 + "requests quota exhausted" → RATE_LIMIT（可重试），不是 QUOTA', () => {
  assert.equal(httpFailure(429, 'Rate limit exceeded: requests quota exhausted, retry later'), 'RATE_LIMIT');
});

test('审计#6：429 + QuotaExceeded → RATE_LIMIT', () => {
  assert.equal(httpFailure(429, '{"error":{"code":"QuotaExceeded","message":"too many requests"}}'), 'RATE_LIMIT');
});

test('审计#6：500 + "quota service unavailable" → SERVER（可重试），不是 QUOTA', () => {
  assert.equal(httpFailure(500, 'upstream quota service unavailable'), 'SERVER');
});

test('审计#6：503 + quota 字样 → SERVER', () => {
  assert.equal(httpFailure(503, 'quota backend overloaded'), 'SERVER');
});

test('审计#6：真正的额度耗尽（200 + insufficient_quota）仍 → QUOTA', () => {
  assert.equal(httpFailure(200, 'insufficient_quota'), 'QUOTA');
});

test('审计#6：真正的额度耗尽（200 + 额度耗尽）仍 → QUOTA', () => {
  assert.equal(httpFailure(200, '您的额度耗尽，请升级套餐'), 'QUOTA');
});

test('审计#6：真正的额度耗尽（403 + quota 语义）仍 → QUOTA；纯 403 → AUTH', () => {
  assert.equal(httpFailure(403, 'insufficient_quota: plan quota exhausted'), 'QUOTA');
  assert.equal(httpFailure(403, '额度耗尽'), 'QUOTA');
  assert.equal(httpFailure(403, 'forbidden'), 'AUTH');
});

test('既有语义保持：401/403 → AUTH；408 → TIMEOUT；400 上下文 → CONTEXT_WINDOW_EXCEEDED；其余 PROVIDER_ERROR', () => {
  assert.equal(httpFailure(401, 'invalid api key'), 'AUTH');
  assert.equal(httpFailure(403, 'forbidden'), 'AUTH');
  assert.equal(httpFailure(408, 'request timeout'), 'TIMEOUT');
  assert.equal(httpFailure(400, 'maximum context length exceeded'), 'CONTEXT_WINDOW_EXCEEDED');
  assert.equal(httpFailure(400, 'bad request'), 'PROVIDER_ERROR');
});

test('retryAfterMs：秒数 / HTTP 日期 / 缺失', () => {
  assert.equal(retryAfterMs({ get: (k) => (k === 'retry-after' ? '2' : null) }), 2000);
  assert.equal(retryAfterMs({ get: () => null }), undefined);
});

// 审计#8：服务端省略 tool_calls[].index 时，旧实现用 toolBlocks.size 当索引，
// 每段 delta 都新开块 → 同一调用的参数被拆成多个坏块。缺 index 应复用当前累积块。
test('审计#8：缺 index 的两段 tool_calls delta → 合并成 1 个块、参数完整', async () => {
  const events = [
    { choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'search', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: '"x"}' } }] } }] }, // 无 index、无 id
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const chunks = await collect(chatToDshChunks(sseBody(events), undefined));
  const starts = chunks.filter((c) => c.type === 'block-start' && c.blockType === 'tool-call');
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.equal(starts.length, 1, '同一调用缺 index 的两段 delta 应只开 1 个块');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].block.arguments, '{"q":"x"}', '参数必须完整拼接到同一块');
  assert.equal(ends[0].block.name, 'search');
  assert.equal(ends[0].block.id, 'call_1');
});

test('审计#8 对照：带 index 时本就正常合并（不得改坏）', async () => {
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const chunks = await collect(chatToDshChunks(sseBody(events), undefined));
  const starts = chunks.filter((c) => c.type === 'block-start' && c.blockType === 'tool-call');
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.equal(starts.length, 1);
  assert.equal(ends[0].block.arguments, '{"q":"x"}');
});

test('审计#8 对照：带 index 的两个并行调用仍是 2 个块（不得误并）', async () => {
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{"x":' } }, { index: 1, id: 'b', function: { name: 'g', arguments: '{"y":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }, { index: 1, function: { arguments: '2}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const chunks = await collect(chatToDshChunks(sseBody(events), undefined));
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.equal(ends.length, 2);
  assert.deepEqual(ends.map((c) => c.block.arguments).sort(), ['{"x":1}', '{"y":2}']);
});

test('审计#8 边界：缺 index 但出现新 id → 是新调用，开新块而非误并', async () => {
  const events = [
    { choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'f', arguments: '{"x":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: '1}' } }] } }] },        // 续 a
    { choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'g', arguments: '{"y":2}' } }] } }] }, // 新调用 b
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const chunks = await collect(chatToDshChunks(sseBody(events), undefined));
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.equal(ends.length, 2, '两个不同 id 的调用应为 2 个块');
  assert.deepEqual(ends.map((c) => c.block.arguments).sort(), ['{"x":1}', '{"y":2}']);
});
