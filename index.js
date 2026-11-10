import z from "@deepseek-ai/schemastery";
import { DynamicCatalog } from "./lib/catalog.js";
import { ArkAgentPlanAdapter } from "./lib/adapter.js";
import { normalizeHarnessMode } from "./lib/harness.js";
import { ArkQuota, bridgeAvailable } from "./lib/quota.js";
import { AFP_PRICING } from "./lib/pricing.js";
import { createProxyFetch, redactProxyUrl } from "./lib/proxy.js";
import { trustedRouteRequest } from "./lib/route-guard.js";

const DEFAULT_ENDPOINT = "https://ark.cn-beijing.volces.com/api/plan/v3";
const DEFAULT_KEY_CANDIDATES = ["ARK_AGENT_PLAN_CN_API_KEY", "ARK_AGENT_PLAN_API_KEY", "VOLCENGINE_ARK_PLAN_API_KEY", "ARK_CODE_API_KEY"];

export const name = "dsh-ark-agent-plan";
export const inject = ["llm", "credentials", "timer", "webServer"];

// DSH settings discover credential inputs through the Config schema's role.
export const Config = z.object({
  providerId: z.string().default("ark-agent-plan"),
  displayName: z.string().default("Volcengine Ark Agent Plan"),
  apiKeyEnv: z.string().role("credential-ref").default("ARK_AGENT_PLAN_CN_API_KEY"),
  extraKeyEnvs: z.array(z.string()).default([]),
  endpoint: z.string().default(DEFAULT_ENDPOINT),
  harness: z.any().default("auto"),
  defaultReasoning: z.string().default("high"),
  models: z.array(z.any()).default([]),
  excludeModels: z.array(z.string()).default([]),
  extraModels: z.array(z.string()).default([]),
  modelListUrls: z.array(z.string()).default([]),
  catalogRefreshMinutes: z.number().min(1).default(30),
  quotaRefreshMinutes: z.number().min(1).default(5),
  // 浏览器只在用户点「更新凭据」时使用。设成 false 可彻底禁用（连手动更新也不碰）。
  allowBrowserForQuota: z.boolean().default(true),
  // 出站代理：留空读 HTTPS_PROXY/HTTP_PROXY/ALL_PROXY 环境变量；"none"/"off"/"direct" 强制直连。
  // Node 默认不继承系统代理，而控制台域名在无代理时 TLS 会被重置（额度面板报 fetch failed）。
  proxy: z.string().default(""),
});

const ROUTE_PREFIX = "/ark-agent-plan";

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Web 路由守卫：拒绝浏览器跨站 / DNS rebinding 的请求。
 *
 * 为什么必须有：插件路由走 `webServer.register`，**绕过 DSH 自己的
 * `isTrustedApiRequest` 鉴权**（实测 `GET /` 401、`GET /ark-agent-plan/quota` 200）。
 * 旧实现 `Origin === Host` 是自比（两个值都归攻击者），已实测被
 * `Host: evil.example` + `Origin: http://evil.example` 绕过并返回 200。
 *
 * 规则实现在 lib/route-guard.js（纯函数，可单测）：
 *   Host 必须 loopback 或 bind 地址 → sec-fetch-site 不许 cross-site →
 *   Origin（若有）必须 loopback/bind（`null` 拒绝）→ 无 Origin 的本机进程放行。
 * @param req - node:http 请求。
 * @param bindHost - webServer 的 bind 地址（`server.host`），可空。
 */
function trustedRequest(req, bindHost) {
  const verdict = trustedRouteRequest(req, bindHost);
  if (!verdict.ok) {
    // 只记原因到日志，不回给客户端（避免泄露判定细节）。
    return false;
  }
  return true;
}

export function apply(ctx, config = {}) {
  const providerId = String(config.providerId || "ark-agent-plan");
  const displayName = String(config.displayName || "Volcengine Ark Agent Plan");
  const endpoint = String(config.endpoint || DEFAULT_ENDPOINT);
  const responsesUrl = endpoint.replace(/\/?$/, "/responses");
  const chatUrl = endpoint.replace(/\/?$/, "/chat/completions");
  const harnessMode = normalizeHarnessMode(config.harness);
  const defaultReasoning = String(config.defaultReasoning || "high");

  const apiKeyCandidates = [
    String(config.apiKeyEnv || DEFAULT_KEY_CANDIDATES[0]),
    ...DEFAULT_KEY_CANDIDATES,
    ...(Array.isArray(config.extraKeyEnvs) ? config.extraKeyEnvs.map(String) : []),
  ].filter((value, index, all) => all.indexOf(value) === index);

  const overrides = Array.isArray(config.models) ? config.models : [];
  const excludes = Array.isArray(config.excludeModels) ? config.excludeModels.map(String) : [];
  const refreshMinutes = Number.isFinite(config.catalogRefreshMinutes) && config.catalogRefreshMinutes >= 1
    ? config.catalogRefreshMinutes : 30;

  const extraCandidates = Array.isArray(config.extraModels) ? config.extraModels.map(String) : [];
  const docSources = Array.isArray(config.modelListUrls) && config.modelListUrls.length > 0
    ? config.modelListUrls.map(String)
    : undefined;
  const quotaRefreshMinutes = Number.isFinite(config.quotaRefreshMinutes) && config.quotaRefreshMinutes >= 1
    ? config.quotaRefreshMinutes : 5;
  // 出站代理：Node 的 fetch 不读系统代理，而 volcengine 控制台在无可用代理时
  // TLS 会被重置（额度面板 fetch failed）。这里统一构造一个走代理的 fetch，
  // 未配置且无环境变量时原样返回原生 fetch —— 行为与改动前完全一致。
  const proxyFetch = createProxyFetch({ proxy: config.proxy, logger: ctx.logger });
  const proxyLabel = redactProxyUrl(typeof config.proxy === "string" && config.proxy.trim() !== ""
    ? (proxyFetch === globalThis.fetch ? "" : config.proxy)
    : proxyFetch.proxyUrl);
  if (proxyLabel) ctx.logger?.info?.(`${name}: 出站请求经代理 ${proxyLabel}`);

  const quota = new ArkQuota({
    logger: ctx.logger, ttlMs: quotaRefreshMinutes * 60_000, afpPricing: AFP_PRICING,
    fetchImpl: proxyFetch,
  });

  const catalog = new DynamicCatalog({
    ctx, probeUrl: responsesUrl, apiKeyCandidates, pluginName: name,
    overrides, excludes, logger: ctx.logger, fetchImpl: proxyFetch,
    extraCandidates, ...(docSources ? { docSources } : {}),
  });

  const adapter = new ArkAgentPlanAdapter({
    ctx, catalog, providerId, displayName, apiKeyCandidates,
    endpoint: responsesUrl, chatEndpoint: chatUrl,
    harnessMode, pluginName: name, defaultReasoning, quota, fetchImpl: proxyFetch,
  });

  // 与 qwen-token-plan-full 相同的可见性注册模式（DSH 0.2.x 已验证）。
  ctx.llm.registerConfigurableProviders([{
    provider: providerId,
    displayName,
    settingsNs: ctx.fiber.entry?.options.id ?? "ark-agent-plan",
    settingsPath: [],
  }]);

  let stopped = false;
  const lifetime = new AbortController();
  const refreshSignal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);

  const makeTimer = (fn, ms) => (typeof ctx.interval === "function" ? ctx.interval(fn, ms) : setInterval(fn, ms));
  const clearTimer = (timer) => { try { if (typeof timer === "function") timer(); else clearInterval(timer); } catch { /* best effort */ } };

  const refreshCatalog = () => catalog.refresh(refreshSignal()).then((updated) => {
    if (updated && !stopped && typeof ctx.llm.emitAdaptersUpdated === "function") ctx.llm.emitAdaptersUpdated();
    return updated;
  });

  ctx.effect(() => {
    const handle = ctx.llm.registerAdapter([providerId], adapter);
    return () => {
      try { if (typeof handle === "function") handle(); else handle?.dispose?.(); } catch { /* best effort */ }
    };
  }, "ark-agent-plan: adapter");

  ctx.effect(() => {
    refreshCatalog().catch(() => {});
    const timer = makeTimer(() => { if (!stopped) refreshCatalog().catch(() => {}); }, refreshMinutes * 60_000);
    return () => {
      stopped = true;
      lifetime.abort();
      clearTimer(timer);
    };
  }, "ark-agent-plan: catalog refresh");

  // 额度面板数据路由（仅同源）：GET /ark-agent-plan/quota
  ctx.effect(() => {
    const server = ctx.get?.("webServer");
    if (server === undefined || typeof server.register !== "function") return () => {};
    // bind 地址用于 Host 栅栏的第二条：请求 Host 等于监听地址时也放行
    // （适用于显式 bind 到非 loopback 单接口的场景）。只读配置值，不随请求变化。
    const bindHost = typeof server.host === "string" ? server.host : undefined;
    try {
      const handle = server.register({
        kind: "prefix",
        path: ROUTE_PREFIX,
        async handler(req, res) {
          // 所有路由分支之前先过守卫（含 404 分支，避免路径枚举）。
          if (!trustedRequest(req, bindHost)) return json(res, 403, { error: "forbidden" });
          let sub = "";
          try {
            sub = new URL(req.url ?? "/", "http://localhost").pathname
              .slice(ROUTE_PREFIX.length).replace(/^\/+/, "");
          } catch { /* keep "" */ }
          if (req.method === "GET" && (sub === "quota" || sub === "")) {
            const peeked = quota.peek();
            // 后端缓存过期才回源，避免每次打开面板都打控制台。
            // GET 一律不碰浏览器（allowBrowser 默认 false）；缓存过期也只走纯 Node。
            const result = peeked.stale ? await quota.refresh({ force: true }) : { ok: true, data: peeked };
            return json(res, 200, result.ok
              ? { ok: true, provider: { id: providerId, name: displayName }, data: result.data, bridge: bridgeAvailable(), proxy: proxyLabel ?? null }
              : { ok: false, provider: { id: providerId, name: displayName }, error: result.error, bridge: bridgeAvailable(), proxy: proxyLabel ?? null });
          }
          // 手动更新凭据：**唯一**允许碰浏览器的入口（用户显式点击触发）。
          if (req.method === "POST" && sub === "quota/login") {
            const result = await quota.refresh({
              force: true,
              allowBrowser: config.allowBrowserForQuota !== false,
            });
            return json(res, 200, result.ok
              ? { ok: true, provider: { id: providerId, name: displayName }, data: result.data, bridge: bridgeAvailable(), proxy: proxyLabel ?? null }
              : { ok: false, provider: { id: providerId, name: displayName }, error: result.error, bridge: bridgeAvailable(), proxy: proxyLabel ?? null });
          }
          if (req.method === "POST" && sub === "quota/refresh") {
            // 普通刷新同样不许碰浏览器，只有用户点「更新凭据」才走 quota/login。
            const result = await quota.refresh({ force: true });
            return json(res, 200, result.ok
              ? { ok: true, provider: { id: providerId, name: displayName }, data: result.data, bridge: bridgeAvailable(), proxy: proxyLabel ?? null }
              : { ok: false, provider: { id: providerId, name: displayName }, error: result.error, bridge: bridgeAvailable(), proxy: proxyLabel ?? null });
          }
          return json(res, 404, { error: "not found" });
        },
      });
      return typeof handle === "function" ? handle : () => { try { handle?.dispose?.(); } catch { /* best effort */ } };
    } catch (error) {
      ctx.logger?.warn?.(`${name}: 额度路由注册失败（${error instanceof Error ? error.message : String(error)}）`);
      return () => {};
    }
  }, "ark-agent-plan: quota route");

  ctx.logger?.info?.(
    `${name}: 已注册 provider "${providerId}"（Responses=${responsesUrl}；Chat=${chatUrl}；` +
    `内置工具 ${harnessMode.mode}；目录每 ${refreshMinutes} 分钟刷新；额度每 ${quotaRefreshMinutes} 分钟刷新；默认思考 ${defaultReasoning}）`,
  );
}

apply.inject = inject;
apply.Config = Config;
export default apply;
