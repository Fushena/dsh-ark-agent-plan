/**
 * Ark 插件中/低危审计漏洞回归测试（#4 ~ #15）。
 */
import test from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const TMP = fs.mkdtempSync('/tmp/ark-audit-ml-');
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME, { mode: 0o700 });
const BRIDGE = path.join(TMP, 'bridge'); fs.mkdirSync(BRIDGE, { mode: 0o700 });
const SOCK = path.join(BRIDGE, 'fake.sock');
process.env.DSH_HOME = HOME;
process.env.DSH_BRIDGE_DIR = BRIDGE;
process.env.DSH_BRIDGE_SOCK = SOCK;
process.env.DSH_BRIDGE_TOKEN = path.join(BRIDGE, 'token');
fs.writeFileSync(process.env.DSH_BRIDGE_TOKEN, `faketoken\n${SOCK}\n`, { mode: 0o600 });

const { isPrivateHostLiteral } = await import('../lib/content.js');
const { resolveReasoningEffort, resolveDefaultReasoningEffort } = await import('../lib/harness.js');
const { downloadMedia } = await import('../lib/media-io.js');
const { familyOf } = await import('../lib/model-display.js');
const { DynamicCatalog } = await import('../lib/catalog.js');
const { createImageGenerationTool, createTtsTool } = await import('../lib/ark-tools.js');
const { ArkQuota, loadStoredCookie, harvestConsoleCookie } = await import('../lib/quota.js');

const USAGE_NEW = { PlanType: 'large', AFPFiveHour: { Quota: 200, Used: 5, ResetTime: Date.now() + 3600_000 } };
let bridgeCookies = [];
let inPageStatus = 200;
let openCount = 0;
let nextTab = 700;
const liveTabs = new Map();

const server = net.createServer((sock) => {
  let acc = '';
  sock.on('data', (chunk) => {
    acc += chunk;
    const at = acc.indexOf('\n'); if (at < 0) return;
    const req = JSON.parse(acc.slice(0, at)); acc = acc.slice(at + 1);
    const reply = (result) => sock.write(JSON.stringify({ ok: true, result }) + '\n');
    const fail = (error) => sock.write(JSON.stringify({ ok: false, error }) + '\n');
    if (req.op === 'tabs') return reply([...liveTabs.entries()].map(([id, t]) => ({ id, ...t })));
    if (req.op === 'open') {
      openCount += 1;
      const id = nextTab++;
      liveTabs.set(id, { url: 'https://console.volcengine.com/ark', agentWindow: true });
      return reply({ tabId: id });
    }
    if (req.op === 'close') { liveTabs.delete(Number(req.args.tabId)); return reply({}); }
    if (req.op === 'detach') return reply({});
    if (req.op === 'cdp') {
      if (req.args.method === 'Runtime.evaluate') {
        const expr = String(req.args.params?.expression ?? '');
        if (expr.includes('readyState')) {
          return reply({ result: { result: { value: JSON.stringify({ ready: 'complete', url: 'https://console.volcengine.com/x', host: 'console.volcengine.com' }) } } });
        }
        const body = inPageStatus === 200
          ? { Result: USAGE_NEW }
          : { ResponseMetadata: { Error: { Code: 'NotLogin', Message: 'Not logged in' } } };
        return reply({ result: { result: { value: JSON.stringify({ status: inPageStatus, body: JSON.stringify(body) }) } } });
      }
      return reply({ result: { result: { cookies: bridgeCookies } } });
    }
    return fail('unknown op');
  });
});
await new Promise((r) => server.listen(SOCK, r));
fs.chmodSync(SOCK, 0o600);
const cookieFile = path.join(HOME, '.ark-plan-console-cookie.json');
after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('#4: isPrivateHostLiteral blocks trailing-dot localhost and hex IPv4-mapped IPv6', () => {
  assert.equal(isPrivateHostLiteral('localhost.'), true);
  assert.equal(isPrivateHostLiteral('foo.localhost.'), true);
  assert.equal(isPrivateHostLiteral('[::ffff:7f00:1]'), true);
  assert.equal(isPrivateHostLiteral('[::ffff:a9fe:a9fe]'), true);
  assert.equal(isPrivateHostLiteral('[::ffff:c0a8:101]'), true);
  assert.equal(isPrivateHostLiteral('[::ffff:127.0.0.1]'), true);
  assert.equal(isPrivateHostLiteral('api.example.com'), false);
  assert.equal(isPrivateHostLiteral('[::ffff:808:808]'), false);
});

test('#5 & #6: allowBrowser skips stale stored cookie and filters non-console cookie domains', async () => {
  fs.rmSync(cookieFile, { force: true });
  openCount = 0;
  // 旧凭据存在，但直连报网络/500 错误（非 COOKIE_EXPIRED）
  fs.writeFileSync(cookieFile, JSON.stringify({
    cookie: 'AccountID=old; csrfToken=oldcsrf', csrf: 'oldcsrf',
    savedAt: Date.now(), expiresAt: Date.now() + 86400_000,
  }), { mode: 0o600 });
  bridgeCookies = [
    { name: 'AccountID', value: 'evil', domain: 'evilvolcengine.com' },
    { name: 'csrfToken', value: 'signin-csrf', domain: 'signin.volcengine.com' },
    { name: 'AccountID', value: 'newacct', domain: 'console.volcengine.com' },
    { name: 'csrfToken', value: 'newcsrf', domain: '.volcengine.com' },
    { name: 'digest', value: 'fresh-digest', domain: '.volcengine.com' },
  ];
  const fetchImpl = async (_url, opts = {}) => {
    const c = String(opts.headers?.cookie ?? '');
    if (c.includes('AccountID=old')) return new Response('upstream error', { status: 500 });
    assert.ok(!c.includes('evil'), '不得包含 evilvolcengine.com 的 Cookie');
    assert.ok(!c.includes('signin-csrf'), '不得混入 signin.volcengine.com 的 Cookie');
    assert.ok(c.includes('AccountID=newacct') && c.includes('csrfToken=newcsrf'));
    return new Response(JSON.stringify({ Result: USAGE_NEW }), { status: 200 });
  };
  const quota = new ArkQuota({ fetchImpl, logger: { info() {}, warn() {}, debug() {} }, ttlMs: 60_000 });
  const res = await quota.refresh({ force: true, allowBrowser: true });
  assert.equal(res.ok, true, `allowBrowser 应跳过旧凭据直接重抓，实际 error=${res.error}`);
  assert.equal(openCount, 1);
  assert.equal(quota.peek().planType, 'large');

  // 单独验证 harvestConsoleCookie 过滤恶意/子域 Cookie
  liveTabs.set(999, { url: 'https://console.volcengine.com/ark', agentWindow: true });
  const harvested = await harvestConsoleCookie(999);
  assert.ok(harvested && harvested.csrf === 'newcsrf' && !harvested.cookie.includes('evil') && !harvested.cookie.includes('signin-csrf'));
  liveTabs.delete(999);
});

test('#13: fallback fetchUsageInPage after COOKIE_EXPIRED does not persist invalid cookie', async () => {
  fs.rmSync(cookieFile, { force: true });
  inPageStatus = 200;
  bridgeCookies = [
    { name: 'AccountID', value: 'badacct', domain: 'console.volcengine.com' },
    { name: 'csrfToken', value: 'badcsrf', domain: 'console.volcengine.com' },
  ];
  // Node 直连永远返回 NotLogin（COOKIE_EXPIRED），最后一次回落页面内取数成功。
  const fetchImpl = async () => new Response(JSON.stringify({
    ResponseMetadata: { Error: { Code: 'NotLogin', Message: 'Not logged in' } },
  }), { status: 200 });
  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => origSetTimeout(fn, Math.min(ms ?? 0, 5), ...rest);
  try {
    const quota = new ArkQuota({ fetchImpl, logger: { info() {}, warn() {}, debug() {} }, ttlMs: 60_000 });
    const res = await quota.refresh({ force: true, allowBrowser: true });
    assert.equal(res.ok, true, `回落页面内取数应成功，实际 error=${res.error}`);
    assert.equal(loadStoredCookie(), null, '已知 COOKIE_EXPIRED 的 harvested Cookie 不得落盘');
  } finally {
    globalThis.setTimeout = origSetTimeout;
  }
});

test('#7: ark-tools omits n when unspecified and guards nullish args', async () => {
  let capturedBody = null;
  const creds = { resolve: async () => ({ value: 'sk-test' }) };
  const fakeCtx = { credentials: creds, get: (n) => (n === 'credentials' ? creds : undefined) };
  const fetchImpl = async (_url, init) => {
    capturedBody = JSON.parse(init.body);
    return new Response(JSON.stringify({ data: [{ url: 'https://example.com/a.png' }] }), { status: 200 });
  };
  const imgTool = createImageGenerationTool({ ctx: fakeCtx, config: { enabled: true, model: 'doubao-seedream-5.0-lite' }, fetchImpl });
  await imgTool.execute({ prompt: 'hello' });
  assert.equal('n' in capturedBody, false, '未传 n 时不应默认塞 n:1');
  await imgTool.execute({ prompt: 'hello', n: 2 });
  assert.equal(capturedBody.n, 2, '显式传 n=2 时应正常透传');

  const ttsTool = createTtsTool({ ctx: fakeCtx, config: { enabled: true }, fetchImpl });
  await assert.rejects(() => ttsTool.execute(undefined), /text 不能为空/);
});

test('#8 & #15: empty excludeModels does not wipe catalog and extraModels keeps speech models', async () => {
  const creds = { resolve: async () => ({ value: 'sk-test' }) };
  const cat = new DynamicCatalog({
    ctx: { credentials: creds, get: (n) => (n === 'credentials' ? creds : undefined) },
    probeUrl: 'https://ark.cn-beijing.volces.com/api/v3/responses',
    apiKeyCandidates: ['ARK_API_KEY'],
    pluginName: 'test',
    excludes: ['', '   '],
    extraCandidates: ['doubao-seed-tts-3.0'],
    docSources: [],
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'MissingParameter' } }), { status: 400 }),
  });
  assert.ok(cat.snapshot().models.length >= 10, '空字符串 exclude 不应清空初始目录');
  await cat.refresh();
  assert.ok(cat.find('doubao-seed-tts-3.0'), 'extraModels 追加的 TTS 语音模型应被保留');
});

test('#9: config defaultReasoning takes effect on builtin models and degrades safely on GLM', () => {
  const deepseek = {
    id: 'deepseek-v4.1-flash', reasoning: true,
    reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high',
  };
  const glm = {
    id: 'glm-5.3', reasoning: true,
    reasoningEfforts: ['low', 'high', 'max'], defaultReasoningEffort: 'high',
    rejectedReasoningEfforts: ['off'],
  };
  const glmDynamic = {
    id: 'glm-5.4', reasoning: true,
    reasoningEfforts: ['low', 'high', 'max'],
    rejectedReasoningEfforts: ['off'],
  };
  assert.equal(resolveReasoningEffort({}, deepseek, 'low'), 'low');
  assert.equal(resolveDefaultReasoningEffort(deepseek, 'low'), 'low');
  assert.equal(resolveReasoningEffort({}, glm, 'off'), 'high');
  assert.equal(resolveDefaultReasoningEffort(glm, 'off'), 'high');
  assert.equal(resolveReasoningEffort({}, glmDynamic, 'off'), undefined);
  assert.throws(() => resolveReasoningEffort({ reasoningEffort: 'off' }, glm, 'high'), /不支持关闭思考/);
});

test('#10: downloadMedia converts malformed Location header into PROVIDER_ERROR', async () => {
  const fetchImpl = async () => new Response('', { status: 302, headers: { location: 'http://[invalid' } });
  await assert.rejects(
    () => downloadMedia(fetchImpl, 'https://example.com/file.png'),
    (err) => err?.code === 'PROVIDER_ERROR',
  );
});

test('#11: familyOf matches multimodal families before doubao and sorts unknown at order 99', () => {
  assert.equal(familyOf('doubao-seedream-5.0-lite').key, 'seedream');
  assert.equal(familyOf('doubao-seedance-2.0').key, 'seedance');
  assert.equal(familyOf('doubao-seed-tts-2.0').key, 'tts');
  assert.equal(familyOf('doubao-seed-asr-2.0').key, 'asr');
  assert.equal(familyOf('doubao-seed-2.1-pro').key, 'doubao');
  assert.equal(familyOf('acme-custom-1').order, 99);
});
