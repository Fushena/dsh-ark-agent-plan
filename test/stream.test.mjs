import assert from 'node:assert/strict';
import http from 'node:http';

/**
 * 真实 SSE 服务器上的端到端超时回归（#4 + 2026-11-10 的空闲超时回归）。
 *
 * 为什么必须用真实 HTTP 服务器而不是假 ReadableStream：
 * 超时是靠 abort 请求信号生效的，真实 undici 收到 abort 会取消 body 并让
 * read() 抛错；手写的假流不响应 abort，就测不出「超时到底有没有真的中止读取」，
 * 只能测出「定时器有没有到点」—— 而真正会伤到用户的是前者。
 *
 * 三条断言：
 *   A. 慢但持续的流（总时长 > 空闲阈值 3 倍）必须正常跑完 —— 防「长回答被掐断」；
 *   B. 卡死的流必须在阈值附近报 TIMEOUT —— 防「干等 300 秒」；
 *   C. 用户取消必须报 ABORTED 且立刻返回 —— 防「取消后还在挂着」。
 *
 * 跑法（插件仓库根目录）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     --import ./test/runtime.mjs ./test/stream.test.mjs
 */

const { ArkAgentPlanAdapter } = await import('../lib/adapter.js');

const SSE_HEADERS = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
const send = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\r\n\r\n`);

const MODEL = { id: 'deepseek-v4.1-flash', transport: 'responses', reasoning: false, input: ['text'], harnessTools: [], maxTokens: 1024 };
const catalog = { find: () => MODEL, snapshot: () => ({ models: [] }) };
const ctx = {
  get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'K' }) } : undefined),
  logger: { info() {}, warn() {}, debug() {} },
};

function makeAdapter(port, requestTimeoutMs) {
  return new ArkAgentPlanAdapter({
    ctx, catalog, providerId: 'ark-agent-plan', displayName: 'Ark', apiKeyCandidates: ['T'],
    endpoint: `http://127.0.0.1:${port}/responses`,
    chatEndpoint: `http://127.0.0.1:${port}/chat`,
    harnessMode: { mode: 'none' }, pluginName: 'test', defaultReasoning: 'high',
    requestTimeoutMs, fetchImpl: globalThis.fetch,
  });
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port, server);
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
}

async function pump(stream) {
  for await (const chunk of stream) void chunk;
}

// A. 9 个 delta 每 150ms（约 1.35s，是 400ms 阈值的 3 倍多）+ 正常 done/completed。
await withServer((req, res) => {
  res.writeHead(200, SSE_HEADERS);
  send(res, { type: 'response.output_item.added', output_index: 0, item: { id: 'm', type: 'message' } });
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    if (i <= 9) {
      send(res, { type: 'response.output_text.delta', output_index: 0, delta: 'x' });
      return;
    }
    clearInterval(timer);
    send(res, { type: 'response.output_item.done', output_index: 0, item: { id: 'm', type: 'message', content: [{ type: 'output_text', text: 'xxxxxxxxx' }] } });
    send(res, { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 9 } } });
    res.end();
  }, 150);
}, async (port) => {
  const adapter = makeAdapter(port, 400);
  const started = Date.now();
  let text = '';
  for await (const chunk of adapter.stream({ model: MODEL.id, messages: [], signal: new AbortController().signal })) {
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  assert.equal(text.length, 9, 'A: 慢但持续的流必须完整读完（不得被总时长超时掐断）');
  assert.ok(Date.now() - started < 2_500, 'A: 1.35s 的流应在 2.5s 内正常结束');
});

// B. 发一个事件后永不再发 → 阈值附近必须 TIMEOUT，不能干等 300 秒。
await withServer((req, res) => {
  res.writeHead(200, SSE_HEADERS);
  send(res, { type: 'response.output_item.added', output_index: 0, item: { id: 'm', type: 'message' } });
  // 故意不 end、也不再写：模拟服务端卡死。
}, async (port) => {
  const adapter = makeAdapter(port, 400);
  const started = Date.now();
  await assert.rejects(pump(adapter.stream({ model: MODEL.id, messages: [], signal: new AbortController().signal })),
    (error) => {
      assert.equal(error.code, 'TIMEOUT', 'B: 卡死的流必须报 TIMEOUT（而不是 STREAM_CLOSED 或干等）');
      assert.ok(Date.now() - started < 1_500, `B: 应在阈值附近中止（实际 ${Date.now() - started}ms）`);
      return true;
    });
});

// C. 用户取消 → ABORTED，且立刻返回（不能继续等阈值）。
await withServer((req, res) => {
  res.writeHead(200, SSE_HEADERS);
  send(res, { type: 'response.output_item.added', output_index: 0, item: { id: 'm', type: 'message' } });
}, async (port) => {
  const adapter = makeAdapter(port, 60_000);
  const controller = new AbortController();
  const started = Date.now();
  const pending = pump(adapter.stream({ model: MODEL.id, messages: [], signal: controller.signal }));
  setTimeout(() => controller.abort(new Error('user abort')), 150);
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'ABORTED', 'C: 用户取消必须报 ABORTED（不能报 TIMEOUT）');
    assert.ok(Date.now() - started < 1_500, `C: 取消应立即生效（实际 ${Date.now() - started}ms）`);
    return true;
  });
});

// D. 内置工具长时间执行：SSE 持续有 searching 事件但没有 text-delta。
//    空闲超时必须按「SSE 事件到达」续命，不能把健康请求掐成 TIMEOUT（审计 #1）。
//    工具执行 1.5s（事件每 150ms），阈值 400ms：修前解析器对 searching 不 yield，
//    adapter 不 touch → 400ms 即 TIMEOUT；修后正常读完。
const TOOL_MODEL = { ...MODEL, harnessTools: ['web_search'] };
await withServer((req, res) => {
  res.writeHead(200, SSE_HEADERS);
  send(res, { type: 'response.output_item.added', output_index: 0, item: { id: 'ws', type: 'web_search_call', status: 'in_progress' } });
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    if (i <= 10) {
      send(res, { type: 'response.web_search_call.searching', output_index: 0, item_id: 'ws' });
      return;
    }
    clearInterval(timer);
    send(res, { type: 'response.output_item.done', output_index: 0, item: { id: 'ws', type: 'web_search_call', status: 'completed' } });
    send(res, { type: 'response.output_item.added', output_index: 1, item: { id: 'm', type: 'message' } });
    send(res, { type: 'response.output_text.delta', output_index: 1, delta: 'answer' });
    send(res, { type: 'response.output_item.done', output_index: 1, item: { id: 'm', type: 'message', content: [{ type: 'output_text', text: 'answer' }] } });
    send(res, { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } });
    res.end();
  }, 150);
}, async (port) => {
  const adapter = new ArkAgentPlanAdapter({
    ctx, catalog: { find: () => TOOL_MODEL, snapshot: () => ({ models: [] }) },
    providerId: 'ark-agent-plan', displayName: 'Ark', apiKeyCandidates: ['T'],
    endpoint: `http://127.0.0.1:${port}/responses`, chatEndpoint: `http://127.0.0.1:${port}/chat`,
    harnessMode: { mode: 'auto' }, pluginName: 'test', defaultReasoning: 'high',
    requestTimeoutMs: 400, fetchImpl: globalThis.fetch,
  });
  let text = '';
  for await (const chunk of adapter.stream({ model: TOOL_MODEL.id, messages: [], signal: new AbortController().signal })) {
    assert.notEqual(chunk.type, 'heartbeat', 'D: heartbeat 只是续命信号，不得转发给上层');
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  assert.ok(text.includes('answer'), 'D: 工具执行期间事件持续到达，请求必须正常完成而非 TIMEOUT');
});

console.log('stream.test.mjs: 全部断言通过（真实 SSE 服务器：A 长流/ B 卡死超时/ C 取消/ D 工具进行中续命）');
