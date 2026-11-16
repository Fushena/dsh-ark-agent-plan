/**
 * 收割时机竞态回归（2026-11-16 用户报障：能获取到 Cookie 时仍反复弹登录页/取数失败）。
 *
 * 实测根因：火山控制台页面加载早期 AccountID + csrfToken 已写入，但 HttpOnly 会话
 * cookie（digest/userInfo）尚未下发。harvestConsoleCookie 只以 AccountID 为登录判据，
 * 于是早期收割返回「非 null 但不完整」的 Cookie → #harvestForStore 不再重试 →
 * saveStoredCookie 存下坏 Cookie → Node 直连 401 NotLogin → 页面内取数同样 401 →
 * 失败 → 用户再点「更新凭据」又开一个标签。页面完全 settled 后收割才拿到可用 Cookie。
 *
 * 修后契约：收割到的 Cookie 必须**真的能取到额度**才算数；取不到（COOKIE_EXPIRED）
 * 就等页面 settle 后重收割，直到拿到可用 Cookie 才落盘。绝不保存一份取数失败的 Cookie。
 *
 * 全注入：假桥（cookie  jar 随收割次数从「不完整」过渡到「完整」，模拟页面 settle）+
 * 内容感知假 fetch（含 digest → 200；缺 digest → NotLogin）+ 临时 DSH_HOME。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *   --import ./test/runtime.mjs --test ./test/quota-harvest.test.mjs
 */
import test from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const TMP = fs.mkdtempSync('/tmp/ark-quota-harvest-');
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME, { mode: 0o700 });
const BRIDGE = path.join(TMP, 'bridge'); fs.mkdirSync(BRIDGE, { mode: 0o700 });
const SOCK = path.join(BRIDGE, 'fake.sock');
process.env.DSH_HOME = HOME;
process.env.DSH_BRIDGE_DIR = BRIDGE;
process.env.DSH_BRIDGE_SOCK = SOCK;
process.env.DSH_BRIDGE_TOKEN = path.join(BRIDGE, 'token');
fs.writeFileSync(process.env.DSH_BRIDGE_TOKEN, `faketoken\n${SOCK}\n`, { mode: 0o600 });

const { ArkQuota, loadStoredCookie } = await import('../lib/quota.js');

const USAGE = { PlanType: 'medium', AFPFiveHour: { Quota: 10000, Used: 1, ResetTime: Date.now() + 3600_000 } };
const INCOMPLETE = [
  { name: 'AccountID', value: 'acct', domain: 'console.volcengine.com' },
  { name: 'csrfToken', value: 'csrf', domain: 'console.volcengine.com' },
];
const COMPLETE = [
  ...INCOMPLETE,
  { name: 'digest', value: 'd'.repeat(64), domain: '.volcengine.com' },
  { name: 'userInfo', value: 'u'.repeat(64), domain: '.volcengine.com' },
];

// 假桥状态：getCookiesCalls 计数；settleAfter 次收割后 jar 才完整（模拟页面加载）。
let getCookiesCalls = 0;
let settleAfter = 2;          // 前 2 次收割拿到不完整 jar，第 3 次起完整
let loggedIn = true;          // false → jar 永远没有 AccountID（真未登录）
let inPageStatus = 401;       // 页面内取数默认也失败（早期浏览器 jar 同样缺 digest）
const ops = [];
let nextTab = 500;
const liveTabs = new Map();

const server = net.createServer((sock) => {
  let acc = '';
  sock.on('data', async (chunk) => {
    acc += chunk;
    const at = acc.indexOf('\n'); if (at < 0) return;
    const req = JSON.parse(acc.slice(0, at)); acc = acc.slice(at + 1);
    ops.push({ op: req.op, args: req.args });
    const reply = (result) => sock.write(JSON.stringify({ ok: true, result }) + '\n');
    const fail = (error) => sock.write(JSON.stringify({ ok: false, error }) + '\n');
    if (req.op === 'tabs') return reply([...liveTabs.entries()].map(([id, t]) => ({ id, ...t })));
    if (req.op === 'open') { const id = nextTab++; liveTabs.set(id, { url: 'https://console.volcengine.com/ark', agentWindow: true }); return reply({ tabId: id }); }
    if (req.op === 'close') { liveTabs.delete(Number(req.args.tabId)); return reply({}); }
    if (req.op === 'detach') return reply({});
    if (req.op === 'cdp') {
      if (!liveTabs.has(Number(req.args.tabId))) return fail('tab closed');
      const method = req.args.method;
      if (method === 'Runtime.evaluate') {
        const expr = String(req.args.params?.expression ?? '');
        if (expr.includes('readyState')) return reply({ result: { result: { value: JSON.stringify({ ready: 'complete', url: 'https://console.volcengine.com/x', host: 'console.volcengine.com' }) } } });
        // 页面内同源取数：早期 session 未就绪 → NotLogin（与 Node 直连一致）。
        const body = inPageStatus === 200 ? { Result: USAGE } : { ResponseMetadata: { Error: { Code: 'NotLogin', Message: 'Not logged in' } } };
        return reply({ result: { result: { value: JSON.stringify({ status: inPageStatus, body: JSON.stringify(body) }) } } });
      }
      // Network.getCookies / Storage.getCookies
      getCookiesCalls += 1;
      let jar;
      if (!loggedIn) jar = [{ name: 'csrfToken', value: 'csrf', domain: 'console.volcengine.com' }];
      else jar = getCookiesCalls > settleAfter ? COMPLETE : INCOMPLETE;
      return reply({ result: { result: { cookies: jar } } });
    }
    return fail('unknown op');
  });
});
await new Promise((r) => server.listen(SOCK, r));
fs.chmodSync(SOCK, 0o600);

// 内容感知假 fetch：Cookie 含 digest → 成功；否则 NotLogin（→ COOKIE_EXPIRED）。
const fetchImpl = async (_url, opts = {}) => {
  const cookie = String(opts.headers?.cookie ?? '');
  if (cookie.includes('digest=')) return new Response(JSON.stringify({ Result: USAGE }), { status: 200 });
  return new Response(JSON.stringify({ ResponseMetadata: { Error: { Code: 'NotLogin', Message: 'Not logged in' } } }), { status: 200 });
};
const logger = { info() {}, warn() {}, debug() {} };
const cookieFile = path.join(HOME, '.ark-plan-console-cookie.json');
const reset = ({ settle = 2, logged = true, inPage = 401 } = {}) => {
  ops.length = 0; liveTabs.clear(); nextTab = 500;
  getCookiesCalls = 0; settleAfter = settle; loggedIn = logged; inPageStatus = inPage;
  fs.rmSync(cookieFile, { force: true });
};
after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('早期收割不完整：必须重试到拿到可用 Cookie 才落盘并成功（修前存坏 Cookie 后失败）', async () => {
  reset({ settle: 2, inPage: 401 });
  const quota = new ArkQuota({ fetchImpl, logger, ttlMs: 60_000 });
  const result = await quota.refresh({ force: true, allowBrowser: true });
  assert.equal(result.ok, true, `应重试收割直到成功，实际 error=${result.error}`);
  assert.ok(getCookiesCalls >= 2, `不完整收割应触发重收割，实际 getCookies 仅 ${getCookiesCalls} 次`);
  const saved = loadStoredCookie();
  assert.ok(saved, '成功后应落盘 Cookie');
  assert.match(saved.cookie, /digest=/, '落盘的必须是含会话 digest 的可用 Cookie，而非 AccountID-only 的坏 Cookie');
});

test('页面 settle 慢（多次不完整）仍在重试上限内自愈', async () => {
  reset({ settle: 3, inPage: 401 });
  const quota = new ArkQuota({ fetchImpl, logger, ttlMs: 60_000 });
  const result = await quota.refresh({ force: true, allowBrowser: true });
  assert.equal(result.ok, true, `settle 较慢也应自愈，实际 error=${result.error}`);
  assert.match(loadStoredCookie().cookie, /digest=/);
});

test('首次收割即完整：一次成功，不多余重试', async () => {
  reset({ settle: 0, inPage: 401 });
  const quota = new ArkQuota({ fetchImpl, logger, ttlMs: 60_000 });
  const result = await quota.refresh({ force: true, allowBrowser: true });
  assert.equal(result.ok, true, `error=${result.error}`);
  assert.equal(getCookiesCalls, 1, '完整 Cookie 一次收割即可，不应多余重试');
  assert.match(loadStoredCookie().cookie, /digest=/);
});

test('真未登录（jar 无 AccountID）：报未登录、不落盘坏 Cookie', async () => {
  reset({ logged: false, inPage: 401 });
  const quota = new ArkQuota({ fetchImpl, logger, ttlMs: 60_000 });
  const result = await quota.refresh({ force: true, allowBrowser: true });
  assert.equal(result.ok, false, '真未登录应失败');
  assert.match(result.error, /未登录|登录/, `应提示未登录，实际 ${result.error}`);
  assert.equal(loadStoredCookie(), null, '未登录不得落盘任何 Cookie');
});
