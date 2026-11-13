import { attributionHeaders } from "@deepseek-ai/dsh-llm";
import builtin from "./builtin-catalog.json" with { type: "json" };
import { tryResolveApiKey } from "./apikey.js";
import { displayName, sortModels, FAMILY_DISPLAY } from "./model-display.js";

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

/** 键排序的规范化 JSON：同内容同签名，与对象键插入顺序无关（signature 用，审计#10）。 */
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
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

// 展示名 / 排序 / 家族归属的唯一规则源：lib/model-display.js
// （与 qwen-token-plan-full 的同名文件逐字节一致，双方测试互相校验防漂移）。
export { displayName, sortModels } from "./model-display.js";

/** 家族规格推断表；显示字段（order/key/brand）来自 model-display.js 的 FAMILY_DISPLAY。 */
const FAMILY_SPEC = {
  deepseek: { transport: "responses", reasoning: true, efforts: ["off", "low", "high", "max"], ctx: 1048576, max: 384000, input: ["text"], harness: ["web_search", "code_interpreter", "web_extractor"] },
  doubao: { transport: "responses", reasoning: true, efforts: ["off", "low", "high", "max"], ctx: 262144, max: 256000, input: ["text", "image"], harness: ["web_search"] },
  glm: { transport: "responses", reasoning: true, efforts: ["low", "high", "max"], rejectsOff: true, ctx: 1048576, max: 128000, input: ["text"], harness: ["web_search"] },
  kimi: { transport: "responses", reasoning: true, efforts: ["low", "high", "max"], rejectsOff: true, ctx: 1048576, max: 128000, input: ["text", "image"], harness: ["web_search"] },
  minimax: { transport: "responses", reasoning: true, efforts: ["off", "low", "high", "max"], ctx: 1048576, max: 128000, input: ["text", "image"], harness: ["web_search"] },
  qwen: { transport: "responses", reasoning: true, efforts: ["off", "low", "high", "max"], ctx: 1048576, max: 65536, input: ["text", "image"], harness: ["web_search"] },
};
const FAMILY = FAMILY_DISPLAY.map((entry) => ({ ...entry, ...FAMILY_SPEC[entry.key] }));


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
  return known ? { ...inferred, ...known, id, name: displayName(id) } : inferred;
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
  const norm = (id) => id.toLowerCase().replace(/-\d{6}$/, "").replace(/-ga$/, "").replace(/(\d)\.(\d)/g, "$1-$2");
  const c = norm(candidate);
  const servedNorm = norm(served);
  if (c === servedNorm) return true;
  // 前缀匹配必须按段对齐（审计#3，2026-11-13）：旧实现裸 startsWith 会把
  // glm-5.3-flash→glm-5.3、kimi-k3→kimi-k3-1-pro 这类**不同模型**放行。
  // 唯一合法的前缀形态是「别名 → 纯数字版本尾段」（日期后缀已在 norm 去掉）；
  // 尾段含任何非数字段（flash/pro/code…）都说明是另一个模型，剔除。
  const [short, long] = c.length <= servedNorm.length ? [c, servedNorm] : [servedNorm, c];
  if (!long.startsWith(`${short}-`)) return false;
  const tail = long.slice(short.length + 1);
  return /^\d+(?:-\d+)*$/.test(tail);
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
  // 展示名一律用共享规则现算：内置 JSON 的旧 name 写法不再生效。
  return deepFreeze({ ...snapshot, models: snapshot.models.map((model) => ({ ...model, name: displayName(model.id) })) });
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
        // 展示名一律现算：内置 JSON 里的旧 name 不再生效，两个插件同名模型同写法。
        name: displayName(model.id),
        discovered: false,
        brand: family?.brand ?? model.brand ?? "第三方",
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
      // 只缓存确定性结论（审计#7，2026-11-13）：401/429/5xx/网络异常/200 无回显
      // 返回 {ok:true, served:null} 是**瞬时故障**，缓存 6h 会把「暂时没验出来」
      // 固化成「已验证」，网关恢复后假模型再也验不掉。served:null 一律不缓存，
      // 下次刷新重试；明确身份不符（ok:false）与已确认 served 才进缓存。
      if (result.served !== null || result.ok === false) this.#verified.set(id, { ...result, at: now });
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
    // signature 必须覆盖**所有影响 adapter 的字段**（审计#10，2026-11-13）：
    // 旧实现只拼 id，用户改 override 的 name/transport/reasoning/maxTokens/
    // harnessTools 等规格（id 不变）时 changed 恒 false，adaptersUpdated 不触发、
    // 选择器与运行中的 adapter 停留在旧规格。这里对每个模型做键排序的规范化
    // JSON：内容相同则签名相同（无变化刷新仍 changed=false），任一规格字段
    // 变化都会改变签名。键排序保证 override 浅合并导致的键序差异不误报。
    const signature = (list) => list.map((model) => canonicalJson(model)).join("|");
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
