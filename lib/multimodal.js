import { LlmError } from "@deepseek-ai/dsh-llm";
import { sanitizeText } from "./content.js";

/**
 * 多模态模型请求体构建。
 * 支持：images/generations、contents/generations/tasks、audio/speech、embeddings
 */
export async function buildMultimodalRequestBody(options, model) {
  const transport = model.transport;
  const text = options.messages
    ?.filter((m) => m.role === "user")
    .flatMap((m) => m.content?.filter((b) => b.type === "text").map((b) => b.text) ?? [])
    .join("\n") ?? "";

  if (transport === "images") {
    return {
      model: model.id,
      prompt: sanitizeText(text),
      size: "1024x1024",
      quality: "standard",
      stream: true,
    };
  }

  if (transport === "video") {
    return {
      model: model.id,
      prompt: sanitizeText(text),
      ratio: "16:9",
      resolution: "720p",
      duration: 5,
      stream: true,
    };
  }

  if (transport === "audio") {
    return {
      model: model.id,
      input: sanitizeText(text),
      voice: "zh_female_cancan_mars_bigtts",
      stream: true,
    };
  }

  if (transport === "embedding") {
    return {
      model: model.id,
      input: sanitizeText(text),
      stream: true,
    };
  }

  throw new LlmError(`不支持的多模态 transport: ${transport}`, "UNSUPPORTED_CONTENT");
}

/**
 * 多模态 SSE 响应解析。
 * 图像/视频/音频/向量的响应格式与对话模型不同，需要分别处理。
 */
export async function* multimodalToDshChunks(body, signal, transport) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal?.aborted) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") return;
          try {
            const event = JSON.parse(data);
            yield* parseMultimodalEvent(event, transport);
          } catch {
            // 非 JSON 行忽略
          }
        }
      }
    }
  } finally {
    // 先 cancel 再 releaseLock：[DONE] 提前 return / abort break / 异常路径都要
    // 取消底层 HTTP body，否则连接挂到 GC（对照 qwen media-tools.js 的下载闸写法）。
    try { await reader.cancel().catch(() => {}); } catch { /* already closed */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/** 上游返回的媒体 URL 只接受 https（http/其它协议不作为附件或文本交给 GUI）。 */
function safeHttpsUrl(raw) {
  try {
    const parsed = new URL(String(raw));
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch { return null; }
}

function* parseMultimodalEvent(event, transport) {
  if (event.type === "error") {
    yield { type: "finish", reason: { kind: "error", failure: { message: event.error?.message ?? "多模态生成失败", code: "PROVIDER_ERROR" } } };
    return;
  }

  if (transport === "images") {
    if (event.type === "image_generation.partial" || event.type === "image_generation.completed") {
      const url = safeHttpsUrl(event.url ?? event.image_url);
      if (url) {
        yield {
          type: "block-start",
          index: 0,
          blockType: "image",
        };
        yield {
          type: "block-end",
          index: 0,
          block: {
            type: "image",
            attachment: {
              attachmentId: `ark-img-${Date.now()}`,
              mediaType: "image/png",
              bytes: 0,
              width: 1024,
              height: 1024,
              name: "generated.png",
              url,
            },
          },
        };
      }
    }
    if (event.type === "image_generation.completed") {
      yield { type: "finish", reason: { kind: "stop" } };
    }
    return;
  }

  if (transport === "video") {
    if (event.type === "video_generation.progress") {
      yield {
        type: "text-delta",
        index: 0,
        text: `[视频生成中 ${event.progress ?? 0}%] `,
      };
    }
    if (event.type === "video_generation.completed") {
      const url = safeHttpsUrl(event.url ?? event.video_url);
      if (url) {
        yield {
          type: "block-start",
          index: 0,
          blockType: "text",
        };
        yield {
          type: "text-delta",
          index: 0,
          text: `视频已生成: ${url}`,
        };
        yield {
          type: "block-end",
          index: 0,
          block: { type: "text", text: `视频已生成: ${url}` },
        };
      }
      yield { type: "finish", reason: { kind: "stop" } };
    }
    return;
  }

  if (transport === "audio") {
    if (event.type === "audio.speech.chunk" || event.type === "audio.speech.completed") {
      const audio = event.audio ?? event.data;
      if (audio) {
        yield {
          type: "text-delta",
          index: 0,
          text: `[音频数据: ${audio.length} bytes] `,
        };
      }
    }
    if (event.type === "audio.speech.completed") {
      yield { type: "finish", reason: { kind: "stop" } };
    }
    return;
  }

  if (transport === "embedding") {
    if (event.type === "embedding.completed" || event.data) {
      const embedding = event.data?.[0]?.embedding ?? event.embedding;
      if (embedding) {
        yield {
          type: "block-start",
          index: 0,
          blockType: "text",
        };
        yield {
          type: "text-delta",
          index: 0,
          text: JSON.stringify(embedding.slice(0, 10)) + "...",
        };
        yield {
          type: "block-end",
          index: 0,
          block: { type: "text", text: `向量维度: ${embedding.length}` },
        };
      }
      yield { type: "finish", reason: { kind: "stop" } };
    }
    return;
  }

  // 未知事件类型：只报事件名，不透传上游可控的 JSON 内容（提示注入面收敛）。
  if (event.type || event.data) {
    const name = typeof event.type === "string" ? event.type.replace(/[^\w.\-]/g, "").slice(0, 60) : "data";
    yield {
      type: "text-delta",
      index: 0,
      text: `[未识别的多模态事件: ${name || "data"}] `,
    };
  }
}
