import { isIP } from "node:net";

/**
 * Web 路由的信任栅栏（纯函数，可单测，不依赖 ctx）。
 *
 * 背景（2026-11-10 实测）：插件用 `ctx.webServer.register({ kind: "prefix", ... })`
 * 注册的路由**绕过 DSH 自己的鉴权** —— `GET /` 与 `/api/...` 都 401，但
 * `GET /ark-agent-plan/quota` 无需任何凭据即 200。因此这条路由必须自带一套
 * 浏览器边界校验，否则等于给宿主机开了个匿名 HTTP 口。
 *
 * 旧实现 `sameOriginOnly()` 有两个致命缺陷：
 *   1. `Origin === Host` 自比 —— 两个值都来自攻击者，等于没校验；
 *   2. 没有 Host 栅栏 —— DNS rebinding 下浏览器会把恶意域名解析到 127.0.0.1，
 *      请求照样是「同源」的，`Origin === Host` 也成立（实测返回 200）。
 *
 * 正确做法是 **Host 栅栏 + sec-fetch-site + Origin 白名单** 三层：
 *   a) Host 必须是 loopback（或与 webServer 的 bind 地址一致）—— 这是挡 DNS
 *      rebinding 的关键：攻击者无法让自己的域名出现在 Host 里同时被判为 loopback。
 *   b) `sec-fetch-site: cross-site` 直接拒绝（浏览器跨站请求的可靠标记）。
 *   c) Origin 若存在，必须是 loopback/bind authority；`Origin: null` 视为可疑。
 *   d) 既无 Origin 也无 sec-fetch-site（本机进程直连，如 curl / 面板调试）→ 放行，
 *      但前提是已通过 Host 栅栏。
 *
 * 关于 (d) 的取舍（有意为之，需写清）：本机同 uid 进程本来就在同一信任域 ——
 * 它能直接读 `~/.dsh` 下的凭据文件、能调 dsh-chrome-bridge 的 socket，拦住它
 * 没有安全收益，反而会破坏面板调试与既有用法。真正的攻击面（DNS rebinding、
 * 浏览器跨站、恶意网页）已经由 a+b+c 挡住。
 *
 * @param req - node:http IncomingMessage（只读 headers）。
 * @param bindHost - webServer 的 bind 地址（`webServer.host`）；可省略。
 * @returns {{ok: boolean, reason: string}} 调用方**只能**用 ok；
 *   reason 仅供日志排障，绝不能回给客户端（避免探测细节泄露）。
 */
export function trustedRouteRequest(req, bindHost) {
  const headers = req?.headers ?? {};

  // ── a) Host 栅栏 ────────────────────────────────────────────────────────
  const rawHost = typeof headers.host === "string" ? headers.host.trim() : "";
  if (rawHost === "") return refuse("missing-host");
  // 用 URL 解析出 hostname：解析失败即拒绝（也顺带拒绝 `host evil.com` 这类夹带注入）。
  const requestHost = hostnameOf(`http://${rawHost}`);
  if (requestHost === null) return refuse("unparsable-host");

  const bind = normalizeBindHost(bindHost);
  if (!isLoopbackHostname(requestHost) && !(bind !== null && requestHost === bind)) {
    return refuse("host-not-loopback-or-bind");
  }

  // ── b) sec-fetch-site ───────────────────────────────────────────────────
  // 浏览器会自己写这个头；cross-site 一律拒。
  const site = typeof headers["sec-fetch-site"] === "string"
    ? headers["sec-fetch-site"].trim().toLowerCase()
    : "";
  if (site === "cross-site") return refuse("cross-site");

  // ── c) Origin（存在就必须是 loopback/bind，且绝不与 Host 自比）──────────
  const origin = headers.origin;
  if (Array.isArray(origin)) return refuse("duplicate-origin"); // 畸形请求
  if (typeof origin === "string" && origin.trim() !== "") {
    const text = origin.trim();
    if (text.toLowerCase() === "null") return refuse("null-origin");
    const originHost = hostnameOf(text);
    if (originHost === null) return refuse("unparsable-origin");
    if (!isLoopbackHostname(originHost) && !(bind !== null && originHost === bind)) {
      return refuse("origin-not-loopback-or-bind");
    }
  }

  // ── d) 本机进程直连（无 Origin / 无 sec-fetch-site）：已过 Host 栅栏 → 放行
  return { ok: true, reason: "trusted" };
}

function refuse(reason) {
  return { ok: false, reason };
}

/**
 * 抓 URL 的 hostname 并归一化；解析失败返回 null。
 * @param urlText - 绝对 URL（`http://host:port` 或 Origin 的值）。
 */
function hostnameOf(urlText) {
  try {
    return normalizeHostname(new URL(urlText).hostname);
  } catch {
    return null;
  }
}

/**
 * 归一化主机名：
 * - 去掉 IPv6 的方括号（URL 解析保留方括号，config 里的 bind 地址不保留）；
 * - 去掉单个尾点（`localhost.` 与 `localhost` 是同一个 FQDN）；
 * - 小写；
 * - IPv4-mapped IPv6（`::ffff:127.0.0.1`）还原成点分四段，与 URL 给的字面量对齐。
 * @param value - 主机名或 URL 的 hostname。
 * @returns 归一化结果，无法识别则 null。
 */
function normalizeHostname(value) {
  if (typeof value !== "string") return null;
  let text = value.trim().toLowerCase();
  if (text === "") return null;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (text.endsWith(".") && !text.endsWith("..")) text = text.slice(0, -1);
  if (text === "") return null;
  // URL 解析把 `::ffff:127.0.0.1` 写成 `::ffff:7f00:1`，这里还原回点分形态，
  // 让「bind 地址」与「请求 Host」能直接比较。两个尾组各 1-4 个十六进制位。
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(text);
  if (mapped) {
    const hi = parseInt(mapped[1], 16);
    const lo = parseInt(mapped[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return text;
}

/**
 * 归一化 webServer 的 bind 地址。Config 只接受具体 IP 字面量，所以这里额外
 * 拒绝非 IP 的取值（`localhost` 也放过，便于测试/注入式调用）。
 * `%zone`（接口选择器）不是地址本身，先剥掉再比较。
 * @param bindHost - webServer.host。
 * @returns 可比较的主机名，或 null（无 bind 信息）。
 */
export function normalizeBindHost(bindHost) {
  if (typeof bindHost !== "string") return null;
  const zoneAt = bindHost.indexOf("%");
  const text = normalizeHostname(zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt));
  if (text === null) return null;
  if (isIP(text) !== 0) return text;
  return text === "localhost" ? text : null;
}

/**
 * 是否 loopback 主机名：localhost、127.0.0.0/8（每段 0-255）、::1。
 * @param host - 已归一化或原始主机名。
 */
export function isLoopbackHostname(host) {
  const text = normalizeHostname(host);
  if (text === null) return false;
  if (text === "localhost") return true;
  // IPv6 loopback：URL 形态已去括号，只认 `::1`。
  if (text === "::1") return true;
  // IPv4 loopback：必须四段、首段 127、其余每段 0-255（`127.0.0.256` 之类是假的）。
  const parts = text.split(".");
  if (parts.length !== 4 || parts[0] !== "127") return false;
  return parts.slice(1).every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}
