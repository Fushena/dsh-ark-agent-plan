import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';

/**
 * A2 回归：多模态四条路线必须按**上游真实契约**发请求、按**真实响应形态**解析。
 *
 * 旧实现的三处硬伤（审计 A2）：
 *   1. 视频发 {prompt,stream:true} 期待 SSE —— 官方是 POST tasks 只回 {id}，再 GET 轮询；
 *   2. 图片对所有模型硬编码 stream:true —— 只有 seedream-5.0-lite/4.5/4.0 支持，
 *      5.0-pro/flash/5.5 传了直接 400；事件名也不是 image_generation.partial；
 *   3. 语音往 ark 网关发 OpenAI 风格 {model,input,voice} 期待 {data:base64} ——
 *      真实端点在 openspeech，鉴权是 X-Api-Key，响应是逐行 JSON + 终止码 20000000。
 *
 * 另外两条与 A2 同源的「成功判据」约束也在这里守住：
 *   - 产物必须是宿主附件库的**真引用**（sha256:…），不能自造 attachmentId；
 *   - 取消 / 断流 / 空产物都不能被包装成一次正常回答（宿主没有 finish 时默认 stop）。
 *
 * 用真实 HTTP 服务器而不是假 ReadableStream：取消与空闲超时靠 abort 请求信号生效，
 * 假流不响应 abort，就测不出「有没有真的中止读取」。
 *
 * 跑法（插件仓库根目录）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     --import ./test/runtime.mjs ./test/multimodal.test.mjs
 */

const { ArkAgentPlanAdapter } = await import('../lib/adapter.js');
const { buildMultimodalRequestBody, supportsImageStream } = await import('../lib/multimodal.js');
const { AGENT_PLAN_TTS_URL, TTS_RESOURCE_ID, TTS_DONE_CODE, DEFAULT_TTS_SPEAKER } = await import('../lib/media-io.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
// 最小可识别 mp4：偏移 4 起是 'ftyp'（魔数校验只看这一段）。
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(16, 1)]);
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(29, 2)]);
const b64 = (buf) => buf.toString('base64');

const MODEL = (transport, id) => ({ id, transport, reasoning: false, input: ['text'], harnessTools: [], maxTokens: 1024 });
const OPTIONS = (text = '画一只猫') => ({
  model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text }] }],
});
let pollCount = 0;
let captured = null;

/** 假附件服务：按宿主契约返回真引用（sha256:<64hex> + name + bytes）。 */
function fakeAttachments({ fail = false, badRef = false } = {}) {
  const saved = [];
  return {
    saved,
    async saveFile({ data, name }) {
      if (fail) throw new Error('ATTACHMENT_FILES_UNSUPPORTED');
      saved.push({ name, bytes: data.byteLength });
      const digest = createHash('sha256').update(data).digest('hex');
      return { attachmentId: badRef ? `ark-img-${Date.now()}` : `sha256:${digest}`, name, bytes: data.byteLength };
    },
  };
}

function makeCtx(attachments) {
  const warnings = [];
  return {
    warnings,
    get: (name) => {
      if (name === 'credentials') return { resolve: async () => ({ value: 'TEST_KEY' }) };
      if (name === 'attachments') return attachments;
      return undefined;
    },
    logger: { info() {}, debug() {}, warn: (m) => warnings.push(String(m)) },
  };
}

function makeAdapter(port, { model, ctx, requestTimeoutMs = 5000, media, quota, fetchImpl } = {}) {
  const catalog = { find: () => model, snapshot: () => ({ models: [] }) };
  return new ArkAgentPlanAdapter({
    ctx, catalog, providerId: 'ark-agent-plan', displayName: 'Ark', apiKeyCandidates: ['T'],
    endpoint: `http://127.0.0.1:${port}/api/plan/v3/responses`,
    chatEndpoint: `http://127.0.0.1:${port}/api/plan/v3/chat/completions`,
    harnessMode: { mode: 'none' }, pluginName: 'test', defaultReasoning: 'high',
    requestTimeoutMs, fetchImpl: fetchImpl ?? globalThis.fetch, media, quota,
  });
}

/**
 * 把上游的 https 媒体地址重写到本地测试服务器（只测下载/落库链路，不出网、不测 TLS）。
 * 网关地址本来就是本地 http，原样透传。
 */
function localMedia(port, { failHosts = [] } = {}) {
  const realFetch = globalThis.fetch;
  return (url, init) => {
    const text = String(url);
    if (failHosts.some((host) => text.startsWith(host))) {
      return Promise.reject(new Error('simulated media download failure'));
    }
    const rewritten = text.replace(/^https:\/\/[a-z0-9.-]+\.example\.com/, `http://127.0.0.1:${port}`);
    return realFetch(rewritten, init);
  };
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

const readBody = (req) => new Promise((resolve) => {
  const parts = [];
  req.on('data', (c) => parts.push(c));
  req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
});
const json = (res, payload, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}
async function expectError(stream, code, pattern) {
  let caught = null;
  try { await collect(stream); } catch (error) { caught = error; }
  assert.ok(caught, `应当抛错（期望 ${code}），实际正常结束`);
  assert.equal(caught.code, code, `失败码应为 ${code}，实际 ${caught.code}：${caught.message}`);
  if (pattern) assert.match(caught.message, pattern);
  return caught;
}
const fileBlocks = (chunks) => chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'file');
const textOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
const finishOf = (chunks) => chunks.find((c) => c.type === 'finish')?.reason;

// ── 1. 请求体形状（纯函数层：官方字段白名单 + stream 门控） ────────────────
{
  // stream 只对官方列出的三个模型开；Agent Plan 在售的 pro/flash/5.5 都不在其中。
  for (const id of ['doubao-seedream-5-0-lite-260128', 'doubao-seedream-4-5-251128', 'doubao-seedream-4-0-250828']) {
    assert.equal(supportsImageStream(id), true, `${id} 官方支持流式`);
  }
  for (const id of ['doubao-seedream-5-0-pro', 'doubao-seedream-5-0-flash', 'doubao-seedream-5-5', 'ep-20250101-abc']) {
    assert.equal(supportsImageStream(id), false, `${id} 不支持流式，传 stream 会被上游 400`);
  }

  const pro = await buildMultimodalRequestBody(OPTIONS(), MODEL('images', 'doubao-seedream-5-0-pro'));
  assert.equal(pro.stream, undefined, 'A2: pro 系不得发 stream');
  assert.equal(pro.quality, undefined, 'A2: 官方图片参数表没有 quality');
  assert.equal(pro.n, undefined, 'A2: 官方图片参数表没有 n');
  assert.equal(pro.size, '2K');
  assert.equal(pro.response_format, 'url');
  assert.equal(pro.prompt, '画一只猫');

  const lite = await buildMultimodalRequestBody(OPTIONS(), MODEL('images', 'doubao-seedream-5-0-lite-260128'));
  assert.equal(lite.stream, true, 'A2: lite 系才发 stream:true');

  const video = await buildMultimodalRequestBody(OPTIONS('一只猫在跑'), MODEL('video', 'doubao-seedance-2-0'));
  assert.deepEqual(video.content, [{ type: 'text', text: '一只猫在跑' }], 'A2: 视频提示词必须在 content 数组里');
  assert.equal(video.prompt, undefined, 'A2: 视频没有顶层 prompt');
  assert.equal(video.stream, undefined, 'A2: 视频是异步任务，没有 SSE');
  assert.equal(video.ratio, 'adaptive');
  assert.equal(video.duration, 5);

  const audio = await buildMultimodalRequestBody(OPTIONS('你好'), MODEL('audio', 'doubao-seed-tts-2-0'));
  assert.equal(audio.req_params.text, '你好');
  assert.equal(audio.req_params.speaker, DEFAULT_TTS_SPEAKER);
  assert.deepEqual(audio.req_params.audio_params, { format: 'mp3', sample_rate: 24000 });
  assert.equal(audio.model, undefined, 'A2: 语音按资源路由，请求体不带 model');
  assert.equal(audio.input, undefined);
  assert.equal(audio.voice, undefined);
  assert.equal(audio.stream, undefined);

  const embedding = await buildMultimodalRequestBody(OPTIONS('文本'), MODEL('embedding', 'doubao-embedding'));
  assert.equal(embedding.stream, undefined, 'A2: /embeddings 不支持 stream');
  assert.equal(embedding.input, '文本');

  // 默认值可覆盖（配置面 mediaDefaults 透传到这里）。
  const tuned = await buildMultimodalRequestBody(OPTIONS(), MODEL('video', 'doubao-seedance-2-5'), { ratio: '9:16', resolution: '1080p', duration: 15 });
  assert.equal(tuned.ratio, '9:16');
  assert.equal(tuned.resolution, '1080p');
  assert.equal(tuned.duration, 15, 'A2: 官方 2.5 系支持到 30 秒，不能被写死成 5/10');
}

// ── 2. 视频：创建任务 → 轮询 → 下载落库（真实两阶段 HTTP） ─────────────────
await withServer(async (req, res) => {
  const url = req.url;
  if (req.method === 'POST' && url === '/api/plan/v3/contents/generations/tasks') {
    const body = JSON.parse(await readBody(req));
    assert.equal(req.headers.authorization, 'Bearer TEST_KEY');
    assert.deepEqual(body.content, [
      { type: 'text', text: '一只猫在跑' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64(PNG) }, role: 'first_frame' },
    ]);
    assert.equal(body.stream, undefined);
    json(res, { id: 'cgt-test-1' }); // 官方创建响应只有 id
    return;
  }
  if (req.method === 'GET' && url === '/api/plan/v3/contents/generations/tasks/cgt-test-1') {
    pollCount += 1;
    if (pollCount < 3) { json(res, { id: 'cgt-test-1', status: 'running' }); return; }
    json(res, {
      id: 'cgt-test-1', status: 'succeeded', duration: 5,
      content: { video_url: 'https://media.example.com/cat.mp4' },
      usage: { completion_tokens: 411300, total_tokens: 411300 },
    });
    return;
  }
  json(res, { error: { message: `unexpected ${req.method} ${url}` } }, 500);
}, async (port) => {
  pollCount = 0;
  const attachments = fakeAttachments();
  const ref = { attachmentId: 'sha256:' + 'a'.repeat(64) };
  attachments.readImage = async (image) => {
    assert.equal(image, ref);
    return { data: PNG, ref: { mediaType: 'image/png' } };
  };
  // 媒体地址是 https（真实形态）；这里模拟下载失败 → 必须降级成文本链接，
  // 不能把「下载失败」当整轮失败，也不能伪造附件引用。
  const adapter = makeAdapter(port, {
    model: MODEL('video', 'doubao-seedance-2-0'), ctx: makeCtx(attachments),
    media: { videoPollIntervalMs: 10, videoMaxWaitMs: 5000 },
    fetchImpl: localMedia(port, { failHosts: ['https://media.example.com/'] }),
  });
  const options = OPTIONS('一只猫在跑');
  options.messages[0].content.push({ type: 'image', attachment: ref });
  const chunks = await collect(adapter.stream(options));
  assert.equal(pollCount, 3, 'A2: 必须轮询到 succeeded（创建响应只有 id，不能当结果用）');
  assert.equal(fileBlocks(chunks).length, 0, '下载失败时不能伪造 file 引用');
  assert.match(textOf(chunks), /视频已生成/);
  assert.match(textOf(chunks), /https:\/\/media\.example\.com\/cat\.mp4/, '降级时必须把真实链接给用户');
  assert.equal(finishOf(chunks)?.kind, 'stop');
  const usage = chunks.find((c) => c.type === 'usage');
  assert.equal(usage?.usage?.outputTokens, 411300, '视频 usage 要记账（completion_tokens）');
});

// 视频：https 媒体地址 → 真下载 + 真落库 + file 块。
await withServer(async (req, res) => {
  if (req.url === '/cat.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(MP4); return; }
  if (req.method === 'POST') { await readBody(req); json(res, { id: 't2' }); return; }
  if (req.url.startsWith('/api/plan/v3/contents/generations/tasks/')) {
    json(res, { id: 't2', status: 'succeeded', duration: 5, content: { video_url: 'https://media.example.com/cat.mp4' } });
    return;
  }
  json(res, { error: { message: 'unexpected' } }, 500);
}, async (port) => {
  const attachments = fakeAttachments();
  const adapter = makeAdapter(port, {
    model: MODEL('video', 'doubao-seedance-2-0'), ctx: makeCtx(attachments),
    media: { videoPollIntervalMs: 10, videoMaxWaitMs: 5000 },
    fetchImpl: localMedia(port),
  });
  const chunks = await collect(adapter.stream(OPTIONS('猫')));
  const files = fileBlocks(chunks);
  assert.equal(files.length, 1, 'A2: 视频产物必须落宿主附件库后发 file 块');
  assert.match(files[0].block.attachment.attachmentId, /^sha256:[a-f0-9]{64}$/, '必须是真引用，不能自造 attachmentId');
  assert.equal(files[0].block.attachment.bytes, MP4.length);
  assert.equal(attachments.saved.length, 1);
  assert.match(textOf(chunks), /已保存为文件/);
  assert.equal(finishOf(chunks)?.kind, 'stop');
});

// 视频：任务 failed → PROVIDER_ERROR（不能把失败当成功）。
await withServer(async (req, res) => {
  if (req.method === 'POST') { await readBody(req); json(res, { id: 't3' }); return; }
  json(res, { id: 't3', status: 'failed', error: { message: '内容审核未通过' } });
}, async (port) => {
  const adapter = makeAdapter(port, {
    model: MODEL('video', 'doubao-seedance-2-0'), ctx: makeCtx(fakeAttachments()),
    media: { videoPollIntervalMs: 10, videoMaxWaitMs: 5000 },
  });
  await expectError(adapter.stream(OPTIONS()), 'PROVIDER_ERROR', /内容审核未通过/);
});

// 视频：一直 running → 总时限到点报 TIMEOUT（不是无限等）。
await withServer(async (req, res) => {
  if (req.method === 'POST') { await readBody(req); json(res, { id: 't4' }); return; }
  json(res, { id: 't4', status: 'running' });
}, async (port) => {
  const adapter = makeAdapter(port, {
    model: MODEL('video', 'doubao-seedance-2-0'), ctx: makeCtx(fakeAttachments()),
    requestTimeoutMs: 5000, media: { videoPollIntervalMs: 10, videoMaxWaitMs: 120 },
  });
  await expectError(adapter.stream(OPTIONS()), 'TIMEOUT', /视频生成超时/);
});

// 视频：创建响应没有 id → PROVIDER_ERROR（旧实现会把 {id} 之外的东西当结果）。
await withServer(async (req, res) => { await readBody(req); json(res, { created: 123 }); }, async (port) => {
  const adapter = makeAdapter(port, { model: MODEL('video', 'doubao-seedance-2-0'), ctx: makeCtx(fakeAttachments()) });
  await expectError(adapter.stream(OPTIONS()), 'PROVIDER_ERROR', /未返回任务 ID/);
});

// ── 3. 图片：非流式 JSON（pro/flash 系）────────────────────────────────────
await withServer(async (req, res) => {
  if (req.url === '/1.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
  const body = JSON.parse(await readBody(req));
  assert.equal(req.url, '/api/plan/v3/images/generations');
  assert.equal(body.stream, undefined, 'A2: pro 系请求体不得带 stream');
  assert.equal(req.headers.accept, 'application/json');
  json(res, { model: body.model, created: 1, data: [{ url: 'https://img.example.com/1.png', size: '2048x2048' }], usage: { generated_images: 1, output_tokens: 16384, total_tokens: 16384 } });
}, async (port) => {
  const attachments = fakeAttachments();
  const adapter = makeAdapter(port, {
    model: MODEL('images', 'doubao-seedream-5-0-pro'), ctx: makeCtx(attachments), fetchImpl: localMedia(port),
  });
  // 本地服务器对 /1.png 返回 PNG 字节。
  const chunks = await collect(adapter.stream(OPTIONS()));
  assert.equal(fileBlocks(chunks).length, 1);
  assert.equal(finishOf(chunks)?.kind, 'stop');
});

// 图片：上游回内联 b64_json（无需下载）+ 没有附件服务 → 降级文本，不伪造引用。
await withServer(async (req, res) => {
  await readBody(req);
  json(res, { data: [{ b64_json: b64(PNG) }], usage: { generated_images: 1, output_tokens: 100, total_tokens: 100 } });
}, async (port) => {
  const adapter = makeAdapter(port, { model: MODEL('images', 'doubao-seedream-5-0-pro'), ctx: makeCtx(undefined) });
  const chunks = await collect(adapter.stream(OPTIONS()));
  assert.equal(fileBlocks(chunks).length, 0, '没有附件服务时不能伪造 file 引用');
  assert.match(textOf(chunks), /没有可用的附件存储/);
  assert.equal(finishOf(chunks)?.kind, 'stop');
});

// 图片：data 为空 → PROVIDER_ERROR（不能空手报成功）。
await withServer(async (req, res) => { await readBody(req); json(res, { data: [] }); }, async (port) => {
  const adapter = makeAdapter(port, { model: MODEL('images', 'doubao-seedream-5-0-pro'), ctx: makeCtx(fakeAttachments()) });
  await expectError(adapter.stream(OPTIONS()), 'PROVIDER_ERROR', /未返回任何图片/);
});

// 图片：上游回 HTML 错误页（200）→ 魔数校验拒收，不能存成 .png。
await withServer(async (req, res) => { await readBody(req); json(res, { data: [{ b64_json: b64(Buffer.from('<html>error</html>')) }] }); }, async (port) => {
  const adapter = makeAdapter(port, { model: MODEL('images', 'doubao-seedream-5-0-pro'), ctx: makeCtx(fakeAttachments()) });
  await expectError(adapter.stream(OPTIONS()), 'PROVIDER_ERROR', /不是有效的 PNG/);
});

// ── 4. 图片：流式（lite 系）真实事件名 ────────────────────────────────────
await withServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  assert.equal(body.stream, true, 'A2: lite 系必须发 stream:true');
  assert.equal(req.headers.accept, 'text/event-stream');
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\r\n\r\n`);
  send({ type: 'image_generation.partial_succeeded', created: 1, model: body.model, image_index: 0, size: '2048x2048', b64_json: b64(PNG) });
  send({ type: 'image_generation.partial_succeeded', created: 1, model: body.model, image_index: 1, size: '2048x2048', b64_json: b64(PNG) });
  send({ type: 'image_generation.completed', created: 1, model: body.model, usage: { generated_images: 2, output_tokens: 32768, total_tokens: 32768 } });
  res.write('data: [DONE]\r\n\r\n');
  res.end();
}, async (port) => {
  const attachments = fakeAttachments();
  const adapter = makeAdapter(port, { model: MODEL('images', 'doubao-seedream-5-0-lite-260128'), ctx: makeCtx(attachments) });
  const chunks = await collect(adapter.stream(OPTIONS()));
  assert.equal(fileBlocks(chunks).length, 2, 'A2: 真实事件名 partial_succeeded 必须被识别（旧代码认的是 partial）');
  assert.equal(attachments.saved.length, 2);
  assert.equal(chunks.find((c) => c.type === 'usage')?.usage?.outputTokens, 32768);
  assert.equal(finishOf(chunks)?.kind, 'stop');
});

// 图片流：只有 partial_failed + completed → 没有产物必须报错。
await withServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ type: 'image_generation.partial_failed', image_index: 0, error: { code: 'OutputImageSensitiveContentDetected', message: '敏感内容' } })}\r\n\r\n`);
  res.write(`data: ${JSON.stringify({ type: 'image_generation.completed', usage: { generated_images: 0, output_tokens: 0, total_tokens: 0 } })}\r\n\r\n`);
  res.end();
}, async (port) => {
  const adapter = makeAdapter(port, { model: MODEL('images', 'doubao-seedream-4-5'), ctx: makeCtx(fakeAttachments()) });
  await expectError(adapter.stream(OPTIONS()), 'PROVIDER_ERROR', /敏感内容/);
});

// 图片流：提前 EOF（没有 completed）→ STREAM_CLOSED，不能当成功。
await withServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ type: 'image_generation.partial_succeeded', image_index: 0, b64_json: b64(PNG) })}\r\n\r\n`);
  res.end();
}, async (port) => {
  const adapter = makeAdapter(port, { model: MODEL('images', 'doubao-seedream-4-0'), ctx: makeCtx(fakeAttachments()) });
  await expectError(adapter.stream(OPTIONS()), 'STREAM_CLOSED', /未收到 completed/);
});

// 图片流：error 事件 → 按上游码分类（限流可重试）。
await withServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write(`data: ${JSON.stringify({ type: 'error', error: { code: 'RateLimitExceeded', message: 'qps limit' } })}\r\n\r\n`);
  res.end();
}, async (port) => {
  const adapter = makeAdapter(port, { model: MODEL('images', 'doubao-seedream-4-5'), ctx: makeCtx(fakeAttachments()) });
  await expectError(adapter.stream(OPTIONS()), 'RATE_LIMIT');
});

// 图片：请求了流式但上游回 JSON（或反之）→ 按实际 Content-Type 分流，不解析错。
await withServer(async (req, res) => {
  await readBody(req);
  json(res, { data: [{ b64_json: b64(PNG) }] }); // content-type: application/json
}, async (port) => {
  const adapter = makeAdapter(port, { model: MODEL('images', 'doubao-seedream-5-0-lite-260128'), ctx: makeCtx(fakeAttachments()) });
  const chunks = await collect(adapter.stream(OPTIONS()));
  assert.equal(fileBlocks(chunks).length, 1, '上游回 JSON 时按 JSON 解析');
  assert.equal(finishOf(chunks)?.kind, 'stop');
});

// ── 5. 语音：Agent Plan 真实端点 + 逐行 JSON + 终止码 ──────────────────────
await withServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  captured = { url: req.url, headers: req.headers, body };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(`${JSON.stringify({ code: 0, message: 'OK', data: b64(MP3.subarray(0, 16)) })}\n`);
  res.write(`${JSON.stringify({ code: 0, message: 'OK', data: b64(MP3.subarray(16)) })}\n`);
  res.write(`${JSON.stringify({ code: TTS_DONE_CODE, data: null, usage: { text_words: 2 } })}\n`);
  res.end();
}, async (port) => {
  captured = null;
  const attachments = fakeAttachments();
  const adapter = makeAdapter(port, {
    model: MODEL('audio', 'doubao-seed-tts-2-0'), ctx: makeCtx(attachments),
    media: { ttsEndpoint: `http://127.0.0.1:${port}/api/v3/plan/tts/unidirectional` },
  });
  const chunks = await collect(adapter.stream(OPTIONS('你好世界')));
  assert.equal(captured.url, '/api/v3/plan/tts/unidirectional');
  assert.equal(captured.headers['x-api-key'], 'TEST_KEY', 'A2: 语音用 X-Api-Key，不是 Bearer');
  assert.equal(captured.headers['x-api-resource-id'], TTS_RESOURCE_ID);
  assert.ok(captured.headers['x-api-request-id'], '官方要求 X-Api-Request-Id');
  assert.equal(captured.headers.authorization, undefined);
  assert.equal(captured.body.req_params.text, '你好世界');
  assert.equal(captured.body.model, undefined);
  const files = fileBlocks(chunks);
  assert.equal(files.length, 1, 'A2: 音频必须落库成 file 块');
  assert.equal(files[0].block.attachment.bytes, MP3.length, '分片必须按顺序拼全');
  assert.equal(finishOf(chunks)?.kind, 'stop');
  // 默认端点常量本身也要指向 openspeech 的 plan 路径（不是 ark 网关）。
  assert.equal(AGENT_PLAN_TTS_URL, 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional');
});

// 语音：没有终止码（提前 EOF）→ STREAM_CLOSED，不能把半截音频当成功。
await withServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(`${JSON.stringify({ code: 0, data: b64(MP3) })}\n`);
  res.end();
}, async (port) => {
  const adapter = makeAdapter(port, {
    model: MODEL('audio', 'doubao-seed-tts-2-0'), ctx: makeCtx(fakeAttachments()),
    media: { ttsEndpoint: `http://127.0.0.1:${port}/tts` },
  });
  await expectError(adapter.stream(OPTIONS('你好')), 'STREAM_CLOSED', /未收到终止码/);
});

// 语音：先报错再补终止码 → 仍必须失败（不能因为看到终止码就当成功）。
await withServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(`${JSON.stringify({ code: 0, data: b64(MP3) })}\n`);
  res.write(`${JSON.stringify({ code: 45000010, message: 'Invalid X-Api-Key' })}\n`);
  res.write(`${JSON.stringify({ code: TTS_DONE_CODE, data: null })}\n`);
  res.end();
}, async (port) => {
  const adapter = makeAdapter(port, {
    model: MODEL('audio', 'doubao-seed-tts-2-0'), ctx: makeCtx(fakeAttachments()),
    media: { ttsEndpoint: `http://127.0.0.1:${port}/tts` },
  });
  await expectError(adapter.stream(OPTIONS('你好')), 'PROVIDER_ERROR', /45000010/);
});

// 语音：只有终止码没有音频 → PROVIDER_ERROR（空产物不算成功）。
await withServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(`${JSON.stringify({ code: TTS_DONE_CODE, data: null })}\n`);
  res.end();
}, async (port) => {
  const adapter = makeAdapter(port, {
    model: MODEL('audio', 'doubao-seed-tts-2-0'), ctx: makeCtx(fakeAttachments()),
    media: { ttsEndpoint: `http://127.0.0.1:${port}/tts` },
  });
  await expectError(adapter.stream(OPTIONS('你好')), 'PROVIDER_ERROR', /空音频/);
});

// 语音：二进制音频响应（OpenAI 兼容形态）→ 直接读字节，不能调 response.json()。
await withServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { 'content-type': 'audio/mpeg' });
  res.end(MP3);
}, async (port) => {
  const attachments = fakeAttachments();
  const adapter = makeAdapter(port, {
    model: MODEL('audio', 'doubao-seed-tts-2-0'), ctx: makeCtx(attachments),
    media: { ttsEndpoint: `http://127.0.0.1:${port}/audio/speech` },
  });
  const chunks = await collect(adapter.stream(OPTIONS('你好')));
  assert.equal(fileBlocks(chunks).length, 1);
  assert.equal(fileBlocks(chunks)[0].block.attachment.bytes, MP3.length);
});

// 语音：Content-Type 声称音频但实际是错误页 → 魔数校验拒收。
await withServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { 'content-type': 'audio/mpeg' });
  res.end(Buffer.from('{"code":45000010,"message":"Invalid X-Api-Key"}'));
}, async (port) => {
  const adapter = makeAdapter(port, {
    model: MODEL('audio', 'doubao-seed-tts-2-0'), ctx: makeCtx(fakeAttachments()),
    media: { ttsEndpoint: `http://127.0.0.1:${port}/audio/speech` },
  });
  await expectError(adapter.stream(OPTIONS('你好')), 'PROVIDER_ERROR', /不是有效音频/);
});

// ── 6. 向量：单 JSON，不支持 stream ──────────────────────────────────────
await withServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  assert.equal(req.url, '/api/plan/v3/embeddings');
  assert.equal(body.stream, undefined);
  json(res, { data: [{ embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 3, total_tokens: 3 } });
}, async (port) => {
  const attachments = fakeAttachments();
  const save = attachments.saveFile.bind(attachments);
  attachments.saveFile = async (file) => {
    assert.deepEqual(JSON.parse(Buffer.from(file.data).toString()), [0.1, 0.2, 0.3]);
    return save(file);
  };
  const adapter = makeAdapter(port, { model: MODEL('embedding', 'doubao-embedding'), ctx: makeCtx(attachments) });
  const chunks = await collect(adapter.stream(OPTIONS('文本')));
  assert.match(textOf(chunks), /向量维度: 3/);
  assert.equal(fileBlocks(chunks).length, 1);
  assert.match(attachments.saved[0].name, /\.json$/);
  assert.equal(chunks.find((c) => c.type === 'usage').usage.inputTokens, 3);
  assert.equal(finishOf(chunks)?.kind, 'stop');
  const noAttachments = makeAdapter(port, { model: MODEL('embedding', 'doubao-embedding'), ctx: makeCtx() });
  assert.match(textOf(await collect(noAttachments.stream(OPTIONS('文本')))), /\[0\.1,0\.2,0\.3\]/);
});

// ── 7. 取消 / 空闲超时：多模态路线同样不能挂死或伪装成功 ────────────────────
// 视频轮询期间用户取消 → ABORTED 且立刻返回。
await withServer(async (req, res) => {
  if (req.method === 'POST') { await readBody(req); json(res, { id: 'cancel-1' }); return; }
  json(res, { id: 'cancel-1', status: 'running' });
}, async (port) => {
  const adapter = makeAdapter(port, {
    model: MODEL('video', 'doubao-seedance-2-0'), ctx: makeCtx(fakeAttachments()),
    requestTimeoutMs: 5000, media: { videoPollIntervalMs: 20, videoMaxWaitMs: 60000 },
  });
  const controller = new AbortController();
  const started = Date.now();
  const promise = expectError(adapter.stream({ ...OPTIONS(), signal: controller.signal }), 'ABORTED');
  setTimeout(() => controller.abort(), 80);
  await promise;
  assert.ok(Date.now() - started < 2000, '取消必须立刻生效，不能等总时限');
});

// 语音流卡死（headers 已到、body 不动）→ 空闲超时报 TIMEOUT。
await withServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.write(`${JSON.stringify({ code: 0, data: b64(MP3) })}\n`);
  // 之后既不写终止码也不结束响应。
}, async (port) => {
  const adapter = makeAdapter(port, {
    model: MODEL('audio', 'doubao-seed-tts-2-0'), ctx: makeCtx(fakeAttachments()),
    requestTimeoutMs: 300, media: { ttsEndpoint: `http://127.0.0.1:${port}/tts` },
  });
  const started = Date.now();
  await expectError(adapter.stream(OPTIONS('你好')), 'TIMEOUT');
  assert.ok(Date.now() - started < 3000, '空闲超时必须真的中止读取');
});

// 图片流：两张图之间间隔较长但持续有事件 → 不能被空闲超时掐断（续命回归）。
await withServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\r\n\r\n`);
  for (let i = 0; i < 4; i += 1) {
    send({ type: 'image_generation.partial_succeeded', image_index: i, b64_json: b64(PNG) });
    await sleep(90);
  }
  send({ type: 'image_generation.completed', usage: { generated_images: 4, output_tokens: 400, total_tokens: 400 } });
  res.end();
}, async (port) => {
  const adapter = makeAdapter(port, {
    model: MODEL('images', 'doubao-seedream-4-5'), ctx: makeCtx(fakeAttachments()), requestTimeoutMs: 250,
  });
  const chunks = await collect(adapter.stream(OPTIONS()));
  assert.equal(fileBlocks(chunks).length, 4, '持续有事件的长生图不能被空闲超时掐断');
  assert.equal(finishOf(chunks)?.kind, 'stop');
});

// ── 8. usage 记账：多模态 usage 要进 AFP 账本 ─────────────────────────────
await withServer(async (req, res) => {
  await readBody(req);
  json(res, { data: [{ b64_json: b64(PNG) }], usage: { generated_images: 1, output_tokens: 16384, total_tokens: 16384 } });
}, async (port) => {
  const recorded = [];
  const quota = { peek: () => ({ ok: false, windows: [] }), recordUsage: (u) => recorded.push(u) };
  const adapter = makeAdapter(port, { model: MODEL('images', 'doubao-seedream-5-0-pro'), ctx: makeCtx(fakeAttachments()), quota });
  await collect(adapter.stream(OPTIONS()));
  assert.equal(recorded.length, 1, '多模态 usage 必须记账');
  assert.equal(recorded[0].outputTokens, 16384);
  assert.equal(recorded[0].model, 'doubao-seedream-5-0-pro');
});

// ── 9. 落库失败必须降级（不能伪造引用，也不能把整轮判失败）──────────────────
// 附件后端不支持 verbatim 存储 → 只给 https 文本链接。
await withServer(async (req, res) => {
  if (req.url === '/x.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return; }
  await readBody(req);
  json(res, { data: [{ url: 'https://img.example.com/x.png' }], usage: { generated_images: 1 } });
}, async (port) => {
  const ctx = makeCtx(fakeAttachments({ fail: true }));
  const adapter = makeAdapter(port, {
    model: MODEL('images', 'doubao-seedream-5-0-pro'), ctx, fetchImpl: localMedia(port),
  });
  const chunks = await collect(adapter.stream(OPTIONS()));
  assert.equal(fileBlocks(chunks).length, 0, '落库失败时不得发 file 块');
  assert.match(textOf(chunks), /图片已生成：https:\/\/img\.example\.com\/x\.png/);
  assert.equal(finishOf(chunks)?.kind, 'stop', '落库失败是降级，不是整轮失败');
  assert.ok(ctx.warnings.some((w) => w.includes('媒体落库失败')), '降级要留 warn');
});

// 附件服务返回非法引用（自造 id）→ storeMediaFile 必须拒收，不能把坏引用发给宿主。
await withServer(async (req, res) => {
  await readBody(req);
  json(res, { data: [{ b64_json: b64(PNG) }] });
}, async (port) => {
  const ctx = makeCtx(fakeAttachments({ badRef: true }));
  const adapter = makeAdapter(port, { model: MODEL('images', 'doubao-seedream-5-0-pro'), ctx });
  const chunks = await collect(adapter.stream(OPTIONS()));
  assert.equal(fileBlocks(chunks).length, 0, '非法引用必须被拒收');
  assert.ok(ctx.warnings.some((w) => w.includes('非法引用')));
  assert.equal(finishOf(chunks)?.kind, 'stop');
});

// 视频下载回来的不是视频（200 + 错误页）→ 魔数拒收，降级给链接，不存坏 .mp4。
await withServer(async (req, res) => {
  if (req.url === '/bad.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(Buffer.from('<html>error</html>')); return; }
  if (req.method === 'POST') { await readBody(req); json(res, { id: 'bad-1' }); return; }
  json(res, { id: 'bad-1', status: 'succeeded', duration: 5, content: { video_url: 'https://media.example.com/bad.mp4' } });
}, async (port) => {
  const ctx = makeCtx(fakeAttachments());
  const adapter = makeAdapter(port, {
    model: MODEL('video', 'doubao-seedance-2-0'), ctx,
    media: { videoPollIntervalMs: 10, videoMaxWaitMs: 5000 }, fetchImpl: localMedia(port),
  });
  const chunks = await collect(adapter.stream(OPTIONS('猫')));
  assert.equal(fileBlocks(chunks).length, 0, '错误页不能存成 .mp4');
  assert.match(textOf(chunks), /https:\/\/media\.example\.com\/bad\.mp4/);
  assert.ok(ctx.warnings.some((w) => w.includes('不是有效视频')));
});

console.log('\nmultimodal.test.mjs: 全部断言通过');
