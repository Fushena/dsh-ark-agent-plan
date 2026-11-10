/**
 * dsh-ark-agent-plan 浏览器半边：输入行「◔ 额度」徽标 + 明细面板。
 *
 * - 徽标显示套餐档位与**近 5 小时**已用百分比（如「Medium · 12%」），点击打开面板。
 *   固定用 5 小时窗口而不是「三窗口最高」：用户要看的是「现在这波用了多少」。
 * - 面板列出 5 小时 / 周 / 月三条额度的 剩余/总量、已用百分比、重置倒计时。
 * - 数据来自宿主路由 GET /ark-agent-plan/quota（同源只读），30s 轮询 + 打开时强制刷新。
 * - 弹层用 createPortal 挂到 body 走 fixed 定位（宿主工具栏的 transform 会劫持包含块）。
 * - 样式经 <style data-plugin-css> 注入，重复挂载去重。
 */
window.__ModuleLoader__.load({
  id: "dsh-ark-agent-plan",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    let createPortal = null;
    try {
      const ReactDOM = require("react-dom");
      if (typeof ReactDOM?.createPortal === "function") createPortal = ReactDOM.createPortal;
    } catch { /* 无 react-dom：内联回退 */ }

    const { useState, useEffect, useLayoutEffect, useRef, useCallback } = React;
    const h = React.createElement;

    const QUOTA = "/ark-agent-plan/quota";
    const REFRESH = "/ark-agent-plan/quota/refresh";
    const LOGIN = "/ark-agent-plan/quota/login";
    const STYLE_ID = "dsh-ark-agent-plan-quota.css";
    const POLL_MS = 30_000;

    const COPY = {
      zh: {
        badge: "额度", unknown: "额度 ?",
        title: "Agent Plan 额度",
        fiveHour: "近 5 小时", weekly: "近一周", monthly: "近一月",
        remaining: "剩余", used: "已用", quota: "总量", reset: "重置",
        resetIn: "后重置", refreshed: "更新于", refresh: "刷新",
        estimated: "含本地估算", estimatedHint: "· 实时估算（下次同步校准）",
        planType: "套餐", noData: "尚未获取额度数据",
        bridgeOff: "浏览器桥不可用：需要 Chrome 已打开且已装 dsh-chrome-bridge 扩展",
        noTab: "需要更新登录凭据",
        detail: "查看控制台",
        relogin: "更新凭据",
        reloginHint: "启动 Chrome（装 dsh-chrome-bridge 扩展）并登录 console.volcengine.com，点此更新一次；之后即可脱离 Chrome 刷新额度。",
        remainingLabel: "剩余", of: "/",
      },
      en: {
        badge: "Quota", unknown: "Quota ?",
        title: "Agent Plan Quota",
        fiveHour: "5-hour", weekly: "Weekly", monthly: "Monthly",
        remaining: "left", used: "used", quota: "total", reset: "resets",
        resetIn: "until reset", refreshed: "updated", refresh: "Refresh",
        estimated: "estimated", estimatedHint: "· live estimate (recalibrated on next sync)",
        planType: "Plan", noData: "No quota data yet",
        bridgeOff: "Browser bridge unavailable: open Chrome with dsh-chrome-bridge extension",
        noTab: "Login credential needs a refresh",
        detail: "Open console",
        relogin: "Update credential",
        reloginHint: "Open Chrome (with dsh-chrome-bridge) and sign in to console.volcengine.com, then click here once; afterwards quota refresh works without Chrome.",
        remainingLabel: "left", of: "/",
      },
    };

    // DSH 宿主 locale 是异步写入的，且默认中文；只有明确英文才切 en。
    const lang = () => {
      const attr = (document.documentElement.getAttribute("lang") || "").toLowerCase();
      if (attr.startsWith("en")) return "en";
      if (attr.startsWith("zh")) return "zh";
      const nav = (navigator?.language || "").toLowerCase();
      return nav.startsWith("en") ? "en" : "zh";
    };
    const t = () => COPY[lang()];

    /** 剩余毫秒 → 「3小时25分钟」。 */
    function formatRemaining(ms) {
      const en = lang() === "en";
      if (!Number.isFinite(ms) || ms <= 0) return en ? "now" : "已重置";
      const totalMinutes = Math.floor(ms / 60_000);
      const days = Math.floor(totalMinutes / 1440);
      const hours = Math.floor((totalMinutes % 1440) / 60);
      const minutes = totalMinutes % 60;
      const d = en ? "d" : "天", hUnit = en ? "h" : "小时", mUnit = en ? "m" : "分钟";
      if (days > 0) return hours > 0 ? `${days}${d} ${hours}${hUnit}` : `${days}${d}`;
      if (hours > 0) return minutes > 0 ? `${hours}${hUnit} ${minutes}${mUnit}` : `${hours}${hUnit}`;
      if (minutes > 0) return `${minutes}${mUnit}`;
      return en ? "<1m" : "不到1分钟";
    }

    /** 额度数字 → 「1,199 / 1万」「3,091.92 / 3.5万」。 */
    function formatCredits(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return "—";
      if (number >= 10_000) {
        const wan = number / 10_000;
        const text = wan >= 10 ? String(Math.round(wan)) : String(Math.round(wan * 100) / 100);
        return `${text}万`;
      }
      if (number >= 1_000) {
        const rounded = Math.round(number * 100) / 100;
        return rounded.toLocaleString(lang() === "en" ? "en-US" : "zh-CN");
      }
      return String(Math.round(number * 1000) / 1000);
    }

    function percentText(value) {
      const number = Number(value);
      if (!Number.isFinite(number)) return "—";
      return `${Math.round(number * 10) / 10}%`;
    }

    const STYLE = `
.arkq-badge{display:inline-flex;align-items:center;gap:5px;border:none;background:transparent;
  color:var(--dsh-text-secondary,#8b8b8b);font:inherit;font-size:12px;line-height:1;
  padding:4px 6px;border-radius:6px;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s}
.arkq-badge:hover{background:var(--dsh-hover,#ffffff14);color:var(--dsh-text-primary,#e8e8e8)}
.arkq-badge[data-warn="1"]{color:#f0a020}
.arkq-dot{width:7px;height:7px;border-radius:50%;flex:none;background:#3fa34d}
.arkq-badge[data-warn="1"] .arkq-dot{background:#f0a020}
.arkq-overlay{position:fixed;inset:0;z-index:2147483000;background:transparent}
.arkq-panel{position:fixed;z-index:2147483001;box-sizing:border-box;width:320px;max-width:calc(100vw - 24px);
  background:var(--dsh-surface-raised,#1f1f1f);color:var(--dsh-text-primary,#e8e8e8);
  border:1px solid var(--dsh-border,#ffffff1f);border-radius:12px;
  box-shadow:0 12px 36px #00000059;padding:14px;font-size:13px}
.arkq-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
.arkq-title{font-weight:600;font-size:14px}
.arkq-plan{font-size:11px;opacity:.65;text-transform:uppercase;letter-spacing:.5px}
.arkq-row{margin-bottom:13px}
.arkq-row:last-of-type{margin-bottom:0}
.arkq-rowhead{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:5px}
.arkq-label{font-size:12px;opacity:.75}
.arkq-pct{font-size:12px;font-variant-numeric:tabular-nums;opacity:.9}
.arkq-bar{height:4px;border-radius:2px;background:var(--dsh-border,#ffffff26);overflow:hidden}
.arkq-fill{height:100%;border-radius:2px;background:#3fa34d;transition:width .3s}
.arkq-fill[data-high="1"]{background:#f0a020}
.arkq-fill[data-high="2"]{background:#e5484d}
.arkq-meta{display:flex;align-items:baseline;justify-content:space-between;margin-top:5px;font-size:11px;opacity:.6}
.arkq-remain{font-variant-numeric:tabular-nums}
.arkq-foot{display:flex;align-items:center;justify-content:space-between;margin-top:13px;
  padding-top:10px;border-top:1px solid var(--dsh-border,#ffffff1a);font-size:11px;opacity:.6}
.arkq-btn{border:none;background:transparent;color:inherit;font:inherit;font-size:11px;
  cursor:pointer;padding:3px 6px;border-radius:4px;opacity:.8}
.arkq-btn:hover{background:var(--dsh-hover,#ffffff14);opacity:1}
.arkq-empty{padding:8px 0;font-size:12px;line-height:1.7;opacity:.7}
.arkq-err{color:#f0a020;font-size:12px;line-height:1.6;margin-top:8px}
`;

    function ensureStyle() {
      if (typeof document === "undefined") return;
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return;
      const el = document.createElement("style");
      el.setAttribute("data-plugin-css", STYLE_ID);
      el.textContent = STYLE;
      document.head.appendChild(el);
    }

    /** 拉取额度：GET 缓存优先，force 时走 POST 回源。 */
    async function fetchQuota({ force = false, login = false } = {}) {
      const url = login ? LOGIN : force ? REFRESH : QUOTA;
      const response = await fetch(url, {
        method: force ? "POST" : "GET",
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }

    /**
     * 徽标示数固定取**近 5 小时**窗口的已用百分比（用户要求 2026-11-10）。
     *
     * 旧实现取三条窗口里占用比例最高的一项（topWindow），于是同一时刻可能显示
     * weekly 的 74% 而 5 小时窗口才用了 72% —— 用户想盯的是「现在这波用了多少」，
     * 而不是「哪个周期最紧」。所以改成固定 key=fiveHour：
     *   - 命中 fiveHour 就返回它；
     *   - 服务端窗口集合里没有 fiveHour（接口改版/降级）时退回占用最高的一项，
     *     宁可显示近似值也不要空着；
     *   - 完全没有 windows 返回 null（徽标显示「额度」占位，不显示残缺文案）。
     */
    function fiveHourWindow(data) {
      const windows = data?.windows ?? [];
      if (!windows.length) return null;
      const fiveHour = windows.find((item) => item?.key === "fiveHour");
      if (fiveHour) return fiveHour;
      return windows.reduce((best, item) => (item.percentUsed > (best?.percentUsed ?? -1) ? item : best), null);
    }

    function QuotaRow({ item, labels }) {
      const percent = Number.isFinite(item.percentUsed) ? item.percentUsed : 0;
      const high = percent >= 90 ? 2 : percent >= 70 ? 1 : 0;
      const resetIn = item.resetAt ? formatRemaining(item.resetAt - Date.now()) : "";
      return h("div", { className: "arkq-row" },
        h("div", { className: "arkq-rowhead" },
          h("span", { className: "arkq-label" }, item.label),
          h("span", { className: "arkq-pct" }, percentText(percent)),
        ),
        h("div", { className: "arkq-bar" },
          h("div", { className: "arkq-fill", "data-high": String(high), style: { width: `${Math.min(100, percent)}%` } }),
        ),
        h("div", { className: "arkq-meta" },
          h("span", { className: "arkq-remain" },
            `${labels.remaining} ${formatCredits(item.remaining)} ${labels.of} ${formatCredits(item.quota)}${item.estimated ? ` ${labels.estimatedHint}` : ""}`),
          item.resetAt
            ? h("span", null, `${formatRemaining(item.resetAt - Date.now())} ${labels.resetIn}`)
            : null,
        ),
      );
    }

    const PANEL_WIDTH = 320;
    const GAP = 8;

    /**
     * 把面板摆在徽标上方：面板底边留 GAP 贴住徽标顶边，右边缘与徽标右边缘对齐。
     * 上方空间不足时翻到下方，保证面板始终完整可见。
     */
    /**
     * 依据实测的面板外框尺寸计算落位：面板底边贴徽标顶边（留 GAP），右边缘与徽标右边缘对齐。
     * 上方放不下时翻到徽标下方，保证完整可见。
     */
    function computeLayout(badge, panel) {
      const margin = 12;
      const width = panel.width || PANEL_WIDTH;
      const height = panel.height || 0;
      const left = Math.min(
        Math.max(margin, badge.right - width),
        Math.max(margin, window.innerWidth - width - margin),
      );
      const above = badge.top - GAP - height;
      const below = badge.bottom + GAP;
      const fitsAbove = above >= margin;
      const fitsBelow = below + height <= window.innerHeight - margin;
      const top = height > 0 && !fitsAbove && fitsBelow ? below : Math.max(margin, above);
      return { top, left };
    }

    function Panel({ data, error, onClose, onRefresh, onRelogin, anchor, labels }) {
      const [busy, setBusy] = useState(false);
      const panelRef = useRef(null);
      const [layout, setLayout] = useState(null);

      // 先测量真实外框尺寸再落位，内容变化（加载/报错）后重新测量，避免错位。
      useLayoutEffect(() => {
        const el = panelRef.current;
        if (!el) return;
        const reposition = () => {
          const box = el.getBoundingClientRect();
          setLayout(computeLayout(anchor, { width: box.width, height: box.height }));
        };
        reposition();
        // 内容行数变化会改变高度，用 ResizeObserver 跟随重排。
        let observer = null;
        if (typeof ResizeObserver === "function") {
          observer = new ResizeObserver(() => reposition());
          observer.observe(el);
        }
        return () => { try { observer?.disconnect(); } catch { /* 幂等 */ } };
      }, [anchor, data]);
      const panelStyle = layout
        ? { ...layout, visibility: "visible" }
        : { top: 0, left: 0, visibility: "hidden" };
      const windows = data?.windows ?? [];
      return createPortal
        ? createPortal(h("div", { className: "arkq-overlay", onClick: onClose },
            h("div", { ref: panelRef, className: "arkq-panel", style: panelStyle, translate: "no", onClick: (event) => event.stopPropagation() },
              h("div", { className: "arkq-head" },
                h("div", null,
                  h("div", { className: "arkq-title" }, labels.title),
                  data?.planType ? h("div", { className: "arkq-plan" }, `${labels.planType} ${data.planType}`) : null,
                ),
                h("button", {
                  className: "arkq-btn",
                  onClick: async () => { setBusy(true); try { await onRefresh(); } finally { setBusy(false); } },
                  disabled: busy,
                }, busy ? "…" : labels.refresh),
              ),
              windows.length
                ? windows.map((item) => h(QuotaRow, { key: item.key, item, labels }))
                : h("div", { className: "arkq-empty" }, error || labels.noData),
              error && windows.length ? h("div", { className: "arkq-err" }, error) : null,
              h("div", { className: "arkq-foot" },
                h("span", null, data?.fetchedAt
                  ? `${labels.refreshed} ${new Date(data.fetchedAt).toLocaleTimeString()}`
                  : ""),
                h("span", { style: { display: "flex", gap: 8, alignItems: "center" } },
                  h("button", {
                    className: "arkq-btn",
                    title: labels.reloginHint,
                    onClick: async () => { setBusy(true); try { await onRelogin(); } finally { setBusy(false); } },
                    disabled: busy,
                  }, labels.relogin),
                  h("a", {
                    className: "arkq-btn",
                    href: "https://console.volcengine.com/ark/region:cn-beijing/subscription/agent-plan",
                    target: "_blank", rel: "noreferrer",
                  }, labels.detail),
                ),
              ),
            ),
          ), document.body)
        : h("div", { ref: panelRef, className: "arkq-panel", style: panelStyle }, windows.length ? windows.map((item) => h(QuotaRow, { key: item.key, item, labels })) : labels.noData);
    }

    /** 本插件 provider id 的兜底值（宿主路由返回后会以其为准）。 */
    const DEFAULT_PROVIDER_ID = "ark-agent-plan";

    /**
     * 从徽标容器向上走祖先，在最近的 composer 子树里找模型触发器，
     * 读出当前会话选中模型的 provider id。找不到（未选模型/占位文本）返回 null。
     * 菜单选项行挂在 body 门车里，不会被 composer 祖先的子树查询命中。
     */
    function readTriggerProvider(root) {
      if (typeof document === "undefined") return null;
      let node = root;
      while (node && node !== document.body && node.parentElement) {
        const span = node.querySelector?.('[class*="triggerLabel"] [data-provider-id]');
        if (span) return span.getAttribute("data-provider-id");
        node = node.parentElement;
      }
      return null;
    }

    function Badge() {
      const [open, setOpen] = useState(false);
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [anchor, setAnchor] = useState({ top: 0, left: 0, right: 0, bottom: 0, width: 0 });
      // 只有当前会话选中的模型属于本插件 provider 时才显示徽标。
      const [mine, setMine] = useState(false);
      const ref = useRef(null);
      const containerRef = useRef(null);
      const providerIdRef = useRef(DEFAULT_PROVIDER_ID);
      const labels = t();

      const load = useCallback(async (force, login = false) => {
        try {
          const payload = await fetchQuota({ force, login });
          // 宿主返回的 provider id 才是权威值（用户可能改过配置）。
          if (payload?.provider?.id) providerIdRef.current = String(payload.provider.id);
          if (payload.ok) { setData(payload.data); setError(null); }
          else { setError(payload.error || labels.noData); }
          return payload;
        } catch (event) {
          setError(`额度接口不可达：${event instanceof Error ? event.message : String(event)}`);
          return null;
        }
      }, []);

      // 探测当前 composer 的模型触发器：provider 匹配才显示徽标。
      const probe = useCallback(() => {
        setMine(readTriggerProvider(containerRef.current) === providerIdRef.current);
      }, []);

      useEffect(() => {
        if (typeof document === "undefined" || typeof MutationObserver === "undefined") return undefined;
        probe();
        let scheduled = false;
        // 节流 400ms：聊天流式输出会高频触发 DOM 变更，探测本身只是小范围查询。
        const schedule = () => {
          if (scheduled) return;
          scheduled = true;
          setTimeout(() => { scheduled = false; probe(); }, 400);
        };
        const observer = new MutationObserver(schedule);
        observer.observe(document.body, {
          subtree: true, childList: true, attributes: true,
          attributeFilter: ["data-provider-id"],
        });
        window.addEventListener("focus", schedule);
        return () => {
          observer.disconnect();
          window.removeEventListener("focus", schedule);
        };
      }, [probe]);

      useEffect(() => {
        ensureStyle();
        load(false);
        const timer = setInterval(() => { if (!open) load(false); }, POLL_MS);
        return () => clearInterval(timer);
      }, [load, open]);

      const toggle = async () => {
        if (!open && ref.current) {
          // 传完整矩形：定位要用 right/bottom，裁剪字段会让面板落错位置。
          const rect = ref.current.getBoundingClientRect();
          setAnchor({ top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width });
          setOpen(true);
          // 打开面板时强制回源，保证看到最新额度。
          await load(true);
          return;
        }
        setOpen(false);
      };

      // 徽标示数固定用近 5 小时窗口（见 fiveHourWindow 的注释）。
      const shown = fiveHourWindow(data);
      const warn = shown && shown.percentUsed >= 90;
      // 首屏数据未到时只显示「额度」，避免闪出「额度？」这种残缺文案。
      const text = shown
        ? `${data?.planType ? data.planType.replace(/^./, (c) => c.toUpperCase()) + " · " : ""}${percentText(shown.percentUsed)}`
        : labels.badge;

      // 当前模型不属于本插件 provider 时整块不渲染（连按钮都不占位）。
      // 注意：containerRef 必须挂在外层，否则探测拿不到祖先链、永远判为不匹配。
      if (!mine) {
        return h("span", { ref: containerRef, style: { display: "none" } });
      }

      return h(React.Fragment, null,
        h("button", {
          ref: (node) => { ref.current = node; containerRef.current = node; },
          className: "arkq-badge",
          "data-warn": warn ? "1" : "0",
          translate: "no",
          onClick: toggle,
          title: labels.title,
        },
          h("span", { className: "arkq-dot" }),
          text,
        ),
        open
          ? h(Panel, {
              data, error, labels, anchor,
              onClose: () => setOpen(false),
              onRefresh: () => load(true),
              // 「更新凭据」是唯一允许插件碰浏览器的入口（用户显式点击）。
              onRelogin: () => load(true, true),
            })
          : null,
      );
    }

    function apply(ctx) {
      const slots = ctx.get("slots");
      if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
      const seat = { name: "conversation.input.right", order: 42 };
      ctx.effect(() => slots.inject(seat.name, () => {
        try {
          const dispose = slots.register(
            { name: seat.name, id: "ark-agent-plan-quota", order: seat.order },
            () => h(Badge, null),
          );
          const release = typeof dispose === "function" ? dispose : () => {};
          return () => { try { release(); } catch { /* 幂等 */ } };
        } catch (error) {
          ctx.logger?.warn?.(new Error(`ark-agent-plan: 挂载额度徽标失败 —— ${error instanceof Error ? error.message : String(error)}`));
          return () => {};
        }
      }), "dsh-ark-agent-plan: quota badge");
    }

    exports.apply = apply;
    // 动态插件的 fiber 只看得见声明过的服务：slots 是徽标唯一硬依赖。
    exports.inject = ["slots"];
    // 纯函数导出：仅供离线测试断言「徽标示数取哪个窗口」这类规则，
    // 运行时不会用到（模块加载器只校验 apply 存在）。
    exports.fiveHourWindow = fiveHourWindow;
    exports.percentText = percentText;

    return module.exports;
  },
});
