import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Agent Plan 额度查询（5 小时 / 周 / 月）。
 *
 * 为什么需要浏览器 Cookie：
 *   Plan 专属 API Key 只能打 `/api/plan/v3/*` 推理端点，控制台额度接口
 *   (`console.volcengine.com/api/top/ark/...`) 一律返回 401（实测 2026-11-05）。
 *   额度数据的唯一来源是控制台接口 `GetAgentPlanAFPUsage`，它需要登录态 Cookie +
 *   CSRF Token。登录票据 `AccountID`/会话票据是 HttpOnly，`document.cookie` 读不到，
 *   必须经 CDP `Network.getCookies` 取。
 *
 * 复用 dsh-chrome-bridge 的 socket 协议（若用户装了该插件）：一行 JSON 请求
 * {token,id,op,args,client,timeoutMs} → 一行 JSON 响应 {ok,result}。
 */

const WIN = process.platform === "win32";
const UID = typeof process.getuid === "function" ? process.getuid() : null;
const DIR = process.env.DSH_BRIDGE_DIR || (WIN ? path.join(os.tmpdir(), "dsh-bridge") : `/tmp/dsh-bridge-${UID ?? "user"}`);
const TOKEN_FILE = process.env.DSH_BRIDGE_TOKEN || path.join(DIR, "dsh-bridge.token");
const FIXED_SOCK = process.env.DSH_BRIDGE_SOCK || (WIN ? null : path.join(DIR, "dsh-bridge.sock"));

/**
 * 收割域：**只用 console 这一个域**。
 *
 * 实测教训（2026-11-09）：多域收割会把同名 cookie 的不同域副本混在一起
 * （signin.volcengine.com 的 csrfToken/digest 与 console 域的值不同），
 * 按名字去重后可能留下错误的那个，导致 Node 直连稳定返回 401 NotLogin，
 * 而页面内同源请求却成功。只查 console 域，拿到的就是该域真实生效的那套。
 */
const CONSOLE_URLS = Object.freeze([
  "https://console.volcengine.com",
]);

/** 只保留火山域的 cookie；其它域一律丢弃。 */
function isVolcCookie(cookie) {
  const domain = String(cookie?.domain ?? "").toLowerCase();
  return domain.endsWith("volcengine.com") || domain.endsWith("bytepluses.com");
}
/** 登录判据：有 AccountID 说明已登录。 */
const LOGIN_COOKIE = "AccountID";

const USAGE_ACTION = "GetAgentPlanAFPUsage";

/**
 * 控制台 Cookie 的本地持久化文件。
 * 收割一次后落盘，之后即使 Chrome 完全关闭，额度刷新也只走 Node 直连。
 */
function cookieStorePath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  return path.join(home, ".ark-plan-console-cookie.json");
}
const API_BASE = "https://console.volcengine.com";
const API_PATH = "/api/top/ark/cn-beijing/2024-01-01/";

function tokenLines() {
  try { return fs.readFileSync(TOKEN_FILE, "utf8").split("\n").map((l) => l.trim()); } catch { return []; }
}
function hostSock() { return FIXED_SOCK || tokenLines()[1] || null; }
function hostUp() { const s = hostSock(); return Boolean(s) && (WIN || fs.existsSync(s)); }

function checkDir(dir) {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (!WIN && ((UID !== null && st.uid !== UID) || (st.mode & 0o077)))) {
    throw new Error(`${dir} 不是只属于当前用户的目录，拒绝使用`);
  }
}

/** Chrome 在跑、桥宿主在听、扩展已连接时返回 true；否则静默 false。 */
export function bridgeAvailable() {
  try {
    if (!hostUp()) return false;
    checkDir(WIN ? DIR : path.dirname(hostSock()));
    return true;
  } catch { return false; }
}

function call(op, args = {}, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const SOCK = hostSock();
    if (!SOCK) return reject(new Error("浏览器桥不在运行"));
    let sock;
    try { sock = net.connect(SOCK); } catch (error) { return reject(error); }
    let acc = "";
    let done = false;
    let timer = null;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { sock.destroy(); } catch { /* 幂等 */ }
      fn(value);
    };
    timer = setTimeout(() => finish(reject, new Error(`浏览器桥 ${op} 超时`)), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(`${JSON.stringify({
      token: tokenLines()[0], id: `ark-${Date.now()}`, op, args, client: "dsh-ark-agent-plan",
    })}\n`));
    sock.on("data", (chunk) => {
      acc += chunk;
      const at = acc.indexOf("\n");
      if (at < 0) return;
      acc = acc.slice(0, at);
      let parsed;
      try { parsed = JSON.parse(acc); } catch (error) { return finish(reject, error); }
      if (!parsed?.ok) return finish(reject, new Error(parsed?.error ?? `${op} 失败`));
      finish(resolve, parsed.result);
    });
    sock.on("error", (error) => finish(reject, new Error(`连不上浏览器桥：${error.message}`)));
    sock.on("close", () => finish(reject, new Error("浏览器桥连接被关闭")));
  });
}

const CONSOLE_HOME = "https://console.volcengine.com/ark/region:cn-beijing/subscription/agent-plan";

function isConsoleUrl(url) {
  return typeof url === "string"
    && (url.startsWith("https://console.volcengine.com") || url.startsWith("https://www.volcengine.com"));
}

/**
 * 找一个火山控制台标签页（页面内取数需要 tabId 走 CDP Runtime.evaluate）。
 * 任何窗口都可以：页面自己带登录态，与所在窗口无关。
 */
/**
 * 找一个**插件自己开的**火山控制台标签（agentWindow=true）。
 *
 * 绝不复用用户自己开的标签：CDP 调用会给标签附着调试器，Chrome 顶部就会
 * 出现「DSH agent 正在操作此标签页」的横幅，用户关都关不掉（2026-11-09 反馈）。
 * 用户开的标签一律不碰，宁可自己开一个临时的、用完立刻关。
 */
export async function findConsoleTab({ autoOpen = false } = {}) {
  const tabs = await call("tabs", {}, 10_000);
  const list = Array.isArray(tabs) ? tabs : [];
  // 只认 agentWindow=true 的（插件自己开的）；用户的标签直接跳过。
  const consoleTabs = list.filter((tab) => isConsoleUrl(tab?.url) && isDisposableTab(tab));
  if (consoleTabs.length) return consoleTabs[0];
  if (!autoOpen) return null;
  try {
    const opened = await call("open", { url: CONSOLE_HOME }, 20_000);
    const tabId = Number(opened?.tabId ?? opened?.result?.tabId);
    if (!Number.isFinite(tabId)) return null;
    return { id: tabId, agentWindow: true, url: CONSOLE_HOME, autoOpened: true };
  } catch {
    return null;
  }
}

/**
 * 只处理「插件自己开的」标签：agentWindow=true 说明它落在 DSH 干活窗口，
 * 是插件为取数临时打开的，可以随手关掉；用户自己在主窗口开的不动。
 */
function isDisposableTab(tab) {
  return Boolean(tab?.agentWindow) || Boolean(tab?.autoOpened);
}

/**
 * 解除用户标签上的调试器附着。
 *
 * CDP 调用会给标签附着 debugger，Chrome 顶部随之出现「DSH agent 正在操作此标签页」
 * 的横幅，即使标签早已关闭也可能残留。detach 是桥提供的解绑操作，调用后
 * attached 变 false，横幅消失。这里只对**用户自己的**火山标签做善后，
 * 插件自己开的标签直接关掉就够了。
 */
export async function releaseUserConsoleTabs() {
  try {
    const tabs = await call("tabs", {}, 10_000);
    const list = Array.isArray(tabs) ? tabs : [];
    const userTabs = list.filter((tab) => isConsoleUrl(tab?.url) && !isDisposableTab(tab));
    for (const tab of userTabs) {
      try {
        const status = await call("detach", { tabId: Number(tab.id) }, 8_000);
        // 已不再附着时 detach 也是成功的，忽略结果即可。
        void status;
      } catch { /* 扩展不支持 detach 时静默跳过 */ }
    }
    return userTabs.length;
  } catch {
    return 0;
  }
}

/** 关掉所有插件自己开的火山标签（清理历史残留，避免越积越多）。 */
export async function closeStrayConsoleTabs({ excludeId = null } = {}) {
  try {
    const tabs = await call("tabs", {}, 10_000);
    const list = Array.isArray(tabs) ? tabs : [];
    const strays = list.filter((tab) => isConsoleUrl(tab?.url)
      && isDisposableTab(tab)
      && Number(tab.id) !== Number(excludeId));
    for (const tab of strays) {
      try { await call("close", { tabId: Number(tab.id) }, 8_000); } catch { /* 已关掉 */ }
    }
    return strays.length;
  } catch {
    return 0;
  }
}

/**
 * 收割火山控制台 Cookie。返回 {cookie, csrf} 或 null（未登录/无标签页）。
 * 优先 Network.getCookies（能读 HttpOnly 登录票据），失败再试 Storage.getCookies。
 */
/**
 * 解出 CDP 返回里的 cookie 数组。
 * 实测桥的信封是两层：{result:{result:{cookies:[...]}}}（2026-11-05 踩过的坑：
 * 只找一层的 raw.result.cookies 会永远返回 0 条，误判成「拿不到登录态」）。
 * 这里逐层下探，兼容所有已知形状。
 */
function cookiesOf(raw) {
  const candidates = [
    raw?.result?.result?.cookies,
    raw?.result?.cookies,
    raw?.cookies,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return [];
}

/**
 * 在后台开一个控制台标签页并返回 tabId。
 * 用 active:false，标签在后台、不抢焦点；用户完全不必看到它。
 * 页面自己有登录态（同一 Chrome profile），所以在哪个窗口开都能取到数据。
 */
export async function openConsoleTab() {
  try {
    const opened = await call("open", { url: CONSOLE_HOME, active: false }, 20_000);
    const tabId = Number(opened?.tabId ?? opened?.result?.tabId);
    return Number.isFinite(tabId) ? tabId : null;
  } catch {
    return null;
  }
}

export async function harvestConsoleCookie(tabId) {
  // 只按火山域收割，全部尝试都带 urls —— 无域名限制的收割已删除（安全审计）。
  const attempts = [
    { method: "Network.getCookies", params: { urls: [...CONSOLE_URLS] } },
    { method: "Storage.getCookies", params: { urls: [...CONSOLE_URLS] } },
  ];
  let cookies = [];
  const bag = new Map();
  for (const attempt of attempts) {
    let raw = null;
    try { raw = await call("cdp", { tabId, ...attempt }, 15_000); } catch { continue; }
    for (const cookie of cookiesOf(raw)) {
      if (!cookie?.name || !cookie.value) continue;
      // 双重防线：CDP 返回的每条 cookie 再验一次域，非火山域直接丢弃。
      if (!isVolcCookie(cookie)) continue;
      // 同域同名只保留第一个：不按长度择优（多域时那会选中别的域的副本）。
      if (!bag.has(cookie.name)) bag.set(cookie.name, cookie);
    }
    cookies = [...bag.values()];
    // 拿到登录判据就能停，避免多余的 CDP 往返。
    if (cookies.some((cookie) => cookie.name === LOGIN_COOKIE && String(cookie.value ?? "").trim() !== "")) break;
  }
  if (!cookies.some((cookie) => cookie?.name === LOGIN_COOKIE && String(cookie.value ?? "").trim() !== "")) return null;
  const parts = [];
  let csrf = null;
  for (const cookie of cookies) {
    parts.push(`${cookie.name}=${cookie.value ?? ""}`);
    if (cookie.name === "csrfToken") csrf = String(cookie.value ?? "");
  }
  return { cookie: parts.join("; "), csrf };
}

/** 直接请求控制台额度接口。 */
async function fetchUsage(fetchImpl, cookie, csrf, timeoutMs) {
  const response = await fetchImpl(`${API_BASE}${API_PATH}${USAGE_ACTION}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      "user-agent": "Mozilla/5.0 (compatible; dsh-ark-agent-plan)",
    },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`额度接口返回非 JSON（HTTP ${response.status}）`); }
  const metadata = payload?.ResponseMetadata ?? {};
  if (metadata.Error) {
    const code = String(metadata.Error.Code ?? "");
    if (code === "InvalidCSRFToken") throw new Error("CSRF 校验失败，请刷新控制台页面后重试");
    throw new Error(`额度接口错误：${code} ${metadata.Error.Message ?? ""}`.trim());
  }
  const result = payload?.Result;
  if (!result) throw new Error("额度接口没有返回 Result");
  return result;
}

/**
 * 在页面上下文里直接请求控制台额度接口（首选方案）。
 *
 * 为什么比收割 Cookie 更好：
 *   - 页面自己带着登录态（含 HttpOnly 票据）请求，同源 + credentials:"include" 天然通过，
 *     不需要把任何票据搬出浏览器。
 *   - 不依赖 Network.getCookies 是否附着调试器（实测该通道在 DSH 干活窗口常返回 0 条）。
 *   - 后台标签页就够：用户不必切过去，看一眼标签也没有感知。
 * 返回归一化数据，失败抛错由调用方处理。
 */
/**
 * 等标签页处于可执行状态（SPA 完成加载、document 可读）。
 * 刚 open 出来的标签会短暂停在 about:blank / 加载中，此时读 cookie 会被拒。
 */
async function waitForUsablePage(tabId, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = await call("cdp", {
        tabId, method: "Runtime.evaluate",
        params: {
          expression: 'JSON.stringify({ ready: document.readyState, url: location.href, host: location.host })',
          returnByValue: true,
        },
      }, 8_000);
      const text = raw?.result?.result?.result?.value ?? raw?.result?.result?.value ?? raw?.result?.value;
      if (typeof text === "string") {
        const info = JSON.parse(text);
        if (info.host === "console.volcengine.com" && (info.ready === "interactive" || info.ready === "complete")) {
          return true;
        }
      }
    } catch { /* 页面还没就绪，继续等 */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

async function fetchUsageInPage(tabId) {
  const expression = `(async () => {
    try {
      const pick = (name) => {
        const hit = document.cookie.split(";").map((s) => s.trim()).find((c) => c.startsWith(name + "="));
        return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
      };
      const csrf = pick("csrfToken");
      const response = await fetch(${JSON.stringify(API_PATH + USAGE_ACTION)}, {
        method: "POST",
        headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) },
        body: "{}",
        credentials: "include",
      });
      const text = await response.text();
      return JSON.stringify({ status: response.status, body: text });
    } catch (error) {
      return JSON.stringify({ status: 0, body: String(error && error.message || error) });
    }
  })()`;
  const raw = await call("cdp", {
    tabId, method: "Runtime.evaluate",
    params: { expression, returnByValue: true, awaitPromise: true },
  }, 25_000);
  const payloadText = raw?.result?.result?.result?.value ?? raw?.result?.result?.value ?? raw?.result?.value;
  if (typeof payloadText !== "string") throw new Error("页面内取数没有返回结果");
  let envelope;
  try { envelope = JSON.parse(payloadText); } catch { throw new Error("页面内取数返回无法解析"); }
  if (envelope.status !== 200) throw new Error(`页面内取数失败（HTTP ${envelope.status}）：${String(envelope.body).slice(0, 160)}`);
  let body;
  try { body = JSON.parse(envelope.body); } catch { throw new Error("额度接口返回非 JSON"); }
  const metadata = body?.ResponseMetadata ?? {};
  if (metadata.Error) throw new Error(`额度接口错误：${metadata.Error.Code} ${metadata.Error.Message ?? ""}`.trim());
  if (!body?.Result) throw new Error("额度接口没有返回 Result");
  return body.Result;
}

/** 读取已持久化的控制台 Cookie；过期返回 null。 */
export function loadStoredCookie() {
  try {
    const raw = fs.readFileSync(cookieStorePath(), "utf8");
    const data = JSON.parse(raw);
    if (!data?.cookie || typeof data.cookie !== "string") return null;
    if (data.expiresAt && Date.now() > data.expiresAt) return null;
    return data;
  } catch {
    return null;
  }
}

/** 落盘控制台 Cookie（仅当前用户可读）。 */
function saveStoredCookie(cookie, csrf) {
  try {
    const file = cookieStorePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 30 天有效期：火山登录态通常能维持很久，取数失败会自动回落到浏览器收割。
    const payload = JSON.stringify({ cookie, csrf, savedAt: Date.now(), expiresAt: Date.now() + 30 * 86400_000 });
    // writeFileSync 的 mode 只在**新建**文件时生效：文件已存在（上次收割留下的）
    // 时会沿用旧权限，可能宽到 0644。这里再补一次 chmod 强制收紧到 0600，
    // 与 README 承诺的「仅当前用户可读」对齐。失败（如 Windows 无此语义）忽略。
    fs.writeFileSync(file, payload, { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* 平台不支持或文件已被移除，忽略 */ }
    return true;
  } catch {
    return false;
  }
}

/** 用 Cookie 直接请求（不需要浏览器）。 */
async function fetchUsageWithCookie(fetchImpl, cookie, csrf, timeoutMs = 20_000) {
  const response = await fetchImpl(`${API_BASE}${API_PATH}${USAGE_ACTION}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    },
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`额度接口返回非 JSON（HTTP ${response.status}）`); }
  const metadata = payload?.ResponseMetadata ?? {};
  if (metadata.Error) {
    const code = String(metadata.Error.Code ?? "");
    if (/NotLogin|InvalidCSRF/i.test(code)) throw new Error(`COOKIE_EXPIRED: ${code}`);
    throw new Error(`额度接口错误：${code} ${metadata.Error.Message ?? ""}`.trim());
  }
  if (!payload?.Result) throw new Error("额度接口没有返回 Result");
  return payload.Result;
}

const WINDOWS = Object.freeze([
  { key: "fiveHour", field: "AFPFiveHour", label: "近 5 小时", short: "5小时" },
  { key: "weekly", field: "AFPWeekly", label: "近一周", short: "周" },
  { key: "monthly", field: "AFPMonthly", label: "近一月", short: "月" },
]);

/** 把网关返回的 AFP 用量归一化成 UI 直接可用的结构。 */
export function normalizeUsage(result) {
  const planType = String(result?.PlanType ?? "");
  const windows = [];
  for (const spec of WINDOWS) {
    const bucket = result?.[spec.field];
    if (!bucket) continue;
    const quota = Number(bucket.Quota) || 0;
    const used = Number(bucket.Used) || 0;
    const resetAt = Number(bucket.ResetTime) || 0;
    windows.push({
      key: spec.key,
      label: spec.label,
      short: spec.short,
      quota,
      used,
      remaining: Math.max(0, quota - used),
      percentUsed: quota > 0 ? Math.min(100, (used / quota) * 100) : 0,
      resetAt: resetAt || undefined,
    });
  }
  return { planType, windows, fetchedAt: Date.now(), hasReward: Boolean(result?.HasReward) };
}

/** 把剩余毫秒格式化成「3小时25分钟」这种中文短格式。 */
export function formatRemaining(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "已重置";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return hours > 0 ? `${days}天${hours}小时` : `${days}天`;
  if (hours > 0) return minutes > 0 ? `${hours}小时${minutes}分钟` : `${hours}小时`;
  if (minutes > 0) return `${minutes}分钟`;
  return "不到1分钟";
}

/** 人类可读数字：1,199 / 1万 / 3.5万。 */
export function formatCredits(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (number >= 10_000) {
    const wan = number / 10_000;
    const text = wan >= 10 ? Math.round(wan).toString() : (Math.round(wan * 100) / 100).toString();
    return `${text}万`;
  }
  if (number >= 1_000) return Math.round(number).toLocaleString("zh-CN");
  return String(Math.round(number * 1000) / 1000);
}

/**
 * 额度服务：持有最近一次成功抓取的结果，供 UI 与工具调用。
 * 任何失败都不抛出，返回带 error 的对象，保证插件主体不受影响。
 */
export class ArkQuota {
  #fetch;
  #logger;
  #cache = null;
  #lastError = null;
  #inflight = null;
  #ttlMs;
  /** 收割到的控制台 Cookie 缓存：标签页被关掉后仍可续用，避免每次都要开标签。 */
  #harvested = null;
  #harvestedAt = 0;
  /**
   * 本地 AFP 记账账本：在两次服务端同步之间，用每次推理的 token 消耗估算 AFP。
   * 结构 {fiveHour:{used,resetAt}, weekly:{...}, monthly:{...}, tokens:{...}}。
   * 服务端同步成功时用真实值覆盖（消除估算漂移）；窗口过期自动清零。
   */
  #ledger = null;
  /** 失败退避：连续失败后暂缓重试，避免每次轮询都开一次浏览器标签。 */
  #failures = 0;
  #nextAttemptAt = 0;
  /** 每模型 AFP 计价（CNY/百万token），afpPerCny 折算；可用 config 覆盖。 */
  #afpPricing = null;
  #afpPerCny = 1;

  constructor({ fetchImpl = globalThis.fetch, logger, ttlMs = 60_000, afpPricing, afpPerCny } = {}) {
    this.#fetch = fetchImpl;
    this.#logger = logger;
    this.#ttlMs = ttlMs;
    if (afpPricing && typeof afpPricing === "object") this.#afpPricing = afpPricing;
    if (Number.isFinite(afpPerCny) && afpPerCny > 0) this.#afpPerCny = afpPerCny;
  }

  /** 最近一次结果（可能为空）。stale=true 表示已过期但仍在展示。 */
  peek() {
    if (!this.#cache) return { ok: false, error: this.#lastError ?? "尚未获取", stale: true };
    const age = Date.now() - this.#cache.fetchedAt;
    return { ...this.#applyLedger(this.#cache), ok: true, stale: age > this.#ttlMs, age };
  }

  /**
   * 拉取额度。force=false 时命中缓存直接返回。
   * 返回 {ok:true, data} 或 {ok:false, error}，永不 throw。
   */
  async refresh({ force = false, allowBrowser = false } = {}) {
    if (!force && this.#cache && Date.now() - this.#cache.fetchedAt < this.#ttlMs) {
      return { ok: true, data: this.#applyLedger(this.#cache) };
    }
    // 并发去重（审计#5，2026-11-13）：
    //   - 手动(allowBrowser)请求复用「另一个手动」在途 promise —— 否则两次「更新凭据」
    //     各开一个标签，先完成的清理(closeStrayConsoleTabs)会关掉另一个仍在收割的
    //     标签，后者误报「控制台未登录」。
    //   - 纯 Node 轮询复用任何在途结果（只读缓存，谁的结果都行）。
    //   - 手动请求遇到「纯 Node」在途时不能复用（那不会碰浏览器、拿不到新凭据），
    //     升级为手动任务接管槽位。
    if (this.#inflight && (!allowBrowser || this.#inflight.allowBrowser)) return this.#inflight.promise;
    const task = this.#doRefresh({ allowBrowser }).finally(() => {
      if (this.#inflight?.promise === task) this.#inflight = null;
    });
    this.#inflight = { promise: task, allowBrowser };
    return task;
  }

  /**
   * 刷新额度。
   *
   * **默认永不碰浏览器**（allowBrowser=false）：只读已保存的 Cookie 走纯 Node 请求。
   * 这是刻意设计 —— dsh-chrome-bridge 每操作一个标签就建一个同名的
   * 「DSH agent 正在操作」标签组，关标签时组不回收，空组会在标签栏无限累积
   * （2026-11-09 实测堆了 40+ 个）。只有用户显式点「更新凭据」时才允许碰浏览器。
   */
  async #doRefresh({ allowBrowser = false } = {}) {
    try {
      // 退避只约束自动/纯 Node 轮询（审计#4，2026-11-13）：用户显式点「更新凭据」
      // (allowBrowser=true) 是手动操作，必须绕过退避窗口直接尝试收割，否则连续
      // 失败后最长 30 分钟内手动点击零响应。
      if (!allowBrowser && Date.now() < this.#nextAttemptAt) {
        // 退避窗口内只回放上次错误，**不推进退避**：面板约 30 秒轮询一次，
        // 若这里也走 #fail，每次轮询都会 #failures++ 并继续翻倍
        // （60s → 120s → 240s … 很快顶到 30 分钟上限），等于把「连续失败」
        // 放大成「每次轮询都算新失败」，退避窗口内反而越来越退不了。
        return this.#fail(this.#lastError ?? "额度获取暂时不可用", { count: false });
      }

      // ── 常态：纯 Node，只用已保存的凭据 ──────────────────────────────
      const stored = loadStoredCookie();
      if (stored) {
        try {
          const result = await fetchUsageWithCookie(this.#fetch, stored.cookie, stored.csrf, 20_000);
          return this.#succeed(result);
        } catch (error) {
          const expired = /COOKIE_EXPIRED/.test(String(error?.message ?? ""));
          if (!expired) throw error;          // 断网等：直接报出，不动浏览器
          if (!allowBrowser) {
            // 凭据过期且没被授权碰浏览器 → 明确提示用户手动更新，绝不自动开标签。
            return this.#fail("控制台登录已过期，请在面板点「更新凭据」重新同步一次");
          }
          // 被授权了才往下走去收割。
        }
      } else if (!allowBrowser) {
        return this.#fail("尚未保存控制台凭据，请在面板点「更新凭据」初始化一次");
      }

      // ── 仅在用户显式点「更新凭据」时：借浏览器收割一次 ────────────────
      if (!bridgeAvailable()) {
        return this.#fail(
          stored
            ? "控制台登录已过期，且 Chrome 未运行：请启动 Chrome（装 dsh-chrome-bridge 扩展）后点「更新凭据」"
            : "尚未保存控制台凭据：请启动 Chrome（装 dsh-chrome-bridge 扩展）后点「更新凭据」",
        );
      }

      const existing = await findConsoleTab();
      let tabId = existing ? Number(existing.id) : null;
      if (!tabId) tabId = await openConsoleTab();
      if (!tabId) return this.#fail("无法在 Chrome 里打开控制台页面：请确认 dsh-chrome-bridge 扩展已加载");

      try {
        const harvested = await this.#harvestForStore(tabId);
        if (!harvested) return this.#fail("控制台未登录：请在 Chrome 登录 console.volcengine.com 后点「更新凭据」");
        saveStoredCookie(harvested.cookie, harvested.csrf);
        try {
          const result = await fetchUsageWithCookie(this.#fetch, harvested.cookie, harvested.csrf, 20_000);
          return this.#succeed(result);
        } catch {
          // 收割到但 Node 请求失败：回落到页面内取数（同样是这一次性的手动操作里）。
          const result = await fetchUsageInPage(tabId);
          return this.#succeed(result);
        }
      } finally {
        // 这一次性操作结束后立刻收拾干净：关标签、清残留、解除调试附着。
        try { await call("close", { tabId }, 8_000); } catch { /* 已关掉 */ }
        try { await closeStrayConsoleTabs(); } catch { /* 尽力而为 */ }
        try { await releaseUserConsoleTabs(); } catch { /* 尽力而为 */ }
      }
    } catch (error) {
      return this.#fail(error instanceof Error ? error.message : String(error));
    }
  }

  /** 等页面就绪后收割全量 Cookie（含 HttpOnly 票据）。 */
  async #harvestForStore(tabId) {
    await waitForUsablePage(tabId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
      const harvested = await harvestConsoleCookie(tabId);
      if (harvested) return harvested;
    }
    return null;
  }

  /** 统一的成功收尾：写缓存、清错误、以真实值重建本地账本基准。 */
  #succeed(result) {
    const data = normalizeUsage(result);
    this.#cache = data;
    this.#lastError = null;
    this.#resetLedgerFrom(data);
    this.#failures = 0;
    this.#nextAttemptAt = 0;
    this.#logger?.info?.(`dsh-ark-agent-plan: 额度已同步（${data.planType}）`);
    return { ok: true, data };
  }

  /**
   * 记一笔推理消耗（token → AFP 估算）。
   * 由适配器在每次流结束后调用；服务端下次同步时以真实值覆盖，消除漂移。
   * AFP ≈ 人民币额度。按模型单价（元/百万token）折算，无计价表的模型跳过。
   */
  recordUsage({ model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, reasoningTokens = 0 } = {}) {
    if (!this.#ledger) return;
    const pricing = this.#afpPricing?.[model] ?? this.#afpPricing?._default;
    if (!pricing) return;
    const M = 1_000_000;
    const inRate = pricing.input ?? 0;
    const outRate = pricing.output ?? inRate;
    const cacheRate = pricing.cacheRead ?? inRate * 0.2;
    const reasoningRate = pricing.reasoning ?? 0;
    const cost =
      (inputTokens / M) * inRate
      + (outputTokens / M) * outRate
      + (cacheReadTokens / M) * cacheRate
      + (reasoningRate ? (reasoningTokens / M) * reasoningRate : 0);
    const afp = cost * this.#afpPerCny;
    if (!Number.isFinite(afp) || afp <= 0) return;
    const now = Date.now();
    for (const key of ["fiveHour", "weekly", "monthly"]) {
      const bucket = this.#ledger[key];
      if (!bucket) continue;
      if (bucket.resetAt && now >= bucket.resetAt) { bucket.used = 0; bucket.resetAt = 0; }
      bucket.used += afp;
    }
    this.#ledger.tokens = (this.#ledger.tokens ?? 0) + inputTokens + outputTokens;
  }

  /** 把账本投影到快照：used/remaining/percent 在两次同步之间实时滚动。 */
  #applyLedger(data) {
    if (!this.#ledger || !data?.windows?.length) return data;
    const now = Date.now();
    const windows = data.windows.map((w) => {
      const bucket = this.#ledger[w.key];
      if (!bucket) return w;
      const expired = bucket.resetAt && now >= bucket.resetAt;
      // 窗口已过期重置 → used 归零（审计#9，2026-11-13），与 recordUsage 的过期
      // 清零一致。旧实现 expired 时仍用 w.used（上次同步的旧值），导致额度用满后
      // 即使窗口已重置，remaining 仍恒 0、内置工具被误摘，直到下次服务端同步。
      const used = expired ? 0 : Math.max(w.used, bucket.used);
      const quota = w.quota || bucket.quota || 0;
      return {
        ...w,
        used,
        remaining: Math.max(0, quota - used),
        percentUsed: quota > 0 ? Math.min(100, (used / quota) * 100) : 0,
        estimated: !expired && bucket.used > w.used + 0.01,
      };
    });
    return { ...data, windows };
  }

  /** 服务端同步成功后，用真实值重建账本基准。 */
  #resetLedgerFrom(data) {
    if (!data?.windows?.length) { this.#ledger = null; return; }
    this.#ledger = {};
    for (const w of data.windows) {
      this.#ledger[w.key] = { used: w.used, quota: w.quota, resetAt: w.resetAt ?? 0 };
    }
  }

  /**
   * 记一次失败并进入指数退避。
   *
   * @param message - 给面板看的错误文本。
   * @param options.count - false 表示「只是回放已有错误，不是一次新的失败」：
   *   不递增 #failures、不推进 #nextAttemptAt。退避窗口内的轮询必须用这个，
   *   否则轮询频率本身会把退避顶到上限（见 #doRefresh）。
   */
  #fail(message, { count = true } = {}) {
    this.#lastError = message;
    if (!count) return { ok: false, error: message };
    // 指数退避：1min → 2min → 4min … 上限 30 分钟，避免登录失效时反复开标签。
    this.#failures = Math.min(this.#failures + 1, 6);
    this.#nextAttemptAt = Date.now() + Math.min(30 * 60_000, 60_000 * 2 ** (this.#failures - 1));
    return { ok: false, error: message };
  }
}
