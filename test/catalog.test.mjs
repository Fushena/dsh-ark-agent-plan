import assert from 'node:assert/strict';

/**
 * 目录探测与配置应用回归脚本（无需网络、无需真实凭据）：
 *   #2 探测把 401/403/429/5xx 当「模型可用」→ 整份文档候选被发布（假模型进选择器）
 *   #7 初始快照不应用 excludes/overrides
 *
 * 跑法（插件仓库根目录）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     --import ./test/runtime.mjs ./test/catalog.test.mjs
 */

const { DynamicCatalog } = await import('../lib/catalog.js');

const DOCS_BODY = 'glm-5.3\ndeepseek-v4.1-flash\nkimi-k3.1-pro-260201\n';

/** 造一个注入式目录：文档站点固定返回 DOCS_BODY；探测端点按 status 应答。 */
function makeCatalog({ probeStatus, excludes = [], overrides = [] } = {}) {
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('docs.example.invalid')) {
      return new Response(DOCS_BODY, { status: 200, headers: { 'content-type': 'text/html' } });
    }
    const body = init.body ? JSON.parse(init.body) : {};
    // 身份校验调用（带 input）；探测调用只有 model。
    if (body.input === 'hi') {
      return new Response(JSON.stringify({ model: body.model }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (probeStatus === 200) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response('{"error":"x"}', { status: probeStatus });
  };
  const credentials = { resolve: async () => ({ value: 'TEST_KEY' }) };
  const ctx = { get: (name) => (name === 'credentials' ? credentials : undefined), logger: { info() {}, warn() {}, debug() {} } };
  return new DynamicCatalog({
    ctx,
    probeUrl: 'https://ark.example.invalid/api/plan/v3/responses',
    apiKeyCandidates: ['T'],
    pluginName: 'test',
    overrides,
    excludes,
    logger: { info() {}, warn() {}, debug() {} },
    fetchImpl,
    docSources: ['https://docs.example.invalid/models'],
  });
}

// #2 凭据失效 / 限流 / 网关故障时，探测没有任何肯定结论 → 刷新失败、旧目录保留，
//     绝不能把整份文档候选当作存活发布（修前这三个状态都会 published 假模型）。
for (const status of [401, 403, 429, 503]) {
  const catalog = makeCatalog({ probeStatus: status });
  const before = catalog.snapshot().models.length;
  const changed = await catalog.refresh();
  const after = catalog.snapshot();
  assert.equal(changed, false, `HTTP ${status} 时刷新必须判定失败`);
  assert.equal(after.models.length, before, `HTTP ${status} 时不得改动已发布目录`);
  assert.ok(after.lastError, `HTTP ${status} 时必须记录 lastError 供面板展示`);
}

// 对照：全 200 时正常发布新模型（证明上面的收紧没有把正常路径掐死）。
{
  const catalog = makeCatalog({ probeStatus: 200 });
  const before = catalog.snapshot().models.length;
  const changed = await catalog.refresh();
  assert.equal(changed, true, '探测全部可用时必须正常发布');
  assert.ok(catalog.snapshot().models.length >= before, '正常刷新不得减少模型');
}

// #7 excludes 在**未 refresh** 前就要生效（首次刷新失败时用户配置不能被忽略）。
{
  const catalog = makeCatalog({ excludes: ['glm'] });
  const ids = catalog.snapshot().models.map((model) => model.id);
  assert.equal(ids.some((id) => id.startsWith('glm')), false, 'excludes 必须在初始快照即生效');
}

// #7 overrides 同理。
{
  const catalog = makeCatalog({ overrides: [{ id: 'deepseek-v4-flash', name: 'X' }] });
  const model = catalog.snapshot().models.find((entry) => entry.id === 'deepseek-v4-flash');
  assert.equal(model?.name, 'X', 'overrides 必须在初始快照即生效');
}

// ── 审计#3 / #7 / #10 的可控身份校验目录工厂 ──────────────────────────────
// fetchImpl 完全注入：文档站固定 DOCS_BODY；零 token 探测恒 200（alive）；
// 身份校验（input==='hi'）的 served 回显 / 状态码由调用方决定。
function catalogWith(fetchImpl, { overrides = [], excludes = [] } = {}) {
  const credentials = { resolve: async () => ({ value: 'TEST_KEY' }) };
  const ctx = { get: (name) => (name === 'credentials' ? credentials : undefined), logger: { info() {}, warn() {}, debug() {} } };
  return new DynamicCatalog({
    ctx, probeUrl: 'https://ark.example.invalid/api/plan/v3/responses',
    apiKeyCandidates: ['T'], pluginName: 'test', overrides, excludes,
    logger: { info() {}, warn() {}, debug() {} }, fetchImpl,
    docSources: ['https://docs.example.invalid/models'],
  });
}
const aliveProbe = async (url, init = {}) => {
  if (String(url).includes('docs.example.invalid')) return new Response(DOCS_BODY, { status: 200 });
  const body = init.body ? JSON.parse(init.body) : {};
  if (body.input === 'hi') return new Response(JSON.stringify({ model: body.model }), { status: 200 });
  return new Response('{}', { status: 200 });
};

// 审计#3：身份校验前缀无边界 —— glm-5.3-flash 回显 glm-5.3、kimi-k3 回显
//   kimi-k3-1-pro 都是**不同模型**，必须剔除；真正相等 / 日期版本别名仍放行。
{
  const servedMap = {
    'glm-5.3-flash': 'glm-5.3',
    'kimi-k3': 'kimi-k3-1-pro',
    'deepseek-v4.1-flash': 'deepseek-v4-1-flash-261017', // 合法日期别名，应保留
  };
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('docs.example.invalid')) return new Response(DOCS_BODY, { status: 200 });
    const body = init.body ? JSON.parse(init.body) : {};
    if (body.input === 'hi') return new Response(JSON.stringify({ model: servedMap[body.model] ?? body.model }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const catalog = catalogWith(fetchImpl);
  await catalog.refresh();
  const ids = catalog.snapshot().models.map((model) => model.id);
  assert.equal(ids.includes('glm-5.3-flash'), false, '审计#3：glm-5.3-flash 回显 glm-5.3 是不同模型，应剔除');
  assert.equal(ids.includes('kimi-k3'), false, '审计#3：kimi-k3 回显 kimi-k3-1-pro 是不同模型，应剔除');
  assert.ok(ids.includes('glm-5.3'), '审计#3：glm-5.3 本身应保留');
  assert.ok(ids.includes('deepseek-v4.1-flash'), '审计#3：日期版本别名仍是同模型，应保留');
}

// 审计#7：瞬时故障（429 → ok:true,served:null）不得被 6h 缓存固化。
//   首次 429 暂留；恢复 200 且回显 glm-5.3 后，下一次刷新必须能剔除假模型。
{
  const identityCalls = new Map();
  const fetchImpl = async (url, init = {}) => {
    if (String(url).includes('docs.example.invalid')) return new Response(DOCS_BODY, { status: 200 });
    const body = init.body ? JSON.parse(init.body) : {};
    if (body.input === 'hi') {
      if (body.model === 'glm-5.3-flash') {
        const n = (identityCalls.get('glm-5.3-flash') ?? 0) + 1;
        identityCalls.set('glm-5.3-flash', n);
        if (n === 1) return new Response('{"error":"rate limited"}', { status: 429 });
        return new Response(JSON.stringify({ model: 'glm-5.3' }), { status: 200 });
      }
      return new Response(JSON.stringify({ model: body.model }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  };
  const catalog = catalogWith(fetchImpl);
  await catalog.refresh();
  assert.ok(catalog.snapshot().models.some((model) => model.id === 'glm-5.3-flash'), '审计#7：首次 429 是瞬时故障，不应判假模型，暂留');
  await catalog.refresh();
  assert.equal(catalog.snapshot().models.some((model) => model.id === 'glm-5.3-flash'), false, '审计#7：恢复 200 回显 glm-5.3 后应剔除，不得被 6h 缓存固化');
}

// 审计#10：signature 只比 id —— 仅改 override 的 name/规格（id 不变）也应 changed=true。
{
  const overrides = [{ id: 'glm-5.3', name: 'Override-A' }];
  const catalog = catalogWith(aliveProbe, { overrides });
  await catalog.refresh();                 // 建立基线
  const stable = await catalog.refresh();  // 无任何变化
  assert.equal(stable, false, '审计#10：无变化的刷新应 changed=false（signature 稳定，不能恒 true）');
  overrides[0].name = 'Override-B';        // 只改 name，id 不变
  const changed = await catalog.refresh();
  assert.equal(changed, true, '审计#10：仅改 override name（id 不变）也应触发 changed=true');
}

console.log('catalog.test.mjs: 全部断言通过（#2 探测状态三态 + #7 初始配置应用 + 审计#3 身份边界 / #7 瞬时故障不缓存 / #10 规格 signature）');
