#!/usr/bin/env node
// 给 dsh-qwen-token-plan-cn-responses 的冻结模型目录追加经实测验证的新模型。
// 插件 lib/catalog.js 只校验 version===3 / source 固定串 / id 唯一 / input+harnessTools 为数组 /
// transport 只允许 "chat" / reasoning 时 reasoningEfforts 必含 defaultReasoningEffort，不校验 fingerprint。
// 幂等：重复运行以插件当前快照为底，先剔除同名条目再插入。
// 用法: node update-catalog.mjs [--dry]
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGET =
  "/Users/fushe/.dsh/profiles/desktop/node_modules/dsh-qwen-token-plan-cn-responses/lib/catalog.snapshot.json";
const DRY = process.argv.includes("--dry");

// ---- 2026-11-03 实测（token-plan compatible-mode 端点，全部 HTTP 200 除注明） ----
// glm-5.3            chat 端点，enable_thinking:false 被拒（"restricted to True"）→ 档位不含 none；low/high/max 均 200
// deepseek-v4.1-flash      responses 200；图片输入 200；reasoning.effort:"none" 200
// deepseek-v4.1-flash-1017 responses 200（形态跟随 v4.1-flash）
// auto                     responses 200（路由模型，无档位/无内置工具；maxTokens 缺省由 content.js:102 钳到 16384）
// decision-model-preview   responses 400 "Unsupported model" → 不收录
const ADDITIONS = [
  {
    after: "glm-5.2",
    model: {
      id: "glm-5.3",
      brand: "智谱 AI",
      capabilities: "推理模型、文本生成",
      transport: "chat",
      reasoning: true,
      reasoningEfforts: ["low", "high", "max"],
      defaultReasoningEffort: "high",
      acceptedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
      rejectedReasoningEfforts: ["none"],
      reasoningAliases: { minimal: "low", medium: "high", xhigh: "max" },
      input: ["text"],
      contextWindow: 1000000,
      maxTokens: 131072,
      harnessTools: [],
    },
  },
  {
    after: "deepseek-v4-flash-0731",
    model: {
      id: "deepseek-v4.1-flash",
      brand: "DeepSeek",
      capabilities: "推理模型、视觉理解、文本生成",
      reasoning: true,
      reasoningEfforts: ["none", "low", "high", "max"],
      defaultReasoningEffort: "high",
      acceptedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      rejectedReasoningEfforts: [],
      reasoningAliases: { medium: "high", xhigh: "high" },
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 384000,
      harnessTools: [],
    },
  },
  {
    after: "deepseek-v4.1-flash",
    model: {
      id: "deepseek-v4.1-flash-1017",
      brand: "DeepSeek",
      capabilities: "推理模型、视觉理解、文本生成",
      reasoning: true,
      reasoningEfforts: ["none", "low", "high", "max"],
      defaultReasoningEffort: "high",
      acceptedReasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      rejectedReasoningEfforts: [],
      reasoningAliases: { medium: "high", xhigh: "high" },
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 384000,
      harnessTools: [],
    },
  },
  {
    after: null, // 末尾
    model: {
      id: "auto",
      brand: "千问",
      capabilities: "智能路由：按请求自动选择模型、文本生成",
      reasoning: false,
      input: ["text"],
      harnessTools: [],
    },
  },
];

// ---- 复刻插件 lib/catalog.js 的 validate()，写盘前先过一遍 ----
function validate(value) {
  if (value?.version !== 3 || value.source !== "official-docs+verified-probes") {
    throw new Error("bundled Qwen catalog has an unsupported format");
  }
  if (!Array.isArray(value.models) || value.models.length < 2) throw new Error("bundled Qwen catalog is empty");
  const ids = new Set();
  for (const model of value.models) {
    if (!model?.id || ids.has(model.id)) throw new Error("bundled Qwen catalog contains an invalid or duplicate model id");
    ids.add(model.id);
    if (!Array.isArray(model.input) || !Array.isArray(model.harnessTools)) throw new Error(`bundled Qwen catalog model ${model.id} is malformed`);
    if (model.transport !== undefined && model.transport !== "chat") throw new Error(`bundled Qwen catalog model ${model.id} has an invalid transport`);
    if (model.reasoning) {
      if (!Array.isArray(model.reasoningEfforts) || !model.reasoningEfforts.includes(model.defaultReasoningEffort)) {
        throw new Error(`bundled Qwen catalog model ${model.id} has an invalid reasoning profile`);
      }
    }
  }
  return value;
}

const base = JSON.parse(readFileSync(TARGET, "utf8"));
const addIds = new Set(ADDITIONS.map((a) => a.model.id));
let models = base.models.filter((m) => !addIds.has(m.id)); // 幂等：先剔除旧的同名条目

for (const { after, model } of ADDITIONS) {
  const idx = after ? models.findIndex((m) => m.id === after) : models.length - 1;
  models.splice(idx + 1, 0, model);
}

const now = new Date().toISOString();
const out = {
  version: base.version,
  source: base.source,
  syncedAt: now,
  reasoningProbedAt: now,
  models,
  // 运行时不校验；按新 models 重算 sha256，标注本地更新
  fingerprint: createHash("sha256").update(JSON.stringify(models)).digest("hex"),
};

validate(out);
const text = JSON.stringify(out, null, 2) + "\n";

// 首次运行时保留出厂原件
const factoryBackup = join(HERE, "catalog.snapshot.json.factory-backup");
if (!DRY && !existsSync(factoryBackup)) copyFileSync(TARGET, factoryBackup);

writeFileSync(join(HERE, "catalog.snapshot.json"), text);
if (!DRY) writeFileSync(TARGET, text);

console.log(
  `${DRY ? "[dry-run] " : ""}OK: ${models.length} models -> ${models.map((m) => m.id).join(", ")}`
);
console.log(DRY ? "未写入插件目录" : `已写入 ${TARGET}（出厂备份: ${factoryBackup}）`);
