import { randomUUID } from "node:crypto";
import { LlmError } from "@deepseek-ai/dsh-llm";
import { sanitizeText } from "./content.js";
import { transcribeSpeech } from "./asr.js";
import { httpFailure, retryAfterMs } from "./errors.js";
import {
  AGENT_PLAN_TTS_URL, TTS_RESOURCE_ID, DEFAULT_TTS_SPEAKER,
  iterateLines, sseData, safeHttpsUrl, decodeBase64Strict, sniffImageMediaType, sniffMediaType,
  mediaExtension, downloadMedia, mediaFileName, storeMediaFile, readSpeechAudio,
  fileBlock, textBlockChunks, usageChunk,
} from "./media-io.js";

/**
 * 多模态路线（图片 / 视频 / 语音 / 向量）。
 *
 * 这一层以前是「按想象的 SSE 事件名解析一切」，与上游真实契约对不上（审计 A2）：
 *
 * - **视频**：官方是异步任务 —— POST /contents/generations/tasks 只返回 `{id}`，
 *   再 GET /contents/generations/tasks/{id} 轮询到 `status:"succeeded"` 拿
 *   `content.video_url`。根本没有 `video_generation.progress/completed` 这种 SSE。
 * - **图片**：`stream:true` 只有 doubao-seedream-5.0-lite / 4.5 / 4.0 支持，
 *   5.0-pro / 5.0-flash / 5.5 传了直接 400；真实事件名是
 *   `image_generation.partial_succeeded / partial_failed / completed`。
 *   请求体里也没有 `quality`、`n` 这两个字段（多图走 sequential_image_generation）。
 * - **语音**：Agent Plan 的语音不在 ark 网关上，而是
 *   `POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional`，
 *   用 `X-Api-Key` + `X-Api-Resource-Id: seed-tts-2.0`，请求体是 `req_params`，
 *   响应是**逐行 JSON**（不是 SSE）：`{code:0,data:"<base64>"}` 若干行，
 *   最后 `{code:20000000}` 终止。没有终止码或音频为空都不算成功。
 * - **向量**：/embeddings 不支持 stream，返回单个 JSON。
 *
 * 产物形态见 media-io.js 的说明：一律落宿主附件库拿真引用后发 file 块，
 * 落不了库就退化成 https 文本链接，绝不伪造 attachmentId。
 */

/** 官方支持流式输出的生图模型（其余模型必须走非流式 JSON）。 */
const IMAGE_STREAM_PATTERN = /seedream[-_.]?(?:5[-_.]0[-_.]lite|4[-_.]5|4[-_.]0)(?:[-_.]|$)/i;

/** 该生图模型是否支持 `stream:true`。 */
export function supportsImageStream(modelId) {
  return IMAGE_STREAM_PATTERN.test(String(modelId ?? ""));
}

/** Agent Plan 生图默认尺寸档位（精确像素档位随模型不同，档位名全系通用）。 */
export const DEFAULT_IMAGE_SIZE = "2K";
const MAX_VIDEO_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_VIDEO_REFERENCE_BYTES = 45 * 1024 * 1024;

export const VIDEO_POLL_INTERVAL_MS = 5_000;
export const VIDEO_MAX_WAIT_MS = 300_000;

/** 从对话消息里取用户文本（多模态请求只吃文本提示词）。 */
export function promptText(options) {
  return options.messages
    ?.filter((m) => m.role === "user")
    .flatMap((m) => m.content?.filter((b) => b.type === "text").map((b) => b.text) ?? [])
    .join("\n") ?? "";
}

/**
 * 按 transport 构建**官方形状**的请求体。
 *
 * @param options - LLM 请求（messages 等）。
 * @param model - 目录模型（id/transport）。
 * @param defaults - 可选默认值（size/speaker/ratio/resolution/duration）。
 * @param attachments - DSH 图片附件服务，用于读取视频参考图。
 */
export async function buildMultimodalRequestBody(options, model, defaults = {}, attachments) {
  const transport = model.transport;
  const text = sanitizeText(promptText(options));

  if (transport === "images") {
    return {
      model: model.id,
      prompt: text,
      size: defaults.size ?? DEFAULT_IMAGE_SIZE,
      response_format: "url",
      watermark: true,
      // 只有官方列出的三个模型支持流式；其余模型传 stream 会被上游 400。
      ...(supportsImageStream(model.id) ? { stream: true } : {}),
    };
  }

  if (transport === "video") {
    const latestUser = options.messages?.findLast((message) => message.role === "user");
    const images = latestUser?.content?.filter((block) => block.type === "image") ?? [];
    if (images.length && !attachments?.readImage) {
      throw new LlmError("参考图需要 DSH 图片附件服务", "UNSUPPORTED_CONTENT");
    }
    const content = text ? [{ type: "text", text }] : [];
    let referenceBytes = 0;
    for (const image of images) {
      const { ref, data } = await attachments.readImage(image.attachment, options.signal);
      referenceBytes += data.byteLength;
      if (data.byteLength >= MAX_VIDEO_IMAGE_BYTES || referenceBytes > MAX_VIDEO_REFERENCE_BYTES) {
        throw new LlmError("参考图过大，请缩小图片后再生成视频", "UNSUPPORTED_CONTENT");
      }
      content.push({
        type: "image_url",
        image_url: { url: `data:${ref.mediaType};base64,${Buffer.from(data).toString("base64")}` },
        role: images.length === 1 ? "first_frame" : "reference_image",
      });
    }
    if (!content.length) throw new LlmError("视频生成需要提示词或参考图", "UNSUPPORTED_CONTENT");
    return {
      model: model.id,
      content,
      ratio: defaults.ratio ?? "adaptive",
      resolution: defaults.resolution ?? "720p",
      duration: Number.isFinite(defaults.duration) ? defaults.duration : 5,
      watermark: true,
    };
  }

  if (transport === "audio") {
    return {
      req_params: {
        text,
        speaker: defaults.speaker ?? DEFAULT_TTS_SPEAKER,
        audio_params: { format: "mp3", sample_rate: 24000 },
      },
    };
  }

  if (transport === "embedding") {
    return { model: model.id, input: text };
  }

  throw new LlmError(`不支持的多模态 transport: ${transport}`, "UNSUPPORTED_CONTENT");
}

/** 非 2xx → 带可重试分类的 LlmError（与 adapter 的 HTTP 错误路径同款）。 */
async function ensureOk(response, routeName, label) {
  if (response.ok) return;
  const text = await response.text().catch(() => "");
  const retryMs = retryAfterMs(response.headers);
  throw new LlmError(
    `${routeName} ${label}返回 HTTP ${response.status}${text ? `：${text.slice(0, 600)}` : ""}`,
    httpFailure(response.status, text),
    { status: response.status, ...(retryMs ? { providerRetryAfterMs: retryMs } : {}) },
  );
}

/** 读单个 JSON 响应；空体/坏 JSON 都是协议错误，不能当成功。 */
async function readJson(response, routeName, label) {
  const text = await response.text();
  if (!text || !text.trim()) throw new LlmError(`${routeName} ${label}返回了空响应`, "STREAM_CLOSED");
  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError(`${routeName} ${label}返回了非 JSON 响应`, "PROVIDER_ERROR");
  }
}

/** 上游流内错误码 → 宿主失败码（可重试的交给重试策略，其余终局）。 */
function upstreamFailureCode(code, message) {
  const text = `${String(code ?? "")} ${String(message ?? "")}`.toLowerCase();
  if (/quota|billing|余额不足|额度/.test(text)) return "QUOTA";
  if (/rate.?limit|throttl|too_many|qps|concurr/.test(text)) return "RATE_LIMIT";
  if (/timeout/.test(text)) return "TIMEOUT";
  if (/internal|server|unavailable/.test(text)) return "SERVER";
  return "PROVIDER_ERROR";
}

/** 可取消的 sleep（到点/取消都移除监听器，避免长任务累积监听器）。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new LlmError("请求已取消", "ABORTED")); return; }
    const onAbort = () => { clearTimeout(timer); reject(new LlmError("请求已取消", "ABORTED")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 取图片字节：优先内联 base64，其次下载 https URL；魔数不对就拒收。 */
async function imageBytes(item, { fetchImpl, signal, touch }) {
  let bytes = null;
  if (typeof item?.b64_json === "string" && item.b64_json.length > 0) {
    bytes = decodeBase64Strict(item.b64_json, "图片 base64");
  } else {
    const url = safeHttpsUrl(item?.url ?? item?.image_url);
    if (!url) throw new LlmError("上游图片结果既没有 base64 也没有 https 地址", "PROVIDER_ERROR");
    bytes = await downloadMedia(fetchImpl, url, { signal, touch });
  }
  if (!sniffImageMediaType(bytes)) {
    throw new LlmError("上游返回的图片内容不是有效的 PNG/JPEG/WebP/GIF", "PROVIDER_ERROR");
  }
  return bytes;
}

/**
 * 发出一张图片：落库成功 → file 块；落不了库 → https 文本链接。
 * @returns 是否真的存成了文件。
 */
async function* emitImage(bytes, url, index, attachments, logger) {
  const mediaType = sniffImageMediaType(bytes);
  const name = mediaFileName("ark-image", mediaExtension(mediaType, "png"));
  const ref = await storeMediaFile(attachments, bytes, name, logger);
  if (ref) {
    yield { type: "block-start", index, blockType: "file" };
    yield fileBlock(index, ref);
    return true;
  }
  const safe = safeHttpsUrl(url);
  yield* textBlockChunks(index, safe
    ? `图片已生成：${safe}`
    : "图片已生成，但当前环境没有可用的附件存储，未能保存为文件。");
  return false;
}

/**
 * 音频/视频产物出口：落库成功发 file 块 + 一句说明，落不了库只发说明文本。
 *
 * 为什么一律 file 块而不是 image 块：本插件自己的 Responses 历史转换
 * （content.js）与宿主 pi-ai/deepseek 投影层都拒绝 assistant 侧 image 块，
 * 而 file 块会被宿主 projectFilesToText 换成「已存到 <路径>，用文件工具读」的
 * 文本句柄 —— 历史与 GUI 两边都能用，且引用是附件库的真引用。
 *
 * 下载由调用方先做完（downloadMedia 每收到一片就 touch 续命），这里只做落库，
 * 不在「没有任何 chunk」的状态下长时间等待。
 */
async function* mediaOutput(bytes, fallbackName, note, fallbackNote, attachments, logger) {
  const ref = await storeMediaFile(attachments, bytes, fallbackName, logger);
  let index = 0;
  if (ref) {
    yield { type: "block-start", index, blockType: "file" };
    yield fileBlock(index, ref);
    index += 1;
  }
  yield* textBlockChunks(index, ref ? note(bytes.length) : fallbackNote(bytes.length));
}

/** 非流式图片响应：{ data:[{url|b64_json,size}], usage }。 */
async function* imagesFromJson(response, ctx) {
  const payload = await readJson(response, ctx.routeName, "生图");
  const items = Array.isArray(payload?.data) ? payload.data : [];
  if (items.length === 0) {
    throw new LlmError(`${ctx.routeName} 生图未返回任何图片${payload?.error?.message ? `：${payload.error.message}` : ""}`, "PROVIDER_ERROR");
  }
  let index = 0;
  for (const item of items) {
    const bytes = await imageBytes(item, ctx);
    yield* emitImage(bytes, item?.url ?? item?.image_url, index, ctx.attachments, ctx.logger);
    index += 1;
    yield { type: "heartbeat" };
  }
  if (payload?.usage) yield usageChunk(payload.usage);
  yield { type: "finish", reason: { kind: "stop" } };
}

/**
 * 流式图片响应：partial_succeeded / partial_failed / completed / error。
 *
 * 边读边产出（不是「攒完再下载」）：下载一张大图可能要几秒到几十秒，
 * 攒着一起处理会让 adapter 的空闲超时在「一个 chunk 都没发」的下载期间到点，
 * 把一次正常生成掐成 TIMEOUT。iterateLines 是异步迭代，两行之间可以 await
 * 下载/落库，每处理完一张就 yield 一次给上层续命。
 */
async function* imagesFromSse(response, ctx) {
  let index = 0;
  let completed = false;
  let usage = null;
  const failures = [];

  for await (const line of iterateLines(response.body, ctx.signal)) {
    // 收到一行就是「有动静」：多张图之间的渲染间隔是正常的，续空闲超时。
    ctx.touch?.();
    const data = sseData(line);
    if (data === null) continue;
    if (data === "[DONE]") { completed = true; break; }
    let event;
    try { event = JSON.parse(data); } catch {
      // 单行坏 JSON 不致命，但也不静默当心跳：记下来，末尾若没 completed 会报 STREAM_CLOSED。
      failures.push("上游返回了无法解析的流事件");
      continue;
    }
    const type = event?.type;
    if (type === "error") {
      const message = event?.error?.message ?? "生图失败";
      throw new LlmError(`${ctx.routeName} ${message}`, upstreamFailureCode(event?.error?.code, message));
    }
    if (type === "image_generation.partial_succeeded") {
      const bytes = await imageBytes(event, ctx);
      yield* emitImage(bytes, event?.url, index, ctx.attachments, ctx.logger);
      index += 1;
      yield { type: "heartbeat" };
      continue;
    }
    if (type === "image_generation.partial_failed") {
      failures.push(event?.error?.message ?? `第 ${event?.image_index ?? "?"} 张生成失败`);
      continue;
    }
    if (type === "image_generation.completed") {
      usage = event?.usage ?? null;
      completed = true;
      break;
    }
  }

  if (!completed) {
    throw new LlmError(`${ctx.routeName} 生图流提前结束（未收到 completed 事件）`, "STREAM_CLOSED");
  }
  if (index === 0) {
    throw new LlmError(`${ctx.routeName} 生图没有产出任何图片${failures.length ? `：${failures.join("；").slice(0, 300)}` : ""}`, "PROVIDER_ERROR");
  }
  if (usage) yield usageChunk(usage);
  yield { type: "finish", reason: { kind: "stop" } };
}

/**
 * 视频：创建异步任务 → 轮询 → 下载落库。
 *
 * 轮询期间持续 yield heartbeat 给 adapter 续空闲超时；总时限独立于空闲超时
 * （渲染几分钟没有新数据是正常的，但不能无限等）。下载期间由 downloadMedia
 * 每收到一片就 touch 续命，不会在「没有任何 chunk」的状态下干等。
 */
async function* videoFromTask(ctx) {
  const { model, options, baseUrl, apiKey, fetchImpl, signal, routeName } = ctx;
  const body = await buildMultimodalRequestBody({ ...options, signal }, model, ctx.defaults, ctx.attachments);
  const tasksUrl = `${baseUrl}/contents/generations/tasks`;
  const auth = { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
  const created = await fetchImpl(tasksUrl, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  await ensureOk(created, routeName, "创建视频任务");
  const payload = await readJson(created, routeName, "创建视频任务");
  const taskId = typeof payload?.id === "string" && payload.id ? payload.id : null;
  if (!taskId) throw new LlmError(`${routeName} 创建视频任务未返回任务 ID`, "PROVIDER_ERROR");
  yield { type: "heartbeat" };

  const pollIntervalMs = Number.isFinite(ctx.video?.pollIntervalMs) && ctx.video.pollIntervalMs > 0
    ? ctx.video.pollIntervalMs : VIDEO_POLL_INTERVAL_MS;
  const maxWaitMs = Number.isFinite(ctx.video?.maxWaitMs) && ctx.video.maxWaitMs > 0
    ? ctx.video.maxWaitMs : VIDEO_MAX_WAIT_MS;
  const deadlineAt = Date.now() + maxWaitMs;
  let task = null;
  while (true) {
    if (signal?.aborted) throw new LlmError("请求已取消", "ABORTED");
    if (Date.now() >= deadlineAt) {
      throw new LlmError(`${routeName} 视频生成超时：等待超过 ${Math.round(maxWaitMs / 1000)} 秒仍未完成`, "TIMEOUT");
    }
    const polled = await fetchImpl(`${tasksUrl}/${encodeURIComponent(taskId)}`, { method: "GET", headers: auth, signal });
    await ensureOk(polled, routeName, "查询视频任务");
    task = await readJson(polled, routeName, "查询视频任务");
    yield { type: "heartbeat" };
    const status = task?.status;
    if (status === "succeeded") break;
    if (status === "failed" || status === "cancelled") {
      throw new LlmError(
        `${routeName} 视频生成${status === "failed" ? "失败" : "被取消"}${task?.error?.message ? `：${task.error.message}` : ""}`,
        "PROVIDER_ERROR",
      );
    }
    await sleep(pollIntervalMs, signal);
  }

  const videoUrl = safeHttpsUrl(task?.content?.video_url ?? task?.content?.file_url);
  if (!videoUrl) throw new LlmError(`${routeName} 视频任务已完成但未返回视频地址`, "PROVIDER_ERROR");
  if (task?.usage) yield usageChunk({ input_tokens: 0, output_tokens: task.usage.completion_tokens ?? task.usage.total_tokens ?? 0 });

  // 下载落库是「尽力而为」：失败/超限/没有附件服务都退化成 https 链接，
  // 但**取消**必须原样抛出，不能把被掐断的下载包装成一次成功回答。
  let videoBytes = null;
  try {
    const bytes = await downloadMedia(fetchImpl, videoUrl, { signal, touch: ctx.touch });
    // 魔数校验：代理/上游出错时会回 200 + 错误页，存成 .mp4 等于给个坏文件。
    if (!sniffMediaType(bytes)?.startsWith("video/")) {
      ctx.logger?.warn?.("ark-agent-plan: 视频下载内容不是有效视频，改为给出链接");
    } else {
      videoBytes = bytes;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    ctx.logger?.warn?.(`ark-agent-plan: 视频下载失败（${String(error?.message ?? error).slice(0, 160)}），改为给出链接`);
  }
  const seconds = Number.isFinite(task?.duration) ? `${task.duration} 秒，` : "";
  if (videoBytes) {
    yield* mediaOutput(
      videoBytes,
      mediaFileName("ark-video", "mp4"),
      (size) => `视频已生成（${seconds}${size} 字节，任务 ${taskId}），已保存为文件：${videoUrl}`,
      (size) => `视频已生成（${seconds}${size} 字节，任务 ${taskId}）：${videoUrl}`,
      ctx.attachments,
      ctx.logger,
    );
  } else {
    yield* textBlockChunks(0, `视频已生成（${seconds}任务 ${taskId}）：${videoUrl}`);
  }
  yield { type: "finish", reason: { kind: "stop" } };
}

/**
 * 语音合成（Agent Plan / 豆包语音 HTTP Chunked）。
 *
 * 响应是逐行 JSON：`{code:0,data:"<base64>"}` 累积音频，`{code:20000000}` 终止。
 * 成功判据 = **收到终止码** 且 **音频非空**；其它非零码一律致命错误，
 * 即使后面还跟着终止码也不能当成功（上游可能先报错再补一个收尾帧）。
 */
async function* audioFromSpeech(ctx) {
  const { model, options, apiKey, fetchImpl, signal, routeName } = ctx;
  const body = await buildMultimodalRequestBody(options, model, ctx.defaults);
  const url = ctx.tts?.endpoint || AGENT_PLAN_TTS_URL;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": ctx.tts?.resourceId || TTS_RESOURCE_ID,
      "X-Api-Request-Id": randomUUID(),
      "X-Control-Require-Usage-Tokens-Return": "*",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  await ensureOk(response, routeName, "语音合成");
  // 真实响应形态（二进制音频 / 逐行 JSON + 终止码）的解析与成功判据都在
  // media-io.readSpeechAudio 里，工具路线（ark_text_to_speech）共用同一套。
  const audio = await readSpeechAudio(response, {
    signal,
    touch: ctx.touch,
    label: `${routeName} 语音合成`,
    failureCode: upstreamFailureCode,
  });

  yield* mediaOutput(
    audio,
    mediaFileName("ark-speech", "mp3"),
    (size) => `语音已合成（${size} 字节，mp3），已保存为文件。`,
    (size) => `语音已合成（${size} 字节，mp3），但当前环境没有可用的附件存储，未能保存为文件。`,
    ctx.attachments,
    ctx.logger,
  );
  yield { type: "finish", reason: { kind: "stop" } };
}

/** 向量：单个 JSON 响应，不支持 stream。 */
async function* embeddingFromJson(response, ctx) {
  const payload = await readJson(response, ctx.routeName, "向量");
  const embedding = payload?.data?.[0]?.embedding;
  if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every(Number.isFinite)) {
    throw new LlmError(`${ctx.routeName} 向量接口未返回 embedding`, "PROVIDER_ERROR");
  }
  const json = JSON.stringify(embedding);
  const ref = await storeMediaFile(ctx.attachments, Buffer.from(json), mediaFileName("ark-embedding", "json"), ctx.logger);
  if (ref) {
    yield { type: "block-start", index: 0, blockType: "file" };
    yield fileBlock(0, ref);
  }
  yield* textBlockChunks(ref ? 1 : 0, ref
    ? `向量维度: ${embedding.length}，完整向量已保存为 JSON 文件。`
    : `向量维度: ${embedding.length}\n${json}`);
  if (payload?.usage) yield usageChunk({ ...payload.usage, input_tokens: payload.usage.input_tokens ?? payload.usage.prompt_tokens });
  yield { type: "finish", reason: { kind: "stop" } };
}

/**
 * 多模态请求的统一入口：自己发请求（视频要发多次）、自己解析真实响应形态，
 * 产出宿主 chunk。adapter 只负责空闲超时/取消分类与 usage 记账。
 *
 * @param {Object} ctx
 * @param {Object} ctx.model - 目录模型。
 * @param {Object} ctx.options - LLM 请求。
 * @param {string} ctx.baseUrl - 网关 base（.../api/plan/v3），语音路线忽略它。
 * @param {string} ctx.apiKey - 已解析的 Key。
 * @param {Function} ctx.fetchImpl - 注入式 fetch。
 * @param {AbortSignal} ctx.signal - 融合信号（外部取消 + 空闲超时）。
 * @param {Object} [ctx.attachments] - 宿主附件服务。
 * @param {Object} [ctx.speechAttachment] - 本轮 DSH WAV 附件引用（ASR）。
 * @param {Function} [ctx.openWebSocket] - ASR 的可选代理 WebSocket 工厂。
 * @param {Object} [ctx.logger]
 * @param {string} ctx.routeName - 错误消息前缀。
 * @param {Function} [ctx.touch] - 续空闲超时（长下载期间调用）。
 * @param {Object} [ctx.video] - { pollIntervalMs, maxWaitMs }。
 * @param {Object} [ctx.tts] - { endpoint, resourceId, speaker }。
 * @param {Object} [ctx.defaults] - 请求体默认值（size/ratio/resolution/duration/speaker）。
 */
export async function* runMultimodal(ctx) {
  const transport = ctx.model?.transport;
  if (transport === "video") { yield* videoFromTask(ctx); return; }
  if (transport === "audio") { yield* audioFromSpeech(ctx); return; }
  if (transport === "asr") {
    yield* textBlockChunks(0, await transcribeSpeech(ctx));
    yield { type: "finish", reason: { kind: "stop" } };
    return;
  }

  const body = await buildMultimodalRequestBody(ctx.options, ctx.model, ctx.defaults);
  const path = transport === "images" ? "/images/generations" : transport === "embedding" ? "/embeddings" : null;
  if (!path) throw new LlmError(`不支持的多模态 transport: ${transport}`, "UNSUPPORTED_CONTENT");
  const response = await ctx.fetchImpl(`${ctx.baseUrl}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ctx.apiKey}`,
      "Content-Type": "application/json",
      Accept: body.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
  await ensureOk(response, ctx.routeName, transport === "images" ? "生图" : "向量");
  if (!response.body) throw new LlmError(`${ctx.routeName} API 没有返回响应体`, "PROVIDER_ERROR");
  const contentType = String(response.headers?.get?.("content-type") ?? "").toLowerCase();
  if (transport === "embedding") { yield* embeddingFromJson(response, ctx); return; }
  // 按**实际响应**形态分流：请求了流式但上游回 JSON（或反之）都不会解析错。
  if (contentType.includes("text/event-stream")) yield* imagesFromSse(response, ctx);
  else yield* imagesFromJson(response, ctx);
}
