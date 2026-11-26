import { randomUUID } from "node:crypto";
import dns from "node:dns";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { isPrivateHostLiteral, parseIpv4Literal, parseIpv6Literal } from "./content.js";

/**
 * 多模态产物的公共 I/O：按行读响应、下载上游媒体、落进宿主附件库。
 *
 * 三条硬约束（都来自宿主源码，不是猜测）：
 *
 * 1. **附件引用必须是真引用**。宿主 dsh-attachment-local 只认
 *    `/^sha256:[a-f0-9]{64}$/`，读取时还会逐字段核对 mediaType/bytes/width/height，
 *    对不上就抛 ATTACHMENT_CORRUPT；而且 image 块的消费方只会拿
 *    `block.attachment.attachmentId` 去附件库取字节，**没有任何「按 url 下载」的通道**。
 *    所以 `attachmentId: "ark-img-<时间戳>"` 这种自造引用一定坏，必须先落库拿真 ref。
 *
 * 2. **assistant 侧不能产出 image 块**。本插件自己的 Responses 历史转换
 *    （content.js）遇到 assistant image 块直接抛 UNSUPPORTED_CONTENT，
 *    pi-ai / deepseek 的投影层同样拒绝。file 块则会被宿主
 *    `projectFilesToText` 换成「已存到 <路径>，需要时用文件工具读」的文本句柄，
 *    既能进历史又能被 GUI 当文件展示 —— 所以媒体产物一律走 file 块。
 *
 * 3. **取消/断流不能当成功**。宿主的 BlockAssembler 在没有 finish chunk 时
 *    默认 `{kind:"stop"}`，于是「读到一半被掐断」会被持久化成一次正常回答。
 *    这里所有读取路径都在取消时抛 ABORTED、在提前 EOF 时抛 STREAM_CLOSED。
 */

/** 单个媒体产物的字节上限（图片/视频/音频统一，避免把超大响应堆进内存）。 */
export const MEDIA_MAX_BYTES = 64 * 1024 * 1024;

/** 逐行读取响应体的单行上限（32MB），防止无换行持续流撑爆进程内存（OOM）。 */
export const MAX_LINE_BYTES = 32 * 1024 * 1024;

/** Agent Plan 语音合成的专属 HTTP 端点（不是 ark 网关的 /audio/speech）。 */
export const AGENT_PLAN_TTS_URL = "https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional";

/** 语音资源 ID：豆包语音合成 2.0（官方 Agent Plan 文档指定值）。 */
export const TTS_RESOURCE_ID = "seed-tts-2.0";

/** chunked TTS 的成功终止码；没有它就不算合成成功。 */
export const TTS_DONE_CODE = 20000000;

/** 豆包语音合成 2.0 的公版音色（1.0 的 mars 音色在 2.0 资源下不可用）。 */
export const DEFAULT_TTS_SPEAKER = "zh_female_vv_uranus_bigtts";

/**
 * 按行读取响应体，产出一行一行的异步迭代（SSE / NDJSON 共用）。
 *
 * 与旧实现的三处差别：
 * - 分隔用 `/\r\n|\n|\r/`：CRLF 服务器下旧代码的 `split("\n")` 会把 `\r` 留在行尾，
 *   于是 `data === "[DONE]"` 永远不成立、JSON.parse 也可能带上尾部控制字符；
 * - EOF 时把残留 buffer 也当一行产出（最后一行没有换行符是常见情况）；
 * - 取消/异常/提前 break 都在 finally 里 cancel 底层 body，不留悬挂连接。
 *
 * 用异步迭代而不是回调：消费方可以在两行之间做异步工作（下载图片、落附件库）
 * 而不必把结果攒进数组 —— 攒着处理会让上层在「一个 chunk 都没发」的下载期间
 * 触发空闲超时。生成器被 return（上层取消/抛错）时 finally 同样会收尾。
 *
 * @param body - fetch 响应的 ReadableStream。
 * @param signal - 融合信号（外部取消 + 空闲超时）。
 */
export async function* iterateLines(body, signal, maxLineBytes = MAX_LINE_BYTES) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new LlmError("请求已取消", "ABORTED");
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r\n|\n|\r/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.length > maxLineBytes) {
          throw new LlmError(`响应单行超过 ${maxLineBytes} 字节上限，判定协议损坏`, "STREAM_CLOSED");
        }
        yield line;
      }
      if (buffer.length > maxLineBytes) {
        throw new LlmError(`响应单行超过 ${maxLineBytes} 字节仍无换行，判定协议损坏`, "STREAM_CLOSED");
      }
    }
    buffer += decoder.decode();
    if (buffer.length > maxLineBytes) {
      throw new LlmError(`响应单行超过 ${maxLineBytes} 字节上限，判定协议损坏`, "STREAM_CLOSED");
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    // 先 cancel 再 releaseLock：提前 return / abort / 异常都要取消底层 HTTP body，
    // 否则连接挂到 GC（与 qwen 下载闸同写法）。
    try { await reader.cancel().catch(() => {}); } catch { /* already closed */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * 按行读取并逐行交给同步回调；回调返回 false 表示停止读取。
 *
 * 需要在读取过程中累积状态（如语音分片）时用这个；需要在两行之间做异步工作
 * （下载/落库）时直接用 iterateLines。
 *
 * @param body - fetch 响应的 ReadableStream。
 * @param signal - 融合信号（外部取消 + 空闲超时）。
 * @param onLine - 每行回调，返回 false 表示停止读取。
 */
export async function readLines(body, signal, onLine) {
  for await (const line of iterateLines(body, signal)) {
    if (onLine(line) === false) return;
  }
}

/** 去掉 SSE 的 `data:` 前缀；不是 data 行返回 null（event:/id:/注释行都跳过）。 */
export function sseData(line) {
  if (!line.startsWith("data:")) return null;
  return line.slice(5).replace(/^ /, "");
}

/**
 * 上游返回的媒体 URL 安全闸：仅接受 https、无内嵌凭据、非本机/私网字面量。
 * http/其它协议、含 user:pass@、或私网地址一律拒绝，不下载也不作为链接交给 GUI。
 */
export function safeHttpsUrl(raw) {
  try {
    const parsed = new URL(String(raw));
    if (parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    if (isPrivateHostLiteral(parsed.hostname)) return null;
    return parsed.href;
  } catch { return null; }
}

/** 198.18.0.0/15 代理 fake-IP 段（Clash/Surge）；DNS 解析落入该段时放行 + warn。 */
function isBenchmarkIpv4(text) {
  const octets = parseIpv4Literal(String(text ?? ""));
  return !!octets && octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

/**
 * 逐跳 DNS SSRF 校验：解析目标域名的所有 A/AAAA 记录，任一落入私网/本机段即拒。
 * 遵循与 qwen-token-plan-full 相同的代理兼容策略：本地 DNS 解析失败/空结果或落入
 * 代理 fake-IP（198.18.0.0/15）时记 warn 放行交由连接层/代理处理。
 */
async function assertHostDnsSafe(url, logger) {
  const host = url.hostname;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const isLiteral = parseIpv4Literal(bare) !== null || parseIpv6Literal(bare) !== null
    || bare === "localhost" || bare === "localhost.";
  if (isLiteral) return;
  let answers;
  try {
    answers = await dns.promises.lookup(bare, { all: true, verbatim: true });
  } catch (err) {
    logger?.warn?.(`dsh-ark-agent-plan: 媒体下载域名本地 DNS 解析失败（${err?.code ?? "unknown"}），放行交由连接层/代理处理：${host}`);
    return;
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    logger?.warn?.(`dsh-ark-agent-plan: 媒体下载域名无本地 DNS 解析结果，放行交由连接层/代理处理：${host}`);
    return;
  }
  for (const ans of answers) {
    const addr = String(ans?.address ?? "");
    if (isPrivateHostLiteral(addr)) {
      if (isBenchmarkIpv4(addr)) {
        logger?.warn?.(`dsh-ark-agent-plan: 媒体下载域名解析到代理 fake-IP 段（198.18.0.0/15），放行交由代理路由：${host}（${addr}）`);
        continue;
      }
      throw new LlmError(`媒体下载目标地址解析到本机/内网地址（${host}），已拒绝`, "PROVIDER_ERROR");
    }
  }
}

/**
 * 严格 base64 解码。
 *
 * `Buffer.from(x, "base64")` 会静默丢掉非法字符，于是「上游返回了一段 HTML」
 * 也能解出几 KB 垃圾并被当成音频存盘。这里要求字符集合法且长度是 4 的倍数
 * （允许末尾 padding），不合法就抛错。
 */
export function decodeBase64Strict(value, label = "base64") {
  const text = String(value ?? "").replace(/\s+/g, "");
  if (text.length === 0) throw new LlmError(`${label} 为空`, "PROVIDER_ERROR");
  if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new LlmError(`${label} 不是合法的 base64 数据`, "PROVIDER_ERROR");
  }
  const bytes = Buffer.from(text, "base64");
  if (bytes.length === 0) throw new LlmError(`${label} 解码后为空`, "PROVIDER_ERROR");
  return bytes;
}

/** 按魔数判定图片类型（宿主只认 png/jpeg/webp/gif，其它值会走 assertNever）。 */
export function sniffImageMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

/**
 * 按魔数判定媒体类型（音频/视频也认）。
 *
 * 为什么要看字节而不是信 Content-Type：上游（或中间代理）在出错时会回
 * 200 + 一段 JSON/HTML 错误页，把它存成 .mp3/.mp4 等于给用户一个坏文件。
 *
 * @returns {string|null} mediaType，认不出返回 null。
 */
export function sniffMediaType(bytes) {
  const image = sniffImageMediaType(bytes);
  if (image) return image;
  if (bytes.length < 2) return null;
  // MPEG 音频：ID3v2 标签头，或裸帧同步（11 个 1 位）。
  if (bytes.length >= 3 && bytes.toString("ascii", 0, 3) === "ID3") return "audio/mpeg";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (bytes.length < 12) return null;
  const head4 = bytes.toString("ascii", 0, 4);
  // ISO BMFF（mp4/mov）：偏移 4 起是 'ftyp'。
  if (bytes.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
  if (head4 === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE") return "audio/wav";
  if (head4 === "OggS") return "audio/ogg";
  if (head4 === "fLaC") return "audio/flac";
  return null;
}

/** 上游声明的 output_format / URL 后缀 → 扩展名（只用于展示名，落库类型看魔数）。 */
export function mediaExtension(mediaType, fallback = "bin") {
  const map = {
    "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "video/mp4": "mp4",
  };
  return map[mediaType] ?? fallback;
}

/**
 * 读取整个响应体为字节（有上限、可取消）。
 *
 * 上限按**累计字节**判定，超限立刻取消底层流并抛错，不先把超大响应堆进内存。
 */
export async function readAllBytes(body, signal, maxBytes = MEDIA_MAX_BYTES, touch) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new LlmError("请求已取消", "ABORTED");
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      touch?.();
      total += value.byteLength;
      if (total > maxBytes) {
        throw new LlmError(`媒体内容超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, "PROVIDER_ERROR");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel().catch(() => {}); } catch { /* already closed */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return Buffer.concat(chunks, total);
}

/**
 * 下载上游媒体 URL（图片/视频）。
 *
 * 只接受 https；重定向逐跳重新校验（manual 模式，避免 https→http 降级）；
 * 非 2xx 与超限都在 finally 里取消 body，不留悬挂连接。
 */
export async function downloadMedia(fetchImpl, rawUrl, { signal, maxBytes = MEDIA_MAX_BYTES, maxRedirects = 3, touch, logger } = {}) {
  let url = safeHttpsUrl(rawUrl);
  if (!url) throw new LlmError("上游返回的媒体地址不安全（要求 https、无凭据且非私网地址），已拒绝", "PROVIDER_ERROR");
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertHostDnsSafe(new URL(url), logger);
    const response = await fetchImpl(url, { method: "GET", redirect: "manual", ...(signal ? { signal } : {}) });
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      const loc = response.headers?.get?.("location");
      let resolved = null;
      if (loc) {
        try { resolved = new URL(loc, url).href; } catch { resolved = null; }
      }
      const next = safeHttpsUrl(resolved);
      if (!next) throw new LlmError("媒体下载重定向到不安全地址，已拒绝", "PROVIDER_ERROR");
      url = next;
      continue;
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw new LlmError(`媒体下载失败：HTTP ${response.status}`, "PROVIDER_ERROR");
    }
    if (!response.body) throw new LlmError("媒体下载没有响应体", "PROVIDER_ERROR");
    // 下载期间持续续命空闲超时：大视频分片之间有间隔是正常的。
    return await readAllBytes(response.body, signal, maxBytes, touch);
  }
  throw new LlmError("媒体下载重定向次数过多", "PROVIDER_ERROR");
}

/** 本地生成的展示名（时间戳 + 随机后缀；上游数据不参与命名，避免路径穿越）。 */
export function mediaFileName(prefix, extension) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${prefix}-${stamp}-${randomUUID().slice(0, 8)}.${extension}`;
}

/**
 * 把媒体字节落进宿主附件库，返回**真** file 引用。
 *
 * 用 saveFile（逐字节 verbatim）而不是 saveImages：saveImages 会做图片归一化与
 * 尺寸探测，视频/音频过不了；file 引用只需要 {attachmentId,name,bytes}，
 * 且宿主会把 file 块投影成带可读路径的文本句柄，历史与 GUI 两边都能用。
 *
 * @returns 真引用；宿主没有附件服务或后端不支持 verbatim 存储时返回 null
 *          （调用方降级成文本块给出 https 链接，绝不伪造引用）。
 */
export async function storeMediaFile(attachments, bytes, name, logger) {
  if (!attachments || typeof attachments.saveFile !== "function") return null;
  try {
    const ref = await attachments.saveFile({ data: new Uint8Array(bytes), name });
    if (!ref || typeof ref.attachmentId !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId)) {
      logger?.warn?.("dsh-ark-agent-plan: 附件服务返回了非法引用，改用文本链接");
      return null;
    }
    return { attachmentId: ref.attachmentId, name: ref.name ?? name, bytes: ref.bytes ?? bytes.length };
  } catch (error) {
    logger?.warn?.(`dsh-ark-agent-plan: 媒体落库失败（${String(error?.message ?? error).slice(0, 160)}），改用文本链接`);
    return null;
  }
}

/** file 块（宿主会投影成「已存到 <路径>」的文本句柄）。 */
export function fileBlock(index, ref) {
  return { type: "block-end", index, block: { type: "file", attachment: ref } };
}

/** 文本块（一次性内容：block-start + delta + block-end，索引自管）。 */
export function* textBlockChunks(index, text) {
  yield { type: "block-start", index, blockType: "text" };
  yield { type: "text-delta", index, text };
  yield { type: "block-end", index, block: { type: "text", text } };
}

/** 把上游 usage 归一成宿主 usage chunk 的形状（缺项按 0，不编造）。 */
export function usageChunk(usage) {
  const input = Number.isFinite(usage?.input_tokens) ? usage.input_tokens : 0;
  const output = Number.isFinite(usage?.output_tokens) ? usage.output_tokens : 0;
  const total = Number.isFinite(usage?.total_tokens) ? usage.total_tokens : input + output;
  return { type: "usage", usage: { inputTokens: Math.max(0, input), outputTokens: Math.max(0, output || total - input) } };
}

/**
 * 解析语音合成的响应体，返回**完整音频字节**。
 *
 * 两种真实形态（都不是「一个 JSON 里塞 base64」）：
 *
 * 1. **二进制音频**（Content-Type: audio/*，OpenAI 兼容 /audio/speech 一类）：
 *    整个响应体就是音频，直接读字节。旧代码在这里调 response.json()，
 *    对任何一次成功合成都必然抛「返回了非 JSON 响应」。
 * 2. **逐行 JSON**（豆包语音 HTTP Chunked，Agent Plan 的 plan/tts/unidirectional）：
 *    每行 `{code:0,data:"<base64>"}` 是一片音频，`{code:20000000}` 是成功终止码。
 *    成功判据 = 收到终止码 **且** 音频非空；其它非零码一律致命 —— 即使后面还跟着
 *    终止码也不能当成功（上游可能先报错再补收尾帧）。没有终止码就是断流。
 *
 * 也容忍两种边缘形态：单行完整 JSON（HTTP 正常结束即完整）、SSE 包装（data: 前缀
 * 与 [DONE]），但都不会把「读到一半」包装成成功。
 *
 * @param response - fetch 响应。
 * @param {Object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.touch] - 续空闲超时（长音频分片之间有间隔是正常的）。
 * @param {string} [opts.label] - 错误消息前缀。
 * @param {number} [opts.maxBytes]
 * @param {Function} [opts.failureCode] - (code, message) => 宿主失败码，默认 PROVIDER_ERROR。
 * @returns {Promise<Buffer>} 完整音频字节（保证非空）。
 */
export async function readSpeechAudio(response, { signal, touch, label = "语音合成", maxBytes = MEDIA_MAX_BYTES, failureCode } = {}) {
  if (!response.body) throw new LlmError(`${label}没有返回响应体`, "PROVIDER_ERROR");
  const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
  const parts = [];
  let total = 0;
  let terminated = false;

  const takeAudio = (base64) => {
    const bytes = decodeBase64Strict(base64, "音频分片");
    total += bytes.length;
    if (total > maxBytes) throw new LlmError(`${label}音频超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`, "PROVIDER_ERROR");
    parts.push(bytes);
  };
  const takeEvent = (event) => {
    if (!event || typeof event !== "object") {
      throw new LlmError(`${label}返回了非对象事件`, "PROVIDER_ERROR");
    }
    if (event.error) {
      const errCode = (typeof event.error === "object" ? event.error.code : undefined) ?? event.code ?? "error";
      const errMessage = typeof event.error === "string"
        ? event.error
        : (event.error.message ?? event.message ?? "未知错误");
      throw new LlmError(
        `${label}失败（${errCode}）：${errMessage}`,
        failureCode ? failureCode(errCode, errMessage) : "PROVIDER_ERROR",
      );
    }
    const rawCode = event.code;
    if (rawCode !== undefined && rawCode !== null) {
      const numericCode = typeof rawCode === "number"
        ? (Number.isFinite(rawCode) ? rawCode : null)
        : (typeof rawCode === "string" && /^-?\d+$/.test(rawCode.trim()) ? Number(rawCode.trim()) : null);
      if (numericCode === TTS_DONE_CODE) { terminated = true; return false; }
      if (numericCode !== 0) {
        const message = event?.message ?? "未知错误";
        throw new LlmError(
          `${label}失败（code ${rawCode}）：${message}`,
          failureCode ? failureCode(rawCode, message) : "PROVIDER_ERROR",
        );
      }
    }
    if (typeof event?.data === "string" && event.data.length > 0) takeAudio(event.data);
    return true;
  };
  const finish = () => {
    if (!terminated) throw new LlmError(`${label}流提前结束（未收到终止码 ${TTS_DONE_CODE}）`, "STREAM_CLOSED");
    if (total === 0) throw new LlmError(`${label}返回了空音频`, "PROVIDER_ERROR");
    const audio = Buffer.concat(parts, total);
    if (!sniffMediaType(audio)?.startsWith("audio/")) {
      throw new LlmError(`${label}返回的内容不是有效音频`, "PROVIDER_ERROR");
    }
    return audio;
  };

  if (contentType.startsWith("audio/")) {
    const bytes = await readAllBytes(response.body, signal, maxBytes, touch);
    if (bytes.length === 0) throw new LlmError(`${label}返回了空音频`, "PROVIDER_ERROR");
    if (!sniffMediaType(bytes)?.startsWith("audio/")) {
      throw new LlmError(`${label}返回的内容不是有效音频（Content-Type 声称音频）`, "PROVIDER_ERROR");
    }
    return bytes;
  }

  await readLines(response.body, signal, (line) => {
    touch?.();
    const trimmed = line.trim();
    if (!trimmed) return true;
    // 跳过标准 SSE 注释行（: keep-alive）与控制行（event:/id:/retry:）。
    if (trimmed.startsWith(":") || /^(?:event|id|retry):/i.test(trimmed)) return true;
    const data = sseData(trimmed);
    const raw = data !== null ? data : trimmed;
    if (!raw) return true;
    if (raw === "[DONE]") { terminated = true; return false; }
    let event;
    try { event = JSON.parse(raw); } catch {
      throw new LlmError(`${label}返回了无法解析的行`, "PROVIDER_ERROR");
    }
    return takeEvent(event);
  });
  // 这里**不**把「只收到一片 code:0」当成完整响应：真实协议的成功判据只有终止码。
  // 之前那条「单行完整 JSON 也算成功」的宽容分支，恰好把「合成到一半断流」
  // 这个最需要报错的场景包装成了成功（半截音频被当完整音频存盘）。
  return finish();
}
