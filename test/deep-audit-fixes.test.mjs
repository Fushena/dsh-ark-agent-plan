/**
 * 深度审计全量 High + Medium 缺陷回归测试。
 * 覆盖共享 5 项 + Ark 专项 6 项 High + 16 项 Medium 修复。
 */
import test from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import TimerService from '@deepseek-ai/cordis-plugin-timer';

// ── 临时隔离环境（在 import quota.js 之前设置）────────────────────────────
const TMP = fs.mkdtempSync('/tmp/ark-deep-audit-');
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME, { mode: 0o700 });
const BRIDGE = path.join(TMP, 'bridge'); fs.mkdirSync(BRIDGE, { mode: 0o700 });
const SOCK = path.join(BRIDGE, 'fake.sock');
process.env.DSH_HOME = HOME;
process.env.DSH_BRIDGE_DIR = BRIDGE;
process.env.DSH_BRIDGE_SOCK = SOCK;
process.env.DSH_BRIDGE_TOKEN = path.join(BRIDGE, 'token');
fs.writeFileSync(process.env.DSH_BRIDGE_TOKEN, `faketoken\n${SOCK}\n`, { mode: 0o600 });

const { trustedRouteRequest, normalizeBindHost, isLoopbackAddress } = await import('../lib/route-guard.js');
const { redactProxyUrl } = await import('../lib/proxy.js');
const { iterateSse, responsesToDshChunks } = await import('../lib/responses-sse.js');
const { buildChatRequestBody, chatToDshChunks } = await import('../lib/chat.js');
const { isPrivateHostLiteral, mcpToolDeclarations, expandCredentialTemplates } = await import('../lib/content.js');
const { iterateLines, safeHttpsUrl, downloadMedia, readSpeechAudio, TTS_DONE_CODE } = await import('../lib/media-io.js');
const { promptText, runMultimodal } = await import('../lib/multimodal.js');
const { waitVideoTask } = await import('../lib/ark-api.js');
const { createTtsTool } = await import('../lib/ark-tools.js');
const { ArkAgentPlanAdapter } = await import('../lib/adapter.js');
const { DynamicCatalog, servedMatches } = await import('../lib/catalog.js');
const { ArkQuota, harvestConsoleCookie, loadStoredCookie } = await import('../lib/quota.js');
const plugin = await import('../index.js');

const enc = new TextEncoder();
const streamFrom = (chunks) => new ReadableStream({
  start(controller) {
    for (const c of chunks) controller.enqueue(typeof c === 'string' ? enc.encode(c) : c);
    controller.close();
  },
});
const sseStream = (events) => streamFrom(events.map((e) => `data: ${JSON.stringify(e)}\n\n`));
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(16, 7)]);

// ── 假浏览器桥（用于 A-H4 Cookie 过滤与 ArkQuota.dispose() 测试）──────────
let bridgeCookies = [];
const liveTabs = new Map();
let nextTab = 900;
const server = net.createServer((sock) => {
  let acc = '';
  sock.on('data', (chunk) => {
    acc += chunk;
    const at = acc.indexOf('\n'); if (at < 0) return;
    const req = JSON.parse(acc.slice(0, at)); acc = acc.slice(at + 1);
    const reply = (result) => sock.write(JSON.stringify({ ok: true, result }) + '\n');
    if (req.op === 'tabs') return reply([...liveTabs.entries()].map(([id, t]) => ({ id, ...t })));
    if (req.op === 'open') {
      const id = nextTab++;
      liveTabs.set(id, { url: 'https://console.volcengine.com/ark', agentWindow: true });
      return reply({ tabId: id });
    }
    if (req.op === 'close') { liveTabs.delete(Number(req.args.tabId)); return reply({}); }
    if (req.op === 'detach') return reply({});
    if (req.op === 'cdp') {
      if (req.args.method === 'Runtime.evaluate') {
        return reply({ result: { result: { value: JSON.stringify({ ready: 'complete', url: 'https://console.volcengine.com/x', host: 'console.volcengine.com' }) } } });
      }
      return reply({ result: { result: { cookies: bridgeCookies } } });
    }
    return reply({});
  });
});
await new Promise((r) => server.listen(SOCK, r));
fs.chmodSync(SOCK, 0o600);
const cookieFile = path.join(HOME, '.ark-plan-console-cookie.json');
after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

// ── 1. Shared #1: route-guard.js ─────────────────────────────────────────
test('Shared #1: route-guard enforces remoteAddress loopback, wildcard bind rejection, strict Sec-Fetch-Site & Host/Origin', () => {
  // remoteAddress 校验
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000' }, socket: { remoteAddress: '192.168.1.50' } }).ok, false);
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000' }, socket: { remoteAddress: '127.0.0.1' } }).ok, true);
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000' }, socket: { remoteAddress: '::1' } }).ok, true);
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000' }, socket: { remoteAddress: '::ffff:127.0.0.1' } }).ok, true);
  assert.equal(isLoopbackAddress('localhost'), false);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.2'), true);

  // wildcard bind rejection + bare IPv6 support
  assert.equal(normalizeBindHost('0.0.0.0'), null);
  assert.equal(normalizeBindHost('::'), null);
  assert.equal(normalizeBindHost('0:0:0:0:0:0:0:0'), null);
  assert.equal(normalizeBindHost('::ffff:0.0.0.0'), null);
  assert.equal(normalizeBindHost('fd00::1'), 'fd00::1');

  // Sec-Fetch-Site 严格化
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000', 'sec-fetch-site': ['same-origin', 'cross-site'] } }).ok, false);
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000', 'sec-fetch-site': 'same-site' } }).ok, false);
  assert.equal(trustedRouteRequest({ method: 'POST', headers: { host: '127.0.0.1:3000', 'sec-fetch-site': 'none' } }).ok, false);
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000', 'sec-fetch-site': 'none' } }).ok, false);
  assert.equal(trustedRouteRequest({ method: 'GET', headers: { host: '127.0.0.1:3000', 'sec-fetch-site': 'none' } }).ok, true);
  assert.equal(trustedRouteRequest({ method: 'HEAD', headers: { host: '127.0.0.1:3000', 'sec-fetch-site': 'none' } }).ok, true);

  // 畸形 Host / Origin 拒绝
  assert.equal(trustedRouteRequest({ headers: { host: 'evil.com@127.0.0.1:3000' } }).ok, false);
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000/foo' } }).ok, false);
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000?a=1' } }).ok, false);
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000#x' } }).ok, false);
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000', origin: 'http://user:pass@127.0.0.1:3000' } }).ok, false);
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000/' } }).ok, false);
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000?x=1' } }).ok, false);
  assert.equal(trustedRouteRequest({ headers: { host: '127.0.0.1:3000', origin: 'ftp://127.0.0.1:3000' } }).ok, false);
});

// ── 2. Shared #2 & Medium: proxy.js ──────────────────────────────────────
test('Shared #2 & Medium: redactProxyUrl rejects opaque schemes & strips query/hash; proxy exposes close & guards openWebSocket', () => {
  assert.equal(redactProxyUrl('user:secret@proxy.local:8080'), null);
  assert.equal(redactProxyUrl('socks5://user:secret@proxy.local:1080'), null);
  assert.equal(redactProxyUrl('http:user:secret@proxy.local:8080'), null);
  assert.equal(redactProxyUrl('http://user:secret@proxy.local:8080/path?token=xyz#frag'), 'http://***@proxy.local:8080/path');
  assert.equal(redactProxyUrl('https://proxy.local:8443/?k=v#h'), 'https://proxy.local:8443/');
  const proxySrc = fs.readFileSync(new URL('../lib/proxy.js', import.meta.url), 'utf8');
  assert.match(proxySrc, /proxyFetch\.close\s*=\s*\(\)\s*=>\s*dispatcher\.close\?\.\(\)/);
  assert.match(proxySrc, /typeof undici\.WebSocket === "function"/);
  const indexSrc = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  assert.match(indexSrc, /proxyFetch\.close\?\.\(\)/);
});

// ── 3. Shared #3: STREAM_CLOSED retryability ─────────────────────────────
test('Shared #3: ArkAgentPlanAdapter providerRetryPolicy includes STREAM_CLOSED', () => {
  const adapter = new ArkAgentPlanAdapter({
    ctx: { get: () => undefined },
    catalog: { snapshot: () => ({ models: [] }), find: () => undefined },
    providerId: 'ark-agent-plan',
    displayName: 'Ark',
    apiKeyCandidates: ['T'],
    endpoint: 'https://ark.example.invalid/responses',
    harnessMode: { mode: 'none' },
    pluginName: 'test',
  });
  const policy = adapter.providerRetryPolicy('ark-agent-plan');
  assert.ok(policy && Array.isArray(policy.retryableCodes));
  assert.ok(policy.retryableCodes.includes('STREAM_CLOSED'), 'STREAM_CLOSED 必须在默认可重试码中');
  for (const code of ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT']) {
    assert.ok(policy.retryableCodes.includes(code), `应保留默认可重试码 ${code}`);
  }
  const defaults = plugin.Config(undefined);
  assert.ok(defaults.retryPolicy.retryableCodes.includes('STREAM_CLOSED'));
});

// ── 4. Shared #4 & A-H2: responses-sse.js ────────────────────────────────
test('Shared #4: empty call_id falls back and output_item.done backfills late call_id and name', async () => {
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: '', id: '', name: '', arguments: '' } },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_late_1', name: 'read_file', arguments: '{"p":"a"}' } },
    { type: 'response.completed', response: {} },
  ];
  const chunks = [];
  for await (const c of responsesToDshChunks(sseStream(events))) chunks.push(c);
  const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.equal(end.block.id, 'call_late_1');
  assert.equal(end.block.name, 'read_file');
  assert.equal(end.block.arguments, '{"p":"a"}');

  // added 中 call_id:"" 且有 item.id 时直接回退到 item.id（不变成空串）
  const events2 = [
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', call_id: '', id: 'fc_2', name: 'glob', arguments: '{}' } },
    { type: 'response.output_item.done', output_index: 2, item: { type: 'function_call', call_id: '', id: 'fc_2', name: 'glob', arguments: '{}' } },
    { type: 'response.completed', response: {} },
  ];
  const chunks2 = [];
  for await (const c of responsesToDshChunks(sseStream(events2))) chunks2.push(c);
  const end2 = chunks2.find((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.equal(end2.block.id, 'fc_2');
});

test('A-H2: iterateSse and iterateLines enforce max buffer caps and cancel stream', async () => {
  let sseCancelled = false;
  const bigSse = new ReadableStream({
    pull(controller) { controller.enqueue(enc.encode('data: ' + 'x'.repeat(256))); },
    cancel() { sseCancelled = true; },
  });
  await assert.rejects(async () => {
    for await (const _ of iterateSse(bigSse, undefined, undefined, 512)) { /* drain */ }
  }, (err) => err?.code === 'STREAM_CLOSED');
  assert.equal(sseCancelled, true, 'iterateSse 超限后必须取消底层流');

  let lineCancelled = false;
  const bigLine = new ReadableStream({
    pull(controller) { controller.enqueue(enc.encode('y'.repeat(256))); },
    cancel() { lineCancelled = true; },
  });
  await assert.rejects(async () => {
    for await (const _ of iterateLines(bigLine, undefined, 512)) { /* drain */ }
  }, (err) => err?.code === 'STREAM_CLOSED');
  assert.equal(lineCancelled, true, 'iterateLines 超限后必须取消底层流');
});

// ── 5. Shared #5, A-H5 & Medium: chat.js ─────────────────────────────────
test('Shared #5, A-H5 & Medium: chat.js finish_reason handling, non-colliding wireIndex, omit reasoning_effort when off', async () => {
  // Medium: effort === "off" 时省略 reasoning_effort，保留 enable_thinking: false
  const bodyOff = await buildChatRequestBody(
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], reasoningEffort: 'off' },
    { id: 'test-chat', transport: 'chat', reasoning: true, reasoningEfforts: ['off', 'high'], maxTokens: 4096 },
  );
  assert.equal(bodyOff.enable_thinking, false);
  assert.equal('reasoning_effort' in bodyOff, false);

  // A-H5: 中间 chunk 带 finish_reason: "" 不得判成 UNKNOWN 错误；
  // Shared #5: function_call 映射为 tool-calls；
  // A-H5: 已有 index:1 时，缺 index 的新调用分配未占用的 0，不覆盖 index:1
  const stream1 = sseStream([
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_one', function: { name: 'a', arguments: '{"k":1}' } }] }, finish_reason: '' }] },
    { choices: [{ delta: { tool_calls: [{ id: 'call_two', function: { name: 'b', arguments: '{"k":2}' } }] }, finish_reason: '' }] },
    { choices: [{ delta: {}, finish_reason: 'function_call' }] },
  ]);
  const chunks1 = [];
  for await (const c of chatToDshChunks(stream1)) chunks1.push(c);
  const ends1 = chunks1.filter((c) => c.type === 'block-end' && c.block.type === 'tool-call').map((c) => c.block);
  assert.equal(ends1.length, 2, '缺 index 新调用不得覆盖已有 index:1 块');
  assert.deepEqual(ends1.map((b) => [b.id, b.name, b.arguments]), [
    ['call_one', 'a', '{"k":1}'],
    ['call_two', 'b', '{"k":2}'],
  ]);
  assert.equal(chunks1.at(-1).reason.kind, 'tool-calls');

  // Shared #5: 有 tool-call 且 finish_reason === "stop" → 产出 tool-calls
  const stream2 = sseStream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_s', function: { name: 'f', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
  ]);
  const chunks2 = [];
  for await (const c of chatToDshChunks(stream2)) chunks2.push(c);
  assert.equal(chunks2.at(-1).reason.kind, 'tool-calls');
});

// ── 6. A-H1 & Medium content.js: SSRF + DNS + expandCredentialTemplates ──
test('A-H1 & Medium content.js: SSRF blocklist, credential redaction, per-hop DNS, single-pass credential expansion', async () => {
  // 扩展私网段拦截
  for (const host of ['240.0.0.1', '255.255.255.255', 'ff02::1', '64:ff9b::1', '::ffff:127.0.0.1', '::ffff:8.8.8.8', '0:0:0:0:0:ffff:7f00:1']) {
    assert.equal(isPrivateHostLiteral(host), true, `应拦截 ${host}`);
  }
  assert.equal(isPrivateHostLiteral('8.8.8.8'), false);
  assert.equal(isPrivateHostLiteral('2606:4700:4700::1111'), false);

  // MCP server_url 拒绝凭据并脱敏告警日志
  const warns = [];
  const decls = mcpToolDeclarations(
    [{ server_url: 'http://alice:TOPSECRET@127.0.0.1/mcp?token=SECRETQ#frag' }],
    { warn: (m) => warns.push(m) },
  );
  assert.equal(decls.length, 0);
  assert.equal(warns.length, 1);
  assert.ok(!warns[0].includes('TOPSECRET'), '告警日志不得泄露密码');
  assert.ok(!warns[0].includes('SECRETQ'), '告警日志不得泄露 query 参数');

  // 单遍模板展开：凭据 A 值包含 ${credential:B} 不得被二次展开
  const credCtx = {
    get: (n) => n === 'credentials' ? {
      resolve: async (ref) => ({ value: ref === 'A' ? 'val_${credential:B}_end' : 'SECRET_B' }),
    } : undefined,
  };
  assert.equal(
    await expandCredentialTemplates('${credential:A}|${credential:B}', credCtx, 'test'),
    'val_${credential:B}_end|SECRET_B',
  );

  // safeHttpsUrl / downloadMedia 拒绝内网字面量与内嵌凭据
  assert.equal(safeHttpsUrl('https://127.0.0.1/a.png'), null);
  assert.equal(safeHttpsUrl('https://169.254.169.254/latest'), null);
  assert.equal(safeHttpsUrl('https://user:pass@cdn.example.com/a.png'), null);
  assert.equal(safeHttpsUrl('https://[64:ff9b::1]/a.png'), null);

  let fetchCalled = false;
  const neverFetch = async () => { fetchCalled = true; return new Response('ok'); };
  await assert.rejects(() => downloadMedia(neverFetch, 'https://127.0.0.1/x.png'), (e) => e.code === 'PROVIDER_ERROR');
  await assert.rejects(() => downloadMedia(neverFetch, 'https://user:pw@cdn.example.com/x.png'), (e) => e.code === 'PROVIDER_ERROR');
  assert.equal(fetchCalled, false);

  // 逐跳 DNS SSRF 校验（mock dns.promises.lookup）
  const origLookup = dns.promises.lookup;
  try {
    // 1) 首跳解析到私网 → 拒绝
    dns.promises.lookup = async () => [{ address: '10.0.0.5', family: 4 }];
    await assert.rejects(() => downloadMedia(neverFetch, 'https://rebind.example.com/a.png'), (e) => e.code === 'PROVIDER_ERROR');
    assert.equal(fetchCalled, false);

    // 2) 重定向第二跳解析到回环 → 拒绝
    dns.promises.lookup = async (host) => host === 'hop2.example.com'
      ? [{ address: '127.0.0.1', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }];
    const redirectFetch = async () => new Response('', { status: 302, headers: { location: 'https://hop2.example.com/secret' } });
    await assert.rejects(() => downloadMedia(redirectFetch, 'https://hop1.example.com/a.png'), (e) => e.code === 'PROVIDER_ERROR');

    // 3) 代理 fake-IP (198.18.0.1) → 放行 + warn
    const dnsWarns = [];
    dns.promises.lookup = async () => [{ address: '198.18.0.1', family: 4 }];
    const okFetch = async () => new Response(Buffer.from('hello'), { status: 200 });
    const bytes = await downloadMedia(okFetch, 'https://cdn.example.com/a.bin', { logger: { warn: (m) => dnsWarns.push(m) } });
    assert.equal(bytes.toString(), 'hello');
    assert.ok(dnsWarns.some((w) => w.includes('198.18.0.0/15')));
  } finally {
    dns.promises.lookup = origLookup;
  }
});

// ── 7. A-H3: index.js tools optional injection & honest logging ──────────
test('A-H3: index.js uses ctx.inject(["tools"]) and only logs success when register returns a handle', async () => {
  const root = new Context();
  const logs = [];
  const registered = [];
  let disposedTool = false;
  root.plugin(TimerService);
  root.provide('llm');
  root.set('llm', {
    registerConfigurableProviders() {},
    registerAdapter() { return () => {}; },
    emitAdaptersUpdated() {},
  });
  root.provide('credentials');
  root.set('credentials', { resolve: async () => null });
  root.provide('webServer');
  root.set('webServer', { host: '127.0.0.1', register() { return () => {}; } });
  const logger = {
    info: (m) => logs.push({ level: 'info', m: String(m) }),
    warn: (m) => logs.push({ level: 'warn', m: String(m) }),
    error: (m) => logs.push({ level: 'error', m: String(m) }),
    debug() {},
  };
  root.logger = logger;

  const fiber = root.plugin(plugin, {
    tts: { enabled: true },
    modelListUrls: [],
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(logs.some((l) => l.m.includes('已注册工具')), false, 'tools 未就绪时不得伪造「已注册工具」日志');

  // 延迟提供 tools 服务后自动触发子 fiber 注册并记成功日志
  root.provide('tools');
  root.set('tools', {
    register(tool) {
      registered.push(tool.name);
      return () => { disposedTool = true; };
    },
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(registered, ['ark_text_to_speech']);
  assert.ok(logs.some((l) => l.level === 'info' && l.m.includes('已注册工具 ark_text_to_speech')));
  await fiber.dispose();
  assert.equal(disposedTool, true, 'fiber dispose 必须清理已注册的工具句柄');

  // 若 tools.register 未返回句柄，不得记录「已注册工具」
  const logs2 = [];
  const root2 = new Context();
  root2.plugin(TimerService);
  root2.provide('llm'); root2.set('llm', { registerConfigurableProviders() {}, registerAdapter() { return () => {}; }, emitAdaptersUpdated() {} });
  root2.provide('credentials'); root2.set('credentials', { resolve: async () => null });
  root2.provide('webServer'); root2.set('webServer', { host: '127.0.0.1', register() { return () => {}; } });
  root2.provide('tools'); root2.set('tools', { register() { return undefined; } });
  root2.logger = { info: (m) => logs2.push({ level: 'info', m: String(m) }), warn: (m) => logs2.push({ level: 'warn', m: String(m) }), error() {}, debug() {} };
  const fiber2 = root2.plugin(plugin, { tts: { enabled: true }, modelListUrls: [] });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(logs2.some((l) => l.m.includes('已注册工具')), false, 'register 返回空句柄不得记录已注册工具');
  assert.ok(logs2.some((l) => l.level === 'warn' && l.m.includes('未返回有效句柄')));
  await fiber2.dispose();
});

// ── 8. A-H4 & Medium quota.js: bytepluses, expiry, exact host, atomic write, redirect:manual, dispose, cacheWrite, resetAt
test('A-H4: harvestConsoleCookie drops bytepluses & expired cookies and prefers console.volcengine.com over .volcengine.com', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  bridgeCookies = [
    { name: 'AccountID', value: 'bp_acct', domain: 'console.bytepluses.com', expires: nowSec + 3600 },
    { name: 'bpOnly', value: 'secret', domain: '.bytepluses.com', expires: nowSec + 3600 },
    { name: 'expiredTok', value: 'stale', domain: 'console.volcengine.com', expires: nowSec - 60 },
    { name: 'csrfToken', value: 'broad_csrf', domain: '.volcengine.com', expires: nowSec + 3600 },
    { name: 'csrfToken', value: 'exact_csrf', domain: 'console.volcengine.com', expires: nowSec + 3600 },
    { name: 'AccountID', value: 'cn_acct', domain: 'console.volcengine.com', expires: -1 },
  ];
  liveTabs.set(998, { url: 'https://console.volcengine.com/ark', agentWindow: true });
  const harvested = await harvestConsoleCookie(998);
  liveTabs.delete(998);
  assert.ok(harvested);
  assert.equal(harvested.csrf, 'exact_csrf', '同名冲突应优先精确主机 console.volcengine.com');
  assert.ok(!harvested.cookie.includes('bp_acct') && !harvested.cookie.includes('bpOnly'), '不得收割 bytepluses.com Cookie');
  assert.ok(!harvested.cookie.includes('expiredTok'), '不得保留已过期 Cookie');
  assert.ok(harvested.cookie.includes('AccountID=cn_acct'));
});

test('Medium quota.js: redirect:manual + 3xx/401 non-JSON -> COOKIE_EXPIRED, atomic 0600 save, dispose aborts, cacheWrite & rolled resetAt', async () => {
  // 1) redirect: "manual" 与 302 / 401 非 JSON 判定为 COOKIE_EXPIRED
  fs.writeFileSync(cookieFile, JSON.stringify({
    cookie: 'AccountID=a; csrfToken=c', csrf: 'c', savedAt: Date.now(), expiresAt: Date.now() + 86400_000,
  }), { mode: 0o600 });

  let seenRedirect = null;
  let bodyCancelled = false;
  const q302 = new ArkQuota({
    fetchImpl: async (_url, init) => {
      seenRedirect = init.redirect;
      return {
        status: 302,
        body: { cancel: async () => { bodyCancelled = true; } },
        text: async () => '<html>redirect</html>',
      };
    },
    ttlMs: 60_000,
  });
  const r302 = await q302.refresh({ force: true });
  assert.equal(seenRedirect, 'manual');
  assert.equal(bodyCancelled, true);
  assert.equal(r302.ok, false);
  assert.match(r302.error, /登录已过期/);

  const q401 = new ArkQuota({
    fetchImpl: async () => new Response('<html>login</html>', { status: 401 }),
    ttlMs: 60_000,
  });
  const r401 = await q401.refresh({ force: true });
  assert.equal(r401.ok, false);
  assert.match(r401.error, /登录已过期/);

  // 2) atomic 0600 落盘（覆写原 0644 文件后权限仍为 0600 且不留 .tmp）
  fs.writeFileSync(cookieFile, 'old', { mode: 0o644 });
  fs.chmodSync(cookieFile, 0o644);
  bridgeCookies = [
    { name: 'AccountID', value: 'acct1', domain: 'console.volcengine.com' },
    { name: 'csrfToken', value: 'csrf1', domain: 'console.volcengine.com' },
  ];
  const usage = { PlanType: 'large', AFPFiveHour: { Quota: 100, Used: 10, ResetTime: Date.now() + 3600_000 } };
  const qSave = new ArkQuota({
    fetchImpl: async () => new Response(JSON.stringify({ Result: usage }), { status: 200 }),
    ttlMs: 60_000,
  });
  const rSave = await qSave.refresh({ force: true, allowBrowser: true });
  assert.equal(rSave.ok, true);
  const stat = fs.statSync(cookieFile);
  assert.equal(stat.mode & 0o777, 0o600, '原子写入后文件权限必须为 0600');
  assert.equal(fs.readdirSync(HOME).filter((f) => f.endsWith('.tmp')).length, 0, '不得残留 .tmp 文件');

  // 3) dispose() 中止在途 fetch 且不落盘
  fs.rmSync(cookieFile, { force: true });
  let abortedObserved = false;
  const qDisp = new ArkQuota({
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { abortedObserved = true; reject(new DOMException('Aborted', 'AbortError')); });
    }),
    ttlMs: 60_000,
  });
  const pending = qDisp.refresh({ force: true, allowBrowser: true });
  await new Promise((r) => setTimeout(r, 40));
  qDisp.dispose();
  const rDisp = await pending;
  assert.equal(rDisp.ok, false);
  assert.equal(abortedObserved, true, 'dispose() 必须中止在途 fetch');
  assert.equal(loadStoredCookie(), null, 'dispose 后不得落盘 Cookie');

  // 4) cacheWriteTokens 计价 + #applyLedger 传播滚窗后的 resetAt
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    fs.writeFileSync(cookieFile, JSON.stringify({
      cookie: 'AccountID=a; csrfToken=c', csrf: 'c', savedAt: fakeNow, expiresAt: fakeNow + 86400_000,
    }), { mode: 0o600 });
    const initialReset = fakeNow + 3600_000;
    const qLedger = new ArkQuota({
      fetchImpl: async () => new Response(JSON.stringify({
        Result: { PlanType: 'large', AFPFiveHour: { Quota: 100, Used: 50, ResetTime: initialReset } },
      }), { status: 200 }),
      ttlMs: 60_000,
      afpPricing: { _default: { input: 2, output: 8, cacheRead: 0.4, cacheWrite: 3 } },
      afpPerCny: 1,
    });
    assert.equal((await qLedger.refresh({ force: true })).ok, true);
    // cacheWriteTokens: 1_000_000 * 3 = 3 AFP
    qLedger.recordUsage({ model: 'm', inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 });
    assert.equal(qLedger.peek().windows[0].used, 53);

    // 越过重置边界后再记一笔，bucket.resetAt 向前滚动 5 小时并传播给 peek()
    fakeNow = initialReset + 1000;
    qLedger.recordUsage({ model: 'm', inputTokens: 1_000_000, outputTokens: 0 });
    const rolledWin = qLedger.peek().windows[0];
    assert.equal(rolledWin.used, 2);
    assert.equal(rolledWin.resetAt, initialReset + 5 * 3600_000, '滚窗后的新 resetAt 必须传播到展示项');
  } finally {
    Date.now = realNow;
  }
});

// ── 9. A-H6 & Medium catalog.js ──────────────────────────────────────────
test('A-H6 & Medium catalog.js: abort does not mutate catalog, new unknown candidates not published, servedMatches/3-part/planType/seed3d', async () => {
  // servedMatches 3-part & 拒绝跨次版本回退
  assert.equal(servedMatches('glm-5', 'glm-5.3'), false);
  assert.equal(servedMatches('glm-5.3', 'glm-5'), false);
  assert.equal(servedMatches('deepseek-v4.1', 'deepseek-v4'), false);
  assert.equal(servedMatches('deepseek-v4', 'deepseek-v4.1'), false);
  assert.equal(servedMatches('doubao-seed-2.0.1', 'doubao-seed-2-0-1-260501'), true);
  assert.equal(servedMatches('deepseek-v4.1-flash', 'deepseek-v4-1-flash-20261017'), true);

  const creds = { resolve: async () => ({ value: 'TEST_KEY' }) };
  const ctx = { get: (n) => (n === 'credentials' ? creds : undefined) };

  // A-H6(1): 部分限流时，新发现的 unknown 文档候选绝不发布；先前已在目录中的 unknown 模型保留
  const catPartial = new DynamicCatalog({
    ctx,
    probeUrl: 'https://ark.example.invalid/api/plan/v3/responses',
    apiKeyCandidates: ['T'],
    pluginName: 'test',
    docSources: ['https://docs.example.invalid/list'],
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes('docs.example.invalid')) {
        return new Response('doubao-seed-9.9-phantom\ndoubao-seed3d-3.0\n', { status: 200 });
      }
      const body = JSON.parse(init.body);
      if (body.input === 'hi') return new Response(JSON.stringify({ model: body.model }), { status: 200 });
      // 新文档幽灵模型与既有 glm-5.3 同时返回 429 (unknown)，其余返回 200 (alive)
      if (body.model === 'doubao-seed-9.9-phantom' || body.model === 'glm-5.3') {
        return new Response('rate limit', { status: 429 });
      }
      return new Response('{}', { status: 200 });
    },
  });
  await catPartial.refresh();
  assert.equal(catPartial.find('doubao-seed-9.9-phantom'), undefined, '新发现的 unknown 候选不得发布');
  assert.ok(catPartial.find('glm-5.3'), '先前已验证的目录模型遇到瞬时 429 应保留');
  assert.equal(catPartial.find('doubao-seed3d-3.0'), undefined, 'seed3d 不得作为 responses 对话模型发布');

  // A-H6(2): signal 中止时直接中止 refresh()，不覆盖已有目录
  const ac = new AbortController();
  const catAbort = new DynamicCatalog({
    ctx,
    probeUrl: 'https://ark.example.invalid/api/plan/v3/responses',
    apiKeyCandidates: ['T'],
    pluginName: 'test',
    docSources: ['https://docs.example.invalid/list'],
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes('docs.example.invalid')) {
        return new Response('doubao-seed-8.8-new\n', { status: 200 });
      }
      const body = JSON.parse(init.body);
      if (body.model === 'doubao-seed-8.8-new') {
        ac.abort();
        throw new DOMException('Aborted', 'AbortError');
      }
      if (body.input === 'hi') return new Response(JSON.stringify({ model: body.model }), { status: 200 });
      return new Response('{}', { status: 200 });
    },
  });
  const beforeModels = catAbort.snapshot().models;
  const changed = await catAbort.refresh(ac.signal);
  assert.equal(changed, false, 'signal 中止时 refresh 必须返回 false');
  assert.deepEqual(catAbort.snapshot().models, beforeModels, 'signal 中止不得修改已有目录');

  // Medium: 未知未来套餐名保守放行多模态模型
  const catFutureTier = new DynamicCatalog({
    ctx,
    probeUrl: 'https://ark.example.invalid/api/plan/v3/responses',
    apiKeyCandidates: ['T'],
    pluginName: 'test',
    quota: { planType: 'ultra-enterprise-v2' },
    docSources: ['https://docs.example.invalid/list'],
    fetchImpl: async (url, init = {}) => {
      if (String(url).includes('docs.example.invalid')) {
        return new Response('doubao-seedance-2.5-flash\ndoubao-seedream-5.5\n', { status: 200 });
      }
      const body = JSON.parse(init.body);
      if (body.input === 'hi') return new Response(JSON.stringify({ model: body.model }), { status: 200 });
      return new Response('{}', { status: 200 });
    },
  });
  await catFutureTier.refresh();
  assert.ok(catFutureTier.find('doubao-seedance-2.5-flash'), '未知新套餐名应保守放行视频模型');
  assert.ok(catFutureTier.find('doubao-seedream-5.5'), '未知新套餐名应保守放行图片模型');
});

// ── 10. Medium multimodal.js & media-io.js ───────────────────────────────
test('Medium multimodal.js & media-io.js: promptText uses latest user turn only; readSpeechAudio handles SSE control lines, string code, error envelope', async () => {
  const prompt = promptText({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '旧问题1' }] },
      { role: 'assistant', content: [{ type: 'text', text: '旧回答' }] },
      { role: 'user', content: [{ type: 'text', text: '最新提示词' }] },
    ],
  });
  assert.equal(prompt, '最新提示词');

  // readSpeechAudio 跳过 SSE 注释/控制行
  const sseAudioResp = new Response(streamFrom([
    ': keep-alive\n',
    'event: audio\n',
    'id: 1\n',
    'retry: 1000\n',
    `data: ${JSON.stringify({ code: 0, data: MP3.toString('base64') })}\n`,
    `data: ${JSON.stringify({ code: TTS_DONE_CODE, data: null })}\n`,
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const audio = await readSpeechAudio(sseAudioResp);
  assert.deepEqual(audio, MP3);

  // 字符串 event.code 不被 Number() 转成 NaN，正确走 failureCode
  let seenCode = null;
  const strCodeResp = new Response(`${JSON.stringify({ code: 'RateLimitExceeded', message: 'slow down' })}\n`, {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(
    () => readSpeechAudio(strCodeResp, { failureCode: (c) => { seenCode = c; return 'RATE_LIMIT'; } }),
    (err) => err.code === 'RATE_LIMIT' && !err.message.includes('NaN'),
  );
  assert.equal(seenCode, 'RateLimitExceeded');

  // { error: { code, message } } 信封
  const errEnvResp = new Response(`${JSON.stringify({ error: { code: 'InternalError', message: 'boom' } })}\n`, {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  await assert.rejects(
    () => readSpeechAudio(errEnvResp, { failureCode: () => 'SERVER' }),
    (err) => err.code === 'SERVER' && /boom/.test(err.message),
  );
});

// ── 11. Medium adapter.js: deferToolCalls with mcpTools & cacheWriteTokens
test('Medium adapter.js: defers tool calls when mcpTools present and forwards cacheWriteTokens to quota.recordUsage', async () => {
  const recorded = [];
  const sseEvents = [
    { type: 'response.output_item.added', output_index: 0, item: { id: 'mcp_1', type: 'mcp_call', status: 'in_progress', name: 'lookup' } },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'mcp_1', type: 'mcp_call', status: 'completed', name: 'lookup' } },
    { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_local', name: 'local_fn', arguments: '{}' } },
    { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_local', name: 'local_fn', arguments: '{}' } },
    {
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 1000,
          output_tokens: 200,
          cache_creation_input_tokens: 400,
          input_tokens_details: { cached_tokens: 100 },
        },
      },
    },
  ];
  const adapter = new ArkAgentPlanAdapter({
    ctx: { get: (n) => (n === 'credentials' ? { resolve: async () => ({ value: 'KEY' }) } : undefined) },
    catalog: {
      find: () => ({ id: 'deepseek-v4.1-flash', transport: 'responses', reasoning: false, input: ['text'], maxTokens: 4096, harnessTools: [] }),
      snapshot: () => ({ models: [] }),
    },
    providerId: 'ark-agent-plan',
    displayName: 'Ark',
    apiKeyCandidates: ['T'],
    endpoint: 'https://ark.example.invalid/responses',
    harnessMode: { mode: 'none' },
    pluginName: 'test',
    mcpServers: [{ server_url: 'https://mcp.example.com/sse' }],
    quota: { peek: () => ({ ok: false, windows: [] }), recordUsage: (u) => recorded.push(u) },
    fetchImpl: async () => new Response(sseStream(sseEvents), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  const chunks = [];
  for await (const c of adapter.stream({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
    chunks.push(c);
  }
  const blockTypes = chunks.filter((c) => c.type === 'block-end').map((c) => c.block.type);
  assert.deepEqual(blockTypes, ['text', 'tool-call'], '仅配 MCP（无内置工具）时，mcp_call 活动文本必须先于 tool-call 发出');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].cacheWriteTokens, 400);
});

// ── 12. Medium ark-tools.js & index.js: TTS default credential alignment ─
test('Medium ark-tools.js & index.js: TTS default credential aligns with Agent Plan endpoint', async () => {
  const defaults = plugin.Config(undefined);
  assert.equal(defaults.tts.apiKeyEnv, 'ARK_AGENT_PLAN_CN_API_KEY');
  let requestedRef = null;
  const tool = createTtsTool({
    ctx: {
      get: (n) => n === 'credentials'
        ? { resolve: async (ref) => { requestedRef = ref; return { value: 'PLAN_KEY' }; } }
        : n === 'workingDirectory' ? { defaultDirectory: () => TMP } : undefined,
    },
    config: { enabled: true },
    fetchImpl: async () => new Response(
      `${JSON.stringify({ code: 0, data: MP3.toString('base64') })}\n${JSON.stringify({ code: TTS_DONE_CODE })}\n`,
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  });
  const res = await tool.execute({ text: '测试' });
  assert.equal(requestedRef, 'ARK_AGENT_PLAN_CN_API_KEY');
  fs.rmSync(res.path, { force: true });
});

// ── 13. Medium ark-api.js & multimodal.js: video poll bounded to deadline
test('Medium ark-api.js & multimodal.js: video poll fetch & sleep bounded to remaining maxWaitMs', async () => {
  const started1 = Date.now();
  await assert.rejects(() => waitVideoTask({
    apiKey: 'k',
    taskId: 't-hang',
    pollIntervalMs: 5000,
    maxWaitMs: 120,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError')));
    }),
  }), /视频生成超时/);
  assert.ok(Date.now() - started1 < 1000, 'waitVideoTask 挂起的单次 poll 必须在 deadline 到点中止');

  const started2 = Date.now();
  await assert.rejects(async () => {
    const gen = runMultimodal({
      model: { id: 'doubao-seedance-2.0', transport: 'video' },
      options: { messages: [{ role: 'user', content: [{ type: 'text', text: 'cat' }] }] },
      baseUrl: 'https://ark.example.invalid/api/plan/v3',
      apiKey: 'k',
      routeName: 'Ark',
      video: { pollIntervalMs: 5000, maxWaitMs: 120 },
      fetchImpl: async (_url, init) => {
        if (init.method === 'POST') return new Response(JSON.stringify({ id: 'vid-hang' }), { status: 200 });
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal.reason ?? new DOMException('Aborted', 'AbortError')));
        });
      },
    });
    for await (const _ of gen) { /* drain */ }
  }, (err) => err?.code === 'TIMEOUT');
  assert.ok(Date.now() - started2 < 1000, 'videoFromTask 挂起的单次 poll 必须在 deadline 到点中止');
});

// ── 14. Medium client.js: reset label, !mine resets open & stops polling, cleanup MutationObserver timer
test('Medium client.js: formatResetText avoids "已重置 后重置"; !mine resets open & stops interval; unmount cleans 400ms timer', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const noop = () => {};
  const hookStates = []; const hookRefs = []; const hookCallbacks = []; const effectRecords = [];
  let hookIndex = 0; let refIndex = 0; let cbIndex = 0; let effectIndex = 0;
  let BadgeComp = null; let buttonProps = null;
  const depsChanged = (prev, next) => !prev || !next || prev.length !== next.length || next.some((d, i) => !Object.is(d, prev[i]));
  const activeIntervals = new Map();
  let nextIntervalId = 1;
  const activeTimeouts = new Map();
  let nextTimeoutId = 1;
  let moCallback = null;
  let abortedFetches = 0;

  const stubReact = {
    createElement: (type, props) => {
      if (type?.name === 'Badge') BadgeComp = type;
      if (type === 'button' && props?.className === 'arkq-badge') buttonProps = props;
      return null;
    },
    useState: (initial) => {
      const i = hookIndex++;
      if (!(i in hookStates)) hookStates[i] = typeof initial === 'function' ? initial() : initial;
      return [hookStates[i], (v) => { hookStates[i] = typeof v === 'function' ? v(hookStates[i]) : v; }];
    },
    useEffect: (fn, deps) => {
      const i = effectIndex++;
      const prev = effectRecords[i];
      if (!prev || depsChanged(prev.deps, deps)) {
        prev?.cleanup?.();
        const cleanup = fn();
        effectRecords[i] = { deps, cleanup };
      }
    },
    useLayoutEffect: noop,
    useRef: (initial) => { const i = refIndex++; if (!(i in hookRefs)) hookRefs[i] = { current: initial }; return hookRefs[i]; },
    useCallback: (fn, deps) => {
      const i = cbIndex++;
      const prev = hookCallbacks[i];
      if (!prev || depsChanged(prev.deps, deps)) hookCallbacks[i] = { fn, deps };
      return hookCallbacks[i].fn;
    },
    Fragment: Symbol('Fragment'),
  };
  const render = () => { hookIndex = 0; refIndex = 0; cbIndex = 0; effectIndex = 0; BadgeComp({}); };
  let captured;
  class FakeMutationObserver {
    constructor(cb) { moCallback = cb; }
    observe() {}
    disconnect() {}
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => { captured = factory((n) => (n === 'react' ? stubReact : {})); } }, addEventListener: noop, removeEventListener: noop },
    document: { documentElement: { getAttribute: () => 'zh' }, body: {}, createElement: () => ({ setAttribute: noop, textContent: '' }), head: { appendChild: noop }, querySelector: () => null },
    navigator: { language: 'zh-CN' },
    MutationObserver: FakeMutationObserver,
    AbortController,
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { abortedFetches += 1; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
    }),
    console,
    setTimeout: (fn) => { const id = nextTimeoutId++; activeTimeouts.set(id, fn); return id; },
    clearTimeout: (id) => { activeTimeouts.delete(id); },
    setInterval: (fn) => { const id = nextIntervalId++; activeIntervals.set(id, fn); return id; },
    clearInterval: (id) => { activeIntervals.delete(id); },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });

  // formatResetText 文案检查（中/英）
  assert.equal(captured.formatResetText(0, { resetDone: '已重置', resetIn: '后重置' }), '已重置');
  assert.equal(captured.formatResetText(-1000, { resetDone: 'Reset', resetIn: 'until reset' }), 'Reset');
  assert.equal(captured.formatResetText(120_000, { resetDone: '已重置', resetIn: '后重置' }), '2分钟 后重置');

  let BadgeRender = null;
  const slots = {
    inject: (_n, fn) => { fn(); return () => {}; },
    register: (_s, r) => { BadgeRender = r; return () => {}; },
  };
  captured.apply({ get: (n) => (n === 'slots' ? slots : undefined), effect: (fn) => fn(), logger: { warn: noop } });
  BadgeRender();

  // mine=false 挂载：不得启动 30s 轮询 interval
  render();
  assert.equal(activeIntervals.size, 0, '!mine 时不得启动 30s 轮询定时器');

  // 切到 mine=true：启动轮询并打开面板
  hookStates[4] = true;
  render();
  assert.equal(activeIntervals.size, 1, 'mine=true 时启动 30s 轮询定时器');
  buttonProps.ref({ getBoundingClientRect: () => ({ top: 100, left: 100, right: 160, bottom: 120, width: 60 }) });
  buttonProps.onClick();
  render();
  assert.equal(hookStates[0], true, '点击徽标后 open 应为 true');

  // 切走其他 provider (mine=false)：open 自动重置为 false，轮询停止
  hookStates[4] = false;
  render();
  assert.equal(hookStates[0], false, 'mine 变 false 时 open 必须重置为 false');
  assert.equal(activeIntervals.size, 0, 'mine 变 false 时必须清除轮询定时器');

  // 触发 MutationObserver 400ms 节流定时器后卸载组件：定时器被清理、在途 fetch 被 abort
  moCallback?.();
  assert.equal(activeTimeouts.size, 1);
  for (const rec of effectRecords) rec?.cleanup?.();
  assert.equal(activeTimeouts.size, 0, '卸载时必须清理 400ms MutationObserver 定时器');
  assert.ok(abortedFetches >= 1, '卸载时必须 abort 在途 fetch');
});
