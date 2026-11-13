import { LlmAdapter, LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";
import { buildRequestBody } from "./content.js";
import { buildChatRequestBody, chatToDshChunks } from "./chat.js";
import { responsesToDshChunks } from "./responses-sse.js";
import { selectHarnessTools, describeHarnessTools } from "./harness.js";
import { failure, httpFailure, retryAfterMs } from "./errors.js";
import { resolveApiKey } from "./apikey.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, requestDeadline, classifyFetchError } from "./timeout.js";

const EFFORT_NAMES = Object.freeze({
  off: "关闭", none: "关闭", minimal: "最小", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最大",
});

function reasoningInfo(model) {
  const ids = model.reasoningEfforts ?? (model.reasoning ? ["low", "high", "max"] : []);
  if (!ids.length) return undefined;
  return {
    efforts: ids.map((id) => ({ id, name: EFFORT_NAMES[id] ?? String(id) })),
    ...(model.defaultReasoningEffort ? { defaultEffort: model.defaultReasoningEffort } : {}),
  };
}

function displayModel(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    description: `${model.transport === "chat" ? "Chat" : "Responses"} · ${describeHarnessTools(model.harnessTools)}`,
    inputModalities: [...(model.input ?? ["text"])],
  };
}

/**
 * Volcengine Ark Agent Plan 适配器：
 * - 默认走 Responses API（服务端内置工具、图片输入、推理档位）
 * - Kimi K2.7 Code 等走 OpenAI Chat Completions
 * - 目录由 DynamicCatalog 提供（内置快照 + 零 token 探测动态合并）
 */
export class ArkAgentPlanAdapter extends LlmAdapter {
  #ctx;
  #catalog;
  #fetch;
  #quota;
  providerId;
  displayName;
  apiKeyCandidates;
  endpoint;
  chatEndpoint;
  harnessMode;
  pluginName;
  defaultReasoning;
  requestTimeoutMs;

  constructor({ ctx, catalog, providerId, displayName, apiKeyCandidates, endpoint, chatEndpoint, harnessMode, pluginName, defaultReasoning, requestTimeoutMs, quota, fetchImpl = globalThis.fetch }) {
    super();
    this.#ctx = ctx;
    this.#catalog = catalog;
    this.#fetch = fetchImpl;
    this.providerId = providerId;
    this.displayName = displayName;
    this.apiKeyCandidates = apiKeyCandidates;
    this.endpoint = endpoint;
    this.chatEndpoint = chatEndpoint ?? endpoint.replace(/\/?$/, "/chat/completions");
    this.harnessMode = harnessMode;
    this.pluginName = pluginName;
    this.requestTimeoutMs = Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? requestTimeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
    this.defaultReasoning = defaultReasoning;
    this.#quota = quota;
  }

  providerInfo(provider) {
    return { id: provider, name: this.displayName };
  }

  async listModels() {
    return this.#catalog.snapshot().models.map((model) => displayModel(this.providerId, model));
  }

  async resolveModel(provider, modelId) {
    const model = this.#catalog.find(modelId);
    if (!model) {
      return {
        provider, id: modelId, name: modelId,
        description: "未出现在当前目录中；可尝试调用，但不注入内置工具",
        inputModalities: ["text"],
      };
    }
    const reasoning = reasoningInfo(model);
    return {
      ...displayModel(provider, model),
      ...(Number.isFinite(model.contextWindow) ? { context: { contextWindow: model.contextWindow } } : {}),
      ...(Number.isFinite(model.maxTokens) ? { defaultMaxTokens: model.maxTokens } : {}),
      ...(reasoning ? { reasoning } : {}),
    };
  }

  /**
   * 判断 harness 权益是否已经用完（任一额度窗口 remaining <= 0）。
   *
   * 只读缓存（peek），绝不触发网络或浏览器标签：额度同步由面板的定时刷新负责。
   * 拿不到额度、或缓存从未成功过时返回空数组 —— 宁可继续声明内置工具，
   * 也不要把「查不到额度」误判成「额度用完」，否则会在正常可用时白掉能力。
   *
   * @returns 已耗尽的额度窗口标签；空数组表示权益仍可用。
   */
  #exhaustedHarnessTools() {
    if (!this.#quota) return [];
    let peeked;
    try { peeked = this.#quota.peek(); } catch { return []; }
    if (!peeked?.ok || !Array.isArray(peeked.windows) || peeked.windows.length === 0) return [];
    const exhausted = peeked.windows.filter((w) => Number.isFinite(w.remaining) && w.remaining <= 0);
    return exhausted.map((w) => w.label ?? w.short ?? w.key ?? "额度");
  }

  async *stream(options) {
    const catalogModel = this.#catalog.find(options.model);
    const model = catalogModel ?? {
      id: options.model, reasoning: true, input: ["text"],
      maxTokens: options.maxTokens ?? 16384, harnessTools: [], transport: "responses",
    };
    const useChat = model.transport === "chat";
    // 权益降级：额度（5 小时/周/月任一窗口）用尽后不再声明服务端内置工具，
    // 同名 DSH 本地工具随即自动接管（见 content.js 的让位规则）。
    // 额度不可得（未登录/未同步）时不降级，避免把「暂时查不到」当成「已用完」。
    const exhausted = useChat ? [] : this.#exhaustedHarnessTools();
    const harnessTools = useChat || exhausted.length > 0
      ? []
      : selectHarnessTools(model.harnessTools, this.harnessMode);
    if (exhausted.length > 0) {
      this.#ctx.logger?.info?.(
        `ark-agent-plan: harness 权益额度已用尽（${exhausted.join("、")}），本轮改用 DSH 本地工具；额度窗口重置后自动恢复。`,
      );
    }
    const url = useChat ? this.chatEndpoint : this.endpoint;
    const routeName = `${this.displayName}（${useChat ? "Chat" : "Responses"}）`;
    const key = await resolveApiKey(this.#ctx, this.apiKeyCandidates, this.pluginName);
    const attachments = this.#ctx.get?.("attachments");
    const body = useChat
      ? await buildChatRequestBody(options, model, this.defaultReasoning)
      : await buildRequestBody(options, model, attachments, harnessTools, this.defaultReasoning);

    // 显式超时 + 可重试错误码：undici 默认 headersTimeout/bodyTimeout 都是 300 秒，
    // 不自己设超时就会「突然卡 5 分钟后报 fetch failed」；而原先的 NETWORK 码不在
    // DSH 的 DEFAULT_RETRYABLE_CODES 里，网络抖动一次就终结本轮。两者一起修。
    //
    // 注意超时的生命周期必须覆盖**整个请求**，包括 SSE body 读取阶段：
    // fetch() 只是拿到响应头就 resolve，真正的数据还在后面一点点流。旧代码
    // 在拿到响应头就 finally→dispose() 清掉定时器，于是 body 卡住时又退回
    // undici 的 300 秒兜底（正是 timeout.js 注释声称已修的场景）。所以这里
    // 把 dispose 放进包住整个流的 try/finally，流结束/抛错/提前退出都会清定时器。
    const deadline = requestDeadline(options.signal, this.requestTimeoutMs);
    try {
      let response;
      try {
        response = await this.#fetch(url, {
          method: "POST",
          headers: {
            ...attributionHeaders(),
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
          signal: deadline.signal,
        });
      } catch (error) {
        const failure = classifyFetchError(error, {
          externalAborted: Boolean(options.signal?.aborted),
          timedOut: deadline.timedOut(),
        });
        throw new LlmError(`${routeName} ${failure.message}`, failure.code, { cause: failure.cause });
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const code = httpFailure(response.status, text);
        const retryMs = retryAfterMs(response.headers);
        throw new LlmError(
          `${routeName} API 返回 HTTP ${response.status}${text ? `：${text.slice(0, 600)}` : ""}`,
          code,
          { status: response.status, ...(retryMs ? { providerRetryAfterMs: retryMs } : {}) },
        );
      }
      if (!response.body) throw new LlmError(`${routeName} API 没有返回响应流`, "PROVIDER_ERROR", { status: response.status });

      // 解析器用**融合信号**（外部取消 + 空闲超时）：只传 options.signal 的话，
      // 空闲超时触发时只有 undici 的 body 被取消，解析器自己的 signal 检查看不到；
      // 传融合信号后，超时与用户取消在流读取层都能立刻中断。外部取消的判定仍用
      // options.signal（用来区分 ABORTED 与 TIMEOUT，见下面的 classify）。
      const streamSignal = deadline.signal;
      // 透传流的同时收集 usage，结束后记入本地 AFP 账本（面板数字实时滚动的来源）。
      // 声明了服务端内置工具时，工具调用块要等末尾的内置工具活动文本之后才发，
      // 否则 assistant 会留下 "tool-call 后面还有文本" 的块序，DeepSeek 官方
      // Messages 协议会拒绝这种历史（"tool_use ids were found without
      // tool_result blocks immediately after"）。
      const source = useChat
        ? chatToDshChunks(response.body, streamSignal)
        : responsesToDshChunks(response.body, streamSignal, undefined, { deferToolCalls: harnessTools.length > 0 });
      try {
        for await (const chunk of source) {
          // 每收到一个 chunk 就重置空闲超时：超时语义是「多久没动静算卡死」，
          // 不是「一次请求最多花多久」。不 touch 的话，正常的长回答（>60s 流式
          // 输出）会被当成超时掐断（2026-11-10 实测复现）。
          deadline.touch();
          // 解析器的续命信号（内置工具进行中等事件）：已 touch，不转发给上层。
          if (chunk?.type === "heartbeat") continue;
          if (chunk?.type === "usage" && chunk.usage && this.#quota) {
            try {
              this.#quota.recordUsage({
                model: model.id,
                inputTokens: chunk.usage.inputTokens,
                outputTokens: chunk.usage.outputTokens,
                cacheReadTokens: chunk.usage.cacheReadTokens ?? 0,
                reasoningTokens: chunk.usage.reasoningTokens ?? 0,
              });
            } catch { /* 记账失败不影响回答 */ }
          }
          yield chunk;
        }
      } catch (error) {
        // 解析器自己抛的协议错误（STREAM_CLOSED 等）已经分好类，原样透出。
        // 但 ABORTED 需要再分一次：解析器看到的是**融合信号**，空闲超时到点
        // 时它会同样抛 ABORTED。只有「外部取消」才是真的 ABORTED，
        // 因超时中断的要改报 TIMEOUT（否则超时会被当成用户取消，且不会重试）。
        if (error instanceof LlmError) {
          if (error.code === "ABORTED" && deadline.timedOut() && !options.signal?.aborted) {
            throw new LlmError(`${routeName} 请求超时：等待响应超过 ${this.requestTimeoutMs}ms 没有新数据`, "TIMEOUT", { cause: error });
          }
          throw error;
        }
        // 流读取阶段的超时/取消/连接中断也要归类：超时到点会 abort 请求信号，
        // undici 随之取消 body，read() 抛的是 AbortError —— 不归类就会变成
        // 未分类异常（用户看到不明所以的 "Aborted"）。这里沿用同一套 classify，
        // 保证 TIMEOUT / ABORTED / TRANSPORT 判定在流阶段同样有效。
        const failure = classifyFetchError(error, {
          externalAborted: Boolean(options.signal?.aborted),
          timedOut: deadline.timedOut(),
        });
        throw new LlmError(`${routeName} ${failure.message}`, failure.code, { cause: failure.cause });
      }
    } finally {
      deadline.dispose();
    }
  }
}
