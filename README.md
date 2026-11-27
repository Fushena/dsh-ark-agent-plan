# dsh-ark-agent-plan

**火山方舟 Agent Plan 插件 · Volcengine Ark Agent Plan Provider Plugin for DeepSeek Harness (DSH 0.2.x)**

[![Release](https://img.shields.io/github/v/release/Fushena/dsh-ark-agent-plan?style=flat-square)](https://github.com/Fushena/dsh-ark-agent-plan/releases)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-blue?style=flat-square)](#前置条件与平台支持--prerequisites)
[![License](https://img.shields.io/github/license/Fushena/dsh-ark-agent-plan?style=flat-square)](./LICENSE)

---

### 中文简介

面向 **DeepSeek Harness (DSH 0.2.x)** 的火山引擎 **方舟（Ark）Agent Plan** 全功能模型路由与额度面板插件：

- **动态模型目录与套餐过滤**：从官方模型文档拉取候选池并按真实协议探测可用性，自动折叠别名/日期版本，按订阅套餐等级（Small / Medium / Large / Max）动态过滤可用多模态模型。
- **双协议与深度思考控制**：主流模型走 Responses API，Kimi K2.7 Code 走 Chat Completions；按模型契约精确控制思考档位（`off` / `low` / `medium` / `high` / `max`）。
- **内置工具与外部 MCP 集成**：支持服务端内置工具（`web_search`、`code_interpreter`、`web_extractor`）以及通过 `mcpServers` 声明外部 HTTPS MCP 服务（支持 `${credential:REF}` 凭据模板展开）。
- **原生多模态与本地工具**：支持 Seedream 生图、Seedance 生视频（支持首帧/参考图）、Seed3D、Embedding、TTS 与 ASR 语音转写，并可选启用 `ark_generate_image`、`ark_generate_video`、`ark_text_to_speech` 本地工具。
- **实时 AFP 额度徽标与面板**：输入框旁展示 5 小时窗口用量，点击查看 5h / 周 / 月三窗口余量与倒计时；同步间隔内按模型单价本地实时估账，首次收割 Cookie 后全程无需启动 Chrome。
- **稳定与安全**：可配置空闲超时与重试策略、支持 HTTP/HTTPS 出站代理、内置 SSRF/逐跳 DNS/凭据脱敏防护。

### English Overview

A full-featured **Volcengine Ark Agent Plan** provider plugin for **DeepSeek Harness (DSH 0.2.x)**, authored and verified against the live gateway:

- **Dynamic Model Catalog & Tier Filtering**: Pulls candidates from official Ark model docs, probes live transport availability, folds dated aliases, and filters multimodal models automatically by your subscription tier (Small / Medium / Large / Max).
- **Dual Transport & Thinking-Effort Control**: Routes most models via the Responses API and Kimi K2.7 Code via Chat Completions, with per-model thinking-effort controls (`off` / `low` / `medium` / `high` / `max`).
- **Server-Side Harness & External MCP**: Declares built-in server tools (`web_search`, `code_interpreter`, `web_extractor`) and external HTTPS MCP servers (`mcpServers`) with per-request `${credential:REF}` template expansion.
- **Native Multimodal & Opt-In Local Tools**: Supports Seedream (image), Seedance (video with reference images), Seed3D, embeddings, TTS, and ASR (`doubao-seed-asr-2.0`), plus opt-in local tools (`ark_generate_image`, `ark_generate_video`, `ark_text_to_speech`).
- **Real-Time AFP Quota Badge & Panel**: Shows 5-hour window usage in the composer and 5h / weekly / monthly balances with live countdowns; ticks locally via per-model AFP pricing between console syncs, running Chrome-free after initial cookie bootstrap.
- **Resilience & Security**: Configurable idle timeout and retry policy, HTTP/HTTPS outbound proxy support, and built-in SSRF, per-hop DNS, and credential-redaction guards.

**Quick Install / 快速安装**: Paste `github:Fushena/dsh-ark-agent-plan` in the DSH **Plugins** page, or run `dsh plugin --profile desktop add github:Fushena/dsh-ark-agent-plan`.

---

## Installation / 如何安装

Three routes, all ending with the bundle enabled in your profile. Release tags are listed at <https://github.com/Fushena/dsh-ark-agent-plan/tags>.

**A. Plugins page (recommended — Desktop & Web)**
Open the host's **Plugins** page (sidebar) or **Settings → Plugins**, open the install dialog and paste the git spec:

```
github:Fushena/dsh-ark-agent-plan
```

Append a tag to pin a release, e.g. `github:Fushena/dsh-ark-agent-plan#v1.0.4`. The host fetches the repository, installs it into the active profile and enables the bundle; with HMR on it goes live after a page refresh, otherwise restart the host.

**B. Command line**

```sh
dsh plugin --profile <profile> add github:Fushena/dsh-ark-agent-plan
```

Replace `<profile>` with the profile your host actually runs — the Desktop app's is usually `desktop` (`echo $DSH_PROFILE` inside a session shows it). Installing into the wrong profile (e.g. `web` while running Desktop) makes the plugin invisible to your app.

**C. From a clone (development / offline)**

```sh
git clone https://github.com/Fushena/dsh-ark-agent-plan.git
dsh plugin --profile <profile> add link:/absolute/path/to/dsh-ark-agent-plan
```

or ask a DSH agent to call `plugin_manager` → `install_bundle` with the clone's absolute directory as `target`.

**After install**: configure the credential reference `ARK_AGENT_PLAN_CN_API_KEY` under Settings → Models (see Prerequisites below), then pick the provider in the model selector. Updates: reinstall a newer tag, or re-run the same `add` command.

## 前置条件与平台支持 / Prerequisites

- **DSH 版本**：针对 DeepSeek Harness **0.2.2-rc.1** 开发与验证；peer 依赖
  `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-credentials` 范围为
  `^0.2.1-rc.5 || ^0.2.2-rc.1`（0.2.1-rc.5 至 0.2.2-rc.x 均可安装）。
- **账号**：需要火山引擎 Ark **Agent Plan** 订阅，并在 Settings → Models 配置凭据引用
  `ARK_AGENT_PLAN_CN_API_KEY`；缺失时请求报 `MISSING_CREDENTIAL`。
- **额度面板前置**：首次凭据 bootstrap 依赖第三方插件
  [dsh-chrome-bridge](https://github.com/OrderG-X/dsh-chrome-bridge) 及其 Chrome 扩展
  （收割控制台 Cookie）。未安装时面板提示「浏览器桥不可用」，**聊天功能不受影响**；
  收割成功并落盘（`~/.dsh/.ark-plan-console-cookie.json`，0600）后，刷新不再需要 Chrome。
- **网络/代理**：大陆网络直连 `console.volcengine.com` 会被 TLS 重置（额度面板报
  `fetch failed`）；Node 的 `fetch` 不读系统代理，需配置 `proxy` 或 `HTTPS_PROXY`，见下文专节。
- **平台**：聊天、动态目录、代理支持跨平台（macOS/Windows/Linux）；额度收割经
  dsh-chrome-bridge 的 Unix socket / Windows named pipe，各平台一致。

## Features

- Native model-picker integration through `registerConfigurableProviders` + `registerAdapter` (the visibility pattern verified working in DSH 0.2.2-rc.1).
- **Full dynamic model catalog**: the Agent Plan has no `/models` endpoint and its key cannot call the standard Ark v3 APIs, so discovery works in two stages —
  1. fetch the official Ark model-list documentation as the authoritative candidate pool (name guessing is not viable: the gateway silently falls back on unknown variants, e.g. `glm-5-2` resolves to `glm-5.3`);
  2. probe candidates with the same transport used for invocation, including `/responses`, `/chat/completions`, `/images/generations`, and `/contents/generations/tasks`, carrying only `model`. `404 UnsupportedModel` means unavailable, and `400 MissingParameter` means the name is recognized. The speech catalog uses published Agent Plan IDs because the separate speech service has no model-only probe.

  Alias and dated ids are folded into one entry per model (`deepseek-v4.1-flash` ≡ `deepseek-v4-1-flash-261017`), preferring the friendly alias. Refreshes on a timer; failures keep the last good catalog.
- **Thinking-effort control** per model contract (`off/low/high/max` on V4.1 Flash, five tiers on V4 Pro/Flash, no-off on GLM/Kimi), including the explicit `thinking.type` toggle the gateway requires for V4.1 Flash / Seed 2.1 Turbo.
- **Harness capabilities**: server-side built-in tools declared through the Responses `tools` array — `web_search`, `code_interpreter`, `web_extractor` (verified to produce `web_search_call` items). Activity is rendered into the transcript as Markdown.
- **Quota badge & panel** (ChatGPT-style): the composer shows `Medium · 66.8%` — that figure is the **5-hour window's** used percentage (not the busiest of the three windows), matching what users watch while a session is running; clicking opens a panel with the 5-hour / weekly / monthly Agent Plan AFP quotas — remaining vs total, percent used, and a live reset countdown. Data comes from the console's `GetAgentPlanAFPUsage` endpoint, which the plan API key cannot reach (401).

  **Between syncs, the numbers tick locally:** every completed inference is priced through a per-model AFP table (`lib/pricing.js`) and added to a local ledger, so the panel's percent-used updates in real time as you chat — marked with an "estimate" hint. Each successful console sync replaces the estimate with the authoritative value, wiping drift.

  **Temporary tabs clean themselves up:** any console tab the plugin opens lives in the bridge's agent window and is closed the moment the harvest finishes — including strays left by earlier runs, so repeated refreshes can never pile tabs up. A failure backoff (1 min doubling to 30 min) stops it from reopening tabs while the console login is invalid.

  **Credential bootstrap, then Chrome-free:** the first fetch harvests the console's full cookie jar (including the HttpOnly `digest` / `userInfo` tickets) through the `dsh-chrome-bridge` CDP channel, persists it to `~/.dsh/.ark-plan-console-cookie.json` (mode 0600), and from then on every refresh is a plain `fetch` from Node — **Chrome does not need to be running**, and no console tab has to stay open. Only when the stored cookie expires does the panel ask for a one-click re-harvest (`POST /ark-agent-plan/quota/login`). Host routes: `GET /ark-agent-plan/quota` (5 min cache), `POST /ark-agent-plan/quota/refresh`, `POST /ark-agent-plan/quota/login`.
- Dual transport: Responses for most models, Chat Completions for Kimi K2.7 Code, plus dedicated endpoints for multimodal models (Images, Video, Audio, Embeddings).
- Credentials resolved per request via the DSH credential service (`ARK_AGENT_PLAN_CN_API_KEY` first, then common aliases), so key changes need no restart.
- **MCP server integration**: declare external MCP servers via `mcpServers` config — they are injected into the Responses API `tools` array as `{ type: "mcp", server_url, ... }` declarations. Ark's server-side agent calls these MCP tools on behalf of the model, alongside built-in tools (web_search etc.) and DSH local function tools. `server_url` must be **https and not a private/loopback address** (unsafe entries are dropped with a warning); only whitelisted optional fields (`allowed_tools`, `require_approval`) pass through. Header values support **`${credential:REF}` templates**, expanded through the DSH credential service before every request — an unresolvable ref fails the request instead of silently sending the literal template to Ark.
- **Multimodal model support**: Seedream (image generation), Seedance (video generation), Seed3D, embedding, TTS, and ASR models are included in the catalog. Each type follows its **documented** request/response contract (v1.1.1): images `POST /images/generations` (streaming only on `seedream-5.0-lite/4.5/4.0`, otherwise a single JSON), video `POST /contents/generations/tasks` → poll `GET tasks/{id}` (the create call returns only `{id}` — there is no video SSE), speech `POST https://openspeech.bytedance.com/api/v3/plan/tts/unidirectional` (line-delimited JSON, `X-Api-Key`, terminator code `20000000`), embeddings `POST /embeddings`. Generated media is downloaded and stored through the host attachment service, then handed back as a **file block** (a real `sha256:` reference); if storage is unavailable the reply degrades to the signed https link instead of inventing a reference. Cancellation, a truncated stream, or an empty result are reported as errors — never as a normal answer.

  v1.1.2 adds **reference images for video** (image attachments in the latest user message: one image sets `first_frame`, several become `reference_image`; <30 MiB each, ≤45 MiB total), **full embedding vectors in a JSON attachment** (inline JSON text when attachment storage is unavailable), and **ASR**: select `doubao-seed-asr-2.0` and attach a 16 kHz, 16-bit mono PCM WAV file up to 10 MiB in the current message. ASR streams over `wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async` (`X-Api-Resource-Id: volc.seedasr.sauc.duration`) and keeps the real attachment reference across the host's file→text projection. Not yet exercised against the live gateway end-to-end; the contracts are pinned by real-HTTP and simulated-WebSocket regression cases.
- **Automatic plan-tier filtering**: the catalog reads your Agent Plan subscription tier from the quota sync (`planType`) and hides models your plan doesn't include — Small/Medium plans show image, embedding, TTS, and ASR models; Large/Max plans additionally show video generation models. Multimodal models in the picker display their tier requirement (e.g. "Video （需 Large+）").
- **Multimodal generation tools** (opt-in): register `ark_generate_image`, `ark_generate_video`, and `ark_text_to_speech` as DSH local tools. Image/video call Ark's standard v3 APIs and need an endpoint id plus a standard Ark API key (separate from the Agent Plan key); video generation polls the async task (hard deadline + abort-aware). **TTS needs no endpoint id** — it routes by voice resource (`seed-tts-2.0`) on the openspeech endpoint and needs a key valid for that resource. All three declare `output { schema, render }` + `timeoutMs` and return objects, so the host actually registers them (v1.1.1), and clamp `n` / `duration` / `speed_ratio` at runtime. **TTS saves the audio to a local MP3 file and returns its path** — DSH conversations cannot embed audio playback, so a file is the only usable deliverable.

## Config (Settings → Plugins → this plugin)

| Field | Meaning |
|---|---|
| `apiKeyEnv` | Primary credential ref (role `credential-ref`, editable in Settings → Models). |
| `extraKeyEnvs` | Additional candidate refs tried in order. |
| `endpoint` | Agent Plan base URL (default `https://ark.cn-beijing.volces.com/api/plan/v3`). |
| `harness` | `auto` / `none` / comma list of built-in tools. |
| `defaultReasoning` | Fallback effort when the session does not pick one. |
| `models` / `excludeModels` | Manual catalog overrides / exclusions. |
| `extraModels` | Extra candidate ids to probe beyond the official list. |
| `modelListUrls` | Override the official documentation URLs used as the candidate pool. |
| `catalogRefreshMinutes` | Probe interval (default 30). |
| `quotaRefreshMinutes` | Quota cache TTL (default 5). |
| `proxy` | Outbound proxy for quota/catalog/model requests. Empty = read `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`; `none`/`off`/`direct` = force direct; http/https only (socks unsupported). |
| `mcpServers` | Array of MCP server declarations injected into the Responses API `tools` array. Each item: `{ server_url, server_label?, headers?, allowed_tools?, require_approval? }`. `server_url` is required, https-only, private/loopback addresses rejected. `headers` values may use `${credential:REF}` templates (resolved per request via the credential service / env). See [Ark MCP docs](https://www.volcengine.com/docs/82379/1851307). |
| `imageGeneration.enabled` | Register `ark_generate_image` DSH tool. Requires `imageGeneration.model` (endpoint id) and a standard Ark API key. |
| `imageGeneration.model` | Seedream endpoint id (e.g. `ep-2025xxxx-xxxx`). |
| `imageGeneration.apiKeyEnv` | Credential ref for the standard Ark v3 API key (default `ARK_API_KEY`). |
| `imageGeneration.defaultSize` | Default size: tier `1K`/`1.5K`/`2K`, or exact `WxH` (per-model pixel floor applies). Default `2K`. |
| `videoGeneration.enabled` | Register `ark_generate_video` DSH tool. |
| `videoGeneration.model` | Seedance endpoint id. |
| `videoGeneration.apiKeyEnv` | Credential ref for the standard Ark v3 API key. |
| `videoGeneration.defaultRatio` / `defaultResolution` / `defaultDuration` | Defaults for the tool: ratio (`adaptive` by default), resolution (`720p`; `1080p` only on 2.5/2.0), duration in seconds (2.5 series 4–30, 2.0 series 4–15, `-1` = model decides). |
| `videoGeneration.pollIntervalSeconds` / `maxWaitSeconds` | Async task polling interval (min 2, default 5) and hard deadline (min 30, default 300). |
| `tts.enabled` | Register `ark_text_to_speech` DSH tool. **No endpoint id needed** — speech routes by voice resource. |
| `tts.apiKeyEnv` | Credential ref for a key valid on the speech resource (default `ARK_AGENT_PLAN_CN_API_KEY`, aligned with the default Agent Plan speech endpoint; override when using a non-plan endpoint). |
| `tts.defaultVoice` | Default speaker id (Doubao speech 2.0 public voices, e.g. `zh_female_vv_uranus_bigtts`). |
| `tts.endpoint` / `tts.resourceId` | Override the speech endpoint / resource id. Empty = Agent Plan endpoint + `seed-tts-2.0`; non-plan accounts use `.../api/v3/tts/unidirectional`, cloned voices use `seed-icl-2.0`. |
| `mediaDefaults` | Defaults for the **conversation** multimodal route (picking a media model in the picker), which uses the Agent Plan gateway and plan key: `imageSize`, `videoRatio`, `videoResolution`, `videoDuration`, `videoPollSeconds`, `videoMaxWaitSeconds`, `ttsSpeaker`, `ttsEndpoint`, `ttsResourceId`. Separate from the three opt-in tools above. |

## 额度面板显示 `fetch failed` 怎么办

`console.volcengine.com` 在**没有可用代理**的网络环境下会直接重置 TLS 握手
（实测 2026-11-09：直连与 curl 走系统代理都是 `SSL_ERROR_SYSCALL`，而同域的
`api.volcengine.com` 正常），面板因此报 `fetch failed`。这与插件凭据无关——
若凭据过期，插件会明确提示 `COOKIE_EXPIRED` / 「更新凭据」，而不是 `fetch failed`。

关键点：**Node 的 `fetch` 默认不读系统代理设置**，所以即使你的系统代理（如
`127.0.0.1:7897`）是通的，插件也不会自动走它。解决方式二选一：

- 让插件识别代理：设置配置项 `proxy`，或在启动 DSH 前设置环境变量
  `HTTPS_PROXY=http://127.0.0.1:7897`（其他端口按实际填写）。
- 修正网络：切换可用代理节点，或把 `console.volcengine.com` 加进直连规则。

配置生效后，额度路由的返回体会带上 `proxy` 字段（已脱敏），可直接确认代理是否接管。

## 本地回归测试

全部离线（不访问网络、不读取个人凭据），用注入式 fetch / 受控时钟驱动：

```bash
cd ark-agent-plan   # 进入本插件目录（clone 后的实际路径）
node test/run.mjs
```

覆盖 4 组最容易复发、也最难在真实环境里手动复现的缺陷：

| 用例 | 钉死的语义 |
|---|---|
| `test/client-badge.test.mjs` | 徽标示数固定取**近 5 小时**窗口的百分比，不是「三窗口最高」；缺 `fiveHour` 时才退回最高项 |
| `test/sse.test.mjs` | `response.incomplete` 时未闭合块要补 `block-end`（不能抢在 max-tokens 前抛 `STREAM_CLOSED`）；内置工具活动项按 `output_index` 去重（无 `id` 时不得重复渲染） |
| `test/timeout.test.mjs` | 超时是**空闲超时**不是总时长：持续有数据的长回答不得被掐断 |
| `test/catalog.test.mjs` | 401/403/429/5xx 的探测结果一律「无结论」，刷新失败并保留旧目录；`excludes`/`overrides` 在初始快照即生效 |
| `test/quota.test.mjs` | 退避窗口内的面板轮询不得把退避自我放大到 30 分钟上限 |
| `test/proxy.test.mjs` | undici 候选目录不得含 `process.cwd()`（宿主 RCE 回归）；home 兜底用 `os.homedir()`（Windows 上 `process.env.HOME` 为空） |
| `test/route-guard.test.mjs` | Origin 必须按完整 authority（host+端口）校验：本机异端口 same-site 页面拒绝，合法同源/默认端口归一放行（2026-11-13 审计） |
| `test/errors.test.mjs` | 429/5xx 先按状态码分类（RATE_LIMIT/SERVER 可重试），不被 body 里的 quota 字样抢判；缺 `index` 的 tool_calls delta 合并为同一块（2026-11-13 审计） |
| `test/quota-audit.test.mjs` | 退避不挡手动「更新凭据」；并发手动刷新去重不互踩；窗口过期后 used 清零、remaining 恢复满额（2026-11-13 审计） |

v1.0.4（2026-11-13 安全与稳定性审计）另钉死：内置工具长时间执行时 SSE 进行中事件必须续命空闲超时（`stream.test.mjs` D / `sse.test.mjs`）；身份校验前缀按段对齐（`glm-5.3-flash` 回显 `glm-5.3` 判不同模型剔除）；瞬时探测故障不进 6h 缓存；目录 signature 覆盖全部规格字段。

v1.1.0（2026-11-24，MCP 声明 + 多模态工具，含发布前安全审计修复）新增 `test/mcp-tools.test.mjs` 钉死：

| 用例 | 钉死的语义 |
|---|---|
| `mcpToolDeclarations` 安全闸 | `server_url` 只收 https + 非私网/本机字面量（http/file/localhost/127.x/10.x/192.168.x/172.16-31.x/169.254.x/CGNAT/::1/fe80::/IPv4-mapped 全拒），坏项丢弃并记 warn；未知配置字段不透传（白名单 `allowed_tools`/`require_approval`） |
| `${credential:REF}` 展开 | headers 模板经凭据服务/环境变量展开后才进请求体；解析不到的引用 fail-closed 抛 `MISSING_CREDENTIAL`（不把字面量发给 Ark）；展开不改原声明（凭据不缓存） |
| `ark_text_to_speech` 落盘 | base64 音频解码落盘为本地 MP3（时间戳+UUID 文件名、`.part` 原子改名、失败清理、50MB 上限）；空/超长文本拒；上游空音频报错不留半截文件 |
| 工具工厂 | 按 `enabled` + `model` 过滤注册；生图/生视频请求体与返回值形状（mock fetch） |

同版顺手修复：多模态 SSE 解析器 finally 先 `reader.cancel()` 再 releaseLock（提前退出不再泄漏底层连接）；上游媒体 URL 只接受 https；未知上游事件只报事件名不透传 JSON 内容（提示注入面收敛）；`arkRequest` 非 JSON 响应归一化报错；视频轮询 sleep 正常到点移除 abort 监听器。

v1.1.1（2026-11-25，审计整改：工具注册、额度账本、多模态真实契约）新增 `test/multimodal.test.mjs`（28 组**真实 HTTP** 用例）并扩充 `mcp-tools` / `quota-audit` / `client-badge`：

| 用例 | 钉死的语义 |
|---|---|
| 工具注册（A1） | 三个工具都声明 `output { schema, render }` + `timeoutMs`、`execute` 返回**对象**（不是 JSON 字符串）；用宿主真实 `ToolsService.register` 验证能注册上（摘掉 `output` 必须抛 `must declare output`）；`n`/`duration`/`speed_ratio` 运行时钳制（宿主不校验 `parameters`，schema 里的 min/max 只是提示） |
| 额度窗口（A3） | 窗口过期后**立刻消耗**要把账滚进新窗口（旧实现抹掉 `resetAt` 导致旧满额压过新消耗、remaining 恒 0、工具持续被摘）；跨第二个窗口边界再归零；过期判定优先于滚窗判定 |
| 刷新竞态（A4） | 手动刷新接管后，晚到的旧响应不得覆盖新缓存/回滚账本（服务端单调序号 + 客户端 `load` 请求序号双守卫） |
| 视频契约（A2） | `POST /contents/generations/tasks` 只回 `{id}` → `GET tasks/{id}` 轮询到 `succeeded`；请求体用 `content:[{type:"text",…}]`、无顶层 `prompt`/`stream`；创建无 id、任务 failed、完成无地址都报错；一直 running 到总时限报 TIMEOUT；轮询中取消立刻 ABORTED |
| 图片契约（A2） | `stream:true` 只对 `seedream-5.0-lite/4.5/4.0` 发（pro/flash/5.5 传了会被上游 400）；事件名 `partial_succeeded`/`partial_failed`/`completed`/`error`；请求体无官方不存在的 `quality`/`n`；按**实际 Content-Type** 分流 SSE/JSON；长生图边读边产出不被空闲超时掐断 |
| 语音契约（A2） | Agent Plan 语音在 `openspeech.bytedance.com/api/v3/plan/tts/unidirectional`，`X-Api-Key` + `X-Api-Resource-Id: seed-tts-2.0`、请求体 `req_params`、语速用整数 `speech_rate`；响应逐行 JSON（`code:0` 累积 base64、`20000000` 终止）或二进制音频；**成功 = 终止码 + 非空音频 + 魔数像音频**（先报错再补终止码仍失败、半截流报 STREAM_CLOSED） |
| 产物落库（A2） | 媒体必须经 `attachments.saveFile` 拿**真引用**（`sha256:<64hex>`）后发 `file` 块；自造 `attachmentId` 会被宿主拒（且宿主没有「按 url 下载」通道）；落库失败/非法引用/下载回来是错误页 → 降级给 https 链接并记 warn，不伪造引用也不把整轮判失败 |

同版顺手修复：取消/断流不再伪装成功（宿主无 `finish` 时默认 `{kind:"stop"}`，旧代码 `signal.aborted → break` 会把半截产物当正常回答持久化）；图片/音频/视频产物过魔数校验（200 + 错误页不再被存成 `.png`/`.mp3`/`.mp4`）；媒体下载逐跳重校验 https 并续空闲超时；`media-io.js` 统一按行读（`\r\n`/`\n`/`\r` 都切、EOF 补尾行）。

v1.1.2（2026-11-25，整合 codex PR #1 + 整合复核修复）新增 `test/asr.test.mjs`（用**真实 `Context` + `LlmRuntime`** 跨宿主 file→text 投影边界验证 ASR）并扩充 `catalog` / `errors` / `multimodal` / `stream`：

| 用例 | 钉死的语义 |
|---|---|
| ASR 附件真引用 | 宿主会把 `file` 块投影成文本，ASR 必须在 `llm/stream` waterfall 里抢在投影前拿到真附件引用；只收 16 kHz/16-bit/单声道 PCM WAV ≤10 MiB；空转写报 `EMPTY_RESPONSE`、提前关闭报 `STREAM_CLOSED` |
| 心跳续命 | SSE 注释行/心跳（`: keep-alive`）也要重置空闲超时——只在产出 chunk 时续命会把纯心跳的长任务误判 TIMEOUT |
| 流内错误分类 | 流内错误按**结构化 code 优先**（限流/超时/网关故障可重试），code 缺失才看 message 文本（含中文「请求过于频繁」「服务繁忙」）；多模态流内错误同口径，不被 body 里的 `quota` 字样抢判 |
| tool_calls 归并 | 空串 `id` 不得覆盖真 id（否则 `tool_result` 对不上上游调用）；无主续片段只在「当前仅一个工具块」时复用上一块，并行调用不得把两条参数拼成坏 JSON |
| 目录判定 | `doubao-seedream-*` / `doubao-seedance-*` 不再被 `^doubao` 抢判成对话模型；探测端点按 transport 选（语音走已发布 ID，不做 model-only 探测）；身份校验不为媒体端点创建计费任务；套餐过滤先于探测 |
| 视频参考图 / 向量落库 | 单图 `first_frame`、多图 `reference_image`，单图 <30 MiB、合计 ≤45 MiB；无附件服务且有图报 `UNSUPPORTED_CONTENT`；向量必须是有限数且完整落 JSON 附件 |

整合复核另修三处 PR 自带缺陷：空串 `id` 覆盖（与 qwen Q13 同源）、`lastToolBlock` 在并行调用下污染已正确的块、`streamFailureCode` 缺文本兜底导致「只给 message」的限流/故障被判不可重试。

v1.1.3（2026-11-26，高/中/低危全量审计修复 + 回归测试补齐）整合 `fix/high-severity-audit-bugs` 分支，新增 `test/chat.test.mjs` 与 `test/audit-medium-low.test.mjs`（共 18 个测试文件全部通过）：

| 用例 / 模块 | 修复的缺陷 |
|---|---|
| `lib/client.js` | 用 ref 跟踪面板 `open` 状态，避免点开面板触发轮询 `useEffect` 重跑并把强制刷新 `load(true)` 取消；`payload.provider.id` 变化时即时重探徽标可见性 |
| `lib/chat.js` | 流式 `tool_calls` 续传分片忽略空串 / `null` 的 `function.name`，防止覆盖真实工具名；`role: "tool"` 严格排在尾随非空 `role: "user"` 消息之前 |
| `lib/content.js` | SSRF 防护补充拦截带尾点 `localhost.` 与十六进制 IPv4-mapped IPv6 地址 |
| `lib/quota.js` | 手动 `allowBrowser` 刷新跳过陈旧本地 Cookie；严格校验控制台 Cookie 域与 URL 主机名；页面内回落取数后绝不落盘已知 `COOKIE_EXPIRED` 的失效 Cookie |
| `lib/ark-tools.js` | 未显式传 `n`（或传入非整数）时省略 `n` 字段而非默认塞 `n: 1`；三个工具对空/nullish 入参做防御 |
| `lib/catalog.js` / `index.js` | 过滤空的 `excludeModels` 项避免误清目录；保留 `extraModels` 追加的语音模型；脱敏 `proxyFetch.proxyUrl`（支持裸 `host:port`） |
| `lib/harness.js` / `adapter.js` | 内置模型尊重配置 `defaultReasoning`，并对拒绝 `off` 的模型（如 GLM）安全降级 |
| `lib/media-io.js` | 非法重定向 `Location` URL 捕获归一化为 `PROVIDER_ERROR` |
| `lib/model-display.js` | 多模态家族先于 `doubao` 匹配，未知家族排序位挪到 `99`（与 `dsh-qwen-token-plan-full` 保持逐字节同步） |

v1.1.4（2026-11-26，全量深度审计整改：9 项高危 + 18 项中危）新增 `test/deep-audit-fixes.test.mjs`（16 项回归，共 19 个测试文件全部通过）：

| 模块 | 修复内容 |
|---|---|
| `lib/route-guard.js` | 校验 `req.socket.remoteAddress` 为回环；拒通配绑定（`0.0.0.0`/`::`）并支持裸 IPv6；拒数组型 `sec-fetch-site` 与 `same-site`；严校验 `Host`/`Origin` 无 userinfo/path 且 `Origin === url.origin` |
| `lib/media-io.js` / `lib/responses-sse.js` | 媒体下载接入完整私网/DNS SSRF 防护与凭据拒收；`iterateSse`/`iterateLines` 加 32 MB 缓冲上限；`readSpeechAudio` 跳过标准 SSE 控制/注释行并兼容字符串错误码与 `error` 信封 |
| `lib/proxy.js` / `lib/content.js` | `redactProxyUrl` 拒绝无协议头 opaque scheme 防明文密码入日志；暴露 `proxyFetch.close()` 卸载释放连接池并守卫 `undici.WebSocket`；`expandCredentialTemplates` 改单遍替换；MCP 拒收日志脱敏并扩充私网段 |
| `lib/catalog.js` | `refresh(signal)` 中止不覆写目录、新 `unknown` 候选不再跳过验身发布；修 3 段版本归一化与 `servedMatches` 跨次版本绕过；未知套餐保守放行多模态；`seed3d` 归 `transport: "3d"` |
| `index.js` / `lib/adapter.js` / `lib/chat.js` / `lib/ark-tools.js` | `ctx.inject(["tools"])` 注册多模态工具并校验句柄；`providerRetryPolicy()` 纳入 `STREAM_CLOSED`；Responses 补空 `call_id` 与 `done` 回填；Chat 过滤空 `finish_reason`、无碰撞 `wireIndex`、`function_call`/带工具 `stop` 映射、`off` 省略 `reasoning_effort`；`deferToolCalls` 覆盖 `mcpTools`；AFP 账本补计 `cacheWriteTokens`；`tts.apiKeyEnv` 默认对齐 `ARK_AGENT_PLAN_CN_API_KEY` |
| `lib/multimodal.js` / `lib/ark-api.js` | `promptText` 仅取最新一轮 user 消息；视频轮询单次请求与睡眠均受 `deadline` 约束 |
| `lib/quota.js` / `lib/client.js` | 移除 `bytepluses.com` 混收并过滤过期 Cookie；`saveStoredCookie` 改原子 `0600` 写；`fetchUsageWithCookie` 禁自动重定向并识别 3xx/401/403 过期；`ArkQuota` 接入卸载 `dispose()`；`#applyLedger` 同步滚窗 `resetAt` 修复「已重置 后重置」；`!mine` 重置面板并停轮询、清理定时器与在途请求 |

v1.1.5（2026-11-26，发布后复核收口）：
- `lib/responses-sse.js` / `lib/media-io.js`：SSE 单事件与行流超出 32 MB 缓冲上限时改为抛出不可重试的 `MALFORMED_RESPONSE`（此前抛 `STREAM_CLOSED` 在开启断流重试后会被无意义重试）。
- `lib/adapter.js` / `index.js`：默认重试上限收口为 `maxRetries: 2`（配 `initialDelayMs: 1000` / `maxDelayMs: 10000` / `jitterRatio: 0.1`），并向 `Config` 暴露 `requestTimeoutMs`（默认 120000 ms、最小 1000 ms）传给适配器。

测试用本机 DeepSeek Harness 内置运行时；其他安装路径用 `DSH_TEST_NODE` 指定。

## License

MIT
