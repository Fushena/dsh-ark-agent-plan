import { LlmError } from "@deepseek-ai/dsh-llm";
import { resolveReasoningEffort, shadowedFunctionNames } from "./harness.js";
import { resolveApiKey } from "./apikey.js";

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
 * server_url 安全闸：只允许 https + 非私网/本机字面量。
 *
 * 请求虽由 Ark 服务端发起（不是本机 SSRF），但把 http://、file:// 或内网地址
 * 声明给云端等于让 Ark 代打任意 URL——配置笔误会静默变成坏声明。这里在归一化
 * 阶段就拒掉，与 qwen-token-plan-full 的下载闸同一思路（协议 + 私网字面量）。
 * DNS 解析不在此做：声明是静态配置，真正连接由 Ark 服务端负责。
 */
export function isPrivateHostLiteral(hostname) {
  const host = String(hostname ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "" ) return true;
  // IPv6：loopback / link-local / unique-local / IPv4-mapped
  if (host.includes(":")) {
    if (host === "::1" || host === "::") return true;
    if (/^f[ecd]/.test(host)) return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateHostLiteral(mapped[1]);
    return false;
  }
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function safeMcpServerUrl(raw) {
  const trimmed = String(raw).trim();
  let parsed;
  try { parsed = new URL(trimmed); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  if (isPrivateHostLiteral(parsed.hostname)) return null;
  // 返回用户原样 URL（仅 trim）：href 会补尾斜杠/重编码，改变用户声明的字面值。
  return trimmed;
}

/**
 * 将插件配置的 mcpServers 数组归一化为 Responses API 的 tools 声明。
 *
 * 配置项格式（来自 index.js Config.mcpServers）：
 *   { server_url: "https://...", server_label?: "...", headers?: { ... },
 *     allowed_tools?: [...], require_approval?: ... }
 *
 * Ark Responses API 接受 type: "mcp" 的 tools 声明，由 Ark 服务端代替模型
 * 调用外部 MCP server。与 function 声明、内置工具（web_search 等）共存于
 * tools 数组。
 *
 * headers 里的值支持 ${credential:REF} 模板，此处只做结构归一化（模板原样
 * 保留），展开由调用方（adapter）在构建请求体前经 expandCredentialTemplates
 * 完成——不展开就会把字面量发给 Ark，MCP 鉴权静默失败。
 *
 * @param {Array} servers - 用户配置的 MCP server 列表。
 * @param {Object} [logger] - 可选 logger，被拒的声明记 warn（不含凭据值）。
 * @returns {Array} 归一化后的 MCP tool 声明数组。
 */
export function mcpToolDeclarations(servers, logger) {
  if (!Array.isArray(servers) || servers.length === 0) return [];
  const result = [];
  for (const s of servers) {
    if (!s || typeof s !== "object" || typeof s.server_url !== "string" || !s.server_url.trim()) continue;
    const url = safeMcpServerUrl(s.server_url);
    if (!url) {
      logger?.warn?.(`dsh-ark-agent-plan: 忽略不安全的 MCP server_url（要求 https 且非私网/本机地址）：${String(s.server_url).slice(0, 120)}`);
      continue;
    }
    const decl = { type: "mcp", server_url: url };
    if (typeof s.server_label === "string" && s.server_label.trim()) {
      decl.server_label = s.server_label.trim();
    }
    if (s.headers && typeof s.headers === "object" && !Array.isArray(s.headers)) {
      const headers = {};
      for (const [name, value] of Object.entries(s.headers)) {
        if (typeof value === "string") headers[name] = value;
      }
      if (Object.keys(headers).length > 0) decl.headers = headers;
    }
    // 只透传白名单内的可选字段，未知字段丢弃（配置面收敛）。
    // 空值（schema 默认补的 [] / false）不声明，保持请求体最小。
    if (Array.isArray(s.allowed_tools) && s.allowed_tools.length > 0) decl.allowed_tools = s.allowed_tools;
    if (s.require_approval !== undefined && s.require_approval !== false) decl.require_approval = s.require_approval;
    result.push(decl);
  }
  return result;
}

const CREDENTIAL_TEMPLATE_RE = /\$\{credential:([A-Za-z0-9_.\-]+)\}/g;

/**
 * 展开字符串里的 ${credential:REF} 模板（DSH 凭据服务 → 环境变量）。
 * 与宿主 dsh-mcp-client 的 transport 模板同语法；解析不到的引用抛错
 * （fail-closed：宁可报错也不把字面量模板发给上游导致静默鉴权失败）。
 */
export async function expandCredentialTemplates(value, ctx, pluginName) {
  const text = String(value);
  const refs = [...text.matchAll(CREDENTIAL_TEMPLATE_RE)].map((m) => m[1]);
  if (refs.length === 0) return text;
  let out = text;
  for (const ref of [...new Set(refs)]) {
    const resolved = await resolveApiKey(ctx, [ref], pluginName);
    out = out.split(`\${credential:${ref}}`).join(resolved);
  }
  return out;
}

/** 对 MCP 声明数组的 headers 逐项展开凭据模板（返回新数组，不改原声明）。 */
export async function expandMcpHeaders(mcpTools, ctx, pluginName) {
  if (!Array.isArray(mcpTools) || mcpTools.length === 0) return mcpTools ?? [];
  const out = [];
  for (const decl of mcpTools) {
    if (!decl.headers) { out.push(decl); continue; }
    const headers = {};
    for (const [name, value] of Object.entries(decl.headers)) {
      headers[name] = await expandCredentialTemplates(value, ctx, pluginName);
    }
    out.push({ ...decl, headers });
  }
  return out;
}

/**
 * Ark Responses 请求体。harnessTools 为服务端内置工具（web_search 等），
 * 与 DSH 本地函数工具、MCP 工具声明合并进 tools 数组；web_extractor 需与
 * web_search 同声明。
 *
 * 工具仲裁规则（与 DSH 自带模型的工具互不影响）：
 * - 只声明「本次实际生效」的服务端内置工具（权益耗尽的已被 adapter 过滤掉）；
 * - 与内置工具同能力的本地函数让位，但仅限这些名字，其余本地工具原样保留；
 * - 内置工具被权益过滤掉后不再让位，同名本地工具自动重新出现——
 *   这就是「harness 权益用完了自动回退到 DSH 自己的工具」。
 * - MCP 工具声明独立追加，不参与同名仲裁（MCP server 由 Ark 服务端代理调用，
 *   不会与本地函数冲突）。
 *
 * @param {Object} options - DSH 调用选项。
 * @param {Object} model - 目录中的模型规格。
 * @param {Object} attachments - DSH 附件服务。
 * @param {string[]} harnessTools - 本次声明的内置工具类型。
 * @param {string} fallbackEffort - 默认推理档位。
 * @param {Array} [mcpTools] - 归一化后的 MCP tool 声明（来自 mcpToolDeclarations）。
 */
export async function buildRequestBody(options, model, attachments, harnessTools, fallbackEffort, mcpTools) {
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
    ...(Array.isArray(mcpTools) ? mcpTools : []),
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
