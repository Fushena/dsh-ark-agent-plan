import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/**
 * 徽标示数窗口选择回归脚本。
 *
 * 用户要求（2026-11-10）：输入行下方的「◔ Medium · n%」固定显示**近 5 小时**窗口的
 * 已用百分比，而不是「三条窗口里占用最高的那条」。改动的诱因是同一时刻 weekly 74%、
 * fiveHour 72%，旧逻辑会显示 74%（看着像更紧），而用户想看的是「现在这波用了多少」。
 *
 * 这个脚本用 vm 把 lib/client.js 的工厂函数跑起来（用桩 React + 桩 document），
 * 直接断言 fiveHourWindow / percentText 的行为，不需要真实浏览器与 React。
 *
 * 跑法（插件仓库根目录）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     --import ./test/runtime.mjs ./test/client-badge.test.mjs
 */

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** 用最小桩把工厂跑出 exports。 */
function loadClientExports() {
  const noop = () => {};
  const stubReact = {
    createElement: () => null, useState: () => [null, noop], useEffect: noop,
    useLayoutEffect: noop, useRef: () => ({ current: null }), useCallback: (fn) => fn,
    Fragment: Symbol('Fragment'),
  };
  let captured;
  const sandbox = {
    window: {
      __ModuleLoader__: { load: ({ factory }) => { captured = factory((name) => (name === 'react' ? stubReact : {})); } },
    },
    document: { documentElement: { getAttribute: () => 'zh' }, body: {}, createElement: () => ({ setAttribute: noop, textContent: '' }), head: { appendChild: noop }, querySelector: () => null, getElementById: () => null },
    navigator: { language: 'zh-CN' },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  return captured;
}

const client = loadClientExports();
const { fiveHourWindow, percentText } = client;
assert.equal(typeof fiveHourWindow, 'function', 'client 必须导出 fiveHourWindow 供测试');
assert.equal(client.apply !== undefined, true, 'apply 仍必须存在（模块加载器要有它）');

// 生成一条与宿主真实返回同形的窗口数据。
const windowOf = (key, percentUsed) => ({ key, percentUsed, quota: 100, used: percentUsed, remaining: 100 - percentUsed, resetAt: 0 });

// A. 核心行为：weekly 更高时，徽标仍取 fiveHour（这正是用户报的那个场景）。
{
  const data = { windows: [windowOf('fiveHour', 72.44), windowOf('weekly', 74.05), windowOf('monthly', 38.27)] };
  const shown = fiveHourWindow(data);
  assert.equal(shown.key, 'fiveHour', 'A: 必须取 fiveHour，即使 weekly 的百分比更高');
  assert.equal(percentText(shown.percentUsed), '72.4%', 'A: 徽标文案应为 fiveHour 的百分比');
}

// B. fiveHour 恰好最高时也取它（不是「碰巧对了」）。
{
  const data = { windows: [windowOf('fiveHour', 88), windowOf('weekly', 20), windowOf('monthly', 5)] };
  assert.equal(fiveHourWindow(data).key, 'fiveHour', 'B: fiveHour 最高时仍取 fiveHour');
}

// C. 窗口顺序变化不影响结果（不能依赖数组第 0 项）。
{
  const data = { windows: [windowOf('monthly', 30), windowOf('weekly', 90), windowOf('fiveHour', 10)] };
  assert.equal(fiveHourWindow(data).key, 'fiveHour', 'C: 必须按 key 查找，不能按位置');
}

// D. 服务端没有 fiveHour（接口改版/降级）→ 退回占用最高的一项，不退化成空。
{
  const data = { windows: [windowOf('weekly', 90), windowOf('monthly', 30)] };
  assert.equal(fiveHourWindow(data).key, 'weekly', 'D: 缺 fiveHour 时退回最高占用项');
}

// E. 完全没有窗口 → null（徽标显示「额度」占位）。
{
  assert.equal(fiveHourWindow({}), null, 'E: 无数据时返回 null');
  assert.equal(fiveHourWindow(undefined), null, 'E: undefined 时返回 null');
  assert.equal(fiveHourWindow({ windows: [] }), null, 'E: 空窗口数组返回 null');
}

// F. percentText 保留一位小数、非数字退化。
{
  assert.equal(percentText(0.06), '0.1%', 'F: 四舍五入到一位小数');
  assert.equal(percentText(100), '100%', 'F: 整数不带小数');
  assert.equal(percentText(NaN), '—', 'F: 非数字显示占位符');
}

// G.（2026-11-24 审计 A4 客户端侧）慢 GET 晚到不得覆盖新 POST 的结果。
// 用有状态 hooks 桩把 Badge 渲染一次，捕获第一个 useCallback（即 load 闭包）；
// 门控 fetch 让第一次 GET 挂住，期间发起 POST（手动刷新）先完成，再放行旧 GET
// —— 面板数据必须停留在新值。
{
  const noop = () => {};
  const hookStates = []; const hookRefs = [];
  let hookIndex = 0; let refIndex = 0; let load = null;
  const stubReact = {
    createElement: (type) => {
      if (type?.name === 'Badge') { hookIndex = 0; refIndex = 0; type({}); }
      return null;
    },
    useState: (initial) => {
      const i = hookIndex++;
      if (!(i in hookStates)) hookStates[i] = typeof initial === 'function' ? initial() : initial;
      return [hookStates[i], (v) => { hookStates[i] = typeof v === 'function' ? v(hookStates[i]) : v; }];
    },
    useEffect: noop, useLayoutEffect: noop,
    useRef: (initial) => { const i = refIndex++; if (!(i in hookRefs)) hookRefs[i] = { current: initial }; return hookRefs[i]; },
    useCallback: (fn) => { if (!load) load = fn; return fn; }, // Badge 里第一个 useCallback 就是 load
    Fragment: Symbol('Fragment'),
  };
  const pending = [];
  const gatedFetch = (url, init) => new Promise((resolve) => { pending.push({ url, init, resolve }); });
  const respond = (entry, payload) => entry.resolve({ ok: true, status: 200, json: async () => payload });
  let captured;
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => { captured = factory((name) => (name === 'react' ? stubReact : {})); } }, addEventListener: noop, removeEventListener: noop },
    document: { documentElement: { getAttribute: () => 'zh' }, body: {}, createElement: () => ({ setAttribute: noop, textContent: '' }), head: { appendChild: noop }, querySelector: () => null, getElementById: () => null },
    navigator: { language: 'zh-CN' },
    fetch: gatedFetch,
    console, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  // 经 apply→slots 注入拿到徽标渲染函数，再渲染一次建立 hooks 状态与 load 闭包。
  let BadgeRender = null;
  const slots = {
    inject: (_name, fn) => { fn(); return () => {}; },
    register: (_seat, render) => { BadgeRender = render; return () => {}; },
  };
  captured.apply({ get: (n) => (n === 'slots' ? slots : undefined), effect: (fn) => fn(), logger: { warn: noop } });
  assert.ok(BadgeRender, 'G: 应能经 slots.register 拿到徽标渲染函数');
  BadgeRender();
  assert.ok(load, 'G: 应捕获到 load 闭包');
  // 发起 GET（轮询）→ 挂住；再发起 POST（手动刷新）→ 立即完成。
  const getDone = load(false);
  assert.equal(pending.length, 1, 'G: 第一次 load 应发出请求');
  assert.equal(pending[0].init.method, 'GET');
  const postDone = load(true);
  assert.equal(pending.length, 2);
  assert.equal(pending[1].init.method, 'POST');
  const fresh = { ok: true, data: { planType: 'pro', windows: [{ key: 'fiveHour', percentUsed: 10, quota: 100, used: 10, remaining: 90 }] } };
  respond(pending[1], fresh);
  await postDone;
  // useState 顺序：open(0), data(1), error(2), anchor(3), mine(4)。
  assert.equal(hookStates[1]?.windows?.[0]?.used, 10, 'G: POST 完成后 data 应为新值 Used=10');
  // 放行旧 GET（Used=90 的旧值）——不得覆盖。
  const stale = { ok: true, data: { planType: 'pro', windows: [{ key: 'fiveHour', percentUsed: 90, quota: 100, used: 90, remaining: 10 }] } };
  respond(pending[0], stale);
  await getDone;
  assert.equal(hookStates[1]?.windows?.[0]?.used, 10, `G: 晚到的旧 GET 不得覆盖新值（应仍为 10，实际 ${hookStates[1]?.windows?.[0]?.used}）`);
}

// H. 打开面板（setOpen(true) + load(true)）时，轮询 useEffect 不得随 open 变化重跑并发出 GET 覆盖 POST。
{
  const noop = () => {};
  const hookStates = []; const hookRefs = []; const hookCallbacks = []; const effectRecords = [];
  let hookIndex = 0; let refIndex = 0; let cbIndex = 0; let effectIndex = 0;
  let buttonProps = null;
  let BadgeComp = null;
  const depsChanged = (prev, next) => !prev || !next || prev.length !== next.length || next.some((d, i) => !Object.is(d, prev[i]));
  const pending = [];
  const timers = [];
  const gatedFetch = (url, init) => new Promise((resolve) => { pending.push({ url, init, resolve }); });
  const respond = (entry, payload) => entry.resolve({ ok: true, status: 200, json: async () => payload });

  const stubReact = {
    createElement: (type, props) => {
      if (type?.name === 'Badge') BadgeComp = type;
      if (type === 'button' && props?.className === 'arkq-badge') buttonProps = props;
      return null;
    },
    useState: (initial) => {
      const i = hookIndex++;
      if (!(i in hookStates)) hookStates[i] = typeof initial === 'function' ? initial() : initial;
      return [hookStates[i], (v) => { hookStates[i] = typeof v === 'function' ? v(hookStates[i]) : v; }];
    },
    useEffect: (fn, deps) => {
      const i = effectIndex++;
      const prev = effectRecords[i];
      if (!prev || depsChanged(prev.deps, deps)) {
        prev?.cleanup?.();
        const cleanup = fn();
        effectRecords[i] = { deps, cleanup };
      }
    },
    useLayoutEffect: noop,
    useRef: (initial) => { const i = refIndex++; if (!(i in hookRefs)) hookRefs[i] = { current: initial }; return hookRefs[i]; },
    useCallback: (fn, deps) => {
      const i = cbIndex++;
      const prev = hookCallbacks[i];
      if (!prev || depsChanged(prev.deps, deps)) hookCallbacks[i] = { fn, deps };
      return hookCallbacks[i].fn;
    },
    Fragment: Symbol('Fragment'),
  };
  const render = () => {
    hookIndex = 0; refIndex = 0; cbIndex = 0; effectIndex = 0;
    BadgeComp({});
  };
  let captured;
  const sandbox = {
    window: { __ModuleLoader__: { load: ({ factory }) => { captured = factory((name) => (name === 'react' ? stubReact : {})); } }, addEventListener: noop, removeEventListener: noop },
    document: { documentElement: { getAttribute: () => 'zh' }, body: {}, createElement: () => ({ setAttribute: noop, textContent: '' }), head: { appendChild: noop }, querySelector: () => null, getElementById: () => null },
    navigator: { language: 'zh-CN' },
    fetch: gatedFetch,
    console,
    setTimeout, clearTimeout,
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: noop,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'client.js' });
  let BadgeRender = null;
  const slots = {
    inject: (_name, fn) => { fn(); return () => {}; },
    register: (_seat, r) => { BadgeRender = r; return () => {}; },
  };
  captured.apply({ get: (n) => (n === 'slots' ? slots : undefined), effect: (fn) => fn(), logger: { warn: noop } });
  BadgeRender();
  render(); // 首次挂载：触发一次 GET
  hookStates[4] = true; // mine = true
  render(); // 渲染出 button
  assert.equal(pending.length, 1, 'H: 首次挂载应只发出一次 GET');
  assert.equal(pending[0].init.method, 'GET');
  const cached = { ok: true, data: { planType: 'pro', windows: [{ key: 'fiveHour', percentUsed: 80, quota: 100, used: 80, remaining: 20 }] } };
  respond(pending[0], cached);
  await Promise.resolve();
  await Promise.resolve();

  // 模拟点击徽标打开面板：buttonProps.ref 挂上节点，调用 onClick，随后触发 React 重渲染（模拟 commit 后跑 effect）。
  buttonProps.ref({ getBoundingClientRect: () => ({ top: 100, left: 100, right: 160, bottom: 120, width: 60 }) });
  const toggleDone = buttonProps.onClick();
  render(); // 模拟 setOpen(true) 后的重渲染与 useEffect 检查
  assert.equal(pending.length, 2, 'H: 打开面板后只能多出一次 POST，不得被 useEffect 再发一次 GET');
  assert.equal(pending[1].init.method, 'POST');
  // 面板打开期间定时器触发也不得发 GET。
  timers.at(-1)?.();
  assert.equal(pending.length, 2, 'H: 面板打开期间轮询定时器不得发 GET');
  const fresh = { ok: true, data: { planType: 'pro', windows: [{ key: 'fiveHour', percentUsed: 25, quota: 100, used: 25, remaining: 75 }] } };
  respond(pending[1], fresh);
  await toggleDone;
  assert.equal(hookStates[1]?.windows?.[0]?.used, 25, 'H: 强制刷新的 POST 结果必须写入面板状态');
}

console.log('client-badge.test.mjs: 全部断言通过（徽标示数固定取 5 小时窗口 + 打开面板强制刷新不被竞态取消）');
