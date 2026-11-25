import test from 'node:test';
import assert from 'node:assert/strict';
import { httpFailure, retryAfterMs } from '../lib/errors.js';
import { chatToDshChunks } from '../lib/chat.js';
import { responsesToDshChunks } from '../lib/responses-sse.js';

function sseBody(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { c.enqueue(enc.encode(text)); c.close(); } });
}
async function collect(gen) { const out = []; for await (const c of gen) out.push(c); return out; }

test('Ark maps transient errors inside both SSE protocols to DSH retry codes', async () => {
  const rateLimit = { code: 'rate_limit_exceeded', message: 'slow down' };
  const serverError = { code: 'InternalError', message: 'service unavailable' };
  await assert.rejects(collect(chatToDshChunks(sseBody([{ error: serverError }]))), { code: 'SERVER' });
  await assert.rejects(collect(responsesToDshChunks(sseBody([{ type: 'error', error: rateLimit }]))), { code: 'RATE_LIMIT' });
  const chunks = await collect(responsesToDshChunks(sseBody([
    { type: 'response.failed', response: { error: rateLimit } },
  ])));
  assert.equal(chunks.at(-1).reason.failure.code, 'RATE_LIMIT');
});

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

// 整合复核（2026-11-25）：PR 新增的 streamFailureCode 只按 code 分类，code 缺失或不认识时
// 直接落 httpFailure(400, text)，而 Ark 的 httpFailure 文本词表只有 quota/context——
// 于是「只给 message」的限流/超时/网关故障全落不可重试的 PROVIDER_ERROR。
// Ark 是国内网关，中文错误文案常见，必须补文本兜底（与 qwen 侧同款）。
test('整合：流内错误只给 message 时也要归到可重试码（中文文案同样生效）', async () => {
  const cases = [
    [{ message: 'rate limit exceeded, please retry' }, 'RATE_LIMIT'],
    [{ message: '请求过于频繁，请稍后重试' }, 'RATE_LIMIT'],
    [{ message: 'upstream request timeout' }, 'TIMEOUT'],
    [{ message: '网关超时' }, 'TIMEOUT'],
    [{ message: '服务繁忙，请稍后重试' }, 'SERVER'],
    [{ message: 'The service is temporarily unavailable' }, 'SERVER'],
    [{ code: 'SomethingBrandNew', message: '服务暂时不可用' }, 'SERVER'],
  ];
  for (const [error, expected] of cases) {
    await assert.rejects(collect(chatToDshChunks(sseBody([{ error }]))), { code: expected },
      `chat 流内 ${JSON.stringify(error)} 应归 ${expected}`);
    await assert.rejects(collect(responsesToDshChunks(sseBody([{ type: 'error', error }]))), { code: expected },
      `responses 流内 ${JSON.stringify(error)} 应归 ${expected}`);
  }
});

test('整合：结构化 code 仍优先于 message 文本（不得因补兜底而回退）', async () => {
  await assert.rejects(
    collect(chatToDshChunks(sseBody([{ error: { code: 'rate_limit_exceeded', message: 'requests quota exhausted' } }]))),
    { code: 'RATE_LIMIT' }, 'code 是限流就不能被 message 里的 quota 字样抢判');
  await assert.rejects(
    collect(chatToDshChunks(sseBody([{ error: { code: 'InternalError', message: 'quota service unavailable' } }]))),
    { code: 'SERVER' });
  await assert.rejects(
    collect(chatToDshChunks(sseBody([{ error: { code: 'QuotaExceeded', message: 'retry later' } }]))),
    { code: 'QUOTA' }, '真额度耗尽仍是终局，不得因文本兜底变成可重试');
});

// 整合复核（2026-11-25）：Ark 侧与 qwen Q13 同坑——`call.id !== undefined` 让续片段的
// id:"" 覆盖真 id；无主片段复用 lastToolBlock 在并行调用时会把两条参数串成坏 JSON。
test('整合：续片段 id:"" 不得覆盖真 id（与 qwen Q13 同款）', async () => {
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_real', function: { name: 'f', arguments: '{"x":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { arguments: '1}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const chunks = await collect(chatToDshChunks(sseBody(events), undefined));
  const deltas = chunks.filter((c) => c.type === 'tool-call-delta');
  assert.deepEqual(deltas.map((c) => c.id), ['call_real', 'call_real']);
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].block.id, 'call_real');
  assert.equal(ends[0].block.arguments, '{"x":1}');
});

test('整合：并行调用后的无主片段不得污染已完整的两条调用', async () => {
  const events = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{"x":1}' } }, { index: 1, id: 'b', function: { name: 'g', arguments: '{"y":2}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ function: { arguments: 'tail' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const chunks = await collect(chatToDshChunks(sseBody(events), undefined));
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  const byId = new Map(ends.map((c) => [c.block.id, c.block.arguments]));
  assert.equal(byId.get('a'), '{"x":1}', '第一条调用参数不得被无主片段追加');
  assert.equal(byId.get('b'), '{"y":2}', '第二条调用参数不得被无主片段追加');
  assert.equal(ends.length, 3, '无主片段自成一块');
  assert.equal(ends.at(-1).block.arguments, 'tail');
});
