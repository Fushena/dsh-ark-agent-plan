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
  2. probe each candidate with `POST /responses` carrying only `model` — `404 UnsupportedModel` means unavailable, `400 MissingParameter` means the name is recognized. Probes cost no tokens (8-way concurrent, ~1.5 s for the whole catalog).

  Alias and dated ids are folded into one entry per model (`deepseek-v4.1-flash` ≡ `deepseek-v4-1-flash-261017`), preferring the friendly alias. Refreshes on a timer; failures keep the last good catalog.
- **Thinking-effort control** per model contract (`off/low/high/max` on V4.1 Flash, five tiers on V4 Pro/Flash, no-off on GLM/Kimi), including the explicit `thinking.type` toggle the gateway requires for V4.1 Flash / Seed 2.1 Turbo.
- **Harness capabilities**: server-side built-in tools declared through the Responses `tools` array — `web_search`, `code_interpreter`, `web_extractor` (verified to produce `web_search_call` items). Activity is rendered into the transcript as Markdown.
- **Quota badge & panel** (ChatGPT-style): the composer shows `Medium · 66.8%` — that figure is the **5-hour window's** used percentage (not the busiest of the three windows), matching what users watch while a session is running; clicking opens a panel with the 5-hour / weekly / monthly Agent Plan AFP quotas — remaining vs total, percent used, and a live reset countdown. Data comes from the console's `GetAgentPlanAFPUsage` endpoint, which the plan API key cannot reach (401).

  **Between syncs, the numbers tick locally:** every completed inference is priced through a per-model AFP table (`lib/pricing.js`) and added to a local ledger, so the panel's percent-used updates in real time as you chat — marked with an "estimate" hint. Each successful console sync replaces the estimate with the authoritative value, wiping drift.

  **Temporary tabs clean themselves up:** any console tab the plugin opens lives in the bridge's agent window and is closed the moment the harvest finishes — including strays left by earlier runs, so repeated refreshes can never pile tabs up. A failure backoff (1 min doubling to 30 min) stops it from reopening tabs while the console login is invalid.

  **Credential bootstrap, then Chrome-free:** the first fetch harvests the console's full cookie jar (including the HttpOnly `digest` / `userInfo` tickets) through the `dsh-chrome-bridge` CDP channel, persists it to `~/.dsh/.ark-plan-console-cookie.json` (mode 0600), and from then on every refresh is a plain `fetch` from Node — **Chrome does not need to be running**, and no console tab has to stay open. Only when the stored cookie expires does the panel ask for a one-click re-harvest (`POST /ark-agent-plan/quota/login`). Host routes: `GET /ark-agent-plan/quota` (5 min cache), `POST /ark-agent-plan/quota/refresh`, `POST /ark-agent-plan/quota/login`.
- Dual transport: Responses for most models, Chat Completions for Kimi K2.7 Code.
- Credentials resolved per request via the DSH credential service (`ARK_AGENT_PLAN_CN_API_KEY` first, then common aliases), so key changes need no restart.

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

测试用本机 DeepSeek Harness 内置运行时；其他安装路径用 `DSH_TEST_NODE` 指定。

## License

MIT
