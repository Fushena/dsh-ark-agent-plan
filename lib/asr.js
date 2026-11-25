import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";

const ASR_URL = "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async";
const ASR_RESOURCE = "volc.seedasr.sauc.duration";
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SEGMENT_MS = 200;
const SEGMENT_BYTES = 16000 * 2 * SEGMENT_MS / 1000;

export function latestSpeechAttachment(messages) {
  const user = messages?.findLast((message) => message.role === "user");
  return user?.content?.findLast((block) => block.type === "file"
    && /\.wav$/i.test(block.attachment?.name ?? ""))?.attachment;
}

/** Preserve the real file reference before DSH projects file blocks to text. */
export function createSpeechInput(providerId, catalog) {
  const current = new AsyncLocalStorage();
  return {
    attachment: () => current.getStore(),
    intercept(options, next) {
      const ref = options.provider === providerId && catalog.find(options.model)?.transport === "asr"
        ? latestSpeechAttachment(options.messages) : undefined;
      if (!ref) return next();
      return (async function* () {
        const stream = current.run(ref, () => next()[Symbol.asyncIterator]());
        try {
          while (true) {
            const item = await current.run(ref, () => stream.next());
            if (item.done) return;
            yield item.value;
          }
        } finally {
          await current.run(ref, () => stream.return?.());
        }
      })();
    },
  };
}

function isSupportedWav(data) {
  if (data.length < 44 || data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") return false;
  let pcm = false;
  let samples = false;
  for (let offset = 12; offset + 8 <= data.length;) {
    const kind = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > data.length) return false;
    if (kind === "fmt " && size >= 16) {
      pcm = data.readUInt16LE(start) === 1 && data.readUInt16LE(start + 2) === 1
        && data.readUInt32LE(start + 4) === 16000 && data.readUInt16LE(start + 14) === 16;
    }
    if (kind === "data") samples = size > 0 && size % 2 === 0;
    offset = start + size + (size % 2);
  }
  return pcm && samples;
}

async function readAudio(ref, attachments, signal) {
  if (!ref) throw new LlmError("请在本轮上传一份 WAV 音频附件", "UNSUPPORTED_CONTENT");
  if (typeof attachments?.readFileStream !== "function") {
    throw new LlmError("语音识别需要支持读取文件的 DSH 附件服务", "UNSUPPORTED_CONTENT");
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of attachments.readFileStream(ref, signal)) {
    signal?.throwIfAborted();
    bytes += chunk.byteLength;
    if (bytes > MAX_AUDIO_BYTES) throw new LlmError("WAV 附件超过 10 MiB", "UNSUPPORTED_CONTENT");
    chunks.push(chunk);
  }
  const data = Buffer.concat(chunks, bytes);
  if (!isSupportedWav(data)) {
    throw new LlmError("请上传 16 kHz、16 位、单声道 PCM WAV 文件", "UNSUPPORTED_CONTENT");
  }
  return data;
}

function requestFrame(type, sequence, payload) {
  const compressed = gzipSync(payload);
  const header = Buffer.alloc(12);
  header[0] = 0x11; // Protocol v1, four-byte base header.
  header[1] = (type << 4) | (sequence < 0 ? 3 : 1);
  header[2] = 0x11; // Gzip and the serialization marker used by the Plan ASR client.
  header.writeInt32BE(sequence, 4);
  header.writeUInt32BE(compressed.length, 8);
  return Buffer.concat([header, compressed]);
}

function readResponseFrame(value) {
  const data = Buffer.from(value);
  const malformed = () => new LlmError("语音识别返回无效的数据帧", "MALFORMED_RESPONSE");
  if (data.length < 8 || data.length > MAX_RESPONSE_BYTES || data[0] >> 4 !== 1) throw malformed();
  const type = data[1] >> 4;
  const flags = data[1] & 0x0f;
  let offset = (data[0] & 0x0f) * 4;
  if (offset < 4 || (type !== 9 && type !== 15)) throw malformed();
  if (flags & 1) offset += 4; // Sequence.
  if (flags & 4) offset += 4; // Optional event number.
  if (offset + (type === 15 ? 8 : 4) > data.length) throw malformed();
  if (type === 15) {
    const code = data.readUInt32BE(offset);
    throw new LlmError(`语音识别服务返回错误 ${code}`, "PROVIDER_ERROR");
  }
  const size = data.readUInt32BE(offset);
  const payload = data.subarray(offset + 4);
  if (payload.length !== size) throw malformed();
  let result;
  if (size) {
    try {
      const compression = data[2] & 0x0f;
      if (data[2] >> 4 !== 1 || compression > 1) throw malformed();
      const json = compression === 1 ? gunzipSync(payload, { maxOutputLength: MAX_RESPONSE_BYTES }) : payload;
      result = JSON.parse(json.toString("utf8"))?.result;
    } catch {
      throw malformed();
    }
  }
  return { done: Boolean(flags & 2), text: result?.text };
}

async function sendAudio(socket, audio, signal, touch) {
  for (let offset = 0, sequence = 2; offset < audio.length; offset += SEGMENT_BYTES, sequence += 1) {
    signal.throwIfAborted();
    const end = offset + SEGMENT_BYTES;
    const last = end >= audio.length;
    socket.send(requestFrame(2, last ? -sequence : sequence, audio.subarray(offset, end)));
    touch?.();
    if (!last) await delay(SEGMENT_MS, undefined, { signal });
  }
}

/** Send a WAV attachment on the documented Agent Plan ASR WebSocket. */
export async function transcribeSpeech({ speechAttachment, attachments, apiKey, signal, touch, openWebSocket }) {
  const audio = await readAudio(speechAttachment, attachments, signal);
  signal?.throwIfAborted();
  const requestId = randomUUID();
  const headers = {
    ...attributionHeaders(),
    "X-Api-Key": apiKey,
    "X-Api-Resource-Id": ASR_RESOURCE,
    "X-Api-Request-Id": requestId,
    "X-Api-Connect-Id": requestId,
    "X-Api-Sequence": "-1",
  };
  const init = Buffer.from(JSON.stringify({
    user: { uid: "dsh" },
    audio: { format: "wav", codec: "raw", rate: 16000, bits: 16, channel: 1 },
    request: { model_name: "bigmodel", enable_itn: true, enable_punc: true },
  }));
  const socket = openWebSocket ? openWebSocket(ASR_URL, headers) : new WebSocket(ASR_URL, { headers });
  socket.binaryType = "arraybuffer";
  const sender = new AbortController();
  const listeners = new AbortController();
  const listen = { signal: listeners.signal };
  let abort;
  let sending = false;
  let text = "";
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
      socket.addEventListener("open", () => {
        try { socket.send(requestFrame(1, 1, init)); } catch (error) { reject(error); }
      }, listen);
      socket.addEventListener("message", ({ data }) => {
        touch?.();
        try {
          const frame = readResponseFrame(data);
          if (typeof frame.text === "string" && frame.text) text = frame.text;
          if (frame.done) {
            if (text.trim()) resolve(text);
            else reject(new LlmError("语音识别未返回文字", "EMPTY_RESPONSE"));
          } else if (!sending) {
            sending = true;
            void sendAudio(socket, audio, sender.signal, touch).catch(reject);
          }
        } catch (error) { reject(error); }
      }, listen);
      socket.addEventListener("error", () => reject(new LlmError("无法连接语音识别服务", "TRANSPORT")), listen);
      socket.addEventListener("close", () => reject(new LlmError("语音识别连接在最终结果前关闭", "STREAM_CLOSED")), listen);
    });
  } finally {
    sender.abort();
    listeners.abort();
    signal?.removeEventListener("abort", abort);
    socket.close();
  }
}
