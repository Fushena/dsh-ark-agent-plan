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

  // ── 0) 远端地址校验（若 socket.remoteAddress 存在，必须是回环地址）────────
  // 防止 webServer.host 绑定到非回环/通配地址时，局域网远端主机直接访问无鉴权路由。
  // 纯 header 构造的离线单测对象无 req.socket 时跳过此检查，保持单测兼容性。
  if (req?.socket && req.socket.remoteAddress !== undefined) {
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      return refuse("non-loopback-remote");
    }
  }

  // ── a) Host 栅栏 ────────────────────────────────────────────────────────
  if (Array.isArray(headers.host)) return refuse("duplicate-host");
  const rawHost = typeof headers.host === "string" ? headers.host.trim() : "";
  if (rawHost === "") return refuse("missing-host");
  const parsedHost = parseHostHeader(rawHost);
  if (parsedHost === null) return refuse("unparsable-host");
  const { host: requestHost, port: hostPort } = parsedHost;

  const bind = normalizeBindHost(bindHost);
  if (!isLoopbackHostname(requestHost) && !(bind !== null && requestHost === bind)) {
    return refuse("host-not-loopback-or-bind");
  }

  // ── b) sec-fetch-site ───────────────────────────────────────────────────
  // 浏览器会自己写这个头；拒绝重复数组头，仅允许空（非浏览器）或 same-origin，
  // 导航请求（none）仅在显式 GET/HEAD 方法下放行，绝不允许 same-site 或 cross-site。
  const rawSite = headers["sec-fetch-site"];
  if (Array.isArray(rawSite)) return refuse("duplicate-sec-fetch-site");
  const site = typeof rawSite === "string" ? rawSite.trim().toLowerCase() : "";
  if (site !== "" && site !== "same-origin") {
    const method = typeof req?.method === "string" ? req.method.trim().toUpperCase() : "";
    const allowNone = site === "none" && (method === "GET" || method === "HEAD");
    if (!allowNone) return refuse(site === "cross-site" ? "cross-site" : "untrusted-sec-fetch-site");
  }

  // ── c) Origin（存在就必须是合法 http(s) origin，且与 Host 完整 authority 一致）
  const origin = headers.origin;
  if (Array.isArray(origin)) return refuse("duplicate-origin"); // 畸形请求
  if (typeof origin === "string" && origin.trim() !== "") {
    const text = origin.trim();
    if (text.toLowerCase() === "null") return refuse("null-origin");
    const parsedOrigin = parseOriginHeader(text);
    if (parsedOrigin === null) return refuse("unparsable-origin");
    const { host: originHost, port: originPort } = parsedOrigin;
    if (!isLoopbackHostname(originHost) && !(bind !== null && originHost === bind)) {
      return refuse("origin-not-loopback-or-bind");
    }
    // 完整 authority 比较（审计#2，2026-11-13）：只比 hostname 会放行本机
    // **其它端口**的页面（sec-fetch-site=same-site），构成 CSRF 面。
    // 同源请求的 Origin 与 Host 必须是同一 host+端口（默认端口按协议归一：
    // http→80、https→443；本服务经 plain HTTP 提供，Host 无端口即 80）。
    if (originHost !== requestHost || originPort !== hostPort) {
      return refuse("origin-authority-mismatch");
    }
  }

  // ── d) 本机进程直连（无 Origin / 无 sec-fetch-site）：已过 remoteAddress + Host 栅栏 → 放行
  return { ok: true, reason: "trusted" };
}

function refuse(reason) {
  return { ok: false, reason };
}

/**
 * 严格解析 Host 头：拒绝 userinfo (@)、路径 (/)、查询 (?)、片段 (#)、空白或控制字符。
 * @param rawHost - 去除首尾空白的 Host 头。
 * @returns {{host: string, port: string} | null}
 */
function parseHostHeader(rawHost) {
  if (/[\s@/\\?#\u0000-\u001f\u007f]/.test(rawHost)) return null;
  try {
    const url = new URL(`http://${rawHost}`);
    if (url.username !== "" || url.password !== "") return null;
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
    const host = normalizeHostname(url.hostname);
    if (host === null) return null;
    const port = url.port !== "" ? url.port : "80";
    return { host, port };
  } catch {
    return null;
  }
}

/**
 * 严格解析 Origin 头：仅接受规范的 http/https origin（必须等于 url.origin，
 * 不含 userinfo / path / query / fragment / 空白）。
 * @param text - 去除首尾空白的 Origin 头。
 * @returns {{host: string, port: string} | null}
 */
function parseOriginHeader(text) {
  if (/[\s@\\?#\u0000-\u001f\u007f]/.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
    if (url.origin !== text) return null;
    const host = normalizeHostname(url.hostname);
    if (host === null) return null;
    const port = url.port !== "" ? url.port : (url.protocol === "https:" ? "443" : "80");
    return { host, port };
  } catch {
    return null;
  }
}

/**
 * 归一化主机名：
 * - 去掉 IPv6 的方括号（URL 解析保留方括号，config 里的 bind 地址不保留）；
 * - 去掉单个尾点（`localhost.` 与 `localhost` 是同一个 FQDN）；
 * - 小写；
 * - 裸 IPv6 经 WHATWG URL 规范化（`0:0:0:0:0:0:0:1` → `::1`）；
 * - IPv4-mapped IPv6（点分 `::ffff:127.0.0.1` 与十六进制 `::ffff:7f00:1`）还原成点分四段。
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
  if (text.includes(":")) {
    // 通过 WHATWG URL 规范化裸 IPv6 形态（处理压缩、前导零与 ::ffff:a.b.c.d）。
    try {
      const canonical = new URL(`http://[${text}]`).hostname;
      text = canonical.startsWith("[") && canonical.endsWith("]") ? canonical.slice(1, -1) : canonical;
    } catch {
      return null;
    }
  }
  const mappedDot = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mappedDot) return mappedDot[1];
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

/** 是否回环 IP 字面量（仅用于 socket.remoteAddress，不接受域名 localhost）。 */
export function isLoopbackAddress(addr) {
  if (typeof addr !== "string") return false;
  const zoneAt = addr.indexOf("%");
  const text = normalizeHostname(zoneAt === -1 ? addr : addr.slice(0, zoneAt));
  if (text === null || text === "localhost") return false;
  return isLoopbackHostname(text);
}

/**
 * 归一化 webServer 的 bind 地址。Config 只接受具体 IP 字面量，拒绝通配绑定
 * （`0.0.0.0` / `::`）与非 IP 取值（`localhost` 除外，便于测试/注入式调用）。
 * `%zone`（接口选择器）不是地址本身，先剥掉再比较。
 * @param bindHost - webServer.host。
 * @returns 可比较的主机名，或 null（无 bind 信息或为通配地址）。
 */
export function normalizeBindHost(bindHost) {
  if (typeof bindHost !== "string") return null;
  const zoneAt = bindHost.indexOf("%");
  const text = normalizeHostname(zoneAt === -1 ? bindHost : bindHost.slice(0, zoneAt));
  if (text === null) return null;
  if (text === "0.0.0.0" || text === "::") return null;
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
