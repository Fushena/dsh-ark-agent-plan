# dsh-ark-agent-plan

Volcengine Ark **Agent Plan** provider for DeepSeek Harness (DSH 0.2.x), authored against the live gateway on 2026-11-05.

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
cd /Users/fushe/Documents/deepseek-harness/default-workspace/ark-agent-plan
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

测试用本机 DeepSeek Harness 内置运行时；其他安装路径用 `DSH_TEST_NODE` 指定。

## License

MIT
