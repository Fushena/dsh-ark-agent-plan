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

console.log('catalog.test.mjs: 全部断言通过（#2 探测状态三态 + #7 初始配置应用）');
