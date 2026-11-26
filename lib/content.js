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
/** IPv4 点分四段 → [a,b,c,d]；不是合法 IPv4 字面量返回 null。 */
export function parseIpv4Literal(text) {
  const parts = String(text).split(".");
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** IPv6 字面量 → 8 个 16 位组；支持 :: 压缩、末尾内嵌 IPv4、%zone 后缀。 */
export function parseIpv6Literal(text) {
  let s = String(text ?? "");
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct);
  if (!s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4Literal(tail);
    if (!v4) return null;
    const g0 = ((v4[0] << 8) | v4[1]).toString(16);
    const g1 = ((v4[2] << 8) | v4[3]).toString(16);
    s = s.slice(0, lastColon + 1) + g0 + ":" + g1;
  }
  let parts;
  const dbl = s.indexOf("::");
  if (dbl >= 0) {
    if (s.indexOf("::", dbl + 1) >= 0) return null;
    const head = s.slice(0, dbl) ? s.slice(0, dbl).split(":") : [];
    const rest = s.slice(dbl + 2) ? s.slice(dbl + 2).split(":") : [];
    const missing = 8 - head.length - rest.length;
    if (missing < 1) return null;
    parts = [...head, ...Array(missing).fill("0"), ...rest];
  } else {
    parts = s.split(":");
    if (parts.length !== 8) return null;
  }
  const groups = [];
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    groups.push(parseInt(p, 16));
  }
  return groups.length === 8 ? groups : null;
}

function isPrivateIpv4([a, b, c]) {
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0 && c === 0) return true;  // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved/broadcast
  return false;
}

function isPrivateIpv6(text) {
  const g = parseIpv6Literal(text);
  if (!g) return false;
  if (g.every((x) => x === 0)) return true; // ::
  if (g.every((x, i) => (i < 7 ? x === 0 : x === 1))) return true; // ::1
  // ::ffff:0:0/96（IPv4-mapped）、::ffff:0:0:0/96（IPv4-translated）、::/96（IPv4-compatible）
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return true;
  if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return true;
  if (g.slice(0, 6).every((x) => x === 0)) return true;
  // 64:ff9b::/96（NAT64 well-known prefix）与 64:ff9b:1::/48（本地 NAT64）
  if (g[0] === 0x0064 && g[1] === 0xff9b && ((g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) || g[2] === 1)) return true;
  if ((g[0] >> 8) === 0xff) return true; // ff00::/8 multicast
  if (g[0] >= 0xfc00 && g[0] <= 0xfdff) return true; // fc00::/7 ULA
  if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return true; // fe80::/10 link-local
  if (g[0] >= 0xfec0 && g[0] <= 0xfeff) return true; // fec0::/10 site-local
  return false;
}

export function isPrivateHostLiteral(hostname) {
  let host = String(hostname ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  const zoneAt = host.indexOf("%");
  if (zoneAt !== -1) host = host.slice(0, zoneAt);
  if (host.endsWith(".") && !host.endsWith("..")) host = host.slice(0, -1);
  if (host === "localhost" || host.endsWith(".localhost") || host === "") return true;
  if (host.includes(":")) return isPrivateIpv6(host);
  const octets = parseIpv4Literal(host);
  return octets ? isPrivateIpv4(octets) : false;
}

function redactUrlForLog(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return "(empty)";
  try {
    const parsed = new URL(trimmed);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && /^https?:\/\//i.test(trimmed) && parsed.host) {
      if (parsed.username || parsed.password) {
        parsed.username = "***";
        parsed.password = "";
      }
      parsed.search = "";
      parsed.hash = "";
      return parsed.href.slice(0, 120);
    }
    // 非 http(s) 或 opaque URL 不回显原文，防止 query / user:pass@host 明文落入日志。
    return `${parsed.protocol}//(redacted)`;
  } catch {
    return "(unparsable-url)";
  }
}

function safeMcpServerUrl(raw) {
  const trimmed = String(raw).trim();
  let parsed;
  try { parsed = new URL(trimmed); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username || parsed.password) return null;
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
      logger?.warn?.(`dsh-ark-agent-plan: 忽略不安全的 MCP server_url（要求 https 且非私网/本机地址）：${redactUrlForLog(s.server_url)}`);
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
 * 单遍替换：先解析所有唯一引用进 Map，再用一次 replace 展开，避免凭据 A 的值
 * 恰好包含 `${credential:B}` 字样时被下一轮二次展开污染。
 */
export async function expandCredentialTemplates(value, ctx, pluginName) {
  const text = String(value);
  const refs = [...text.matchAll(CREDENTIAL_TEMPLATE_RE)].map((m) => m[1]);
  if (refs.length === 0) return text;
  const resolved = new Map();
  for (const ref of new Set(refs)) {
    resolved.set(ref, await resolveApiKey(ctx, [ref], pluginName));
  }
  return text.replace(CREDENTIAL_TEMPLATE_RE, (_, ref) => resolved.get(ref));
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
