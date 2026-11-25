/**
 * Ark 标准 v3 API 封装（生图 / 生视频 / TTS）。
 *
 * 生图/生视频走标准 Ark v3 网关（https://ark.cn-beijing.volces.com/api/v3），
 * 不是 Agent Plan 网关。用独立的 API key（默认 ARK_API_KEY 凭据引用）。
 * **语音合成不在 ark 网关上**，走 openspeech（见 synthesizeSpeech）。
 *
 * 所有函数都接受注入式 fetchImpl 和 apiKey，不直接读环境变量。
 */

import { randomUUID } from "node:crypto";
import { AGENT_PLAN_TTS_URL, TTS_RESOURCE_ID, DEFAULT_TTS_SPEAKER, readSpeechAudio } from "./media-io.js";

const DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";

/**
 * 发起一次 Ark v3 API 调用。
 *
 * @param {Object} params
 * @param {Function} params.fetchImpl - 注入式 fetch（支持代理）。
 * @param {string} params.apiKey - API key 明文。
 * @param {string} params.path - API 路径（如 "/images/generations"）。
 * @param {Object} [params.body] - 请求体（POST 时）。
 * @param {string} [params.method] - HTTP 方法，默认 "POST"。
 * @param {string} [params.baseUrl] - 覆盖默认 base URL。
 * @param {AbortSignal} [params.signal] - 取消信号。
 * @returns {Promise<Object>} 解析后的 JSON 响应体。
 */
async function arkRequest({ fetchImpl, apiKey, path, body, method = "POST", baseUrl = DEFAULT_BASE_URL, signal }) {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  };
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`Ark API ${method} ${path} 返回 HTTP ${response.status}${text ? `：${text.slice(0, 500)}` : ""}`);
    error.status = response.status;
    throw error;
  }
  try {
    return await response.json();
  } catch {
    const error = new Error(`Ark API ${method} ${path} 返回了非 JSON 响应（HTTP ${response.status}）`);
    error.status = response.status;
    throw error;
  }
}

// ── 图片生成 ──────────────────────────────────────────────────────────

/**
 * 调用 Ark 图片生成 API。
 * 文档：https://www.volcengine.com/docs/82379/1541523
 *
 * 官方参数表里**没有 `quality`**；`n` 只对部分（OpenAI 兼容的第三方）模型有效，
 * 豆包 Seedream 系多图走 sequential_image_generation_options.max_images。
 * 所以这里只在调用方明确给了 n 时才发，不再无条件塞一个上游不认的字段。
 *
 * @param {Object} params
 * @param {Function} params.fetchImpl
 * @param {string} params.apiKey
 * @param {string} params.model - 生图模型名或 endpoint id。
 * @param {string} params.prompt - 文本提示词。
 * @param {string} [params.size] - 尺寸档位（1K/1.5K/2K）或精确 WxH。
 * @param {number} [params.n] - 生成数量（仅支持的模型有效）。
 * @param {boolean} [params.watermark] - 是否加水印，默认 true。
 * @param {string} [params.responseFormat] - "url" 或 "b64_json"，默认 "url"。
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Object>} { created, data: [{ url?, b64_json? }] }
 */
export async function generateImage({ fetchImpl, apiKey, model, prompt, size, n, watermark, responseFormat, signal, baseUrl }) {
  const body = {
    model,
    prompt,
    ...(size ? { size } : {}),
    ...(Number.isFinite(n) && n > 0 ? { n } : {}),
    ...(watermark !== undefined ? { watermark } : {}),
    ...(responseFormat ? { response_format: responseFormat } : {}),
  };
  return arkRequest({ fetchImpl, apiKey, path: "/images/generations", body, signal, baseUrl });
}

// ── 视频生成 ──────────────────────────────────────────────────────────

/**
 * 创建视频生成任务。
 * 文档：https://www.volcengine.com/docs/82379/1520757
 *
 * @param {Object} params
 * @param {Function} params.fetchImpl
 * @param {string} params.apiKey
 * @param {string} params.model - 视频模型 endpoint id。
 * @param {string} params.prompt - 文本提示词。
 * @param {string} [params.image] - 首帧图片 URL 或 base64（图生视频）。
 * @param {string} [params.ratio] - 画幅比例，"16:9" / "9:16" / "1:1" / "4:3" / "3:4" / "21:9"。
 * @param {string} [params.resolution] - 分辨率，"480p" / "720p" / "1080p"。
 * @param {number} [params.duration] - 时长（秒）：2.5 系 4~30、2.0 系 4~15，-1 由模型自选。
 * @param {boolean} [params.watermark] - 是否加水印。
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Object>} { id, status, ... } 任务对象。
 */
export async function createVideoTask({ fetchImpl, apiKey, model, prompt, image, ratio, resolution, duration, watermark, signal, baseUrl }) {
  const content = [{ type: "text", text: prompt }];
  if (image) content.push({ type: "image_url", image_url: { url: image } });
  const body = {
    model,
    content,
    ...(ratio ? { ratio } : {}),
    ...(resolution ? { resolution } : {}),
    ...(Number.isFinite(duration) ? { duration } : {}),
    ...(watermark !== undefined ? { watermark } : {}),
  };
  return arkRequest({ fetchImpl, apiKey, path: "/contents/generations/tasks", body, signal, baseUrl });
}

/**
 * 查询视频生成任务状态。
 *
 * @param {Object} params
 * @param {Function} params.fetchImpl
 * @param {string} params.apiKey
 * @param {string} params.taskId - 任务 ID。
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Object>} { id, status, content?: { video_url? }, error? }
 */
export async function getVideoTask({ fetchImpl, apiKey, taskId, signal, baseUrl }) {
  return arkRequest({
    fetchImpl, apiKey,
    path: `/contents/generations/tasks/${encodeURIComponent(taskId)}`,
    method: "GET", signal, baseUrl,
  });
}

/**
 * 轮询等待视频任务完成。
 *
 * @param {Object} params
 * @param {Function} params.fetchImpl
 * @param {string} params.apiKey
 * @param {string} params.taskId
 * @param {number} [params.pollIntervalMs] - 轮询间隔（毫秒），默认 5000。
 * @param {number} [params.maxWaitMs] - 最长等待（毫秒），默认 300000。
 * @param {AbortSignal} [params.signal]
 * @param {Function} [params.onProgress] - 进度回调 (status, task) => void。
 * @returns {Promise<Object>} 完成的任务对象（status === "succeeded"）。
 */
export async function waitVideoTask({ fetchImpl, apiKey, taskId, pollIntervalMs = 5000, maxWaitMs = 300_000, signal, baseUrl, onProgress }) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const task = await getVideoTask({ fetchImpl, apiKey, taskId, signal, baseUrl });
    onProgress?.(task.status, task);
    if (task.status === "succeeded") return task;
    if (task.status === "failed" || task.status === "cancelled") {
      const msg = task.error?.message ?? `视频生成${task.status === "failed" ? "失败" : "被取消"}`;
      throw new Error(msg);
    }
    // queued / running → 等待后继续轮询。正常到点要移除 abort 监听器，
    // 否则长任务会在调用方 signal 上累积监听器（每轮一个）。
    await new Promise((resolve, reject) => {
      const onAbort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, pollIntervalMs);
      if (signal) {
        if (signal.aborted) { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  throw new Error(`视频生成超时：等待超过 ${Math.round(maxWaitMs / 1000)} 秒仍未完成`);
}

// ── TTS（语音合成） ──────────────────────────────────────────────────

/**
 * 语音合成（豆包语音 HTTP Chunked 接口）。
 *
 * 真实契约（官方 Agent Plan 语音文档 + 豆包语音 HTTP Chunked 文档）：
 * - 端点是 **openspeech**，不是 ark 网关：
 *   `POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional`
 *   （Agent Plan 专属；非套餐版少了 `/plan/`）。往 ark 网关发 /audio/speech 拿不到音频。
 * - 鉴权用 `X-Api-Key` + `X-Api-Resource-Id: seed-tts-2.0`（不是 Bearer）。
 * - 请求体是 `req_params`，语速字段是整数 `speech_rate`（-50..100，100=2 倍速），
 *   **没有 `speed_ratio` / `input` / `voice` / `encoding` 这些 OpenAI 风格字段**。
 * - 响应是逐行 JSON（`{code:0,data:"<base64>"}` … `{code:20000000}`），
 *   或二进制音频；解析与成功判据统一走 media-io.readSpeechAudio。
 *
 * @param {Object} params
 * @param {Function} params.fetchImpl
 * @param {string} params.apiKey
 * @param {string} params.text - 要合成的文本。
 * @param {string} [params.voice] - 音色（speaker），默认 2.0 公版音色。
 * @param {string} [params.encoding] - 音频格式，默认 "mp3"。
 * @param {number} [params.speedRatio] - 语速倍率 0.5-2.0，内部换算成 speech_rate。
 * @param {string} [params.endpoint] - 覆盖端点（非套餐版/自建网关）。
 * @param {string} [params.resourceId] - 覆盖语音资源 ID（复刻音色用 seed-icl-2.0）。
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<{audio: Buffer, format: string}>} 完整音频字节。
 */
export async function synthesizeSpeech({
  fetchImpl, apiKey, text, voice, encoding, speedRatio, signal, endpoint, resourceId,
}) {
  const format = encoding ?? "mp3";
  // 倍率 → 官方整数语速：1.0→0、2.0→100、0.5→-50（越界夹到官方区间）。
  const speechRate = Number.isFinite(speedRatio)
    ? Math.max(-50, Math.min(100, Math.round((speedRatio - 1) * 100)))
    : undefined;
  const body = {
    req_params: {
      text,
      speaker: voice ?? DEFAULT_TTS_SPEAKER,
      audio_params: {
        format,
        sample_rate: 24000,
        ...(speechRate !== undefined && speechRate !== 0 ? { speech_rate: speechRate } : {}),
      },
    },
  };
  const url = endpoint || AGENT_PLAN_TTS_URL;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      "X-Api-Key": apiKey,
      "X-Api-Resource-Id": resourceId || TTS_RESOURCE_ID,
      "X-Api-Request-Id": randomUUID(),
      "X-Control-Require-Usage-Tokens-Return": "*",
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`语音合成返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 500)}` : ""}`);
    error.status = response.status;
    throw error;
  }
  const audio = await readSpeechAudio(response, { signal, label: "语音合成" });
  return { audio, format };
}
