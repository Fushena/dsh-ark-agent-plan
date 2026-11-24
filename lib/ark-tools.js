/**
 * DSH 工具注册：将 Ark 的生图 / 生视频 / TTS 能力封装为 DSH 本地工具。
 *
 * 每个工具返回标准 DSH tool 描述对象（name / description / parameters / execute），
 * 由 index.js 在 apply() 中注册到 ctx.tools。
 *
 * 所有工具都需要：
 *   - 对应的 Config 子对象 enabled === true
 *   - model 字段非空（endpoint id）
 *   - 可用的 API key（通过 credentials 服务解析）
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { generateImage, createVideoTask, waitVideoTask, synthesizeSpeech } from "./ark-api.js";
import { resolveApiKey } from "./apikey.js";

const TTS_MAX_BYTES = 50 * 1024 * 1024; // 落盘上限：base64 解码后 50MB

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
 * base64 音频落盘（与 qwen-token-plan-full 的 TTS 落盘同模式）：
 * 本地生成文件名（时间戳+UUID，上游数据不参与路径）、.part 临时文件原子改名、
 * 失败清理、大小上限。DSH 对话无法内嵌播放音频，给本地文件是唯一可用出口。
 */
async function saveAudioBase64(base64, dir, signal) {
  const bytes = Buffer.from(String(base64), "base64");
  if (bytes.length === 0) throw new Error("TTS 返回了空的音频数据");
  if (bytes.length > TTS_MAX_BYTES) throw new Error(`TTS 音频超过 ${TTS_MAX_BYTES / 1024 / 1024}MB 上限`);
  await mkdir(dir, { recursive: true });
  const name = `ark-speech-${stamp()}-${randomUUID().slice(0, 8)}.mp3`;
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
          description: '图片尺寸。可选 "512x512"、"1024x1024"、"2048x2048"、"adaptive"。',
          default: config.defaultSize || "1024x1024",
        },
        quality: {
          type: "string",
          description: '图片质量。"standard"（标准）或 "hd"（高清）。',
          default: config.defaultQuality || "standard",
        },
        n: {
          type: "number",
          description: "生成图片数量（1-4）。",
          default: 1,
          minimum: 1,
          maximum: 4,
        },
      },
      required: ["prompt"],
    },
    async execute(args, { signal } = {}) {
      const apiKey = await resolveApiKey(ctx, [apiKeyEnv], pluginName);
      const result = await generateImage({
        fetchImpl,
        apiKey,
        model: config.model,
        prompt: args.prompt,
        size: args.size || config.defaultSize || "1024x1024",
        quality: args.quality || config.defaultQuality || "standard",
        n: args.n || 1,
        watermark: true,
        responseFormat: "url",
        signal,
      });
      const images = (result.data ?? []).map((item, i) => ({
        index: i + 1,
        url: item.url,
        ...(item.b64_json ? { b64_json: item.b64_json.slice(0, 100) + "…" } : {}),
      }));
      return JSON.stringify({ success: true, images }, null, 2);
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
          description: '画幅比例。"16:9"、"9:16"、"1:1"、"4:3"、"3:4"、"21:9"。',
          default: config.defaultRatio || "16:9",
        },
        resolution: {
          type: "string",
          description: '分辨率。"480p"、"720p"、"1080p"。',
          default: config.defaultResolution || "720p",
        },
        duration: {
          type: "number",
          description: "视频时长（秒）。5 或 10。",
          default: config.defaultDuration || 5,
          enum: [5, 10],
        },
      },
      required: ["prompt"],
    },
    async execute(args, { signal, onProgress } = {}) {
      const apiKey = await resolveApiKey(ctx, [apiKeyEnv], pluginName);
      const task = await createVideoTask({
        fetchImpl,
        apiKey,
        model: config.model,
        prompt: args.prompt,
        image: args.image || undefined,
        ratio: args.ratio || config.defaultRatio || "16:9",
        resolution: args.resolution || config.defaultResolution || "720p",
        duration: args.duration || config.defaultDuration || 5,
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
      return JSON.stringify({
        success: true,
        taskId,
        videoUrl,
        duration: args.duration || config.defaultDuration || 5,
      }, null, 2);
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
  if (!config?.enabled || !config.model) return null;
  const apiKeyEnv = config.apiKeyEnv || "ARK_API_KEY";
  const pluginName = "dsh-ark-agent-plan";

  return {
    name: "ark_text_to_speech",
    description: "使用火山方舟 TTS 将文本转为语音，自动下载保存为本地 MP3 文件并返回文件路径。音频无法在对话里内嵌播放，请引导用户打开返回的本地文件收听。",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "要合成语音的文本内容。",
        },
        voice: {
          type: "string",
          description: "音色 ID。常用值：zh_female_cancan_mars_bigtts（灿灿女声）、zh_male_shaonianzixin_mars_bigtts（少年梓辛男声）。",
          default: config.defaultVoice || "zh_female_cancan_mars_bigtts",
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
    async execute(args, exec = {}) {
      const { signal } = exec;
      const text = String(args.text ?? "").trim();
      if (!text) throw new Error("text 不能为空");
      if (text.length > 10_000) throw new Error("text 超过 10000 字符上限，请分段合成");
      const apiKey = await resolveApiKey(ctx, [apiKeyEnv], pluginName);
      const result = await synthesizeSpeech({
        fetchImpl,
        apiKey,
        model: config.model,
        text,
        voice: args.voice || config.defaultVoice || "zh_female_cancan_mars_bigtts",
        encoding: "mp3",
        speedRatio: args.speed_ratio || 1.0,
        signal,
      });
      // 自动落盘 + 给文件（对话无法内嵌播放音频，base64 截断返回等于把音频丢了）。
      const dir = await resolveWorkDir(ctx, exec);
      const saved = await saveAudioBase64(result.data, dir, signal);
      return JSON.stringify({
        success: true,
        format: "mp3",
        path: saved.path,
        bytes: saved.bytes,
        characters: text.length,
        message: `语音合成完成，已保存到本地文件：${saved.path}（${saved.bytes} 字节）。请引导用户打开该文件收听。`,
      }, null, 2);
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
