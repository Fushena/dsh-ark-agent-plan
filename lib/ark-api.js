/**
 * Ark 标准 v3 API 封装（生图 / 生视频 / TTS）。
 *
 * 这些 API 走标准 Ark v3 网关（https://ark.cn-beijing.volces.com/api/v3），
 * 不是 Agent Plan 网关。用独立的 API key（默认 ARK_API_KEY 凭据引用）。
 *
 * 所有函数都接受注入式 fetchImpl 和 apiKey，不直接读环境变量。
 */

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
 * @param {Object} params
 * @param {Function} params.fetchImpl
 * @param {string} params.apiKey
 * @param {string} params.model - 生图模型 endpoint id（如 ep-2025xxxx）。
 * @param {string} params.prompt - 文本提示词。
 * @param {string} [params.size] - 尺寸，默认 "1024x1024"。
 * @param {string} [params.quality] - 质量，"standard" 或 "hd"。
 * @param {number} [params.n] - 生成数量，默认 1。
 * @param {boolean} [params.watermark] - 是否加水印，默认 true。
 * @param {string} [params.responseFormat] - "url" 或 "b64_json"，默认 "url"。
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Object>} { created, data: [{ url?, b64_json? }] }
 */
export async function generateImage({ fetchImpl, apiKey, model, prompt, size, quality, n, watermark, responseFormat, signal, baseUrl }) {
  const body = {
    model,
    prompt,
    ...(size ? { size } : {}),
    ...(quality ? { quality } : {}),
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
 * @param {number} [params.duration] - 时长（秒），5 或 10。
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
 * 调用 Ark TTS API。
 * 文档：https://www.volcengine.com/docs/6561/1257584
 *
 * @param {Object} params
 * @param {Function} params.fetchImpl
 * @param {string} params.apiKey
 * @param {string} params.model - TTS endpoint id。
 * @param {string} params.text - 要合成的文本。
 * @param {string} [params.voice] - 音色，默认 "zh_female_cancan_mars_bigtts"。
 * @param {string} [params.encoding] - 音频格式，默认 "mp3"。
 * @param {number} [params.speedRatio] - 语速倍率，默认 1.0。
 * @param {AbortSignal} [params.signal]
 * @returns {Promise<Object>} { data: base64 音频数据 }
 */
export async function synthesizeSpeech({ fetchImpl, apiKey, model, text, voice, encoding, speedRatio, signal, baseUrl }) {
  const body = {
    model,
    input: text,
    voice: voice ?? "zh_female_cancan_mars_bigtts",
    encoding: encoding ?? "mp3",
    ...(Number.isFinite(speedRatio) ? { speed_ratio: speedRatio } : {}),
  };
  return arkRequest({ fetchImpl, apiKey, path: "/audio/speech", body, signal, baseUrl });
}
