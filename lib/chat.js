import { LlmError, ToolCallId } from "@deepseek-ai/dsh-llm";
import { sanitizeText } from "./content.js";
import { iterateSse } from "./responses-sse.js";
import { failure, streamFailureCode } from "./errors.js";
import { resolveReasoningEffort } from "./harness.js";

function textBlocks(blocks, emptyText) {
  const text = [];
  for (const block of blocks ?? []) {
    if (block.type === "text" || block.type === "reasoning") text.push(sanitizeText(block.text));
    else if (block.type === "image") throw new LlmError("Chat 路线不支持图片输入", "UNSUPPORTED_CONTENT");
    else if (block.type !== "tool-call" && block.type !== "tool-result"
      && block.type !== "tool-addition" && block.type !== "tool-removal" && block.type !== "file") {
      throw new LlmError(`Chat 路线不支持内容类型 ${block.type}`, "UNSUPPORTED_CONTENT");
    }
  }
  return text.join("") || emptyText;
}

function assistantMessage(message) {
  const reasoning = (message.content ?? []).filter((block) => block.type === "reasoning")
    .map((block) => sanitizeText(block.text)).join("");
  const content = (message.content ?? []).filter((block) => block.type === "text")
    .map((block) => sanitizeText(block.text)).join("");
  const toolCalls = (message.content ?? []).filter((block) => block.type === "tool-call").map((block) => ({
    id: String(block.id),
    type: "function",
    function: { name: block.name, arguments: sanitizeText(block.arguments || "{}") },
  }));
  for (const block of message.content ?? []) {
    if (!["text", "reasoning", "tool-call"].includes(block.type)) {
      throw new LlmError(`Chat assistant 历史不支持内容类型 ${block.type}`, "UNSUPPORTED_CONTENT");
    }
  }
  return {
    role: "assistant",
    content,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
  };
}

function chatMessages(options) {
  const messages = [];
  if (options.system) messages.push({ role: "system", content: sanitizeText(options.system) });
  for (const message of options.messages ?? []) {
    if (message.role === "system") {
      messages.push({ role: "system", content: textBlocks(message.content, "") });
      continue;
    }
    if (message.role === "assistant") {
      messages.push(assistantMessage(message));
      continue;
    }
    if (message.role === "tool") {
      messages.push({
        role: "tool",
        tool_call_id: String(message.toolCallId),
        content: textBlocks(message.content, message.isError ? "(工具执行失败且没有输出)" : "(工具没有输出)"),
      });
      continue;
    }
    const ordinary = (message.content ?? []).filter((block) => block.type !== "tool-result");
    const results = (message.content ?? []).filter((block) => block.type === "tool-result");
    // OpenAI Chat Completions 要求 role:"tool" 紧跟在上一条带 tool_calls 的 assistant 之后；
    // 先发全部 tool 结果，再仅在存在非空用户文本（或本条不含 tool-result）时发 role:"user"。
    for (const result of results) {
      messages.push({
        role: "tool",
        tool_call_id: String(result.toolCallId),
        content: textBlocks(result.content, result.isError ? "(工具执行失败且没有输出)" : "(工具没有输出)"),
      });
    }
    const ordinaryText = textBlocks(ordinary, "");
    if (ordinaryText !== "" || !results.length) messages.push({ role: "user", content: ordinaryText });
  }
  return messages;
}

/** Kimi K2.7 Code 等走 OpenAI Chat Completions（enable_thinking + reasoning_effort）。 */
export async function buildChatRequestBody(options, model, fallbackEffort) {
  const maximum = Number.isFinite(model.maxTokens) ? model.maxTokens : 32768;
  const requested = Number.isFinite(options.maxTokens) ? options.maxTokens : maximum;
  const effort = resolveReasoningEffort(options, model, fallbackEffort);
  const tools = (options.tools ?? []).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: sanitizeText(tool.description), parameters: tool.parameters },
  }));
  return {
    model: model.id,
    messages: chatMessages(options),
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: Math.max(1, Math.min(Math.floor(requested), maximum)),
    ...(effort ? { enable_thinking: effort !== "off", reasoning_effort: effort } : {}),
    ...(tools.length ? { tools, tool_choice: "auto" } : {}),
    ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stop?.length ? { stop: options.stop } : {}),
  };
}

function mappedUsage(usage) {
  const totalInput = Number.isFinite(usage?.prompt_tokens) ? usage.prompt_tokens : 0;
  const cacheRead = Number.isFinite(usage?.prompt_tokens_details?.cached_tokens)
    ? usage.prompt_tokens_details.cached_tokens : usage?.prompt_cache_hit_tokens ?? 0;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: Math.max(0, totalInput - cacheRead),
    outputTokens: Number.isFinite(usage?.completion_tokens) ? usage.completion_tokens : 0,
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(Number.isFinite(reasoning) && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

function mappedFinish(reason) {
  if (reason === "stop") return { kind: "stop" };
  if (reason === "tool_calls") return { kind: "tool-calls" };
  if (reason === "length") return { kind: "max-tokens" };
  return { kind: "error", failure: failure(`Chat 异常结束：${reason}`, String(reason || "UNKNOWN").toUpperCase()) };
}

function closeBlock(block) {
  if (block.kind === "text") return { type: "text", text: block.text };
  if (block.kind === "reasoning") return { type: "reasoning", text: block.text };
  return { type: "tool-call", id: ToolCallId(block.id || `call_${block.wireIndex}`), name: block.name || "", arguments: block.text || "{}" };
}

/** 把 OpenAI Chat Completions SSE 翻译为 DSH StreamChunk。 */
export async function* chatToDshChunks(body, signal, onData) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = new Map();
  let lastToolBlock;
  const order = [];
  let finish;
  let usage;
  const open = (kind, extra = {}) => {
    const block = { kind, index: nextIndex++, text: "", ...extra };
    order.push(block);
    return block;
  };

  for await (const chunk of iterateSse(body, signal, onData)) {
    if (chunk?.error) throw new LlmError(`${chunk.error.code ?? "error"}: ${chunk.error.message ?? "Chat 流错误"}`, streamFailureCode(chunk.error));
    for (const choice of chunk?.choices ?? []) {
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += delta.reasoning_content;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: delta.reasoning_content };
      }
      if (typeof delta.content === "string" && delta.content) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += delta.content;
        yield { type: "text-delta", index: textBlock.index, text: delta.content };
      }
      for (const call of delta.tool_calls ?? []) {
        // 空串不是 id：`call.id !== undefined` 会让续片段的 id:"" 覆盖真 id，
        // tool_result 就对不上上游那条调用了（与 qwen 侧 Q13 同款）。
        const rawId = call.id == null ? "" : String(call.id);
        const id = rawId === "" ? undefined : rawId;
        let block;
        let wireIndex;
        if (Number.isInteger(call.index)) {
          wireIndex = call.index;
          block = toolBlocks.get(wireIndex);
        } else {
          // 服务端省略 index（审计#8，2026-11-13）：旧实现用 toolBlocks.size 当
          // 索引，每段 delta 都新开块，同一调用的参数被拆成多个坏块。改为：
          //   带 id → 按 id 找回已开的块（找不到才视为新调用）；
          //   无 id → 只在「当前仅一个工具块」时复用上一块。并行调用时归属不可判定，
          //   串进最后一块会把两条调用的参数拼成坏 JSON，并污染已经正确的那一条。
          if (id !== undefined) {
            for (const candidate of toolBlocks.values()) {
              if (candidate.id === id) { block = candidate; break; }
            }
          }
          if (!block && id === undefined && toolBlocks.size === 1) block = lastToolBlock;
          if (block) wireIndex = block.wireIndex;
          else wireIndex = toolBlocks.size;
        }
        if (!block) {
          block = open("tool-call", { wireIndex, id: "", name: "" });
          toolBlocks.set(wireIndex, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        lastToolBlock = block;
        if (id !== undefined) block.id = id;
        // 续片段常带 name:"" 或 name:null，仅非空字符串才更新工具名，避免覆写为空串或 "null"。
        const fnName = typeof call.function?.name === "string" && call.function.name !== "" ? call.function.name : undefined;
        if (fnName !== undefined) block.name = fnName;
        const fragment = typeof call.function?.arguments === "string" ? call.function.arguments : "";
        block.text += fragment;
        if (fragment || id !== undefined || fnName !== undefined) {
          yield {
            type: "tool-call-delta", index: block.index, id: ToolCallId(block.id || `call_${wireIndex}`),
            ...(block.name ? { name: block.name } : {}), argumentsDelta: fragment,
          };
        }
      }
      if (typeof choice.finish_reason === "string") finish = mappedFinish(choice.finish_reason);
    }
    if (chunk?.usage) usage = mappedUsage(chunk.usage);
  }

  if (signal?.aborted) throw new LlmError("Chat 请求已取消", "ABORTED", { cause: signal.reason });
  if (!finish) throw new LlmError("Chat 流在 finish_reason 前关闭", "STREAM_CLOSED");
  for (const block of order) yield { type: "block-end", index: block.index, block: closeBlock(block) };
  if (usage) yield { type: "usage", usage };
  yield {
    type: "finish",
    reason: finish.kind === "stop" && order.length === 0
      ? { kind: "error", failure: failure("Chat 返回空回复", "EMPTY_RESPONSE") }
      : finish,
  };
}
