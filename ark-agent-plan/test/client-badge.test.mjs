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

console.log('client-badge.test.mjs: 全部断言通过（徽标示数固定取 5 小时窗口）');
