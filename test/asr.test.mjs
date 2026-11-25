import assert from 'node:assert/strict';
import test from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import { LlmRuntime } from '@deepseek-ai/dsh-llm';
import { createSpeechInput } from '../lib/asr.js';
import { ArkAgentPlanAdapter } from '../lib/adapter.js';

function testWav() {
  const data = Buffer.alloc(48);
  data.write('RIFF', 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(16000, 24);
  data.writeUInt32LE(32000, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write('data', 36);
  data.writeUInt32LE(data.length - 44, 40);
  return data;
}

function responseFrame(sequence, payload) {
  const gzip = gzipSync(JSON.stringify(payload));
  const header = Buffer.from([0x11, sequence < 0 ? 0x93 : 0x91, 0x11, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  header.writeInt32BE(sequence, 4);
  header.writeUInt32BE(gzip.length, 8);
  return Buffer.concat([header, gzip]);
}

test('ASR transcribes a DSH attachment across the real host file-projection boundary', async () => {
  const audio = testWav();
  const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), name: 'example.wav', bytes: audio.length };
  const reads = [];
  const frames = [];
  let closed = false;
  const ctx = new Context();
  const llm = new LlmRuntime(ctx);
  const catalog = {
    find: () => ({ id: 'doubao-seed-asr-2.0', transport: 'asr', input: ['text'], maxTokens: 0, contextWindow: 0 }),
  };
  const speech = createSpeechInput('ark', catalog);
  ctx.on('llm/stream', speech.intercept);
  const fetchImpl = () => assert.fail('ASR must not use the model HTTP or TTS endpoint');
  fetchImpl.openWebSocket = (url, headers) => {
    assert.equal(new URL(url).pathname, '/api/v3/plan/sauc/bigmodel_async');
    assert.equal(headers['X-Api-Resource-Id'], 'volc.seedasr.sauc.duration');
    assert.equal(headers['X-Api-Key'], 'fixture');
    const socket = new EventTarget();
    socket.send = (frame) => {
      frames.push(frame);
      const result = frames.length === 1 ? responseFrame(1, {}) : responseFrame(-2, { result: { text: '转写结果' } });
      queueMicrotask(() => socket.dispatchEvent(new MessageEvent('message', { data: Uint8Array.from(result).buffer })));
    };
    socket.close = () => { closed = true; };
    queueMicrotask(() => socket.dispatchEvent(new Event('open')));
    return socket;
  };
  const adapter = new ArkAgentPlanAdapter({
    ctx: {
      get(name) {
        if (name === 'credentials') return { resolve: async () => ({ value: 'fixture' }) };
        if (name === 'attachments') return { async *readFileStream(input) { reads.push(input); yield audio; } };
        return undefined;
      },
    },
    catalog, providerId: 'ark', displayName: 'Ark', apiKeyCandidates: ['TEST'],
    endpoint: 'https://ark.example.invalid/responses', pluginName: 'test',
    speechAttachment: speech.attachment, fetchImpl, requestTimeoutMs: 1000,
  });
  const stream = adapter.stream.bind(adapter);
  adapter.stream = (options) => {
    assert.ok(options.messages[0].content.every((block) => block.type === 'text'));
    return stream(options);
  };
  const dispose = llm.registerAdapter(['ark'], adapter);
  try {
    const chunks = [];
    for await (const chunk of llm.stream({
      provider: 'ark', model: 'doubao-seed-asr-2.0',
      messages: [{ role: 'user', content: [{ type: 'file', attachment: ref }] }],
    })) chunks.push(chunk);
    assert.deepEqual(reads, [ref]);
    assert.equal(frames.length, 2);
    assert.equal(frames[0][1], 0x11);
    assert.deepEqual(JSON.parse(gunzipSync(frames[0].subarray(12))).audio,
      { format: 'wav', codec: 'raw', rate: 16000, bits: 16, channel: 1 });
    assert.equal(frames[1][1], 0x23);
    assert.equal(frames[1].readInt32BE(4), -2);
    assert.deepEqual(gunzipSync(frames[1].subarray(12)), audio);
    assert.equal(chunks.find((chunk) => chunk.type === 'text-delta')?.text, '转写结果');
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    assert.equal(closed, true);
    assert.equal(speech.attachment(), undefined);
  } finally {
    if (typeof dispose === 'function') dispose();
    else dispose.dispose?.();
  }
});
