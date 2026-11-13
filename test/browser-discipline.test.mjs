/**
 * 浏览器弹窗纪律源码钉（2026-11-13 用户要求：登录之后，只有获取不到 Cookie 时才允许弹授权页）。
 *
 * 行为测试在 quota.test.mjs（退避/缓存），这里钉**结构**：谁有权碰浏览器。
 * 两个插件的浏览器入口都必须是「用户显式点击」的唯一路由分支，
 * 定时刷新 / GET 轮询 / 失败回调一律不得带 allowBrowser 或 auto:true。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const quotaSrc = fs.readFileSync(path.join(here, "../lib/quota.js"), "utf8");
const indexSrc = fs.readFileSync(path.join(here, "../index.js"), "utf8");

test("quota.js opens browser tabs only inside the allowBrowser-guarded block", () => {
  // openConsoleTab / findConsoleTab 的调用必须落在 #doRefresh 里 allowBrowser 守卫之后。
  const guardIdx = quotaSrc.indexOf("if (!allowBrowser)");
  assert.ok(guardIdx > 0, "quota.js 必须有 allowBrowser 守卫");
  const openIdx = quotaSrc.indexOf("await openConsoleTab()");
  const findIdx = quotaSrc.indexOf("await findConsoleTab()");
  assert.ok(openIdx > guardIdx, "openConsoleTab 调用必须在 allowBrowser 守卫之后");
  assert.ok(findIdx > guardIdx, "findConsoleTab 调用必须在 allowBrowser 守卫之后");
  // 全文只允许这一处开标签（定时刷新路径不得再开）。
  assert.equal(quotaSrc.split("await openConsoleTab()").length - 1, 1, "openConsoleTab 只能被调用一次");
});

test("index.js grants browser access to exactly one route: POST quota/login", () => {
  const grants = indexSrc.match(/allowBrowser:\s*config\.allowBrowserForQuota/g) ?? [];
  assert.equal(grants.length, 1, "只允许一个路由分支带 allowBrowser");
  const loginBranch = indexSrc.indexOf('sub === "quota/login"');
  const grantIdx = indexSrc.indexOf("allowBrowser: config.allowBrowserForQuota");
  assert.ok(grantIdx > loginBranch, "allowBrowser 授权必须落在 quota/login 分支内");
  // GET /quota 与 POST /quota/refresh 不得出现 allowBrowser 授权（注释提及不算）。
  const getBranch = indexSrc.slice(indexSrc.indexOf('sub === "quota"'), loginBranch);
  assert.ok(!/allowBrowser\s*:/.test(getBranch), "GET/refresh 分支不得碰浏览器");
});
