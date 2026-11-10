import { LlmError } from "@deepseek-ai/dsh-llm";
import { resolveReasoningEffort, shadowedFunctionNames } from "./harness.js";

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
export function sanitizeText(text) { return String(text ?? "").replace(LONE_SURROGATE_RE, "\uFFFD"); }

async function imageBlock(block, model, attachments, signal) {
  if (!(model.input ?? []).includes("image")) throw new LlmError(`模型 ${model.id} 不支持图片输入`, "UNSUPPORTED_CONTENT");
  if (!attachments) throw new LlmError("图片输入需要 DSH 附件服务", "UNSUPPORTED_CONTENT");
  const stored = await attachments.readImage(block.attachment, signal);
  return { type: "input_image", image_url: `data:${stored.ref.mediaType};base64,${Buffer.from(stored.data).toString("base64")}` };
}

async function inputContent(blocks, model, attachments, signal) {
  const result = [];
  for (const block of blocks ?? []) {
    if (block.type === "text") result.push({ type: "input_text", text: sanitizeText(block.text) });
    else if (block.type === "image") result.push(await imageBlock(block, model, attachments, signal));
    else if (block.type === "tool-result") result.push(...await inputContent(block.content, model, attachments, signal));
  }
  return result;
}

async function toolOutput(block, model, attachments, signal) {
  const content = await inputContent(block.content, model, attachments, signal);
  if (content.length === 0) return block.isError ? "(工具执行失败且没有输出)" : "(工具没有输出)";
  if (content.every((item) => item.type === "input_text")) return content.map((item) => item.text).join("\n");
  return content;
}

function flushAssistantText(items, text) {
  if (text.length === 0) return "";
  items.push({
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: sanitizeText(text), annotations: [] }],
  });
  return "";
}

async function convertMessage(message, model, attachments, signal) {
  if (message.role === "system") {
    const text = message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
    return text ? [{ role: "system", content: sanitizeText(text) }] : [];
  }
  if (message.role === "assistant") {
    const items = [];
    let text = "";
    for (const block of message.content) {
      if (block.type === "text") text += block.text;
      else if (block.type === "tool-call") {
        text = flushAssistantText(items, text);
        items.push({ type: "function_call", call_id: String(block.id), name: block.name, arguments: sanitizeText(block.arguments || "{}") });
      } else if (block.type === "image") {
        throw new LlmError("Responses 历史不支持结构化的 assistant 图片块", "UNSUPPORTED_CONTENT");
      }
    }
    flushAssistantText(items, text);
    return items;
  }
  if (message.role === "tool") {
    const content = await inputContent(message.content, model, attachments, signal);
    let output;
    if (content.length === 0) output = message.isError ? "(工具执行失败且没有输出)" : "(工具没有输出)";
    else if (content.every((item) => item.type === "input_text")) output = content.map((item) => item.text).join("\n");
    else output = content;
    return [{ type: "function_call_output", call_id: String(message.toolCallId), output }];
  }

  const items = [];
  const ordinary = [];
  for (const block of message.content) {
    if (block.type === "tool-result") {
      items.push({
        type: "function_call_output",
        call_id: String(block.toolCallId),
        output: await toolOutput(block, model, attachments, signal),
      });
    } else ordinary.push(block);
  }
  const content = await inputContent(ordinary, model, attachments, signal);
  if (content.length) items.push({ role: "user", content });
  return items;
}

/** 将 DSH 的 provider-neutral 历史转换为 Ark Responses input items。 */
export async function buildInput(options, model, attachments) {
  const input = [];
  if (options.system) input.push({ role: "system", content: sanitizeText(options.system) });
  for (const message of options.messages) input.push(...await convertMessage(message, model, attachments, options.signal));
  return input;
}

export function functionToolDeclarations(tools = []) {
  return tools.map((tool) => ({
    type: "function",
    name: tool.name,
    description: sanitizeText(tool.description),
    parameters: tool.parameters,
  }));
}

/**
 * Ark Responses 请求体。harnessTools 为服务端内置工具（web_search 等），
 * 与 DSH 本地函数工具合并进 tools 数组；web_extractor 需与 web_search 同声明。
 *
 * 工具仲裁规则（与 DSH 自带模型的工具互不影响）：
 * - 只声明「本次实际生效」的服务端内置工具（权益耗尽的已被 adapter 过滤掉）；
 * - 与内置工具同能力的本地函数让位，但仅限这些名字，其余本地工具原样保留；
 * - 内置工具被权益过滤掉后不再让位，同名本地工具自动重新出现——
 *   这就是「harness 权益用完了自动回退到 DSH 自己的工具」。
 */
export async function buildRequestBody(options, model, attachments, harnessTools, fallbackEffort) {
  if (options.stop?.length) throw new LlmError("Ark Responses API 未声明支持 stop 参数", "UNSUPPORTED_OPTION");
  const effort = resolveReasoningEffort(options, model, fallbackEffort);
  const selectedBuiltins = harnessTools ?? [];
  const builtinSet = new Set(selectedBuiltins);
  const builtins = selectedBuiltins.filter((type, index, all) =>
    all.indexOf(type) === index && (type !== "web_extractor" || builtinSet.has("web_search")));
  // 同名冲突：Ark 服务端内置工具优先于 DSH 本地函数工具。
  // 若两者同时声明，网关会让模型以 function_call 形式调用本地 schema，
  // 服务端 harness 不会执行（实测 2026-11-05）。因此移除同名的函数声明。
  // 只让位给「本次真正声明了」的内置工具：权益耗尽被摘掉后，本地工具回来。
  const declaredFunctions = functionToolDeclarations(options.tools);
  const shadowed = shadowedFunctionNames(builtins, declaredFunctions.map((tool) => tool.name));
  const functions = declaredFunctions.filter((tool) => !shadowed.has(tool.name));
  const tools = [
    ...functions,
    ...builtins.map((type) => ({ type })),
  ];
  const maximum = Number.isFinite(model.maxTokens) ? model.maxTokens : 16384;
  const requested = Number.isFinite(options.maxTokens) ? options.maxTokens : maximum;
  const body = {
    model: model.id,
    input: await buildInput(options, model, attachments),
    stream: true,
    max_output_tokens: Math.max(16, Math.min(Math.floor(requested), maximum)),
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  // V4.1 Flash / Seed 2.1 Turbo：显式 thinking 开关（reasoning.effort 单独不可靠地关思考）。
  if (model.explicitThinkingToggle) {
    body.thinking = { type: effort === "off" ? "disabled" : "enabled" };
    if (effort && effort !== "off") body.reasoning = { effort };
  } else if (effort && effort !== "off") {
    body.reasoning = { effort };
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  return body;
}
