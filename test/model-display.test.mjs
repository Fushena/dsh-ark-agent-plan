/**
 * 模型命名与排序回归（2026-11-13 用户要求：两插件模型排列与命名一致）。
 * 与 qwen-token-plan-full/test/model-display.test.mjs 互为镜像：
 * 规则源 lib/model-display.js 在两个插件里必须逐字节相同（兄弟目录存在时校验）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { displayName, sortModels } from '../lib/model-display.js';
import { BUILTIN_CATALOG } from '../lib/catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));

test('display names follow one format per family', () => {
  assert.equal(displayName('deepseek-v4.1-flash'), 'DeepSeek-V4.1 Flash');
  assert.equal(displayName('deepseek-v4-1-flash-261017'), 'DeepSeek-V4.1 Flash 261017');
  assert.equal(displayName('glm-5.3'), 'GLM-5.3');
  assert.equal(displayName('kimi-k3'), 'Kimi K3');
  assert.equal(displayName('kimi-k3-1-pro'), 'Kimi K3.1 Pro');
  assert.equal(displayName('kimi-k2.7-code'), 'Kimi K2.7 Code');
  assert.equal(displayName('minimax-m3'), 'MiniMax M3');
  assert.equal(displayName('doubao-seed-evolving'), 'Doubao Seed Evolving');
  assert.equal(displayName('qwen3.8-max'), 'Qwen-3.8 Max');
});

test('catalog snapshot ships computed names and grouped newest-first order', () => {
  const models = BUILTIN_CATALOG.models;
  // 名字一律现算：内置 JSON 的旧 name 字段不再生效。
  for (const model of models) assert.equal(model.name, displayName(model.id), `${model.id} 的名字必须是 displayName 现算值`);
  // 家族分组连续：同 familyOrder 的条目不被其它家族插队。
  const orders = models.map((m) => m.familyOrder);
  const firstSeen = [];
  for (const order of orders) if (firstSeen[firstSeen.length - 1] !== order) firstSeen.push(order);
  assert.equal(new Set(firstSeen).size, firstSeen.length, '同家族必须连续成组');
  assert.deepEqual(firstSeen, [...firstSeen].sort((a, b) => a - b), '家族组按 order 升序');
});

test('model-display.js is byte-identical to the qwen-token-plan-full copy (drift guard)', () => {
  const sibling = path.join(here, '../../../qwen-token-plan-full/lib/model-display.js');
  if (!fs.existsSync(sibling)) return; // 独立 clone 时无兄弟目录，跳过
  const mine = fs.readFileSync(path.join(here, '../lib/model-display.js'), 'utf8');
  const theirs = fs.readFileSync(sibling, 'utf8');
  assert.equal(mine, theirs, '两个插件的 model-display.js 必须逐字节一致；改一处要同步两处');
});
