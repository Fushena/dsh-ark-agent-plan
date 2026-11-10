import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import builtin from "./builtin-catalog.json" with { type: "json" };
import { tryResolveApiKey } from "./apikey.js";

/**
 * Agent Plan 的全量模型发现。
 *
 * 实测结论（2026-11-05，火山方舟 cn-beijing）：
 * 1. Agent Plan 没有 /models 列表端点 —— 所有候选路径返回 404。
 * 2. Plan Key 不能调用标准方舟 v3 接口（401），所以拿不到「账号已开通模型」列表。
 * 3. 探测法（POST /responses 只带 model）对「胡编的名字」返回 404 UnsupportedModel，
 *    对「网关认识的名字」返回 400 MissingParameter。所以探测能判定「这个名字网关认不认识」。
 * 4. 但网关对未知变体做模糊回退：glm-5-2 -> glm-5.3，doubao-seed-2-1-turbo -> ...pro。
 *    因此候选池必须来自权威清单，不能靠猜名字枚举（猜出来的会被静默回退，显示成假模型）。
 *
 * 于是「动态获取全部可用模型」= 抓官方模型清单（权威候选池）+ 并发零 token 探测（可用性过滤）。
 * 官方清单抓取失败时退回内置快照，绝不失活。
 */

const DEFAULT_DOC_SOURCES = Object.freeze([
  "https://docs.volcengine.com/docs/ark/model-list?lang=zh",
  "https://www.volcengine.com/docs/82379/1330310",
]);

/** 非对话模型：视频/图片/3D/向量/语音等，不注册到模型选择器。 */
const NON_CHAT_PATTERNS = [
  /seedance/i, /seedream/i, /seed3d/i, /embedding/i,
  /\b(asr|tts)\b/i, /-vision\.png$/i, /pricing/i, /agreement/i,
  /assistant/i, /harness/i, /-docs?$/i, /^claude-code$/i,
];

/** 文档页里混入的导航/协议名，不是模型。 */
const NOISE = new Set([
  "deepseek-v4-1-flash", "deepseek-v4-1-flash-economy", "deepseek-v4-pro-ga",
  "deepseek-v4-flash-ga", "doubao-seed-2-1-pro", "doubao-seed-2-1-lite",
  "doubao-seed-2-1-turbo", "doubao-seed-2-0-pro", "doubao-seed-2-0-lite",
  "doubao-seed-2-0-mini", "doubao-seed-2-0-code", "doubao-seed-character",
  "doubao-seed-translation", "doubao-seed3d-2-0", "kimi-k3-1-pro",
  "glm-5-3-flash", "glm-5-2",
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function isNonChat(id) {
  return NON_CHAT_PATTERNS.some((pattern) => pattern.test(id));
}

/** 从官方文档 HTML 中提取模型 ID（含别名与带日期版本）。 */
export function extractModelIds(html) {
  const text = String(html ?? "");
  const found = text.match(/\b(?:deepseek|doubao|glm|kimi|minimax|qwen|claude)-[a-z0-9][a-z0-9.\-]{2,55}\b/gi) ?? [];
  const ids = new Set();
  for (const raw of found) {
    const id = raw.toLowerCase();
    if (isNonChat(id)) continue;
    ids.add(id);
  }
  return [...ids];
}

/**
 * 把两种写法归一到同一个模型：
 *   deepseek-v4.1-flash  ≡  deepseek-v4-1-flash-261017
 *   glm-5.3-flash        ≡  glm-5-3-flash-260828
 * 做法：去掉日期后缀 → 把「点分版本」和「连字符分版本」统一成同一种键。
 */
function modelKey(id) {
  // 去掉日期后缀（-261017 / -260828）；再去掉 GA 标记（-ga）。
  const base = id.replace(/-\d{6}$/, "").replace(/-ga$/, "");
  // 点分版本一律归一成连字符：v4.1→v4-1、2.1→2-1、5.3→5-3。
  return base.replace(/(\d)\.(\d)/g, "$1-$2");
}

/**
 * 每个模型只保留一个代表 ID。优先无日期的友好别名（deepseek-v4.1-flash），
 * 因为它是火山官方文档推荐写法、且会跟随最新部署；没有别名时用带日期的真实 ID。
 */
function preferCanonical(ids) {
  const groups = new Map();
  for (const id of ids) {
    const key = modelKey(id);
    const group = groups.get(key) ?? [];
    group.push(id);
    groups.set(key, group);
  }
  const picked = [];
  for (const group of groups.values()) {
    const friendly = group.filter((id) => !/-\d{6}$/.test(id));
    picked.push(friendly[0] ?? group[0]);
  }
  return picked;
}

const BRAND_LABEL = {
  deepseek: "DeepSeek", doubao: "Doubao", glm: "GLM", kimi: "Kimi",
  minimax: "MiniMax", qwen: "Qwen", claude: "Claude",
};
const TIER_LABEL = {
  pro: "Pro", max: "Max", air: "Air", lite: "Lite", mini: "Mini",
  flash: "Flash", turbo: "Turbo", economy: "Economy", evolving: "Evolving",
  code: "Code", thinking: "Thinking", vision: "Vision", ga: "GA",
};

/**
 * 由模型 ID 生成人类可读名称，并把同族模型统一成一种格式：
 *   glm-5-3-flash-260828 → "GLM-5.3 Flash"（与 glm-5.3 → "GLM-5.3" 同格式）
 *   kimi-k3-1-pro        → "Kimi-K3.1 Pro"
 *   doubao-seed-2-1-lite → "Doubao Seed 2.1 Lite"
 *   deepseek-v4-1-flash  → "DeepSeek-V4.1 Flash"
 */
function displayName(id) {
  const base = id.replace(/-\d{6}$/, "");
  const tokens = base.split("-");
  const brand = BRAND_LABEL[tokens[0]] ?? tokens[0].charAt(0).toUpperCase() + tokens[0].slice(1);
  const rest = tokens.slice(1);

  const parts = [];
  let i = 0;
  while (i < rest.length) {
    const token = rest[i];

    // V4 / V4-1 → V4.1
    if (/^v\d+$/i.test(token)) {
      let version = token.toUpperCase();
      if (/^\d+$/.test(rest[i + 1] ?? "")) { version += `.${rest[i + 1]}`; i += 2; } else i += 1;
      parts.push(version);
      continue;
    }

    // K3 / M3 这类字母+数字当作版本号（Kimi、MiniMax 写法）
    if (/^[km]\d+$/i.test(token)) {
      parts.push(token.toUpperCase());
      i += 1;
      continue;
    }

    // 纯数字：紧跟在 K3 后面则是次版本（K3-1 → K3.1）；否则是版本号
    if (/^\d+$/.test(token)) {
      const prev = parts[parts.length - 1];
      if (prev && /^[KM]\d+$/.test(prev)) {
        parts[parts.length - 1] = `${prev}.${token}`;
        i += 1;
        continue;
      }
      let version = token;
      if (/^\d+$/.test(rest[i + 1] ?? "")) { version += `.${rest[i + 1]}`; i += 2; } else i += 1;
      parts.push(version);
      continue;
    }

    parts.push(TIER_LABEL[token] ?? token.charAt(0).toUpperCase() + token.slice(1));
    i += 1;
  }

  // 品牌词（如 seed）在版本前时用空格：Doubao Seed 2.1 Pro
  const versionAt = parts.findIndex((part) => /^\d/.test(part) || /^V\d/.test(part) || /^[KM]\d/.test(part));
  if (versionAt > 0) {
    return `${brand} ${parts.slice(0, versionAt).join(" ")} ${parts.slice(versionAt).join(" ")}`.replace(/\s+/g, " ").trim();
  }
  const joined = parts.join(" ");
  if (!/\d/.test(joined)) return `${brand} ${joined}`.trim();
  // 只有「V4.1 / 5.3」这种纯数字版本用连字符（DeepSeek-V4.1、GLM-5.3）；
  // K3 / M3 这类字母版本沿用空格（Kimi K3、MiniMax M3），与同族其它成员一致。
  const first = parts[0] ?? "";
  const useHyphen = /^V\d/.test(first) || /^\d/.test(first);
  return (useHyphen ? `${brand}-${joined}` : `${brand} ${joined}`).replace(/\s+/g, " ").trim();
}

const FAMILY = [
  { test: /^deepseek/i, order: 0, key: "deepseek", brand: "DeepSeek", transport: "responses", reasoning: true, efforts: ["off", "low", "high", "max"], ctx: 1048576, max: 384000, input: ["text"], harness: ["web_search", "code_interpreter", "web_extractor"] },
  { test: /^doubao/i, order: 1, key: "doubao", brand: "豆包", transport: "responses", reasoning: true, efforts: ["off", "low", "high", "max"], ctx: 262144, max: 256000, input: ["text", "image"], harness: ["web_search"] },
  { test: /^glm/i, order: 2, key: "glm", brand: "智谱", transport: "responses", reasoning: true, efforts: ["low", "high", "max"], rejectsOff: true, ctx: 1048576, max: 128000, input: ["text"], harness: ["web_search"] },
  { test: /^kimi/i, order: 3, key: "kimi", brand: "月之暗面", transport: "responses", reasoning: true, efforts: ["low", "high", "max"], rejectsOff: true, ctx: 1048576, max: 128000, input: ["text", "image"], harness: ["web_search"] },
  { test: /^minimax/i, order: 4, key: "minimax", brand: "MiniMax", transport: "responses", reasoning: true, efforts: ["off", "low", "high", "max"], ctx: 1048576, max: 128000, input: ["text", "image"], harness: ["web_search"] },
  { test: /^qwen/i, order: 5, key: "qwen", brand: "千问", transport: "responses", reasoning: true, efforts: ["off", "low", "high", "max"], ctx: 1048576, max: 65536, input: ["text", "image"], harness: ["web_search"] },
];

/**
 * 从模型 ID 里解析 版本号 与 发布日期，用于同族内排序。
 *   deepseek-v4-1-flash-261017 → version [4,1], date 261017
 *   glm-5-3-flash-260828       → version [5,3], date 260828
 *   kimi-k3                    → version [3]（k3 视为 3）
 */
// 无版本号的特殊/新发布模型应排在同族最上方。
const SPECIAL_LATEST = /evolving|latest|preview|experimental/i;

function versionParts(id) {
  if (SPECIAL_LATEST.test(id)) return [99, 99]; // 特殊模型视为最新
  const base = id.replace(/-\d{6}$/, "");
  const tokens = base.split("-");
  const nums = [];
  for (const token of tokens) {
    if (/^v?\d+$/.test(token)) nums.push(Number(token.replace(/^v$/, "")));
    else if (/^v?\d+\.\d+$/.test(token)) nums.push(...token.replace(/^v/, "").split(".").map(Number));
    else if (/^[km]\d+(?:\.\d+)?$/i.test(token)) nums.push(...token.slice(1).split(".").map(Number));
  }
  return nums.length ? nums : [0];
}

function releaseDate(id) {
  const m = /-(\d{6})$/.exec(id);
  return m ? Number(m[1]) : 0;
}

/** 比较两个数字数组（前者大者为新）。 */
function compareVersions(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return y - x; // 版本号大的排前面
  }
  return 0;
}

/** 同族内的层级排序：pro/max > 标准 > turbo/flash > lite/air > mini/economy。 */
function tierRank(id) {
  if (/economy/i.test(id)) return 90;   // 经济版垫底
  if (/\bmini\b|-mini/i.test(id)) return 80;
  if (/\blite\b|-lite|\bair\b|-air/i.test(id)) return 70;
  if (/turbo/i.test(id)) return 60;
  if (/flash/i.test(id)) return 50;
  if (/\bpro\b|-pro\b|\bmax\b|-max/i.test(id)) return 10;
  return 40; // 标准版 / 无后缀
}

/**
 * 列表排序规则（用户要求）：
 *   1. 同品牌（模型家族）聚在一起 —— DeepSeek / 豆包 / 智谱 / 月之暗面 …
 *   2. 同家族内，新版本排在上 —— v4.1 在 v4 之上，K3.1 在 K3 之上，2.1 在 2.0 之上
 *   3. 同版本内按发布日期新→旧，再按层级（pro > 标准 > flash > lite > mini > economy）
 * 返回新数组，不修改入参。
 */
export function sortModels(models) {
  return [...models].sort((a, b) => {
    const familyA = a.familyOrder ?? 9;
    const familyB = b.familyOrder ?? 9;
    if (familyA !== familyB) return familyA - familyB;

    // 新版本在上（evolving 之类无版本号的特殊模型视为最新）
    const versionDiff = compareVersions(versionParts(a.id), versionParts(b.id));
    if (versionDiff !== 0) return versionDiff;

    // 同版本：发布日期新者在上
    const dateA = releaseDate(a.id);
    const dateB = releaseDate(b.id);
    if (dateA !== dateB) return dateB - dateA;

    // 同日期：层级高者在上
    const tierDiff = tierRank(a.id) - tierRank(b.id);
    if (tierDiff !== 0) return tierDiff;

    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** 用家族推断给动态发现的模型补齐规格；内置快照已有精确规格时优先用它。 */
function describeModel(id, known) {
  const family = FAMILY.find((entry) => entry.test.test(id));
  const reasoningAliases = { minimal: "low", medium: "high", xhigh: "max" };
  const inferred = {
    id,
    name: displayName(id),
    transport: family?.transport ?? "responses",
    reasoning: family?.reasoning ?? true,
    reasoningEfforts: family?.efforts ?? ["low", "high", "max"],
    rejectedReasoningEfforts: family?.rejectsOff ? ["off"] : undefined,
    reasoningAliases,
    input: family?.input ?? ["text"],
    contextWindow: family?.ctx ?? 262144,
    maxTokens: family?.max ?? 32768,
    harnessTools: family?.harness ?? [],
    brand: family?.brand ?? "第三方",
    familyOrder: family?.order ?? 9,
    familyKey: family?.key ?? (id.split("-")[0] ?? "zzz"),
    discovered: true,
  };
  return known ? { ...inferred, ...known, id, name: known.name ?? inferred.name } : inferred;
}

/**
 * 零 token 探测：POST /responses 只带 model 不带 input。
 * 404 UnsupportedModel（或本就不认识）= 不可用；400 MissingParameter = 网关认识。
 *
 * 三态返回（这个「null」第三态是必需的）：
 *   true  → 网关明确认识这个名字（400 MissingParameter 或 2xx）
 *   false → 网关明确不认识（404 / UnsupportedModel）
 *   null  → 结果不可判读（401/403/408/429/5xx、网络异常）
 *
 * 为什么不能像以前那样「其余一律 true」：Key 失效（401）、限流（429）、网关 5xx
 * 时，每个候选都会收到同样的错误响应，而旧逻辑把它当成「可用」，于是整份文档
 * 候选被宣布存活并发布进模型选择器（alive 全真），还会白跑一轮身份校验请求。
 * 不可判读的候选一律不进目录，宁可用上一份已验证的目录。
 */
async function probeModel(fetchImpl, url, key, modelId, signal) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { ...attributionHeaders(), Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      signal,
    });
  } catch {
    return null;
  }
  try {
    const text = await response.text().catch(() => "");
    if (response.status === 404 || /UnsupportedModel/i.test(text)) return false;
    if (response.status === 400) return /MissingParameter/i.test(text);
    if (response.ok) return true;
    // 401/403/408/429/5xx（以及其它未知状态）：探测本身没有结论 ——
    // 凭据失效/限流/网关故障时每个候选都收到同样的错误，绝不能当成「模型可用」。
    return null;
  } finally {
    try { await response.body?.cancel?.(); } catch { /* already drained */ }
  }
}

/**
 * 身份校验：探测只能证明「网关认识这个名字」，但网关对未知变体做模糊回退
 * （实测 glm-5-2-260617 → glm-5.3、doubao-seed-2-1-turbo → ...pro）。
 * 因此对探测通过的候选再做一次极小成本调用（input 极短、max_output_tokens=1），
 * 比对响应里的 served model 是否与候选 ID 同族：
 *   同族 → 真实独立模型，保留
 *   跨族/降级到别的系列 → 网关瞎猜，剔除
 * 一次约 14 token；只在目录刷新时执行，并缓存结果避免重复扣费。
 */
async function verifyIdentity(fetchImpl, url, key, modelId, signal) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: { ...attributionHeaders(), Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, input: "hi", max_output_tokens: 1 }),
      signal,
    });
  } catch {
    return { ok: true, served: null }; // 网络问题不判定为假模型
  }
  try {
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      // 404/UnsupportedModel：网关确实不认识这个名字 —— 剔除。
      if (response.status === 404 || /UnsupportedModel/i.test(text)) return { ok: false, served: null };
      // 401/403/408/429/5xx：凭据失效/限流/网关故障，问题不在「模型是否存在」——
      // 保留，避免把一次限流误判成假模型，整份目录被清空。
      return { ok: true, served: null };
    }
    const data = await response.json().catch(() => null);
    const served = String(data?.model ?? "");
    if (!served) return { ok: true, served: null };
    return { ok: servedMatches(modelId, served), served };
  } finally {
    try { await response.body?.cancel?.(); } catch { /* already consumed */ }
  }
}

/** 判断 served 回显是否确实是候选 ID 对应的模型（允许版本点号/连字符差异）。 */
function servedMatches(candidate, served) {
  const norm = (id) => id.toLowerCase().replace(/-\d{6}$/, "").replace(/(\d)\.(\d)/g, "$1-$2");
  const c = norm(candidate);
  const servedNorm = norm(served);
  // 完全一致，或候选是 served 的前缀（别名 → 带日期版本）
  if (c === servedNorm || servedNorm.startsWith(c) || c.startsWith(servedNorm)) return true;
  // 允许「候选省略尾部系列词」的情况，如 glm-5.3 vs glm-5.3-flash 不算匹配
  return false;
}

async function pool(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

const BASE = (() => {
  const snapshot = builtin;
  if (!Array.isArray(snapshot?.models) || snapshot.models.length < 2) {
    throw new Error("内置模型目录至少需要两个模型");
  }
  return deepFreeze(snapshot);
})();

/**
 * 动态模型目录：
 *   权威候选池 = 内置快照 ∪ 官方文档抓取 ∪ 用户配置追加
 *   可用集     = 并发零 token 探测通过的名字
 *   最终目录   = 可用集（内置快照有精确规格的沿用，新发现的按家族推断）
 */
export class DynamicCatalog {
  #models;
  #fetch;
  #probeUrl;
  #ctx;
  #apiKeyCandidates;
  #pluginName;
  #overrides;
  #excludes;
  #logger;
  #docSources;
  #extraCandidates;
  source = "builtin";
  syncedAt = null;
  lastError = null;
  docModelCount = 0;
  /** 身份校验缓存：候选 ID → { ok, served, at }，避免重复扣费。 */
  #verified = new Map();
  #verifyTtlMs = 6 * 60 * 60 * 1000;

  constructor({ ctx, probeUrl, apiKeyCandidates, pluginName, overrides = [], excludes = [], fetchImpl = globalThis.fetch, logger, docSources = DEFAULT_DOC_SOURCES, extraCandidates = [] }) {
    this.#ctx = ctx;
    this.#probeUrl = probeUrl;
    this.#apiKeyCandidates = apiKeyCandidates;
    this.#pluginName = pluginName;
    this.#overrides = overrides;
    this.#excludes = excludes;
    this.#fetch = fetchImpl;
    this.#logger = logger;
    this.#docSources = docSources;
    this.#extraCandidates = extraCandidates;
    const initial = BASE.models.map((model) => {
      const family = FAMILY.find((entry) => entry.test.test(model.id));
      return {
        ...model,
        discovered: false,
        brand: model.brand ?? family?.brand ?? "第三方",
        familyOrder: family?.order ?? 9,
        familyKey: family?.key ?? (model.id.split("-")[0] ?? "zzz"),
      };
    });
    // 初始快照同样要应用 excludes/overrides：首次 refresh 若失败（无 Key、离线、
    // 探测无结论），用户配置的排除与覆盖也必须立刻生效 —— 旧代码只在 refresh()
    // 里应用，于是「refreshed 之前」的模型选择器会漏掉排除项、显示未覆盖的名字。
    this.#models = deepFreeze(sortModels(this.#applyConfig(initial)));
  }

  /**
   * 应用用户配置：excludes 过滤 + overrides 浅合并。
   *
   * 构造函数与 refresh() **共用这一份实现**，不能各写一套规则 ——
   * 两份规则漂移时会出现「首次失败后退回内置快照，排除项又冒出来」这种
   * 难查的行为差异。返回新数组，不修改入参。
   */
  #applyConfig(models) {
    const kept = models.filter((model) => !this.#excludes.some((pattern) => model.id === pattern || model.id.startsWith(pattern)));
    for (const override of this.#overrides) {
      if (!override?.id) continue;
      const at = kept.findIndex((model) => model.id === override.id);
      if (at >= 0) kept[at] = { ...kept[at], ...override };
    }
    return kept;
  }

  snapshot() {
    return {
      version: 1, source: this.source, syncedAt: this.syncedAt,
      models: this.#models, lastError: this.lastError, docModelCount: this.docModelCount,
    };
  }

  find(modelId) {
    return this.#models.find((model) => model.id === modelId);
  }

  /** 抓官方模型清单页（权威候选池）。失败返回空数组，不影响主流程。 */
  async #fetchDocCandidates(signal) {
    const collected = new Set();
    for (const url of this.#docSources) {
      try {
        const response = await this.#fetch(url, {
          headers: { "user-agent": "Mozilla/5.0 (compatible; dsh-ark-agent-plan)" },
          signal,
        });
        if (!response.ok) continue;
        const html = await response.text();
        const ids = extractModelIds(html);
        for (const id of ids) collected.add(id);
        if (collected.size > 0) break;
      } catch {
        // 文档站不可达时继续用内置快照
      }
    }
    return preferCanonical([...collected].filter((id) => !NOISE.has(id)));
  }

  /**
   * 刷新目录。返回 true 表示目录发生变化。
   * 无 Key / 全部探测失败时保留上一份目录。
   */
  async refresh(signal) {
    const key = await tryResolveApiKey(this.#ctx, this.#apiKeyCandidates, this.#pluginName);
    if (!key) { this.lastError = "missing-credential"; return false; }

    const docCandidates = await this.#fetchDocCandidates(signal);
    this.docModelCount = docCandidates.length;

    const known = new Map(BASE.models.map((model) => [model.id, model]));
    // 内置快照优先（规格最精确），文档来的同族日期 ID 归并掉，避免重复条目。
    const seenKeys = new Set(BASE.models.map((model) => modelKey(model.id)));
    const candidates = [...BASE.models.map((model) => model.id)];
    for (const id of [...docCandidates, ...this.#extraCandidates, ...this.#overrides.map((o) => o?.id).filter(Boolean)]) {
      const key = modelKey(id);
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      candidates.push(id);
    }

    const verdicts = await pool(candidates, 8, (id) => probeModel(this.#fetch, this.#probeUrl, key, id, signal));
    const alive = [];
    const unknown = [];
    candidates.forEach((id, index) => {
      if (verdicts[index] === true) alive.push(id);
      else if (verdicts[index] === null) unknown.push(id);
    });
    // 探测没有任何一个候选给出肯定回答时，**整份候选（含 unknown）都不许发布**：
    // Key 失效/限流/网关 5xx 会让所有候选同时变成 unknown，旧逻辑只挡了
    // 「alive 与 unknown 都为空」这一种情况，于是这种「全军无结论」会被当成
    // 整份文档候选存活、覆盖掉已验证的旧目录（模型选择器出现一批假模型）。
    // 这里收紧为「一个 alive 都没有 = 刷新失败，保留旧目录」，
    // 有了 alive 才谈得上用 unknown 兜底（新发现的模型探测可能无结论）。
    if (alive.length === 0) {
      this.lastError = unknown.length > 0
        ? `探测无结论（${unknown.length} 个候选全部无法判定，可能是凭据失效、限流或网关故障）`
        : "探测全部失败";
      return false;
    }

    // 二级校验：探测通过 ≠ 真实模型（网关会模糊回退到别的模型）。
    // 用极小成本调用拿 served 回显，剔除「网关瞎猜」的候选。
    const now = Date.now();
    const identity = await pool(alive, 8, async (id) => {
      const cached = this.#verified.get(id);
      if (cached && now - cached.at < this.#verifyTtlMs) return { id, ...cached };
      const result = await verifyIdentity(this.#fetch, this.#probeUrl, key, id, signal);
      this.#verified.set(id, { ...result, at: now });
      return { id, ...result };
    });
    const rejected = [];
    const confirmed = identity.filter((entry) => {
      if (entry.ok) return true;
      rejected.push(`${entry.id}→${entry.served ?? "?"}`);
      return false;
    }).map((entry) => entry.id);

    // 新增模型按家族推断；内置快照里的精确规格优先。
    // excludes/overrides 统一走 #applyConfig，与构造函数保持同一份规则。
    const models = sortModels(this.#applyConfig([...confirmed, ...unknown].map((id) => describeModel(id, known.get(id)))));

    const next = deepFreeze(models);
    const signature = (list) => list.map((model) => model.id).join(",");
    const changed = signature(next) !== signature(this.#models);
    this.#models = next;
    this.source = docCandidates.length > 0 ? "docs+probe" : "probe";
    this.syncedAt = new Date().toISOString();
    this.lastError = null;
    this.#logger?.info?.(
      `${this.#pluginName}: 模型目录已刷新 → ${models.length} 个可用模型` +
      `（官方清单候选 ${docCandidates.length}，探测存活 ${alive.length}，身份校验剔除 ${rejected.length}，不确定 ${unknown.length}）`
      + (rejected.length ? `；剔除的回退模型：${rejected.join("、")}` : ""),
    );
    return changed;
  }
}

export { BASE as BUILTIN_CATALOG, DEFAULT_DOC_SOURCES };
