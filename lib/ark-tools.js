/**
 * DSH 工具注册：将 Ark 的生图 / 生视频 / TTS 能力封装为 DSH 本地工具。
 *
 * 每个工具返回标准 DSH tool 描述对象（name / description / parameters / execute），
 * 由 index.js 在 apply() 中注册到 ctx.tools。
 *
 * 所有工具都需要：
 *   - 对应的 Config 子对象 enabled === true
 *   - 生图/生视频还要 model 非空（endpoint id）；语音走资源路由，不需要 endpoint id
 *   - 可用的 API key（通过 credentials 服务解析）
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { generateImage, createVideoTask, waitVideoTask, synthesizeSpeech } from "./ark-api.js";
import { DEFAULT_TTS_SPEAKER } from "./media-io.js";
import { resolveApiKey } from "./apikey.js";

const TTS_MAX_BYTES = 50 * 1024 * 1024; // 落盘上限：解码后 50MB

// 宿主派发管线（dsh-tools pipeline）会按 timeoutMs 给 exec.signal 装 deadline，
// 不声明就没有宿主兜底超时，只剩 undici 的 300s。生图/合成给 120s，视频按等待上限加缓冲。
const IMAGE_TIMEOUT_MS = 120_000;
const TTS_TIMEOUT_MS = 120_000;
const VIDEO_TIMEOUT_MARGIN_MS = 60_000;

/** 宿主 render 只认块数组；text 块是最通用的出口。 */
function textBlock(text) {
  return { type: "text", text };
}

/**
 * 运行时钳制。宿主 register 只校验 output.schema，**不校验 parameters**，
 * 而且 minimum/maximum 根本不在它支持的 JSON Schema 子集里 —— 越界值必须在
 * execute 内部挡住，否则直达计费 API（2026-11-24 审计 A1）。
 */
function clampNumber(value, min, max, fallback) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

/** 整数区间：越界夹到边界（要 99 张给 4 张），非整数/非数字回落默认值。 */
function pickInteger(value, min, max, fallback) {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * 视频时长：官方 2.5 系支持 4~30 秒、2.0 系 4~15 秒，另接受 -1（模型自选）。
 * 具体上限随模型不同，这里只做「整数且落在两系的并集内」这层钳制；
 * 旧实现把 enum 写死成 [5,10]，把官方合法值（如 15、-1）全挡掉了。
 */
function pickDuration(value, fallback) {
  if (value === -1) return -1;
  if (!Number.isInteger(value) || value < 4 || value > 30) return fallback;
  return value;
}

/** 必填提示词：宿主不校验 required，空串会白打一次计费请求。 */
function requirePrompt(args) {
  const prompt = String(args?.prompt ?? "").trim();
  if (!prompt) throw new Error("prompt 不能为空");
  return prompt;
}

async function resolveWorkDir(ctx, exec) {
  const wd = ctx.get?.("workingDirectory");
  if (wd) {
    if (exec?.agent && typeof wd.ensure === "function") return await wd.ensure(exec.agent, exec.signal);
    const fallback = typeof wd.defaultDirectory === "function" ? wd.defaultDirectory() : wd.defaultDirectory;
    if (typeof fallback === "string" && fallback) return fallback;
  }
  return process.cwd();
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/**
 * 音频字节落盘（与 qwen-token-plan-full 的 TTS 落盘同模式）：
 * 本地生成文件名（时间戳+UUID，上游数据不参与路径）、.part 临时文件原子改名、
 * 失败清理、大小上限。DSH 对话无法内嵌播放音频，给本地文件是唯一可用出口。
 *
 * 入参是**已解码的字节**：上游语音接口返回逐行 JSON 分片或二进制音频，
 * 解码与「有没有合成成功」的判定都在 media-io.readSpeechAudio 里做过了，
 * 这里再 Buffer.from(String(x),"base64") 只会把 Buffer 变成垃圾。
 */
async function saveAudioBytes(bytes, dir, signal, extension = "mp3") {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error("TTS 返回了空的音频数据");
  if (bytes.length > TTS_MAX_BYTES) throw new Error(`TTS 音频超过 ${TTS_MAX_BYTES / 1024 / 1024}MB 上限`);
  await mkdir(dir, { recursive: true });
  const name = `ark-speech-${stamp()}-${randomUUID().slice(0, 8)}.${extension}`;
  const finalPath = join(dir, name);
  const partPath = `${finalPath}.part`;
  let handle;
  try {
    handle = await open(partPath, "wx", 0o600);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await handle.writeFile(bytes);
    await handle.close();
    handle = undefined;
    await rename(partPath, finalPath);
    return { path: finalPath, bytes: bytes.length };
  } catch (error) {
    try { await handle?.close(); } catch { /* best effort */ }
    try { await unlink(partPath); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * 创建生图工具。
 *
 * @param {Object} deps
 * @param {Object} deps.ctx - Cordis 上下文。
 * @param {Object} deps.config - imageGeneration 配置子对象。
 * @param {Function} deps.fetchImpl - 注入式 fetch（支持代理）。
 * @returns {Object|null} DSH 工具描述，未启用时返回 null。
 */
export function createImageGenerationTool({ ctx, config, fetchImpl }) {
  if (!config?.enabled || !config.model) return null;
  const apiKeyEnv = config.apiKeyEnv || "ARK_API_KEY";
  const pluginName = "dsh-ark-agent-plan";

  return {
    name: "ark_generate_image",
    description: "使用火山方舟 Seedream 模型生成图片。输入文本提示词，返回生成的图片 URL。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "图片的文本描述（提示词）。支持中英文。",
        },
        size: {
          type: "string",
          description: '图片尺寸：档位 "1K" / "1.5K" / "2K"，或精确宽高（如 "2048x2048"，随模型有像素下限）。',
          default: config.defaultSize || "2K",
        },
        n: {
          type: "number",
          description: "生成图片数量（1-4）。仅部分模型支持；Seedream 系请用组图参数。",
          default: 1,
          minimum: 1,
          maximum: 4,
        },
      },
      required: ["prompt"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          images: {
            type: "array",
            items: {
              type: "object",
              properties: {
                index: { type: "integer" },
                url: { type: "string", description: "签名 URL（约 24h 过期）" },
                b64_json: { type: "string", description: "内联 base64 的前 100 字符预览（仅上游内联返回时出现）" },
              },
              required: ["index"],
            },
            description: "生成结果；上游只给内联 base64 时该项无 url",
          },
        },
        required: ["success", "images"],
        additionalProperties: false,
      },
      render: (_args, value) => {
        const images = value?.images ?? [];
        if (images.length === 0) return [textBlock("生图请求已完成，但上游没有返回图片。")];
        const lines = [`已生成 ${images.length} 张图片：`];
        for (const item of images) {
          lines.push(`${item.index}. ${item.url ?? "（上游内联返回，无 URL）"}`);
        }
        return [textBlock(lines.join("\n"))];
      },
    },
    timeoutMs: IMAGE_TIMEOUT_MS,
    async execute(args, { signal } = {}) {
      const prompt = requirePrompt(args);
      const apiKey = await resolveApiKey(ctx, [apiKeyEnv], pluginName);
      const result = await generateImage({
        fetchImpl,
        apiKey,
        model: config.model,
        prompt,
        size: args?.size || config.defaultSize || "2K",
        n: args?.n !== undefined ? pickInteger(args.n, 1, 4, undefined) : undefined,
        watermark: true,
        responseFormat: "url",
        signal,
      });
      const images = (result.data ?? []).map((item, i) => ({
        index: i + 1,
        // url 只在真实存在时给：output.schema 声明 string，塞 undefined 会被宿主判违规。
        ...(typeof item?.url === "string" && item.url ? { url: item.url } : {}),
        ...(item.b64_json ? { b64_json: item.b64_json.slice(0, 100) + "…" } : {}),
      }));
      return { success: true, images };
    },
  };
}

/**
 * 创建生视频工具。
 *
 * @param {Object} deps
 * @param {Object} deps.ctx - Cordis 上下文。
 * @param {Object} deps.config - videoGeneration 配置子对象。
 * @param {Function} deps.fetchImpl - 注入式 fetch。
 * @returns {Object|null} DSH 工具描述，未启用时返回 null。
 */
export function createVideoGenerationTool({ ctx, config, fetchImpl }) {
  if (!config?.enabled || !config.model) return null;
  const apiKeyEnv = config.apiKeyEnv || "ARK_API_KEY";
  const pluginName = "dsh-ark-agent-plan";
  const pollIntervalMs = (config.pollIntervalSeconds || 5) * 1000;
  const maxWaitMs = (config.maxWaitSeconds || 300) * 1000;

  return {
    name: "ark_generate_video",
    description: "使用火山方舟 Seedance 模型生成视频。输入文本提示词（文生视频）或加图片 URL（图生视频），返回生成的视频 URL。视频生成是异步任务，此工具会自动等待完成。",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "视频的文本描述（提示词）。支持中英文。",
        },
        image: {
          type: "string",
          description: "首帧图片 URL（可选，用于图生视频）。",
        },
        ratio: {
          type: "string",
          description: '画幅比例。"16:9"、"9:16"、"1:1"、"4:3"、"3:4"、"21:9"、"adaptive"（随首帧自适应）。',
          default: config.defaultRatio || "adaptive",
        },
        resolution: {
          type: "string",
          description: '分辨率。"480p"、"720p"、"1080p"（1080p 仅 seedance 2.5/2.0 系支持）。',
          default: config.defaultResolution || "720p",
        },
        duration: {
          type: "number",
          description: "视频时长（秒）。seedance 2.5 系 4~30、2.0 系 4~15；-1 表示由模型自选。",
          default: config.defaultDuration ?? 5,
        },
      },
      required: ["prompt"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          taskId: { type: "string", description: "方舟异步任务 ID" },
          videoUrl: { type: "string", description: "生成视频的签名 URL（约 24h 过期）" },
          duration: { type: "integer", description: "实际请求的视频时长（秒）" },
        },
        required: ["success", "taskId", "videoUrl", "duration"],
        additionalProperties: false,
      },
      render: (_args, value) => [textBlock(
        value?.videoUrl
          ? `视频生成完成（${value.duration ?? "?"} 秒）：${value.videoUrl}`
          : "视频任务已结束，但没有拿到视频 URL。",
      )],
    },
    timeoutMs: maxWaitMs + VIDEO_TIMEOUT_MARGIN_MS,
    async execute(args, { signal, onProgress } = {}) {
      const prompt = requirePrompt(args);
      const duration = pickDuration(args?.duration, pickDuration(config.defaultDuration, 5));
      const apiKey = await resolveApiKey(ctx, [apiKeyEnv], pluginName);
      const task = await createVideoTask({
        fetchImpl,
        apiKey,
        model: config.model,
        prompt,
        image: args?.image || undefined,
        ratio: args?.ratio || config.defaultRatio || "adaptive",
        resolution: args?.resolution || config.defaultResolution || "720p",
        duration,
        watermark: true,
        signal,
      });
      const taskId = task.id;
      if (!taskId) throw new Error("创建视频任务失败：未返回任务 ID");

      const completed = await waitVideoTask({
        fetchImpl,
        apiKey,
        taskId,
        pollIntervalMs,
        maxWaitMs,
        signal,
        onProgress: (status) => {
          onProgress?.({ type: "text", text: `视频生成中… 状态：${status}` });
        },
      });

      const videoUrl = completed.content?.video_url;
      if (!videoUrl) throw new Error("视频生成完成但未返回视频 URL");
      return { success: true, taskId, videoUrl, duration };
    },
  };
}

/**
 * 创建 TTS 工具。
 *
 * @param {Object} deps
 * @param {Object} deps.ctx - Cordis 上下文。
 * @param {Object} deps.config - tts 配置子对象。
 * @param {Function} deps.fetchImpl - 注入式 fetch。
 * @returns {Object|null} DSH 工具描述，未启用时返回 null。
 */
export function createTtsTool({ ctx, config, fetchImpl }) {
  if (!config?.enabled) return null;
  // 默认端点是 AGENT_PLAN_TTS_URL（Agent Plan 专属语音路径），对应默认凭据应与
  // Agent Plan 主凭据对齐（非套餐版自定义 endpoint 时用户可同步覆盖 apiKeyEnv）。
  const apiKeyEnv = config.apiKeyEnv || "ARK_AGENT_PLAN_CN_API_KEY";
  const pluginName = "dsh-ark-agent-plan";

  return {
    name: "ark_text_to_speech",
    description: "使用火山方舟豆包语音合成将文本转为语音，自动保存为本地 MP3 文件并返回文件路径。音频无法在对话里内嵌播放，请引导用户打开返回的本地文件收听。",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "要合成语音的文本内容。",
        },
        voice: {
          type: "string",
          description: "音色 ID（豆包语音 2.0 公版音色）。常用值：zh_female_vv_uranus_bigtts（vv 女声）、zh_male_m191_uranus_bigtts（云舟男声）。",
          default: config.defaultVoice || DEFAULT_TTS_SPEAKER,
        },
        speed_ratio: {
          type: "number",
          description: "语速倍率（0.5-2.0）。",
          default: 1.0,
          minimum: 0.5,
          maximum: 2.0,
        },
      },
      required: ["text"],
    },
    output: {
      schema: {
        type: "object",
        properties: {
          success: { type: "boolean" },
          format: { type: "string" },
          path: { type: "string", description: "已落盘的本地音频绝对路径" },
          bytes: { type: "integer" },
          characters: { type: "integer", description: "实际合成的字符数" },
          message: { type: "string" },
        },
        required: ["success", "format", "path", "bytes", "characters", "message"],
        additionalProperties: false,
      },
      render: (_args, value) => [textBlock(
        value?.path
          ? `语音合成完成（${value.bytes ?? 0} 字节）：${value.path}\n请引导用户打开该文件收听。`
          : "语音合成结束，但没有拿到本地文件。",
      )],
    },
    timeoutMs: TTS_TIMEOUT_MS,
    async execute(args, exec = {}) {
      const { signal } = exec;
      const text = String(args?.text ?? "").trim();
      if (!text) throw new Error("text 不能为空");
      if (text.length > 10_000) throw new Error("text 超过 10000 字符上限，请分段合成");
      const apiKey = await resolveApiKey(ctx, [apiKeyEnv], pluginName);
      const result = await synthesizeSpeech({
        fetchImpl,
        apiKey,
        text,
        voice: args?.voice || config.defaultVoice || DEFAULT_TTS_SPEAKER,
        encoding: "mp3",
        speedRatio: clampNumber(args?.speed_ratio, 0.5, 2.0, 1.0),
        ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        ...(config.resourceId ? { resourceId: config.resourceId } : {}),
        signal,
      });
      // 自动落盘 + 给文件（对话无法内嵌播放音频，返回 base64 等于把音频丢了）。
      const dir = await resolveWorkDir(ctx, exec);
      const saved = await saveAudioBytes(result.audio, dir, signal, result.format);
      return {
        success: true,
        format: result.format,
        path: saved.path,
        bytes: saved.bytes,
        characters: text.length,
        message: `语音合成完成，已保存到本地文件：${saved.path}（${saved.bytes} 字节）。请引导用户打开该文件收听。`,
      };
    },
  };
}

/**
 * 批量创建所有已启用的 Ark 工具。
 *
 * @param {Object} deps
 * @param {Object} deps.ctx - Cordis 上下文。
 * @param {Object} deps.config - 完整的插件 Config。
 * @param {Function} deps.fetchImpl - 注入式 fetch。
 * @returns {Array} 已启用的工具列表。
 */
export function createArkTools({ ctx, config, fetchImpl }) {
  const tools = [];
  const image = createImageGenerationTool({ ctx, config: config.imageGeneration, fetchImpl });
  if (image) tools.push(image);
  const video = createVideoGenerationTool({ ctx, config: config.videoGeneration, fetchImpl });
  if (video) tools.push(video);
  const tts = createTtsTool({ ctx, config: config.tts, fetchImpl });
  if (tts) tools.push(tts);
  return tools;
}
