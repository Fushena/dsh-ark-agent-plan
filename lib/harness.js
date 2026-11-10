import { LlmError } from "@deepseek-ai/dsh-llm";

/**
 * 火山方舟 Agent Plan 的 Responses API 服务端内置工具（Harness 能力）。
 * 实测（2026-11-05，deepseek-v4.1-flash）：web_search 会真实触发 web_search_call；
 * code_interpreter / web_extractor 被网关接受（不报 UnsupportedTool）。
 */
export const HARNESS_TOOL_TYPES = Object.freeze([
  "web_search",
  "code_interpreter",
  "web_extractor",
]);

export const HARNESS_TOOL_LABELS = Object.freeze({
  web_search: "联网搜索",
  code_interpreter: "代码解释器",
  web_extractor: "网页抓取",
});

const KNOWN = new Set(HARNESS_TOOL_TYPES);

/** 将插件配置归一化为 auto / none / 显式列表。 */
export function normalizeHarnessMode(value) {
  if (value == null || value === "" || value === "auto") return { mode: "auto" };
  if (value === false || value === "none") return { mode: "none" };
  const raw = Array.isArray(value) ? value : String(value).split(",");
  const tools = raw.map((item) => String(item).trim()).filter((item) => KNOWN.has(item));
  return tools.length === 0 ? { mode: "none" } : { mode: "list", tools };
}

/** 取配置与模型声明能力的交集；web_extractor 依赖 web_search 时一并声明。 */
export function selectHarnessTools(supported, mode) {
  const available = new Set((supported ?? []).filter((item) => KNOWN.has(item)));
  if (mode.mode === "none") return [];
  const selected = mode.mode === "auto"
    ? new Set(available)
    : new Set(mode.tools.filter((item) => available.has(item)));
  if (selected.has("web_extractor") && available.has("web_search")) selected.add("web_search");
  return HARNESS_TOOL_TYPES.filter((item) => selected.has(item));
}

function clip(value, max = 600) {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function stringArray(value) {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

/** 将服务端工具活动渲染为可持久化、可在 DSH UI 看见的简洁 Markdown。 */
export function formatHarnessActivity(activity) {
  if (!Array.isArray(activity) || activity.length === 0) return "";
  const parts = [];
  for (const entry of activity) {
    const data = entry.data && typeof entry.data === "object" ? entry.data : {};
    const action = data.action && typeof data.action === "object" ? data.action : {};
    switch (entry.type) {
      case "web_search_call": {
        const query = typeof action.query === "string" ? action.query : stringArray(action.queries).join("、");
        parts.push(`[内置工具：联网搜索]${query ? ` ${clip(query, 200)}` : ""}（${data.status ?? "completed"}）`);
        break;
      }
      case "code_interpreter_call": {
        const lines = ["[内置工具：代码解释器] 已执行"];
        if (typeof data.code === "string" && data.code.trim()) lines.push(`\`\`\`python\n${clip(data.code)}\n\`\`\``);
        const logs = (Array.isArray(data.outputs) ? data.outputs : [])
          .filter((item) => item && typeof item === "object" && item.type === "logs")
          .map((item) => clip(item.logs))
          .filter(Boolean);
        if (logs.length) lines.push(logs.join("\n"));
        parts.push(lines.join("\n"));
        break;
      }
      case "web_extractor_call": {
        const lines = [`[内置工具：网页抓取]${data.goal ? ` ${clip(data.goal, 200)}` : ""}`];
        lines.push(...stringArray(data.urls).map((url) => `- ${url}`));
        parts.push(lines.join("\n"));
        break;
      }
      default:
        parts.push(`[内置工具：${entry.type}] 已调用`);
    }
  }
  return `\n\n---\n${parts.join("\n\n")}`;
}

export function describeHarnessTools(tools) {
  if (!tools?.length) return "未启用服务端内置工具（DSH 本地工具仍可用）";
  return tools.map((tool) => HARNESS_TOOL_LABELS[tool] ?? tool).join("、");
}

/** Resolve DSH's shared effort ids to the selected model's contract. */
export function resolveReasoningEffort(options, model, fallbackEffort) {
  if (!model.reasoning) return undefined;
  const requested = options.reasoningEffort ?? model.defaultReasoningEffort ?? fallbackEffort;
  if (requested === undefined) return undefined;
  if (requested === "off") {
    if (model.rejectedReasoningEfforts?.includes("off")) {
      throw new LlmError(`模型 ${model.id} 不支持关闭思考；可选 ${model.reasoningEfforts?.join(" / ")}`, "UNSUPPORTED_OPTION");
    }
    return "off";
  }
  const effort = model.reasoningAliases?.[requested] ?? requested;
  if (model.rejectedReasoningEfforts?.includes(requested)
    || (model.reasoningEfforts?.length && !model.reasoningEfforts.includes(effort))) {
    throw new LlmError(`模型 ${model.id} 不支持推理档位 ${requested}；请选择 ${model.reasoningEfforts?.join(" / ") ?? "模型支持的档位"}`, "UNSUPPORTED_OPTION");
  }
  return String(effort);
}

/**
 * DSH 本地工具中与「服务端内置工具」同能力、会被插件的 harness 声明顶掉的函数名。
 *
 * 背景：Ark/Qwen 的 Responses 网关不允许服务端内置工具和同名自定义函数同时声明
 * （见 buildRequestBody 里的注释）；一旦两者共存，网关会让模型以 function_call
 * 形式调用本地 schema，而服务端 harness 不执行。因此声明内置工具时必须剔除同名
 * 本地函数。但「剔除」只是让模型改用服务端版本，本地工具本身依然可用——这里
 * 记录能力 → 本地工具名的映射，用于在权益耗尽时把能力交还给 DSH 本地工具。
 */
export const LOCAL_TOOL_FOR_CAPABILITY = Object.freeze({
  web_search: "web_search",
  web_extractor: "web_fetch",
  code_interpreter: null, // DSH 没有等价本地工具，交还后能力就是不提供
});

/**
 * 由「本次真正能声明的内置工具」推导出必须从函数声明里剔除的名字。
 *
 * 与服务端内置工具同名的本地函数必须让位（网关约束）；不存在的名字自然无影响。
 * 返回的集合可直接用于过滤 options.tools。
 *
 * @param builtins - 本次请求实际声明的内置工具类型（已按权益过滤过）。
 * @param availableFunctions - 本次请求里 DSH 提供的本地函数名。
 * @returns 需要从函数声明中移除的名字。
 */
export function shadowedFunctionNames(builtins, availableFunctions) {
  const declared = new Set(builtins ?? []);
  const present = new Set((availableFunctions ?? []).map((name) => String(name)));
  const shadowed = new Set();
  for (const [capability, localName] of Object.entries(LOCAL_TOOL_FOR_CAPABILITY)) {
    if (!localName || !declared.has(capability)) continue;
    if (present.has(localName)) shadowed.add(localName);
  }
  // 同名同能力的内置工具（web_search）无论映射表怎么写都必须让位。
  for (const capability of declared) if (present.has(capability)) shadowed.add(String(capability));
  return shadowed;
}
