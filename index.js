import z from "@deepseek-ai/schemastery";
import { RetryPolicySchema } from "@deepseek-ai/dsh-llm";
import { DynamicCatalog } from "./lib/catalog.js";
import { ArkAgentPlanAdapter, DEFAULT_RETRY_POLICY } from "./lib/adapter.js";
import { normalizeHarnessMode } from "./lib/harness.js";
import { ArkQuota, bridgeAvailable } from "./lib/quota.js";
import { AFP_PRICING } from "./lib/pricing.js";
import { createProxyFetch, redactProxyUrl } from "./lib/proxy.js";
import { trustedRouteRequest } from "./lib/route-guard.js";
import { createArkTools } from "./lib/ark-tools.js";
import { createSpeechInput } from "./lib/asr.js";

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

  // 请求重试策略（交给宿主 llm-retry 执行）：在宿主默认可重试码基础上补充 STREAM_CLOSED，
  // 让代理/网关在终止事件前干净关闭连接时可自动重试。
  retryPolicy: RetryPolicySchema.default({ ...DEFAULT_RETRY_POLICY }).description("请求重试策略（交给宿主 llm-retry 执行），默认允许对 STREAM_CLOSED 重试。"),

  // ── Ark Responses API 的 MCP tools 声明 ────────────────────────────
  // 声明后 Ark 服务端会代替模型调用外部 MCP server，与内置工具（web_search 等）
  // 一起进 tools 数组。server_url 必填且必须 https + 非私网/本机地址（归一化时
  // 强制，不安全项被丢弃并记 warn）；headers 值支持 ${credential:REF} 模板，
  // 每次请求前经凭据服务展开（解析不到报错，不发字面量）。
  // 参考 https://www.volcengine.com/docs/82379/1851307
  mcpServers: z.array(z.object({
    server_url: z.string().required(),
    server_label: z.string().default(""),
    headers: z.dict(z.string(), z.string()).default({}),
    allowed_tools: z.array(z.string()).default([]),
    require_approval: z.union([z.boolean(), z.string()]).default(false),
  })).default([]),

  // ── Ark 多模态能力工具（生图/生视频/TTS） ──────────────────────────
  // 生图/生视频走 Ark 标准 v3 API（不是 Agent Plan 网关），用独立凭据。
  // 语音走 openspeech 的豆包语音接口（资源 seed-tts-2.0，不需要 endpoint id）。
  // 默认关闭；开启后会在 DSH 工具列表中注册对应工具。
  imageGeneration: z.object({
    enabled: z.boolean().default(false),
    // 生图模型的 endpoint id（如 ep-2025xxxx-xxxx）或模型名。必须填。
    model: z.string().default(""),
    // 走标准 Ark v3 API 的凭据（不是 Agent Plan 的 key）。
    apiKeyEnv: z.string().role("credential-ref").default("ARK_API_KEY"),
    // 默认尺寸：档位 "1K"/"1.5K"/"2K"，或精确 WxH（随模型有下限，如 5.0-lite 总像素≥3686400）
    defaultSize: z.string().default("2K"),
  }).default({}),
  videoGeneration: z.object({
    enabled: z.boolean().default(false),
    // 生视频模型的 endpoint id
    model: z.string().default(""),
    apiKeyEnv: z.string().role("credential-ref").default("ARK_API_KEY"),
    // 画幅比例：21:9 / 16:9 / 4:3 / 1:1 / 3:4 / 9:16 / adaptive（官方默认 adaptive）
    defaultRatio: z.string().default("adaptive"),
    // 分辨率 "480p" / "720p" / "1080p"（1080p 仅 2.5/2.0 系）
    defaultResolution: z.string().default("720p"),
    // 默认时长（秒）：2.5 系 4~30、2.0 系 4~15，-1 表示模型自选
    defaultDuration: z.number().default(5),
    // 轮询间隔（秒）
    pollIntervalSeconds: z.number().min(2).default(5),
    // 最长等待（秒）
    maxWaitSeconds: z.number().min(30).default(300),
  }).default({}),
  tts: z.object({
    enabled: z.boolean().default(false),
    // 默认端点是 Agent Plan 专属语音路径，故默认凭据与 Agent Plan 主凭据对齐；
    // 非套餐版覆盖 endpoint 时可同步改填对应按量/语音凭据名。
    apiKeyEnv: z.string().role("credential-ref").default("ARK_AGENT_PLAN_CN_API_KEY"),
    // 默认音色（豆包语音 2.0 公版音色；1.0 的 mars 音色在 2.0 资源下不可用）
    defaultVoice: z.string().default("zh_female_vv_uranus_bigtts"),
    // 覆盖端点：留空用 Agent Plan 专属地址；非套餐版填 .../api/v3/tts/unidirectional
    endpoint: z.string().default(""),
    // 语音资源 ID：默认 seed-tts-2.0；复刻音色用 seed-icl-2.0
    resourceId: z.string().default(""),
  }).default({}),

  // ── 多模态**对话**路线（模型选择器里选生图/生视频/语音/向量模型） ──────
  // 走 Agent Plan 网关与套餐 Key，与上面三个独立工具分开配置。
  mediaDefaults: z.object({
    imageSize: z.string().default("2K"),
    videoRatio: z.string().default("adaptive"),
    videoResolution: z.string().default("720p"),
    videoDuration: z.number().default(5),
    videoPollSeconds: z.number().min(2).default(5),
    videoMaxWaitSeconds: z.number().min(30).default(300),
    ttsSpeaker: z.string().default("zh_female_vv_uranus_bigtts"),
    ttsEndpoint: z.string().default(""),
    ttsResourceId: z.string().default(""),
  }).default({}),
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
  const excludes = Array.isArray(config.excludeModels)
    ? config.excludeModels.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const refreshMinutes = Number.isFinite(config.catalogRefreshMinutes) && config.catalogRefreshMinutes >= 1
    ? config.catalogRefreshMinutes : 30;

  const extraCandidates = Array.isArray(config.extraModels)
    ? config.extraModels.map((s) => String(s).trim()).filter(Boolean)
    : [];
  const docSources = Array.isArray(config.modelListUrls) && config.modelListUrls.length > 0
    ? config.modelListUrls.map(String)
    : undefined;
  const quotaRefreshMinutes = Number.isFinite(config.quotaRefreshMinutes) && config.quotaRefreshMinutes >= 1
    ? config.quotaRefreshMinutes : 5;
  // 出站代理：Node 的 fetch 不读系统代理，而 volcengine 控制台在无可用代理时
  // TLS 会被重置（额度面板 fetch failed）。这里统一构造一个走代理的 fetch，
  // 未配置且无环境变量时原样返回原生 fetch —— 行为与改动前完全一致。
  const proxyFetch = createProxyFetch({ proxy: config.proxy, logger: ctx.logger });
  const proxyLabel = redactProxyUrl(proxyFetch.proxyUrl);
  if (proxyLabel) ctx.logger?.info?.(`${name}: 出站请求经代理 ${proxyLabel}`);

  let stopped = false;
  const lifetime = new AbortController();
  const refreshSignal = () => AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]);

  const quota = new ArkQuota({
    logger: ctx.logger, ttlMs: quotaRefreshMinutes * 60_000, afpPricing: AFP_PRICING,
    fetchImpl: proxyFetch, signal: lifetime.signal,
  });

  const catalog = new DynamicCatalog({
    ctx, probeUrl: responsesUrl, apiKeyCandidates, pluginName: name,
    overrides, excludes, logger: ctx.logger, fetchImpl: proxyFetch,
    extraCandidates, ...(docSources ? { docSources } : {}),
    quota,
  });

  const mediaDefaults = config.mediaDefaults ?? {};
  const speech = createSpeechInput(providerId, catalog);
  const adapter = new ArkAgentPlanAdapter({
    ctx, catalog, providerId, displayName, apiKeyCandidates,
    endpoint: responsesUrl, chatEndpoint: chatUrl,
    harnessMode, pluginName: name, defaultReasoning, quota, fetchImpl: proxyFetch,
    retryPolicy: config.retryPolicy,
    mcpServers: config.mcpServers,
    speechAttachment: speech.attachment,
    media: {
      imageSize: mediaDefaults.imageSize,
      videoRatio: mediaDefaults.videoRatio,
      videoResolution: mediaDefaults.videoResolution,
      videoDuration: mediaDefaults.videoDuration,
      videoPollIntervalMs: Number.isFinite(mediaDefaults.videoPollSeconds) ? mediaDefaults.videoPollSeconds * 1000 : undefined,
      videoMaxWaitMs: Number.isFinite(mediaDefaults.videoMaxWaitSeconds) ? mediaDefaults.videoMaxWaitSeconds * 1000 : undefined,
      ttsSpeaker: mediaDefaults.ttsSpeaker,
      ttsEndpoint: mediaDefaults.ttsEndpoint,
      ttsResourceId: mediaDefaults.ttsResourceId,
    },
  });

  // 与 qwen-token-plan-full 相同的可见性注册模式（DSH 0.2.x 已验证）。
  ctx.llm.registerConfigurableProviders([{
    provider: providerId,
    displayName,
    settingsNs: ctx.fiber.entry?.options.id ?? "ark-agent-plan",
    settingsPath: [],
  }]);

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

  if (typeof ctx.on === "function") ctx.on("llm/stream", speech.intercept);

  // 注册 Ark 多模态工具（生图/生视频/TTS）。
  // 通过 ctx.inject(["tools"], ...) 声明对 tools 服务的可选子依赖：
  // dsh-tools 晚初始化或被隔离时不会阻塞主插件，且 tools 就绪后自动注册；
  // 仅当 toolsSvc.register 真实执行并返回有效句柄时才记成功日志。
  const registerToolsOn = (targetCtx) => {
    targetCtx.effect(() => {
      const toolsSvc = targetCtx.get?.("tools") ?? targetCtx.tools;
      if (typeof toolsSvc?.register !== "function") return () => {};
      const tools = createArkTools({ ctx: targetCtx, config, fetchImpl: proxyFetch });
      if (tools.length === 0) return () => {};
      const handles = [];
      for (const tool of tools) {
        try {
          const handle = toolsSvc.register(tool);
          if (handle) {
            handles.push(handle);
            ctx.logger?.info?.(`${name}: 已注册工具 ${tool.name}`);
          } else {
            ctx.logger?.warn?.(`${name}: 注册工具 ${tool.name} 未返回有效句柄`);
          }
        } catch (error) {
          ctx.logger?.warn?.(`${name}: 注册工具 ${tool.name} 失败（${error instanceof Error ? error.message : String(error)}）`);
        }
      }
      return () => {
        for (const handle of handles) {
          try { if (typeof handle === "function") handle(); else handle?.dispose?.(); } catch { /* best effort */ }
        }
      };
    }, "ark-agent-plan: tools");
  };
  if (typeof ctx.inject === "function") {
    ctx.inject(["tools"], (innerCtx) => registerToolsOn(innerCtx));
  } else {
    registerToolsOn(ctx);
  }

  ctx.effect(() => {
    refreshCatalog().catch(() => {});
    const timer = makeTimer(() => { if (!stopped) refreshCatalog().catch(() => {}); }, refreshMinutes * 60_000);
    return () => {
      stopped = true;
      lifetime.abort();
      quota.dispose();
      try { proxyFetch.close?.(); } catch { /* best effort */ }
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

  const mcpCount = Array.isArray(config.mcpServers) ? config.mcpServers.filter((s) => s?.server_url).length : 0;
  const enabledTools = [
    config.imageGeneration?.enabled ? "生图" : null,
    config.videoGeneration?.enabled ? "生视频" : null,
    config.tts?.enabled ? "TTS" : null,
  ].filter(Boolean);
  ctx.logger?.info?.(
    `${name}: 已注册 provider "${providerId}"（Responses=${responsesUrl}；Chat=${chatUrl}；` +
    `内置工具 ${harnessMode.mode}；目录每 ${refreshMinutes} 分钟刷新；额度每 ${quotaRefreshMinutes} 分钟刷新；默认思考 ${defaultReasoning}；` +
    `MCP servers ${mcpCount} 个${enabledTools.length ? `；多模态工具 ${enabledTools.join("/")}` : ""}）`,
  );
}

apply.inject = inject;
apply.Config = Config;
export default apply;
