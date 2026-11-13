import { isContextWindowExceededError, isQuotaExceededError } from "@deepseek-ai/dsh-llm";

/** 供应商 HTTP 失败 → DSH LlmFailure code 映射（与 dsh-llm 失败码词表一致）。 */
export function httpFailure(status, text) {
  const lower = String(text ?? "").toLowerCase();
  // 先按 HTTP 状态码分类（审计#6，2026-11-13）：429/5xx 的 body 常带 "quota"
  // 字样（"requests quota exhausted"、"QuotaExceeded"、"quota service
  // unavailable"），旧顺序里 /quota/ 抢在前面，把可重试的限流/网关故障误判成
  // 不可重试的 QUOTA。状态码能确定性质时绝不看 body 关键词。
  if (status === 401) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 408) return "TIMEOUT";
  // 必须用 "SERVER"：dsh-llm 的 DEFAULT_RETRYABLE_CODES 只认这个词，
  // 写成 "SERVER_ERROR" 会让网关 5xx 永远不会被 llm-retry 重试（实测 2026-11-05）。
  if (status >= 500) return "SERVER";
  // 状态码无法判定（2xx/其余 4xx）时才按 body 语义识别额度耗尽。
  // 403 也可能是「套餐额度耗尽」而非鉴权失败：带 quota 语义归 QUOTA，纯 403 才 AUTH。
  if (isQuotaExceededError(lower) || /余额不足|额度耗尽|套餐.*用尽|quota/.test(lower)) return "QUOTA";
  if (status === 403) return "AUTH";
  if (isContextWindowExceededError(lower) || /outofcontext|上下文.*超|超出.*token/.test(lower)) return "CONTEXT_WINDOW_EXCEEDED";
  return "PROVIDER_ERROR";
}

/** 解析 Retry-After（秒数或 HTTP 日期）为毫秒。 */
export function retryAfterMs(headers) {
  const raw = headers?.get?.("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

/** finish.reason.failure 的可序列化形状。 */
export function failure(message, code, status) {
  return { message, code, ...(status ? { status } : {}) };
}
