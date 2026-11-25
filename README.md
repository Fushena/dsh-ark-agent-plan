# dsh-ark-agent-plan

Volcengine Ark **Agent Plan** provider for DeepSeek Harness (DSH 0.2.x), authored against the live gateway on 2026-11-05.

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
- **Multimodal model support**: Seedream uses `/images/generations`. Seedance creates and polls tasks at `/contents/generations/tasks` and accepts image attachments from the latest user message. A single image sets the first frame, while multiple images serve as references. TTS uses the Agent Plan speech synthesis endpoint. For ASR, select `doubao-seed-asr-2.0` and attach a 16 kHz, 16-bit mono PCM WAV file up to 10 MiB in the current message. Embedding responses provide the full vector in a JSON attachment, or as JSON text if attachment storage is unavailable. The regression tests use local HTTP servers and simulated speech responses.
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
| `tts.apiKeyEnv` | Credential ref for a key valid on the speech resource (default `ARK_API_KEY`; point it at your plan/voice key). |
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

测试用本机 DeepSeek Harness 内置运行时；其他安装路径用 `DSH_TEST_NODE` 指定。

## License

MIT
