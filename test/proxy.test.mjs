import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * 出站代理（lib/proxy.js）的安全与跨平台回归。
 *
 * 钉死两条语义：
 *  1. loadUndici 的候选目录里**不得**出现 process.cwd() —— 从任意启动目录解析
 *     undici 等于允许该目录里的第三方包在宿主进程执行任意代码（RCE，2026-11-10 审计）；
 *  2. 兜底 home 目录用 os.homedir() 而不是 process.env.HOME —— Windows 上后者为空，
 *     会让代理支持在 Windows 上静默失效（undici 解析不到 → 直连）。
 */
test('proxy: undici is never resolved from the launch working directory', () => {
  const source = readFileSync(new URL('../lib/proxy.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\s*\.\s*cwd/, 'lib/proxy.js 不得再使用 process.cwd()');
  assert.match(source, /DSH_PROFILE_DIR/, '仍保留 profile 目录候选');
  assert.match(source, /profiles/, '仍保留 DSH_HOME/profiles/desktop 兜底候选');
});

test('proxy: home fallback is cross-platform (os.homedir, not process.env.HOME)', () => {
  const source = readFileSync(new URL('../lib/proxy.js', import.meta.url), 'utf8');
  assert.match(source, /os\.homedir\(\)/, '兜底 home 必须用 os.homedir()');
  assert.doesNotMatch(source, /process\.env\.HOME/, '不得依赖 Windows 上为空的 process.env.HOME');
});
