import assert from 'node:assert/strict';
import { buildChatRequestBody, chatToDshChunks } from '../lib/chat.js';

const enc = new TextEncoder();
const sseBody = (events) => new ReadableStream({
  start(controller) {
    controller.enqueue(enc.encode(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')));
    controller.close();
  },
});

const MODEL = { id: 'kimi-k2.7-code', transport: 'chat', reasoning: false, input: ['text'], maxTokens: 4096 };

// 1. chatToDshChunks：续片段中 function.name 为 "" 或 null 不得清空或覆写工具名为 "null"。
{
  const body = sseBody([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '"/a.txt"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: null, arguments: '}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ]);
  const chunks = [];
  for await (const chunk of chatToDshChunks(body, undefined)) chunks.push(chunk);
  const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call');
  assert.ok(end, '应产出 tool-call block-end');
  assert.equal(end.block.id, 'call_1', '空串 id 不得覆盖真实 id');
  assert.equal(end.block.name, 'read_file', '空串或 null 的 function.name 不得清空/覆写工具名');
  assert.equal(end.block.arguments, '{"path":"/a.txt"}');
}

// 2. chatMessages：user 消息内嵌 tool-result + 伴随块时，role:"tool" 必须紧跟 assistant(tool_calls)，
//    且纯元数据伴随块不得插入空 role:"user"。
{
  const body = await buildChatRequestBody({
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_1', name: 'search', arguments: '{"q":"a"}' }] },
      {
        role: 'user',
        content: [
          { type: 'tool-addition', name: 'extra' },
          { type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'result-1' }] },
        ],
      },
    ],
  }, MODEL);
  assert.deepEqual(body.messages.map((m) => m.role), ['assistant', 'tool'],
    '纯元数据伴随块不得在 assistant 与 tool 之间插入空 user 消息');
  assert.equal(body.messages[1].tool_call_id, 'call_1');
  assert.equal(body.messages[1].content, 'result-1');
}

// 3. chatMessages：user 消息同时包含 tool-result 与用户补充文本时，role:"tool" 必须在 role:"user" 之前。
{
  const body = await buildChatRequestBody({
    messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_2', name: 'search', arguments: '{}' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请总结上述结果' },
          { type: 'tool-result', toolCallId: 'call_2', content: [{ type: 'text', text: 'raw-data' }] },
        ],
      },
    ],
  }, MODEL);
  assert.deepEqual(body.messages.map((m) => m.role), ['assistant', 'tool', 'user'],
    'role:"tool" 必须排在伴随的 role:"user" 之前以符合 OpenAI Chat Completions 协议');
  assert.equal(body.messages[1].tool_call_id, 'call_2');
  assert.equal(body.messages[2].content, '请总结上述结果');
}

console.log('chat.test.mjs: 全部断言通过（tool_calls 续传空/null 工具名防护 + tool/user 消息顺序）');
