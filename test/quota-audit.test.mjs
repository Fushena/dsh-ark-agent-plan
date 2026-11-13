/**
 * quota.js 审计回归（#4 退避挡手动 / #5 并发手动互踩 / #9 窗口过期用旧 used）。
 * 全注入：假桥 net socket + 假 fetch + 临时 DSH_HOME，绝不碰真实凭据/网络/live 脚本。
 *
 * 跑法：ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *   --import ./test/runtime.mjs --test ./test/quota-audit.test.mjs
 */
import test from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// ── 环境必须在 import quota.js 之前设好（DIR/TOKEN_FILE/FIXED_SOCK 在模块顶层读 env）──
const TMP = fs.mkdtempSync('/tmp/ark-quota-audit-');
const HOME = path.join(TMP, 'home'); fs.mkdirSync(HOME, { mode: 0o700 });
const BRIDGE = path.join(TMP, 'bridge'); fs.mkdirSync(BRIDGE, { mode: 0o700 });
const SOCK = path.join(BRIDGE, 'fake.sock');
process.env.DSH_HOME = HOME;
process.env.DSH_BRIDGE_DIR = BRIDGE;
process.env.DSH_BRIDGE_SOCK = SOCK;
process.env.DSH_BRIDGE_TOKEN = path.join(BRIDGE, 'token');
fs.writeFileSync(process.env.DSH_BRIDGE_TOKEN, `faketoken\n${SOCK}\n`, { mode: 0o600 });

const { ArkQuota } = await import('../lib/quota.js');

// ── 假桥：记录 op 序列；open 分配递增 tabId；cdp 按 method 应答 ──
const ops = [];
let nextTab = 100;
const liveTabs = new Map();
let cdpDelayMs = 0;
let currentUsage = { PlanType: 'pro', AFPFiveHour: { Quota: 100, Used: 1, ResetTime: Date.now() + 3600_000 } };
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
      if (cdpDelayMs) await new Promise((r) => setTimeout(r, cdpDelayMs));
      if (!liveTabs.has(Number(req.args.tabId))) return fail('tab closed');
      if (req.args.method === 'Runtime.evaluate') {
        const expr = String(req.args.params?.expression ?? '');
        if (expr.includes('readyState')) return reply({ result: { result: { value: JSON.stringify({ ready: 'complete', url: 'https://console.volcengine.com/x', host: 'console.volcengine.com' }) } } });
        return reply({ result: { result: { value: JSON.stringify({ status: 200, body: JSON.stringify({ Result: currentUsage }) }) } } });
      }
      return reply({ result: { result: { cookies: [{ name: 'AccountID', value: 'fake', domain: 'console.volcengine.com' }, { name: 'csrfToken', value: 'fakecsrf', domain: 'console.volcengine.com' }] } } });
    }
    return fail('unknown op');
  });
});
await new Promise((r) => server.listen(SOCK, r));
fs.chmodSync(SOCK, 0o600);

const fetchImpl = async () => new Response(JSON.stringify({ Result: currentUsage }), { status: 200 });
const logger = { info() {}, warn() {}, debug() {} };
const cookieFile = path.join(HOME, '.ark-plan-console-cookie.json');
const reset = () => { ops.length = 0; liveTabs.clear(); nextTab = 100; cdpDelayMs = 0; fs.rmSync(cookieFile, { force: true }); };

after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

// 审计#4：连续失败进入退避后，用户手动点「更新凭据」(allowBrowser=true) 必须绕过退避直接收割。
test('审计#4：退避窗口内 allowBrowser=true 仍触发桥操作并成功', async () => {
  reset();
  const quota = new ArkQuota({ fetchImpl, logger, ttlMs: 60_000 });
  const realNow = Date.now; let fake = realNow(); Date.now = () => fake;
  try {
    const first = await quota.refresh({ force: true }); // 无 stored cookie、无 allowBrowser → #fail 计数、进退避
    assert.equal(first.ok, false);
    const opsBefore = ops.length;
    const manual = await quota.refresh({ force: true, allowBrowser: true }); // 退避窗口内手动点击
    assert.equal(manual.ok, true, `退避不应挡住手动更新凭据，实际 error=${manual.error}`);
    assert.ok(ops.length > opsBefore, '手动 allowBrowser 必须真正触发桥操作（开标签/收割），而非被退避回放');
  } finally { Date.now = realNow; }
});

// 审计#5：并发两次 allowBrowser 刷新必须去重，不能各自开标签、A 的清理关掉 B 在用的标签。
test('审计#5：并发两次 allowBrowser 刷新都成功、只开一个标签、不误报未登录', async () => {
  reset();
  const quota = new ArkQuota({ fetchImpl, logger, ttlMs: 60_000 });
  cdpDelayMs = 300; // 拉宽收割窗口，让「A 先完成并清理」与「B 仍在收割」必然重叠
  const pA = quota.refresh({ force: true, allowBrowser: true });
  await new Promise((r) => setTimeout(r, 50)); // B 在 A 开标签之后启动
  const pB = quota.refresh({ force: true, allowBrowser: true });
  const [a, b] = await Promise.all([pA, pB]);
  assert.equal(a.ok, true, `A 应成功，error=${a.error}`);
  assert.equal(b.ok, true, `B 应成功（不得被 A 的清理误报未登录），error=${b.error}`);
  const opens = ops.filter((o) => o.op === 'open').length;
  assert.equal(opens, 1, `并发手动刷新应去重为一次开标签，实际开了 ${opens} 个`);
});

// 审计#9：窗口过期后 remaining 应恢复满额（used 清零），而非沿用旧 used 导致 remaining 恒 0。
test('审计#9：窗口过期后 peek 的 remaining 恢复满额、used 归零', async () => {
  reset();
  const realNow = Date.now; let fake = realNow(); Date.now = () => fake;
  try {
    // 用已保存凭据走纯 Node 同步（无需桥）：额度已用满 Used==Quota，1 小时后重置。
    currentUsage = { PlanType: 'pro', AFPFiveHour: { Quota: 100, Used: 100, ResetTime: fake + 3600_000 } };
    fs.writeFileSync(cookieFile, JSON.stringify({ cookie: 'AccountID=fake', csrf: 'fakecsrf', savedAt: fake, expiresAt: fake + 86400_000 }), { mode: 0o600 });
    const quota = new ArkQuota({ fetchImpl, logger, ttlMs: 60_000 });
    const synced = await quota.refresh({ force: true });
    assert.equal(synced.ok, true);
    const before = quota.peek().windows.find((w) => w.key === 'fiveHour');
    assert.equal(before.remaining, 0, '同步时额度用满，remaining 应为 0');
    fake += 3600_001; // 越过重置时间 → 窗口已过期重置
    const after = quota.peek().windows.find((w) => w.key === 'fiveHour');
    assert.equal(after.used, 0, `窗口过期后 used 应清零，实际 ${after.used}`);
    assert.equal(after.remaining, 100, `窗口过期后 remaining 应恢复满额 100，实际 ${after.remaining}`);
  } finally { Date.now = realNow; currentUsage = { PlanType: 'pro', AFPFiveHour: { Quota: 100, Used: 1, ResetTime: Date.now() + 3600_000 } }; }
});
