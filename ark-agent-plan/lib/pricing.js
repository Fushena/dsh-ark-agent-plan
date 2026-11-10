/**
 * Agent Plan 模型的 AFP 计价表（本地记账用）。
 *
 * 背景：额度数据只能从控制台拿（Plan Key 无任何额度端点），同步间隔内
 * 面板数字不会动。本地记账让数字在两次同步之间实时滚动；
 * 每次服务端同步成功会用真实值覆盖，估算漂移自动消除。
 *
 * 单价单位：CNY / 百万 token（来源：火山方舟公开牌价，2026-11 核对）。
 * AFP 与 CNY 等价（控制台显示「1万 AFP」对应 ¥10000 额度）。
 * 价格变动只影响两次同步之间的估算精度，不影响最终显示的准确性。
 */
export const AFP_PRICING = Object.freeze({
  // DeepSeek 系列
  "deepseek-v4.1-flash":           { input: 1,   output: 5,   cacheRead: 0.2 },
  "deepseek-v4.1-flash-economy":   { input: 0.5, output: 2.5, cacheRead: 0.1 },
  "deepseek-v4-pro":               { input: 4,   output: 16,  cacheRead: 0.8 },
  "deepseek-v4-flash":             { input: 1,   output: 4,   cacheRead: 0.2 },
  // GLM 系列
  "glm-5.3":                       { input: 2,   output: 8,   cacheRead: 0.4 },
  "glm-5.3-flash":                 { input: 1,   output: 4,   cacheRead: 0.2 },
  // Kimi 系列
  "kimi-k3":                       { input: 4,   output: 16,  cacheRead: 0.8 },
  "kimi-k3-1-pro":                 { input: 4,   output: 16,  cacheRead: 0.8 },
  "kimi-k2.7-code":                { input: 1,   output: 4,   cacheRead: 0.2 },
  // 豆包系列
  "doubao-seed-evolving":          { input: 0.9, output: 4.5, cacheRead: 0.18 },
  "doubao-seed-2.1-pro":           { input: 0.8, output: 3.2, cacheRead: 0.16 },
  "doubao-seed-2.1-turbo":         { input: 0.3, output: 1.5, cacheRead: 0.06 },
  "doubao-seed-2.0-mini":          { input: 0.15,output: 0.6,  cacheRead: 0.03 },
  // 兜底：未知模型的保守混合单价
  _default:                        { input: 2,   output: 8,   cacheRead: 0.4 },
});
