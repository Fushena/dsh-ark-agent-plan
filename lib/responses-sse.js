import { LlmError, ToolCallId } from "@deepseek-ai/dsh-llm";
import { formatHarnessActivity } from "./harness.js";
import { failure, httpFailure } from "./errors.js";

function eventData(raw) {
  const lines = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("data:")) lines.push(line.slice(5).replace(/^\s/, ""));
  }
  return lines.length ? lines.join("\n") : undefined;
}

/** 无第三方依赖的 SSE data JSON 迭代器，兼容 LF/CRLF、多 data 行和尾事件。 */
export async function* iterateSse(body, signal) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const separator = /\r?\n\r?\n/.exec(buffer);
        if (!separator) break;
        const raw = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = eventData(raw);
        if (!data) continue;
        if (data === "[DONE]") return;
        try { yield JSON.parse(data); }
        catch { /* 供应商偶发的非 JSON 心跳不应杀死整个回复。 */ }
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const data = eventData(buffer);
      if (data && data !== "[DONE]") {
        try { yield JSON.parse(data); } catch { /* ignore trailing heartbeat */ }
      }
    }
  } finally {
    // A protocol terminator can arrive before EOF. Cancel without waiting for the source to close.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function itemMessageText(item) {
  if (!Array.isArray(item?.content)) return "";
  return item.content.map((part) => part && typeof part === "object" ? String(part.text ?? "") : "").join("");
}

function itemReasoningText(item) {
  for (const key of ["summary", "content"]) {
    if (Array.isArray(item?.[key])) {
      const text = item[key].map((part) => part && typeof part === "object" ? String(part.text ?? "") : "").join("");
      if (text) return text;
    }
  }
  return "";
}

function usageFrom(response) {
  const usage = response?.usage ?? {};
  const details = usage.input_tokens_details ?? {};
  const outputDetails = usage.output_tokens_details ?? {};
  const totalInput = Number.isFinite(usage.input_tokens) ? usage.input_tokens : 0;
  const cacheRead = Number.isFinite(details.cached_tokens) ? details.cached_tokens : 0;
  const cacheWrite = Number.isFinite(usage.cache_creation_input_tokens)
    ? usage.cache_creation_input_tokens
    : Number.isFinite(details.cache_creation_input_tokens) ? details.cache_creation_input_tokens : 0;
  return {
    inputTokens: Math.max(0, totalInput - cacheRead - cacheWrite),
    outputTokens: Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    ...(Number.isFinite(outputDetails.reasoning_tokens) && outputDetails.reasoning_tokens > 0
      ? { reasoningTokens: outputDetails.reasoning_tokens } : {}),
  };
}

function mergeHarnessActivity(activity, item, itemId, onHarnessUse, outputIndex) {
  const type = String(item?.type ?? "");
  if (!type || ["message", "reasoning", "function_call"].includes(type)) return;
  const id = String(item?.id ?? itemId ?? "");
  const index = Number.isInteger(outputIndex) && outputIndex >= 0 ? outputIndex : undefined;
  // 去重键优先 output_index：同一条活动项的 added/done 事件共享 output_index，
  // 而部分服务端工具项（web_search_call 等）**不带 id** —— 只看 id 时 added 与
  // done 各记一条，活动说明会被重复渲染（实测「联网搜索」出现两次）。
  // id 作为次选兜底：个别事件缺 output_index 时仍能按 id 合并。
  const hit = activity.find((entry) => entry.type === type
    && ((index !== undefined && entry.outputIndex === index) || (Boolean(id) && entry.itemId === id)));
  if (hit) {
    hit.status = item.status ?? hit.status;
    hit.data = item;
  } else {
    activity.push({ type, itemId: id || undefined, outputIndex: index, status: item.status, data: item });
    if (onHarnessUse && type.endsWith("_call")) onHarnessUse(type);
  }
}

// 文本/思考块从 0 起连续编号；工具调用块单独占用一个高段区间。
// Ark Responses 允许 function_call 之后再输出 message（服务端内置工具的
// 活动说明就是流末尾才收集的），但 DSH 的 assistant 消息会原样持久化，
// 而 Anthropic Messages 协议（DeepSeek 官方 /anthropic 端点）要求同一个
// assistant 消息里 tool_use 之后只能是 tool_result —— 只要 tool_use 后面
// 还跟着文本，切到官方 provider 就必然 400 "tool_use ids were found
// without tool_result blocks immediately after"。用独立索引段保证按
// block-start 首次出现的顺序（BlockAssembler 的 order[]）永远是"文本在前、
// 工具调用在后"，同时也保留流式输出。
const TOOL_CALL_INDEX_BASE = 1_000_000;

/**
 * 把 Ark Responses SSE 翻译为 DSH StreamChunk 协议。
 * @param body - Ark 的 SSE 响应体。
 * @param signal - 取消信号。
 * @param onHarnessUse - 服务端内置工具被调用时的回调。
 * @param options.deferToolCalls - 声明了服务端内置工具时为 true：工具调用块
 *   要等结果末尾的内置工具活动文本发出之后再发，避免 tool-call 后面又出现
 *   文本块（DeepSeek 官方 Messages 协议会因此拒绝整段历史）。未声明内置
 *   工具时保持原样，工具调用参数照常边流边发。
 */
export async function* responsesToDshChunks(body, signal, onHarnessUse, options = {}) {
  const slots = new Map();
  const activity = [];
  // 仅在内置工具模式下使用：工具调用块先攒起来，等在流末尾补上内置工具
  // 活动文本之后再统一发出，保证 assistant 消息里 tool-call 永远排在最后。
  const deferToolCalls = options.deferToolCalls === true;
  const pendingToolCallBlocks = [];
  // 是否已经内联发出过工具调用块（未延迟时）。用于流末尾的防御性判断：
  // 一旦 tool-call 已发出，绝不能再追加文本块，否则历史块序会被写坏。
  let emittedInlineToolCall = false;
  let nextIndex = 0;
  let nextToolCallIndex = TOOL_CALL_INDEX_BASE;
  let terminal;
  let sawContent = false;
  let sawFunctionCall = false;

  events: for await (const event of iterateSse(body, signal)) {
    const outputIndex = Number.isInteger(event.output_index) ? event.output_index : -1;
    switch (event.type) {
      case "response.output_item.added": {
        const item = event.item ?? {};
        if (outputIndex < 0) break;
        if (item.type === "message") {
          const slot = { kind: "text", index: nextIndex++, text: "" };
          slots.set(outputIndex, slot);
          yield { type: "block-start", index: slot.index, blockType: "text" };
        } else if (item.type === "reasoning") {
          const slot = { kind: "reasoning", index: nextIndex++, text: "" };
          slots.set(outputIndex, slot);
          yield { type: "block-start", index: slot.index, blockType: "reasoning" };
        } else if (item.type === "function_call") {
          const slot = {
            kind: "tool-call", index: deferToolCalls ? nextToolCallIndex++ : nextIndex++,
            id: ToolCallId(String(item.call_id ?? item.id ?? `call_${outputIndex}`)),
            name: String(item.name ?? ""), arguments: String(item.arguments ?? ""),
          };
          slots.set(outputIndex, slot);
          if (!deferToolCalls) {
            emittedInlineToolCall = true;
            yield { type: "block-start", index: slot.index, blockType: "tool-call" };
            if (slot.name || slot.arguments) yield { type: "tool-call-delta", index: slot.index, id: slot.id, name: slot.name, argumentsDelta: slot.arguments };
          }
        } else mergeHarnessActivity(activity, item, event.item_id, onHarnessUse, outputIndex);
        break;
      }

      case "response.output_text.delta": {
        const slot = slots.get(outputIndex);
        if (slot?.kind === "text" && typeof event.delta === "string" && event.delta) {
          slot.text += event.delta; sawContent = true;
          yield { type: "text-delta", index: slot.index, text: event.delta };
        }
        break;
      }

      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const slot = slots.get(outputIndex);
        if (slot?.kind === "reasoning" && typeof event.delta === "string" && event.delta) {
          slot.text += event.delta; sawContent = true;
          yield { type: "reasoning-delta", index: slot.index, text: event.delta };
        }
        break;
      }

      case "response.function_call_arguments.delta": {
        const slot = slots.get(outputIndex);
        if (slot?.kind === "tool-call" && typeof event.delta === "string" && event.delta) {
          slot.arguments += event.delta;
          if (deferToolCalls) break; // 块延后发出，见 pendingToolCallBlocks
          sawContent = true;
          yield { type: "tool-call-delta", index: slot.index, id: slot.id, argumentsDelta: event.delta };
        }
        break;
      }

      case "response.output_item.done": {
        const item = event.item ?? {};
        const slot = slots.get(outputIndex);
        if (!slot) { mergeHarnessActivity(activity, item, event.item_id, onHarnessUse, outputIndex); break; }
        if (slot.kind === "text") {
          const finalText = itemMessageText(item);
          if (!slot.text && finalText) {
            slot.text = finalText; sawContent = true;
            yield { type: "text-delta", index: slot.index, text: finalText };
          }
          yield { type: "block-end", index: slot.index, block: { type: "text", text: slot.text } };
        } else if (slot.kind === "reasoning") {
          const finalText = itemReasoningText(item);
          if (!slot.text && finalText) {
            slot.text = finalText; sawContent = true;
            yield { type: "reasoning-delta", index: slot.index, text: finalText };
          }
          yield { type: "block-end", index: slot.index, block: { type: "reasoning", text: slot.text } };
        } else {
          const finalArguments = String(item.arguments ?? slot.arguments ?? "{}");
          if (!slot.arguments && finalArguments) {
            slot.arguments = finalArguments;
            if (!deferToolCalls) {
              sawContent = true;
              yield { type: "tool-call-delta", index: slot.index, id: slot.id, name: slot.name, argumentsDelta: finalArguments };
            }
          }
          slot.arguments ||= "{}";
          sawFunctionCall = true; sawContent = true;
          const block = { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.arguments };
          if (deferToolCalls) pendingToolCallBlocks.push({ index: slot.index, block });
          else yield { type: "block-end", index: slot.index, block };
        }
        slots.delete(outputIndex);
        break;
      }

      case "response.completed":
      case "response.incomplete":
      case "response.failed":
      case "response.cancelled":
        terminal = { eventType: event.type, response: event.response ?? {} };
        break events;

      case "error":
        throw new LlmError(`${event.error?.code ?? event.code ?? "error"}: ${event.error?.message ?? event.message ?? "Ark Responses 流错误"}`, httpFailure(400, JSON.stringify(event.error ?? event)));
      default:
        // 工具进行中/心跳类事件（web_search_call.searching、code_interpreter_call.*
        // 等）：不产出内容，但必须让上层知道「流还活着」。内置工具执行可能远超
        // 空闲超时阈值（默认 60s），若这里静默吞掉，adapter 收不到 chunk 就不会
        // touch 空闲计时 → 健康请求被 TIMEOUT 掐断（审计#1，2026-11-13）。
        // heartbeat 只用于续命，adapter 收到后不转发给上层。
        yield { type: "heartbeat" };
        break;
    }
  }

  if (signal?.aborted) throw new LlmError("Ark Responses 请求已取消", "ABORTED", { cause: signal.reason });
  if (!terminal) throw new LlmError("Ark Responses 流在终止事件前关闭", "STREAM_CLOSED");

  // 「有块没闭合」只有在 response.completed 时才算协议损坏：completed 表示
  // 服务端声称正常结束，此时还挂着输出块说明流被截断/事件乱序。
  // 但 incomplete / failed / cancelled 本身就是**提前终止**（max_output_tokens 截断
  // 最常见），此时未闭合块是预期现象 —— 若在这里也抛 STREAM_CLOSED，就会抢在
  // 下面的 incomplete 分流之前把「max-tokens 语义 + 已生成文本」全部丢掉
  // （实测：截断 + 未闭合 text 块 → 抛出 STREAM_CLOSED，UI 显示成协议错误）。
  // 所以提前终止时改为**补发这些块的 block-end**，保住已有内容。
  const unclosedSlots = [...slots.values()];
  if (slots.size && terminal.eventType === "response.completed") {
    throw new LlmError("Ark Responses 流存在未结束的输出块", "STREAM_CLOSED");
  }
  if (unclosedSlots.length) {
    for (const slot of unclosedSlots) {
      if (slot.kind === "text") {
        if (slot.text) sawContent = true;
        yield { type: "block-end", index: slot.index, block: { type: "text", text: slot.text } };
      } else if (slot.kind === "reasoning") {
        if (slot.text) sawContent = true;
        yield { type: "block-end", index: slot.index, block: { type: "reasoning", text: slot.text } };
      } else {
        // 工具调用：未延迟时块已内联发出，直接闭合；延迟时交给下面的
        // pendingToolCallBlocks，保证 tool-call 仍排在活动说明文本之后
        // （Anthropic Messages 协议不接受「tool_use 后面还有文本」的历史）。
        slot.arguments ||= "{}";
        sawFunctionCall = true; sawContent = true;
        const block = { type: "tool-call", id: slot.id, name: slot.name, arguments: slot.arguments };
        if (deferToolCalls) pendingToolCallBlocks.push({ index: slot.index, block });
        else yield { type: "block-end", index: slot.index, block };
      }
    }
    slots.clear();
  }

  const activityText = formatHarnessActivity(activity);
  // 防御：未延迟模式下若已内联发出 tool-call，此刻再追加文本块会让内容变成
  // [文本…, tool-call, 文本]，Anthropic Messages 协议会拒绝这类历史
  // （"tool_use ids ... without tool_result blocks immediately after"）。
  // 内置工具活动说明属于展示信息，历史完整性优先级更高 —— 此时宁可丢弃说明。
  if (activityText && !emittedInlineToolCall) {
    const index = nextIndex++;
    sawContent = true;
    yield { type: "block-start", index, blockType: "text" };
    yield { type: "text-delta", index, text: activityText };
    yield { type: "block-end", index, block: { type: "text", text: activityText } };
  }
  for (const pending of pendingToolCallBlocks) {
    const block = pending.block;
    yield { type: "block-start", index: pending.index, blockType: "tool-call" };
    yield { type: "tool-call-delta", index: pending.index, id: block.id, name: block.name, argumentsDelta: block.arguments };
    yield { type: "block-end", index: pending.index, block };
  }

  const response = terminal.response;
  yield { type: "usage", usage: usageFrom(response) };
  if (terminal.eventType === "response.completed") {
    if (!sawContent) yield { type: "finish", reason: { kind: "error", failure: failure("Ark Responses 返回空回复", "EMPTY_RESPONSE") } };
    else yield { type: "finish", reason: { kind: sawFunctionCall ? "tool-calls" : "stop" } };
  } else if (terminal.eventType === "response.incomplete") {
    const reason = response.incomplete_details?.reason;
    yield { type: "finish", reason: reason === "max_output_tokens"
      ? { kind: "max-tokens" }
      : { kind: "error", failure: failure(`Ark Responses 未完整结束：${reason ?? "unknown"}`, "PROVIDER_ERROR") } };
  } else {
    const error = response.error ?? {};
    yield { type: "finish", reason: { kind: "error", failure: failure(`${error.code ?? "error"}: ${error.message ?? "Ark Responses 请求失败"}`, terminal.eventType === "response.cancelled" ? "ABORTED" : httpFailure(400, JSON.stringify(error))) } };
  }
}
