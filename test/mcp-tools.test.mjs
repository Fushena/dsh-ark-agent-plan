import assert from 'node:assert/strict';

/**
 * MCP tool 声明归一化 + Responses 请求体合并 + Ark 工具工厂 回归测试。
 *
 * 覆盖：
 *   1. mcpToolDeclarations 的归一化逻辑（过滤空项、透传字段、headers 保留）
 *   2. buildRequestBody 把 MCP tools 追加到 tools 数组（不影响 function/builtin 仲裁）
 *   3. createArkTools 工厂按 config.enabled 过滤
 *   4. 各工具 execute 的注入式 fetch 调用（用 mock fetch 验证请求体）
 */

const { mcpToolDeclarations, buildRequestBody, expandCredentialTemplates, expandMcpHeaders, isPrivateHostLiteral } = await import('../lib/content.js');
const { createArkTools, createImageGenerationTool, createVideoGenerationTool, createTtsTool } = await import('../lib/ark-tools.js');
// 宿主真实校验器：output.schema 必须落在 DSH 支持的 JSON Schema 子集内，
// 且 execute 的返回值必须过得了 output.schema —— 这两条就是注册与派发的实际闸门。
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
const { mkdtemp, readFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

// ── 1. mcpToolDeclarations 归一化 ──────────────────────────────────

// 空数组 / undefined / null → []
assert.deepEqual(mcpToolDeclarations([]), []);
assert.deepEqual(mcpToolDeclarations(undefined), []);
assert.deepEqual(mcpToolDeclarations(null), []);

// 过滤缺 server_url 的项
assert.deepEqual(mcpToolDeclarations([{ server_label: 'x' }]), []);
assert.deepEqual(mcpToolDeclarations([{ server_url: '' }]), []);
assert.deepEqual(mcpToolDeclarations([null, undefined, 42]), []);

// 正常项归一化
{
  const result = mcpToolDeclarations([
    { server_url: ' https://mcp.example.com/sse ', server_label: 'my-server', headers: { Authorization: 'Bearer ${credential:MY_KEY}' } },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'mcp');
  assert.equal(result[0].server_url, 'https://mcp.example.com/sse');
  assert.equal(result[0].server_label, 'my-server');
  assert.deepEqual(result[0].headers, { Authorization: 'Bearer ${credential:MY_KEY}' });
}

// 白名单内的可选字段透传；require_approval:false 是 schema 默认值，不声明
{
  const result = mcpToolDeclarations([
    { server_url: 'https://mcp.example.com', allowed_tools: ['search'], require_approval: 'never' },
  ]);
  assert.equal(result[0].allowed_tools[0], 'search');
  assert.equal(result[0].require_approval, 'never');
  const minimal = mcpToolDeclarations([
    { server_url: 'https://mcp.example.com', allowed_tools: [], require_approval: false },
  ]);
  assert.equal(minimal[0].allowed_tools, undefined);
  assert.equal(minimal[0].require_approval, undefined);
}

// 未知字段不透传（配置面白名单收敛）
{
  const result = mcpToolDeclarations([
    { server_url: 'https://mcp.example.com', evil_field: { x: 1 }, type: 'function' },
  ]);
  assert.equal(result[0].evil_field, undefined);
  assert.equal(result[0].type, 'mcp'); // type 不可被配置覆盖
}

console.log('✔ mcpToolDeclarations: 归一化逻辑正确');

// ── 1b. server_url 安全闸（https + 非私网/本机） ─────────────────────

{
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };
  const bad = [
    'http://mcp.example.com/sse',          // 非 https
    'file:///etc/passwd',                   // 非网络协议
    'ftp://mcp.example.com',
    'not a url',
    'https://localhost/mcp',
    'https://127.0.0.1/mcp',
    'https://10.1.2.3/mcp',
    'https://192.168.1.10/mcp',
    'https://172.16.0.1/mcp',
    'https://169.254.1.1/mcp',
    'https://[::1]/mcp',
    'https://0.0.0.0/mcp',
    'https://foo.localhost/mcp',
  ];
  for (const url of bad) {
    assert.deepEqual(mcpToolDeclarations([{ server_url: url }], logger), [], `应拒绝 ${url}`);
  }
  assert.equal(warnings.length, bad.length);
  // 合法项不受影响；混合列表只丢坏项
  const mixed = mcpToolDeclarations([
    { server_url: 'http://bad.example' },
    { server_url: 'https://good.example/sse' },
  ], logger);
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].server_url, 'https://good.example/sse');
  // 私网字面量判定函数本体
  assert.equal(isPrivateHostLiteral('100.64.0.1'), true);   // CGNAT
  assert.equal(isPrivateHostLiteral('8.8.8.8'), false);
  assert.equal(isPrivateHostLiteral('mcp.example.com'), false);
  assert.equal(isPrivateHostLiteral('[fe80::1]'), true);    // link-local IPv6
  assert.equal(isPrivateHostLiteral('::ffff:192.168.1.1'), true); // IPv4-mapped
}

console.log('✔ mcpToolDeclarations: 不安全 server_url 被拒绝并记 warn');

// ── 1c. ${credential:REF} 模板展开 ──────────────────────────────────

{
  const credCtx = {
    get: (name) => name === 'credentials'
      ? { resolve: async (ref) => ({ value: `SECRET_${String(ref)}` }) }
      : undefined,
  };
  // 无模板原样返回
  assert.equal(await expandCredentialTemplates('Bearer plain', credCtx, 'test'), 'Bearer plain');
  // 单模板 / 多模板 / 同引用重复
  assert.equal(await expandCredentialTemplates('Bearer ${credential:MY_KEY}', credCtx, 'test'), 'Bearer SECRET_MY_KEY');
  assert.equal(
    await expandCredentialTemplates('${credential:A}:${credential:B}/${credential:A}', credCtx, 'test'),
    'SECRET_A:SECRET_B/SECRET_A',
  );
  // headers 逐项展开，返回新数组不改原声明
  const decls = mcpToolDeclarations([
    { server_url: 'https://mcp.example.com', headers: { Authorization: 'Bearer ${credential:MY_KEY}', 'X-Plain': 'static' } },
  ]);
  const expanded = await expandMcpHeaders(decls, credCtx, 'test');
  assert.equal(expanded[0].headers.Authorization, 'Bearer SECRET_MY_KEY');
  assert.equal(expanded[0].headers['X-Plain'], 'static');
  assert.equal(decls[0].headers.Authorization, 'Bearer ${credential:MY_KEY}'); // 原声明未被改
  // 解析不到的引用 fail-closed 抛错（不发字面量给上游）
  const emptyCtx = { get: () => undefined };
  const savedEnv = process.env.NO_SUCH_REF_XYZ;
  delete process.env.NO_SUCH_REF_XYZ;
  await assert.rejects(
    () => expandCredentialTemplates('${credential:NO_SUCH_REF_XYZ}', emptyCtx, 'test'),
    /MISSING_CREDENTIAL|缺少 API Key/,
  );
  if (savedEnv !== undefined) process.env.NO_SUCH_REF_XYZ = savedEnv;
  // 环境变量兜底
  process.env.TTS_TEST_REF_XYZ = 'env-secret';
  assert.equal(await expandCredentialTemplates('k=${credential:TTS_TEST_REF_XYZ}', emptyCtx, 'test'), 'k=env-secret');
  delete process.env.TTS_TEST_REF_XYZ;
}

console.log('✔ expandCredentialTemplates: 模板展开 + fail-closed + env 兜底');

// ── 2. buildRequestBody 合并 MCP tools ──────────────────────────────

// 辅助：最小可用的 buildRequestBody 调用参数
function minimalOptions(tools = []) {
  return {
    system: 'test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools,
    maxTokens: 1024,
  };
}
function minimalModel() {
  return { id: 'test-model', reasoning: false, input: ['text'], maxTokens: 4096 };
}

// 无 MCP 时 tools 只有 function + builtin
{
  const body = await buildRequestBody(
    minimalOptions([{ name: 'my_tool', description: 'test', parameters: {} }]),
    minimalModel(), undefined, ['web_search'], 'high', undefined,
  );
  assert.equal(body.tools.length, 2); // 1 function + 1 builtin
  assert.equal(body.tools[0].type, 'function');
  assert.equal(body.tools[1].type, 'web_search');
}

// 有 MCP 时追加到 tools 数组
{
  const mcpTools = mcpToolDeclarations([{ server_url: 'https://mcp.example.com' }]);
  const body = await buildRequestBody(
    minimalOptions([{ name: 'my_tool', description: 'test', parameters: {} }]),
    minimalModel(), undefined, ['web_search'], 'high', mcpTools,
  );
  assert.equal(body.tools.length, 3); // 1 function + 1 builtin + 1 mcp
  assert.equal(body.tools[2].type, 'mcp');
  assert.equal(body.tools[2].server_url, 'https://mcp.example.com');
}

// 同名 function 让位给 builtin 的规则不受 MCP 影响
{
  const mcpTools = mcpToolDeclarations([{ server_url: 'https://mcp.example.com' }]);
  const body = await buildRequestBody(
    minimalOptions([{ name: 'web_search', description: 'local', parameters: {} }]),
    minimalModel(), undefined, ['web_search'], 'high', mcpTools,
  );
  // web_search function 被让位，只剩 builtin web_search + mcp
  assert.equal(body.tools.length, 2);
  assert.equal(body.tools[0].type, 'web_search');
  assert.equal(body.tools[1].type, 'mcp');
}

console.log('✔ buildRequestBody: MCP tools 正确合并到 tools 数组');

// ── 3. createArkTools 工厂 ──────────────────────────────────────────

// 全部未启用 → 空数组
{
  const tools = createArkTools({ ctx: {}, config: {}, fetchImpl: async () => {} });
  assert.equal(tools.length, 0);
}

// 只启用生图
{
  const tools = createArkTools({
    ctx: {},
    config: { imageGeneration: { enabled: true, model: 'ep-test' } },
    fetchImpl: async () => {},
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ark_generate_image');
}

// 全部启用
{
  const tools = createArkTools({
    ctx: {},
    config: {
      imageGeneration: { enabled: true, model: 'ep-img' },
      videoGeneration: { enabled: true, model: 'ep-vid' },
      tts: { enabled: true },
    },
    fetchImpl: async () => {},
  });
  assert.equal(tools.length, 3);
  assert.equal(tools[0].name, 'ark_generate_image');
  assert.equal(tools[1].name, 'ark_generate_video');
  assert.equal(tools[2].name, 'ark_text_to_speech');
}

// enabled 但 model 为空 → 不注册（生图/生视频必须指定 endpoint）
{
  const tools = createArkTools({
    ctx: {},
    config: { imageGeneration: { enabled: true, model: '' } },
    fetchImpl: async () => {},
  });
  assert.equal(tools.length, 0);
}

// A2：语音走 openspeech 资源路由，请求体不带 model —— 只要 enabled 就能注册。
{
  const tools = createArkTools({
    ctx: {},
    config: { tts: { enabled: true } },
    fetchImpl: async () => {},
  });
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'ark_text_to_speech');
}

console.log('✔ createArkTools: 按 config.enabled + model 过滤');

// ── 4. 工具 execute 的 mock fetch 验证 ──────────────────────────────

// 生图工具
{
  let capturedUrl, capturedBody;
  const mockFetch = async (url, init) => {
    capturedUrl = url;
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({
      created: Date.now(),
      data: [{ url: 'https://img.example.com/1.png' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const mockCtx = {
    get: (name) => name === 'credentials'
      ? { resolve: async () => ({ value: 'TEST_ARK_KEY' }) }
      : undefined,
  };
  const tool = createImageGenerationTool({
    ctx: mockCtx,
    config: { enabled: true, model: 'ep-img-test', defaultSize: '2K' },
    fetchImpl: mockFetch,
  });
  assert.ok(tool);
  const result = await tool.execute({ prompt: '一只猫', size: '2048x2048' });
  assert.equal(result.success, true);
  assert.equal(result.images.length, 1);
  assert.equal(result.images[0].url, 'https://img.example.com/1.png');
  assert.ok(capturedUrl.includes('/images/generations'));
  assert.equal(capturedBody.model, 'ep-img-test');
  assert.equal(capturedBody.prompt, '一只猫');
  assert.equal(capturedBody.size, '2048x2048');
  // A2：官方图片参数表没有 quality（发了就是上游不认的字段）。
  assert.equal(capturedBody.quality, undefined);
}

console.log('✔ ark_generate_image: 请求体和返回值正确');

// 生视频工具
{
  let callCount = 0;
  const mockFetch = async (url, init) => {
    callCount++;
    if (init?.body) {
      // 创建任务
      const body = JSON.parse(init.body);
      assert.equal(body.model, 'ep-vid-test');
      return new Response(JSON.stringify({ id: 'task-123', status: 'queued' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    // 查询任务 — 第一次 running，第二次 succeeded
    if (callCount <= 2) {
      return new Response(JSON.stringify({ id: 'task-123', status: 'running' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      id: 'task-123', status: 'succeeded',
      content: { video_url: 'https://vid.example.com/out.mp4' },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const mockCtx = {
    get: (name) => name === 'credentials'
      ? { resolve: async () => ({ value: 'TEST_ARK_KEY' }) }
      : undefined,
  };
  const tool = createVideoGenerationTool({
    ctx: mockCtx,
    config: {
      enabled: true, model: 'ep-vid-test',
      pollIntervalSeconds: 0.01, maxWaitSeconds: 10,
    },
    fetchImpl: mockFetch,
  });
  assert.ok(tool);
  const result = await tool.execute({ prompt: '一段日落视频', duration: 5 });
  assert.equal(result.success, true);
  assert.equal(result.taskId, 'task-123');
  assert.equal(result.videoUrl, 'https://vid.example.com/out.mp4');
}

console.log('✔ ark_generate_video: 创建任务 + 轮询 + 返回视频 URL');

// TTS 工具：真实语音协议（openspeech 逐行 JSON + 终止码）+ 自动落盘 + 给文件
{
  let capturedUrl, capturedHeaders, capturedBody;
  const audioBytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]); // ID3 头假 MP3
  // 官方 HTTP Chunked 形态：若干 {code:0,data:base64} 分片 + {code:20000000} 终止。
  const half = Math.ceil(audioBytes.length / 2);
  const ndjson = [
    JSON.stringify({ code: 0, message: 'OK', data: audioBytes.subarray(0, half).toString('base64') }),
    JSON.stringify({ code: 0, message: 'OK', data: audioBytes.subarray(half).toString('base64') }),
    JSON.stringify({ code: 20000000, message: 'ok', data: null, usage: { text_words: 4 } }),
  ].join('\n');
  const mockFetch = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return new Response(ndjson, { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const dir = await mkdtemp(join(tmpdir(), 'ark-tts-test-'));
  try {
    const mockCtx = {
      get: (name) => name === 'credentials'
        ? { resolve: async () => ({ value: 'TEST_ARK_KEY' }) }
        : name === 'workingDirectory'
          ? { defaultDirectory: () => dir }
          : undefined,
    };
    const tool = createTtsTool({
      ctx: mockCtx,
      config: { enabled: true },
      fetchImpl: mockFetch,
    });
    assert.ok(tool);
    const result = await tool.execute({ text: '你好世界', speed_ratio: 1.5 });
    assert.equal(result.success, true);
    assert.equal(result.format, 'mp3');
    assert.ok(result.path.startsWith(dir), '文件应落在工作目录');
    assert.ok(result.path.endsWith('.mp3'));
    assert.equal(result.bytes, audioBytes.length);
    assert.equal(result.characters, 4);
    const onDisk = await readFile(result.path);
    assert.deepEqual(onDisk, audioBytes, '落盘字节应与上游分片拼接一致');
    assert.ok(!result.path.includes('..'));
    // A2：端点/鉴权头/请求体都必须是官方语音接口的形状，不是 ark /audio/speech。
    assert.equal(capturedUrl, 'https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional');
    assert.equal(capturedHeaders['X-Api-Key'], 'TEST_ARK_KEY');
    assert.equal(capturedHeaders['X-Api-Resource-Id'], 'seed-tts-2.0');
    assert.ok(capturedHeaders['X-Api-Request-Id'], 'X-Api-Request-Id 必填');
    assert.equal(capturedHeaders.Authorization, undefined, '语音接口不用 Bearer');
    assert.equal(capturedBody.req_params.text, '你好世界');
    assert.equal(capturedBody.req_params.audio_params.format, 'mp3');
    assert.equal(capturedBody.req_params.audio_params.sample_rate, 24000);
    // 官方语速字段是整数 speech_rate（1.5 倍 → 50），没有 speed_ratio。
    assert.equal(capturedBody.req_params.audio_params.speech_rate, 50);
    assert.equal(capturedBody.speed_ratio, undefined);
    assert.equal(capturedBody.input, undefined);
    assert.equal(capturedBody.model, undefined);
    // 空文本 / 超长文本拒绝（不打 API）
    await assert.rejects(() => tool.execute({ text: '   ' }), /不能为空/);
    await assert.rejects(() => tool.execute({ text: 'x'.repeat(10_001) }), /上限/);
    // 只有终止码没有音频 → 报错，不留半截文件
    const emptyTool = createTtsTool({
      ctx: mockCtx,
      config: { enabled: true },
      fetchImpl: async () => new Response(JSON.stringify({ code: 20000000, data: null }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }),
    });
    await assert.rejects(() => emptyTool.execute({ text: '测试' }), /空音频/);
    const { readdir } = await import('node:fs/promises');
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.part'));
    assert.equal(leftovers.length, 0, '失败路径不得留下 .part 临时文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('✔ ark_text_to_speech: 真实语音协议 + 自动落盘 + 输入校验 + 失败清理');

// ── 5. A1（2026-11-24 审计）：宿主注册契约 + 运行时钳制 ───────────────
//
// 宿主 ctx.tools.register(definition) 硬性要求 output { schema, render }，
// 缺一个就 throw TypeError → index.js 只记一条 warn，工具根本不存在。
// 宿主派发管线还会用 output.schema 校验 execute 的返回值（string 过不了 object）。
// 另外宿主**不校验 parameters**（minimum/maximum 甚至不是支持的关键字），
// 所以越界值必须在 execute 内部钳制，不能指望 schema 挡住。

const arkMockCtx = {
  get: (name) => (name === 'credentials' ? { resolve: async () => ({ value: 'TEST_ARK_KEY' }) } : undefined),
};
const jsonResponse = (payload) => new Response(JSON.stringify(payload), {
  status: 200, headers: { 'content-type': 'application/json' },
});

// 5.1 三个工具都必须声明 output{schema,render} + timeoutMs，且 schema 在宿主子集内。
{
  const image = createImageGenerationTool({
    ctx: arkMockCtx, config: { enabled: true, model: 'ep-img' }, fetchImpl: async () => jsonResponse({ data: [] }),
  });
  const video = createVideoGenerationTool({
    ctx: arkMockCtx, config: { enabled: true, model: 'ep-vid' }, fetchImpl: async () => jsonResponse({ id: 't' }),
  });
  const tts = createTtsTool({
    ctx: arkMockCtx, config: { enabled: true }, fetchImpl: async () => jsonResponse({ code: 20000000, data: null }),
  });
  for (const tool of [image, video, tts]) {
    assert.ok(tool?.output, `A1: ${tool?.name} 必须声明 output（否则宿主 register 抛 TypeError）`);
    assert.equal(typeof tool.output.render, 'function', `A1: ${tool.name} output.render 必须是函数`);
    assert.doesNotThrow(
      () => assertSupportedJsonSchema(tool.output.schema),
      `A1: ${tool.name} output.schema 必须落在宿主支持的 JSON Schema 子集内`,
    );
    assert.ok(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0, `A1: ${tool.name} 必须声明正数 timeoutMs`);
    // render 必须产出宿主能渲染的块（text 块数组），且不抛错。
    const blocks = tool.output.render({}, {});
    assert.ok(Array.isArray(blocks) && blocks.length > 0, `A1: ${tool.name} render 应返回非空块数组`);
    for (const block of blocks) {
      assert.equal(block.type, 'text');
      assert.equal(typeof block.text, 'string');
    }
  }
}
console.log('✔ A1: 三工具 output{schema,render} + timeoutMs 齐备且过宿主 schema 子集校验');

// 5.2 execute 必须返回**对象**且过得了自己的 output.schema（宿主派发时就是这么校验的）。
{
  const tool = createImageGenerationTool({
    ctx: arkMockCtx,
    config: { enabled: true, model: 'ep-img' },
    fetchImpl: async () => jsonResponse({ data: [{ url: 'https://img.example.com/a.png' }] }),
  });
  const value = await tool.execute({ prompt: '一只猫' });
  assert.equal(typeof value, 'object', 'A1: execute 必须返回对象，不能是 JSON 字符串');
  assert.ok(value !== null);
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [], 'A1: 生图返回值必须过 output.schema');
  assert.equal(value.success, true);
  assert.equal(value.images[0].url, 'https://img.example.com/a.png');
}
{
  let calls = 0;
  const tool = createVideoGenerationTool({
    ctx: arkMockCtx,
    config: { enabled: true, model: 'ep-vid', pollIntervalSeconds: 0.01, maxWaitSeconds: 10 },
    fetchImpl: async (_url, init) => {
      calls++;
      if (init?.body) return jsonResponse({ id: 'task-a1' });
      return jsonResponse({ id: 'task-a1', status: 'succeeded', content: { video_url: 'https://vid.example.com/a.mp4' } });
    },
  });
  const value = await tool.execute({ prompt: '日落' });
  assert.equal(typeof value, 'object', 'A1: 生视频 execute 必须返回对象');
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [], 'A1: 生视频返回值必须过 output.schema');
  assert.equal(value.videoUrl, 'https://vid.example.com/a.mp4');
}
{
  const dir = await mkdtemp(join(tmpdir(), 'ark-a1-tts-'));
  try {
    const ctx = {
      get: (name) => (name === 'credentials'
        ? { resolve: async () => ({ value: 'TEST_ARK_KEY' }) }
        : name === 'workingDirectory' ? { defaultDirectory: () => dir } : undefined),
    };
    const tool = createTtsTool({
      ctx,
      config: { enabled: true },
      fetchImpl: async () => new Response(
        `${JSON.stringify({ code: 0, data: Buffer.from([0x49, 0x44, 0x33, 0x04]).toString('base64') })}\n${JSON.stringify({ code: 20000000 })}\n`,
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    });
    const value = await tool.execute({ text: '你好' });
    assert.equal(typeof value, 'object', 'A1: TTS execute 必须返回对象');
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [], 'A1: TTS 返回值必须过 output.schema');
    assert.equal(value.bytes, 4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
console.log('✔ A1: 三工具 execute 返回对象且通过宿主 validateJsonSchemaValue');

// 5.3 运行时钳制：宿主不校验 parameters，越界值不得直达计费 API。
{
  let body;
  const tool = createImageGenerationTool({
    ctx: arkMockCtx,
    config: { enabled: true, model: 'ep-img' },
    fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return jsonResponse({ data: [] }); },
  });
  for (const [input, expected] of [[99, 4], [0, 1], [-3, 1], [2.5, undefined], ['3', undefined], [undefined, undefined], [NaN, undefined]]) {
    await tool.execute({ prompt: 'x', n: input });
    assert.equal(body.n, expected, `A1/#7: n=${String(input)} 应钳制或省略为 ${String(expected)}（实际 ${body.n}）`);
  }
  await tool.execute({ prompt: 'x', n: 3 });
  assert.equal(body.n, 3, 'A1: 合法 n 应原样透传');
}
{
  let body;
  const tool = createVideoGenerationTool({
    ctx: arkMockCtx,
    config: { enabled: true, model: 'ep-vid', pollIntervalSeconds: 0.01, maxWaitSeconds: 10 },
    fetchImpl: async (_url, init) => {
      if (init?.body) { body = JSON.parse(init.body); return jsonResponse({ id: 'task-clamp' }); }
      return jsonResponse({ id: 'task-clamp', status: 'succeeded', content: { video_url: 'https://v/x.mp4' } });
    },
  });
  // A2：官方时长范围是 4~30（2.5 系）/4~15（2.0 系）+ -1（模型自选），
  // 旧 enum[5,10] 把合法值全挡了；越界/非整数仍要回落默认值。
  for (const [input, expected] of [[999, 5], [3, 5], ['10', 5], [undefined, 5], [NaN, 5], [7.5, 5]]) {
    const value = await tool.execute({ prompt: 'x', duration: input });
    assert.equal(body.duration, expected, `A2: duration=${String(input)} 应回落到 ${expected}（实际 ${body.duration}）`);
    assert.equal(value.duration, expected, 'A2: 返回的 duration 必须与实际请求一致');
  }
  for (const legal of [10, 15, 30, -1]) {
    const value = await tool.execute({ prompt: 'x', duration: legal });
    assert.equal(body.duration, legal, `A2: 官方合法 duration=${legal} 应原样透传`);
    assert.equal(value.duration, legal);
  }
}
{
  const dir = await mkdtemp(join(tmpdir(), 'ark-a1-clamp-'));
  try {
    let body;
    const ctx = {
      get: (name) => (name === 'credentials'
        ? { resolve: async () => ({ value: 'TEST_ARK_KEY' }) }
        : name === 'workingDirectory' ? { defaultDirectory: () => dir } : undefined),
    };
    const tool = createTtsTool({
      ctx,
      config: { enabled: true },
      fetchImpl: async (_url, init) => {
        body = JSON.parse(init.body);
        return new Response(
          `${JSON.stringify({ code: 0, data: Buffer.from([0x49, 0x44, 0x33]).toString('base64') })}\n${JSON.stringify({ code: 20000000 })}\n`,
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    // 倍率越界夹到边界（-1 → 0.5、99 → 2.0）；非数字/非有限值回落 1.0。
    // 官方字段是整数 speech_rate：1.0→不发（服务端默认）、1.5→50、2.0→100、0.5→-50。
    for (const [input, expectedRatio] of [[99, 2], [0.01, 0.5], [-1, 0.5], ['1.5', 1], [undefined, 1], [NaN, 1]]) {
      await tool.execute({ text: 'x', speed_ratio: input });
      const rate = body.req_params.audio_params.speech_rate;
      const expectedRate = expectedRatio === 1 ? undefined : Math.round((expectedRatio - 1) * 100);
      assert.equal(rate, expectedRate, `A2: speed_ratio=${String(input)} 应换算成 speech_rate=${String(expectedRate)}（实际 ${String(rate)}）`);
      assert.equal(body.speed_ratio, undefined, 'A2: 官方请求体没有 speed_ratio 字段');
    }
    await tool.execute({ text: 'x', speed_ratio: 1.5 });
    assert.equal(body.req_params.audio_params.speech_rate, 50, 'A2: 合法倍率应换算后透传');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
console.log('✔ A1: n / duration / speed_ratio 运行时钳制（宿主不校验 parameters）');

// 5.4 必填提示词校验：空 prompt 不得打 API（宿主不校验 required）。
{
  let hit = false;
  const fetchImpl = async () => { hit = true; return jsonResponse({ data: [] }); };
  const image = createImageGenerationTool({ ctx: arkMockCtx, config: { enabled: true, model: 'ep-img' }, fetchImpl });
  await assert.rejects(() => image.execute({ prompt: '   ' }), /prompt/);
  await assert.rejects(() => image.execute({}), /prompt/);
  const video = createVideoGenerationTool({ ctx: arkMockCtx, config: { enabled: true, model: 'ep-vid' }, fetchImpl });
  await assert.rejects(() => video.execute({ prompt: '' }), /prompt/);
  assert.equal(hit, false, 'A1: 空 prompt 必须在打 API 之前被拒');
}
console.log('✔ A1: 空 prompt 在打 API 前被拒');

// 5.5 直接过宿主真实 register 闸门（不是"看起来像"，而是宿主自己判）。
// ToolsService.prototype.register 只做定义校验 + 插入，用最小 layers 桩即可驱动；
// 同时反证：摘掉 output 的裸定义必须被宿主拒绝 —— 这就是 A1 的根因形状。
{
  const { ToolsService } = await import('@deepseek-ai/dsh-tools');
  const inserted = [];
  const registryStub = {
    ctx: {},
    layers: { effect: (_ctx, fn) => { fn({ tools: { insert: (name) => { inserted.push(name); } } }); return () => {}; } },
  };
  const tools = createArkTools({
    ctx: arkMockCtx,
    config: {
      imageGeneration: { enabled: true, model: 'ep-img' },
      videoGeneration: { enabled: true, model: 'ep-vid' },
      tts: { enabled: true, model: 'ep-tts' },
    },
    fetchImpl: async () => jsonResponse({ data: [] }),
  });
  assert.equal(tools.length, 3);
  for (const tool of tools) {
    assert.doesNotThrow(
      () => ToolsService.prototype.register.call(registryStub, tool),
      `A1: 宿主 register 必须接受 ${tool.name}`,
    );
  }
  assert.deepEqual(inserted, ['ark_generate_image', 'ark_generate_video', 'ark_text_to_speech']);
  // 宿主把定义投影成模型可见的工具 schema（parameters 里的 minimum/maximum 只是提示，
  // 投影不得因此报错——这也是"必须自己在 execute 里钳制"的另一面）。
  const { projectToolSchema } = await import('@deepseek-ai/dsh-tools');
  for (const tool of tools) {
    const projected = projectToolSchema(tool);
    assert.equal(projected.name, tool.name);
    assert.ok(projected.parameters ?? projected.inputSchema, `A1: ${tool.name} 投影后应带参数 schema`);
  }
  // 反证：缺 output 的定义（修复前的形状）必须被宿主拒绝。
  const { output, ...bare } = tools[0];
  assert.throws(
    () => ToolsService.prototype.register.call(registryStub, bare),
    /must declare output/,
    'A1: 缺 output 的定义应被宿主 register 拒绝（修复前正是这条 TypeError 让工具注册不上）',
  );
}
console.log('✔ A1: 三工具通过宿主真实 ToolsService.register，裸定义被拒');

console.log('\nmcp-tools.test.mjs: 全部断言通过');
