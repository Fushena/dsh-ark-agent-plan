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
      tts: { enabled: true, model: 'ep-tts' },
    },
    fetchImpl: async () => {},
  });
  assert.equal(tools.length, 3);
  assert.equal(tools[0].name, 'ark_generate_image');
  assert.equal(tools[1].name, 'ark_generate_video');
  assert.equal(tools[2].name, 'ark_text_to_speech');
}

// enabled 但 model 为空 → 不注册
{
  const tools = createArkTools({
    ctx: {},
    config: { imageGeneration: { enabled: true, model: '' } },
    fetchImpl: async () => {},
  });
  assert.equal(tools.length, 0);
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
    config: { enabled: true, model: 'ep-img-test', defaultSize: '1024x1024', defaultQuality: 'standard' },
    fetchImpl: mockFetch,
  });
  assert.ok(tool);
  const result = await tool.execute({ prompt: '一只猫', size: '512x512' });
  const parsed = JSON.parse(result);
  assert.equal(parsed.success, true);
  assert.equal(parsed.images.length, 1);
  assert.equal(parsed.images[0].url, 'https://img.example.com/1.png');
  assert.ok(capturedUrl.includes('/images/generations'));
  assert.equal(capturedBody.model, 'ep-img-test');
  assert.equal(capturedBody.prompt, '一只猫');
  assert.equal(capturedBody.size, '512x512');
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
  const parsed = JSON.parse(result);
  assert.equal(parsed.success, true);
  assert.equal(parsed.taskId, 'task-123');
  assert.equal(parsed.videoUrl, 'https://vid.example.com/out.mp4');
}

console.log('✔ ark_generate_video: 创建任务 + 轮询 + 返回视频 URL');

// TTS 工具：自动落盘 + 给文件（对话无法内嵌播放音频）
{
  let capturedBody;
  const audioBytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04]); // ID3 头假 MP3
  const mockFetch = async (url, init) => {
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: audioBytes.toString('base64') }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
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
      config: { enabled: true, model: 'ep-tts-test', defaultVoice: 'zh_female_cancan_mars_bigtts' },
      fetchImpl: mockFetch,
    });
    assert.ok(tool);
    const result = await tool.execute({ text: '你好世界', speed_ratio: 1.5 });
    const parsed = JSON.parse(result);
    assert.equal(parsed.success, true);
    assert.equal(parsed.format, 'mp3');
    assert.ok(parsed.path.startsWith(dir), '文件应落在工作目录');
    assert.ok(parsed.path.endsWith('.mp3'));
    assert.equal(parsed.bytes, audioBytes.length);
    assert.equal(parsed.characters, 4);
    const onDisk = await readFile(parsed.path);
    assert.deepEqual(onDisk, audioBytes, '落盘字节应与上游 base64 解码一致');
    assert.ok(!parsed.path.includes('..'));
    assert.equal(capturedBody.model, 'ep-tts-test');
    assert.equal(capturedBody.input, '你好世界');
    assert.equal(capturedBody.speed_ratio, 1.5);
    // 空文本 / 超长文本拒绝（不打 API）
    await assert.rejects(() => tool.execute({ text: '   ' }), /不能为空/);
    await assert.rejects(() => tool.execute({ text: 'x'.repeat(10_001) }), /上限/);
    // 上游空音频报错且不留半截文件
    const emptyTool = createTtsTool({
      ctx: mockCtx,
      config: { enabled: true, model: 'ep-tts-test' },
      fetchImpl: async () => new Response(JSON.stringify({ data: '' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await assert.rejects(() => emptyTool.execute({ text: '测试' }), /空的音频数据/);
    const { readdir } = await import('node:fs/promises');
    const leftovers = (await readdir(dir)).filter((f) => f.endsWith('.part'));
    assert.equal(leftovers.length, 0, '失败路径不得留下 .part 临时文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log('✔ ark_text_to_speech: 自动落盘 + 给文件 + 输入校验 + 失败清理');

console.log('\nmcp-tools.test.mjs: 全部断言通过');
