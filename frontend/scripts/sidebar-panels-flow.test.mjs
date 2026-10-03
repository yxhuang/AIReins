#!/usr/bin/env node
// 静态渲染核对主区/侧栏分工；真实浏览器动画、点击与 iframe 网络另行验收。
import { strict as assert } from "node:assert";
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.window = { location: { hash: "#/", href: "http://127.0.0.1:8790/" }, innerWidth: 1280, addEventListener() {} };
// 这里验证的是列表筛选，不是折叠：时间分区全部展开（默认会折叠「更早」）
globalThis.localStorage = { getItem: (key) => key === "workbench-collapsed-time-sections" ? "[]" : null, setItem() {}, removeItem() {} };
const { store, Store } = await import("../src/store.ts");
const { App } = await import("../src/App.tsx");
const { Sidebar } = await import("../src/components/Sidebar.tsx");
const { PanelActions } = await import("../src/components/PanelActions.tsx");
const { HistoryPreviewPane } = await import("../src/components/HistoryView.tsx");

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (error) { console.error(`❌ ${name}\n   ${error.message}`); process.exitCode = 1; }
};
const page = { id: "ai-usage", name: "AI 用量", icon: "📊", type: "iframe", url: "http://127.0.0.1:8788", maxWidth: "33%" };
store.pages = [page, { ...page, id: "other", name: "其他页面" }];
const renderApp = () => renderToStaticMarkup(React.createElement(App));
const mainOf = (html) => html.match(/<main class="main">([\s\S]*?)<\/main>/)?.[1];
const sidebarOf = (html) => html.match(/<aside class="sidebar(?: sidebar-page-open)?">([\s\S]*?)<\/aside>/)?.[1];

t("历史旧链接：列表在侧栏，窄屏主页没有 has-main", () => {
  store.navigateHistory();
  const html = renderApp();
  assert.ok(sidebarOf(html)?.includes('aria-label="历史会话"'));
  assert.ok(sidebarOf(html)?.includes('aria-expanded="true"'));
  assert.ok(!mainOf(html)?.includes('aria-label="历史会话"'));
  assert.ok(!html.includes('class="app has-main"'));
  assert.ok(sidebarOf(html)?.includes('aria-label="收起历史会话"'));
  assert.ok(!html.includes('sidebar-page-open'), "历史面板不加宽");
});

t("选历史会话：只有主区显示预览与导入，列表仍挂载便于手机返回", () => {
  store.selectHistory({ agent: "claude", nativeSessionId: "native-id", cwd: "/repo", title: "预览标题", source: "interactive", lastActivityAt: "2026-10-01T00:00:00Z", filePath: "/history" });
  const html = renderApp();
  assert.ok(html.includes('class="app has-main"'));
  assert.ok(mainOf(html)?.includes('aria-label="会话预览"'));
  assert.ok(mainOf(html)?.includes("导入并续接"));
  assert.ok(sidebarOf(html)?.includes('aria-label="历史会话"'));
  store.backToHistoryList();
  const back = renderApp();
  assert.ok(!back.includes('class="app has-main"'));
  assert.ok(sidebarOf(back)?.includes('sidebar-panel-expanded'));
});

t("页面旧链接：健康检查加载态在侧栏，仅一个面板展开", () => {
  store.navigatePage("ai-usage");
  const html = renderApp();
  assert.ok(sidebarOf(html)?.includes("正在检查目标服务"));
  assert.ok(!mainOf(html)?.includes("正在检查目标服务"));
  assert.equal((html.match(/sidebar-panel-expanded/g) ?? []).length, 1);
  assert.ok(!html.includes('class="app has-main"'));
  assert.ok(!html.includes('class="page-nav-title">页面'));
  assert.ok(html.includes('class="sidebar sidebar-page-open"'), "页面面板添加桌面加宽标记");
  const collapsed = renderToStaticMarkup(React.createElement(Sidebar, {
    collapsed: true, onToggle() {}, newOpen: false, onNewOpenChange() {},
  }));
  assert.ok(!collapsed.includes("sidebar-page-open"), "页面路由下收起态不加宽");
});

t("AI 用量打开后入口变后退，图标态也保留返回语义，收起后恢复原入口", () => {
  store.navigatePage("ai-usage");
  const html = renderApp();
  assert.ok(sidebarOf(html).includes('aria-label="后退：收起AI 用量"'));
  assert.ok(sidebarOf(html).includes('class="page-nav-name">后退</span>'));
  assert.ok(sidebarOf(html).includes('d="M15 5l-7 7 7 7"'));
  const collapsed = renderToStaticMarkup(React.createElement(Sidebar, {
    collapsed: true, onToggle() {}, newOpen: false, onNewOpenChange() {},
  }));
  assert.ok(collapsed.includes('aria-label="后退：收起AI 用量"'));
  store.closeSidebarPanel();
  const back = renderApp();
  assert.ok(sidebarOf(back).includes('aria-label="AI 用量"'));
  assert.ok(!sidebarOf(back).includes('aria-label="后退：收起AI 用量"'));
});

t("收起面板恢复会话列表；图标态保留历史/页面/设置/直达入口", () => {
  store.closeSidebarPanel();
  const html = renderApp();
  assert.ok(!html.includes("sidebar-panel-expanded"));
  assert.ok(!html.includes("sidebar-page-open"), "收起面板移除加宽标记");
  const icons = renderToStaticMarkup(React.createElement(Sidebar, {
    collapsed: true, onToggle() {}, newOpen: false, onNewOpenChange() {},
  }));
  assert.ok(icons.includes('aria-label="历史会话"'));
  assert.ok(icons.includes('aria-label="AI 用量"'));
  for (const label of ["终端", "派单", "文件", "浏览文件"]) assert.ok(!icons.includes(`aria-label="${label}"`));
  assert.ok(icons.includes('class="settings"'));
  assert.ok(icons.includes('aria-label="直达"'));
  assert.ok(!icons.includes('<span>直达</span>'), "收起态只显示直达图标");
});

t("底部单行显示历史与额度，额度为加宽胶囊、直达为圆钮；内容仍在覆盖区", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const foot = (html) => sidebarOf(html)?.match(/<div class="sidebar-foot">([\s\S]*)/)?.[1];
  store.navigateHistory();
  const history = renderApp();
  assert.ok(sidebarOf(history).indexOf('id="sidebar-history-panel"') < sidebarOf(history).indexOf('class="sidebar-foot"'));
  assert.ok(!foot(history).includes('sidebar-panel-content'));
  for (const label of ["终端", "派单", "文件", "浏览文件"]) assert.ok(!foot(history).includes(`aria-label="${label}"`));
  assert.ok(foot(history).indexOf('aria-label="历史会话"') < foot(history).indexOf('aria-label="AI 用量"'));
  assert.ok(foot(history).includes('class="sidebar-foot-pages"'));
  assert.ok(foot(history).indexOf('aria-label="AI 用量"') < foot(history).indexOf('class="sidebar-foot-actions"'));
  assert.ok(foot(history).indexOf('class="settings"') < foot(history).indexOf('aria-label="直达"'));
  assert.ok(history.includes('inert=""'), "覆盖时会话区不可聚焦");
  store.navigatePage("ai-usage");
  const pageHtml = renderApp();
  assert.ok(!foot(pageHtml).includes('sidebar-panel-content'));
  assert.ok(foot(pageHtml).indexOf('aria-label="历史会话"') < foot(pageHtml).indexOf('aria-label="AI 用量"'));
  assert.match(css, /\.sidebar-session-area \{\s*grid-area: 1 \/ 1;/);
  assert.match(css, /\.sidebar-foot \{\s*grid-area: 2 \/ 1;/);
  const overlayCss = css.match(/\.sidebar-panel-expanded \{([\s\S]*?)\}/)[1];
  assert.ok(overlayCss.includes("grid-area: 1 / 1"));
  assert.ok(!overlayCss.includes("order:"));
  assert.ok(!css.includes(".sidebar-foot.has-panel"));
  const desktopFoot = css.match(/@media \(min-width: 721px\) \{\s*\/\* 桌面展开态[\s\S]*?\n\}/)?.[0];
  assert.ok(desktopFoot, "新增规则限定桌面展开态");
  assert.match(desktopFoot, /flex-direction: row;.*flex-wrap: nowrap/);
  for (const [selector, order] of [["settings", 1], ["page-nav:first-child", 2], ["page-nav:not(:first-child)", 3], ["launcher", 4]]) {
    assert.ok(desktopFoot.includes(`.${selector} { order: ${order};`));
  }
  assert.match(desktopFoot, /width: var\(--foot-btn\); height: var\(--foot-btn\)/);
  assert.match(desktopFoot, /border-radius: 50%/);
  assert.match(desktopFoot, /\.launcher-button > span \{ display: none; \}/);
  assert.ok(!desktopFoot.includes(".sidebar-foot-usage .page-nav-name"), "额度文字在桌面可见");
  assert.match(css, /\.page-nav-item\.sidebar-foot-usage \{ min-width: 88px; justify-content: center; \}/);
  store.closeSidebarPanel();
  const closed = foot(renderApp());
  assert.ok(closed.includes('class="page-nav-name">历史</span>'));
  assert.ok(closed.includes('class="page-nav-name">额度</span>'));
  assert.match(closed, /class="page-nav-item sidebar-foot-usage" title="AI 用量" aria-label="AI 用量"/);
  assert.match(closed, /class="launcher-button"[^>]*title="直达" aria-label="直达"/);
});

t("派单打开不替换主区历史预览，收起保留侧栏展开状态", () => {
  store.navigateHistory();
  store.selectHistory({ agent: "claude", nativeSessionId: "preview", cwd: "/repo", title: "保留预览", source: "interactive", lastActivityAt: "2026-10-01T00:00:00Z", filePath: "/history" });
  store.toggleDispatches();
  const html = renderApp();
  assert.ok(mainOf(html).includes('aria-label="会话预览"'));
  assert.ok(!mainOf(html).includes('aria-label="派单面板"'));
  assert.ok(sidebarOf(html).includes('id="sidebar-history-panel"'));
  assert.ok(html.indexOf('aria-label="派单面板"') > html.indexOf('</main>'));
  store.closeDispatches();
  const back = renderApp();
  assert.ok(mainOf(back).includes('aria-label="会话预览"'));
  assert.ok(sidebarOf(back).includes('sidebar-panel-expanded'));
  assert.ok(!back.includes('aria-label="派单面板"'));
});

t("共用入口按文件/终端/派单排列，能力位控制终端，打开状态高亮", () => {
  store.meta = { capabilities: { terminal: true }, drivers: {} };
  const renderActions = () => renderToStaticMarkup(React.createElement(PanelActions));
  let html = renderActions();
  assert.ok(html.indexOf('aria-label="文件"') < html.indexOf('aria-label="终端"'));
  assert.ok(html.indexOf('aria-label="终端"') < html.indexOf('aria-label="派单"'));
  assert.ok(html.includes('Ctrl+`'));
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.ok(!html.includes('page-nav-name'), "只有图标");
  store.setFilesOpen(true);
  assert.ok(renderActions().includes('aria-label="文件" aria-pressed="true"'));
  store.setFilesOpen(false);
  store.setTerminalOpen(true);
  assert.ok(renderActions().includes('aria-label="终端" aria-pressed="true"'));
  store.setTerminalOpen(false);
  store.toggleDispatches();
  assert.ok(renderActions().includes('aria-label="派单" aria-pressed="true"'));
  store.closeDispatches();
  store.meta = { ...store.meta, capabilities: { terminal: false } };
  assert.ok(!renderActions().includes('aria-label="终端"'));
  store.meta = null;
  html = renderActions();
  assert.ok(!html.includes('aria-label="终端"'));
  assert.equal((html.match(/<button/g) ?? []).length, 2);
});

t("会话、欢迎页与历史预览均有同组入口；手机列表有顶部入口且不重复终端快捷按钮", () => {
  store.meta = { capabilities: { terminal: true }, drivers: {} };
  store.ensureLoaded = async () => {};
  store.sessions = [{ id: "header", agent: "claude", cwd: "/repo", status: "idle", config: {}, createdAt: "2026-10-01T00:00:00Z", lastActivityAt: "2026-10-01T00:00:00Z" }];
  store.navigate("header");
  let html = renderApp();
  const head = mainOf(html).match(/<header class="session-head">([\s\S]*?)<\/header>/)?.[1];
  assert.ok(head.includes('class="panel-actions"'));
  assert.ok(!head.includes('ws-dot'));
  assert.ok(head.indexOf('aria-label="派单"') < head.indexOf('aria-label="更多"'));
  assert.ok(head.indexOf('aria-label="更多"') < head.indexOf('class="ws-note'));
  assert.ok(head.includes('aria-haspopup="menu" aria-expanded="false"'));
  assert.ok(head.includes('role="menuitem" aria-label="VSCode 继续"'));
  assert.ok(!head.includes('CLI 继续'));
  assert.equal((html.match(/aria-label="终端"/g) ?? []).length, 1);
  assert.ok(!sidebarOf(html).includes('class="panel-actions"'));
  // 手机顶栏：返回 · 标题 · 「⋯」；文件/终端/派单/AI 用量收进「⋯」，不再单独出 mobile-topbar
  assert.ok(head.includes('aria-label="返回会话列表"'));
  assert.ok(head.includes('class="mobile-title"'));
  const more = head.match(/class="session-more-menu"[\s\S]*$/)[0];
  for (const label of ["文件", "派单", "AI 用量"]) assert.ok(more.includes(label), label);
  assert.ok(!html.includes('<div class="mobile-topbar">'));
  store.navigate(null);
  html = renderApp();
  assert.ok(mainOf(html).includes('class="welcome-view"'));
  assert.ok(mainOf(html).includes('class="panel-actions"'));
  // 手机列表页：面板开关并进侧栏顶栏同一行（桌面 CSS 隐藏）
  assert.ok(sidebarOf(html).includes('class="mobile-panel-launcher"'));
  assert.equal((html.match(/aria-label="派单"/g) ?? []).length, 2);
  const item = { agent: "claude", nativeSessionId: "preview", cwd: "/repo", title: "历史标题", source: "interactive", lastActivityAt: "2026-10-01T00:00:00Z", filePath: "/history" };
  store.navigateHistory(); store.selectHistory(item);
  html = renderApp();
  assert.ok(mainOf(html).includes('class="panel-actions"'));
  assert.equal((html.match(/aria-label="终端"/g) ?? []).length, 1);
  assert.ok(!html.includes('mobile-panel-launcher'));
  const emptyPreview = renderToStaticMarkup(React.createElement(HistoryPreviewPane, { onBack() {} }));
  assert.ok(emptyPreview.includes('class="panel-actions"'));
});

t("更多菜单仅保留 VSCode 继续，不能释放时直接显示原因并禁用菜单项", () => {
  store.ensureLoaded = async () => {};
  const base = { id: "more", agent: "claude", cwd: "/repo", status: "idle", nativeSessionId: "native", config: {}, createdAt: "2026-10-01T00:00:00Z", lastActivityAt: "2026-10-01T00:00:00Z" };
  for (const [overrides, reason] of [
    [{}, null],
    [{ status: "running" }, "会话空闲时才能释放"],
    [{ status: "starting" }, "会话空闲时才能释放"],
    [{ status: "dead" }, "会话空闲时才能释放"],
    [{ released: true }, "worker 已释放；下次发送时自动从磁盘续接"],
    [{ nativeSessionId: undefined }, "首轮完成前没有原生会话 id，无法释放"],
  ]) {
    store.sessions = [{ ...base, ...overrides }];
    store.navigate("more");
    const head = mainOf(renderApp()).match(/<header class="session-head">([\s\S]*?)<\/header>/)[1];
    const menu = head.match(/<div id="[^"]+" class="session-more-menu"([\s\S]*?)<\/div>/)[0];
    assert.ok(menu.includes('role="menu"'));
    assert.ok(menu.includes('hidden=""'), "默认收起");
    // 文件/终端/派单/AI 用量是手机专用项（session-more-mobile，桌面 CSS 隐藏），不计入
    assert.equal((menu.match(/<button[^>]*role="menuitem"[^>]*>/g) ?? []).filter((tag) => !tag.includes("session-more-mobile")).length, 1);
    assert.ok(menu.includes('aria-label="VSCode 继续"'));
    assert.ok(menu.includes('role="img" aria-label="VSCode"'));
    if (reason) {
      assert.ok(menu.includes('disabled=""'));
      assert.ok(menu.includes('aria-disabled="true"'));
      assert.ok(menu.includes('aria-describedby='));
      assert.ok(menu.includes(`class="session-more-reason">${reason}</p>`), "原因写在菜单项下方");
    } else {
      assert.ok(!menu.includes('disabled=""'));
      assert.ok(menu.includes('aria-disabled="false"'));
      assert.ok(!menu.includes('session-more-reason'));
    }
    assert.ok(!head.replace(menu, "").includes('aria-label="VSCode 继续"'), "标题栏不再有独立释放按钮");
  }
});

// 真正模拟 history 栈：push/replace 不发事件，异步 back/forward 发 popstate + hashchange。
// 不用手工改 store 来“模拟后退”，否则无法发现同 hash 的 state 丢失、面板残留。
const originalWindow = globalThis.window;
function navigationHarness({ mobile = true, hash = "#/", state = null } = {}) {
  let narrow = mobile;
  const entries = [{ hash, state }];
  let index = 0;
  let backCalls = 0;
  const events = new Map();
  const pending = [];
  const emit = (name) => { for (const listener of events.get(name) ?? []) listener(); };
  const traverse = (delta) => pending.push(() => {
    const next = index + delta;
    if (next < 0 || next >= entries.length) return;
    const previousHash = entries[index].hash;
    index = next;
    emit("popstate");
    if (previousHash !== entries[index].hash) pending.unshift(() => emit("hashchange"));
  });
  const history = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    pushState(value, _title, url) {
      entries.splice(index + 1);
      entries.push({ hash: String(url), state: structuredClone(value) });
      index++;
    },
    replaceState(value, _title, url) { entries[index] = { hash: String(url), state: structuredClone(value) }; },
    back() { backCalls++; traverse(-1); },
    forward() { traverse(1); },
  };
  globalThis.window = {
    location: {
      get hash() { return entries[index].hash; },
      set hash(value) {
        if (value === entries[index].hash) return;
        history.pushState(null, "", value);
        emit("hashchange");
      },
      href: "http://127.0.0.1:8790/",
    },
    history, matchMedia: () => ({ matches: narrow }),
    addEventListener(name, listener) {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(listener);
    },
  };
  const bind = (s) => {
    s.ensureLoaded = async () => {};
    window.addEventListener("popstate", s.onPopState);
    window.addEventListener("hashchange", s.onHashChange);
    s.onHashChange();
    return s;
  };
  const s = bind(new Store());
  const flush = () => { while (pending.length) pending.shift()(); };
  return {
    s, history, entries, flush,
    step() { pending.shift()?.(); },
    setMobile(value) { narrow = value; },
    back() { history.back(); flush(); }, forward() { history.forward(); flush(); },
    get backCalls() { return backCalls; },
    reload() { events.clear(); return bind(new Store()); },
  };
}
const noRightPanel = (s) => assert.deepEqual([s.termOpen, s.filesOpen, s.dispatchesOpen], [false, false, false]);
const panelCases = [
  ["终端", s => s.setTerminalOpen(true), s => s.setTerminalOpen(false), "termOpen", "#/terminal"],
  ["文件", s => s.setFilesOpen(true), s => s.setFilesOpen(false), "filesOpen", "#/files"],
  ["派单", s => s.toggleDispatches(), s => s.closeDispatches(), "dispatchesOpen", "#/dispatches"],
];
for (const [name, open, close, flag, hash] of panelCases) {
  t(`手机主页→${name}→系统后退=主页，前进与关闭按钮可往返`, () => {
    const h = navigationHarness(); const { s } = h;
    open(s); assert.equal(window.location.hash, hash); assert.ok(s[flag]);
    assert.equal(h.history.length, 2);
    h.back(); assert.equal(s.currentId, null); noRightPanel(s); assert.equal(window.location.hash, "#/");
    h.forward(); assert.ok(s[flag]);
    close(s); h.flush(); noRightPanel(s);
    assert.equal(h.history.length, 2); assert.equal(window.location.hash, "#/");
    h.forward(); assert.ok(s[flag]);
  });
  t(`手机会话→${name}→后退=原会话→前进=面板，关闭不增 history`, () => {
    const h = navigationHarness(); const { s } = h;
    s.navigate("session-a"); open(s);
    assert.equal(s.currentId, "session-a"); assert.equal(h.history.length, 3);
    h.back(); noRightPanel(s); assert.equal(s.currentId, "session-a");
    assert.equal(window.location.hash, "#/session/session-a");
    h.forward(); assert.ok(s[flag]); assert.equal(s.currentId, "session-a");
    close(s); h.flush(); noRightPanel(s); assert.equal(s.currentId, "session-a");
    assert.equal(h.history.length, 3); assert.equal(h.backCalls, 2);
    h.forward(); assert.ok(s[flag]); assert.equal(window.location.hash, hash);
  });
}
t("手机主页→会话→后退=主页→前进=会话，顶栏返回不新增条目", () => {
  const h = navigationHarness(); const { s } = h;
  s.navigate("session-a"); h.back(); assert.equal(s.currentId, null);
  h.forward(); assert.equal(s.currentId, "session-a");
  s.backFromSession(); s.backFromSession(); h.flush(); // 连点只发一次 back
  assert.equal(h.backCalls, 2); assert.equal(s.currentId, null); assert.equal(h.history.length, 2);
  h.forward(); assert.equal(s.currentId, "session-a");
});
for (const [name, open, isOpen] of [
  ["AI 用量", s => s.navigatePage("ai-usage"), s => s.currentPageId === "ai-usage"],
  ["历史会话", s => s.navigateHistory(), s => s.historyOpen],
]) {
  t(`手机会话→${name}→后退=原会话→前进=页面，收起按来源返回`, () => {
    const h = navigationHarness(); const { s } = h;
    s.navigate("session-a"); open(s); assert.ok(isOpen(s));
    h.back(); assert.equal(s.currentId, "session-a"); assert.ok(!isOpen(s)); noRightPanel(s);
    h.forward(); assert.ok(isOpen(s));
    s.closeSidebarPanel(true); h.flush(); // 不依赖 App 的临时 returnToSession 标记
    assert.equal(s.currentId, "session-a"); assert.ok(!isOpen(s)); assert.equal(h.history.length, 3);
    h.forward(); assert.ok(isOpen(s));
  });
}
t("手机面板切换、派单详情与前往新会话都 push；同 hash 前进恢复正确来源", () => {
  const h = navigationHarness(); const { s } = h;
  s.navigate("session-a"); s.setTerminalOpen(true); s.setFilesOpen(true); s.navigateDispatches(["one"]);
  assert.equal(h.history.length, 5); assert.ok(s.dispatchesOpen); assert.equal(s.filesOpen, false);
  h.back(); assert.ok(s.filesOpen); h.back(); assert.ok(s.termOpen);
  h.forward(); h.forward(); s.navigate("session-b");
  assert.equal(h.history.length, 6); noRightPanel(s);
  h.back(); assert.ok(s.dispatchesOpen); assert.equal(s.currentId, "session-a");
  h.forward(); s.setFilesOpen(true); assert.equal(s.currentId, "session-b");
  h.back(); h.back(); h.back(); assert.ok(s.filesOpen); assert.equal(s.currentId, "session-a");
  h.forward(); h.forward(); h.forward(); assert.ok(s.filesOpen); assert.equal(s.currentId, "session-b");
  s.setFilesOpen(false); h.flush(); assert.equal(s.currentId, "session-b"); noRightPanel(s);
});
t("手机派单详情的返回按钮 back，前进仍可回详情", () => {
  const h = navigationHarness(); const { s } = h;
  s.navigate("session-a"); s.navigateDispatches(); s.navigateDispatches(["one"]);
  s.navigateDispatches(); h.flush(); assert.equal(window.location.hash, "#/dispatches");
  assert.equal(h.history.length, 4); h.forward(); assert.equal(window.location.hash, "#/dispatches/one");
});
t("刷新恢复面板和来源；未知相邻关系的关闭 replace，不误 back", () => {
  const h = navigationHarness();
  h.s.navigate("session-a"); h.s.navigatePage("ai-usage"); h.s.setFilesOpen(true);
  const reloaded = h.reload(); assert.ok(reloaded.filesOpen); assert.equal(reloaded.currentId, "session-a");
  reloaded.setFilesOpen(false);
  assert.equal(h.backCalls, 0); assert.equal(h.history.length, 4);
  assert.equal(reloaded.currentPageId, "ai-usage"); assert.equal(reloaded.filesOpen, false);
  reloaded.closeSidebarPanel(); assert.equal(window.location.hash, "#/session/session-a");
  assert.equal(h.history.length, 4); assert.equal(h.backCalls, 0);
});
t("手机冷启动面板/会话旧链接关闭 replace 到主页；不碰外部上一条", () => {
  for (const hash of ["#/terminal", "#/files", "#/dispatches/one", "#/page/ai-usage", "#/history", "#/session/cold"]) {
    const h = navigationHarness({ hash: "#/external" });
    h.history.pushState({ unrelated: true }, "", hash); h.s.onHashChange();
    if (hash === "#/terminal") h.s.setTerminalOpen(false);
    else if (hash === "#/files") h.s.setFilesOpen(false);
    else if (hash.startsWith("#/dispatches")) h.s.closeDispatches();
    else if (hash.startsWith("#/session")) h.s.backFromSession();
    else h.s.closeSidebarPanel();
    assert.equal(window.location.hash, "#/"); assert.equal(h.history.length, 2); assert.equal(h.backCalls, 0);
    noRightPanel(h.s); assert.ok(h.history.state.unrelated);
  }
});
t("同 hash 条目只发 popstate 也恢复会话；外部 hash 不沿用旧 state", () => {
  const h = navigationHarness(); const { s } = h;
  s.navigate("session-a"); s.setFilesOpen(true);
  const route = { ...h.history.state.workbenchNavigation.route, currentId: "session-b" };
  h.history.pushState({ workbenchNavigation: { version: 1, id: "external-state", route } }, "", "#/files");
  s.onHashChange(); assert.equal(s.currentId, "session-b");
  h.back(); assert.equal(s.currentId, "session-a"); assert.ok(s.filesOpen);
  window.location.hash = "#/session/external";
  assert.equal(s.currentId, "external"); noRightPanel(s);
  s.backFromSession(); assert.equal(window.location.hash, "#/"); // 外部 hash 不能证明来源
});
t("桌面终端/文件开关不写 history，派单/页面关闭保留原 hash push 语义", () => {
  const h = navigationHarness({ mobile: false }); const { s } = h;
  s.navigate("session-a"); const length = h.history.length;
  for (let i = 0; i < 3; i++) {
    s.setTerminalOpen(true); s.setTerminalOpen(false); s.setFilesOpen(true); s.setFilesOpen(false);
  }
  assert.equal(h.history.length, length); assert.equal(h.history.state, null);
  s.toggleDispatches(); s.closeDispatches(); assert.equal(h.history.length, length + 2);
  s.navigatePage("ai-usage"); s.closeSidebarPanel(); assert.equal(h.history.length, length + 4);
  assert.equal(h.backCalls, 0); assert.equal(s.currentId, "session-a");
});

const asyncTest = async (name, fn) => {
  try { await fn(); pass++; }
  catch (error) { console.error(`❌ ${name}\n   ${error.message}`); process.exitCode = 1; }
};
await asyncTest("复核1：终端能力关闭时冷启动或刷新终端路由 replace 到来源", async () => {
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;
  try {
    globalThis.document = { addEventListener() {} };
    globalThis.fetch = async (path) => ({ json: async () => ({ code: 0, data: path === "/api/meta"
      ? { capabilities: { terminal: false }, drivers: {} }
      : { sessions: [{ id: "session-a", seq: 0 }] } }) });
    for (const withSource of [false, true]) {
      const h = navigationHarness({ hash: withSource ? "#/" : "#/terminal" });
      let s = h.s;
      if (withSource) { s.navigate("session-a"); s.setTerminalOpen(true); s = h.reload(); }
      const length = h.history.length;
      s.connect = () => {}; s.startClock = () => {}; s.refreshPages = async () => {};
      await s.init();
      assert.equal(s.termOpen, false, "不能因能力关闭留下隐藏主区的 termOpen");
      assert.equal(window.location.hash, withSource ? "#/session/session-a" : "#/");
      assert.equal(s.currentId, withSource ? "session-a" : null);
      assert.equal(h.history.length, length); assert.equal(h.backCalls, 0);
      assert.equal(h.history.state.workbenchNavigation.route.termOpen, false);
    }
  } finally { globalThis.fetch = previousFetch; globalThis.document = previousDocument; }
});
t("复核2：异步后退跨到桌面后解锁，缩回手机仍可导航", () => {
  const h = navigationHarness(); const { s } = h;
  s.navigate("session-a"); s.setFilesOpen(true); s.setFilesOpen(false);
  h.setMobile(false); h.step(); // 桌面 popstate
  h.setMobile(true); h.step(); // 手机 hashchange
  s.navigate("session-b"); assert.equal(s.currentId, "session-b"); noRightPanel(s);
  s.setFilesOpen(true); s.setFilesOpen(false);
  h.setMobile(false); h.flush(); // 两个事件均在桌面处理
  h.setMobile(true); s.navigate("session-c");
  assert.equal(s.currentId, "session-c"); s.setTerminalOpen(true); assert.ok(s.termOpen);
});
t("复核2：两事件之间再次返回，旧 hashchange 不解除新 back 的锁", () => {
  const h = navigationHarness(); const { s } = h;
  s.navigate("session-a"); s.setFilesOpen(true); s.setFilesOpen(false);
  h.step(); s.backFromSession(); // popstate 已回会话，但旧 hashchange 还未到达
  h.step(); s.backFromSession(); h.flush();
  assert.equal(s.currentId, null); noRightPanel(s); assert.equal(h.backCalls, 2);
});
for (const [name, open, close, flag] of panelCases.slice(0, 2)) {
  t(`复核3：手机${name}跨到桌面关闭后 URL/state 一致，可刷新与重开`, () => {
    const h = navigationHarness(); const { s } = h;
    s.navigate("session-a"); open(s); const length = h.history.length;
    h.setMobile(false); close(s); assert.equal(s[flag], false);
    assert.equal(window.location.hash, "#/session/session-a");
    assert.equal(h.history.state.workbenchNavigation.route[flag], false);
    assert.equal(h.history.length, length); assert.equal(h.backCalls, 0);
    h.setMobile(true); const reloaded = h.reload();
    assert.equal(reloaded[flag], false); open(reloaded); assert.ok(reloaded[flag]);
    assert.equal(h.history.length, length + 1);
  });
}
await asyncTest("复核4：删除来源会话后后退与收起不恢复失效 ID 或写回 LAST_SESSION_KEY", async () => {
  const h = navigationHarness(); const { s } = h;
  const previousFetch = globalThis.fetch;
  const previousStorage = globalThis.localStorage;
  const saved = new Map();
  globalThis.localStorage = {
    getItem(key) { return saved.get(key) ?? null; }, setItem(key, value) { saved.set(key, value); }, removeItem(key) { saved.delete(key); },
  };
  globalThis.fetch = async (path) => ({ json: async () => ({ code: 0, data: path === "/api/sessions" ? { sessions: s.sessions } : {} }) });
  s.sessions = ["session-a", "session-b"].map((id) => ({ id, agent: "claude", status: "idle", lastActivityAt: "2026-10-02T00:00:00Z" }));
  try {
    s.navigate("session-a"); s.navigatePage("ai-usage"); await s.remove("session-a");
    assert.equal(s.currentId, "session-b");
    h.back(); assert.equal(s.currentPageId, "ai-usage"); assert.equal(s.currentId, null);
    assert.notEqual(saved.get("workbench-last-session"), "session-a");
    s.closeSidebarPanel(); h.flush(); assert.equal(window.location.hash, "#/"); assert.equal(s.currentId, null);
    assert.notEqual(saved.get("workbench-last-session"), "session-a");
    h.forward(); h.forward(); assert.equal(s.currentId, "session-b");
    const reloaded = h.reload(); await reloaded.refreshSessions();
    h.back(); assert.equal(reloaded.currentPageId, "ai-usage"); assert.equal(reloaded.currentId, null);
    reloaded.closeSidebarPanel(); h.flush(); assert.equal(window.location.hash, "#/");
    assert.notEqual(saved.get("workbench-last-session"), "session-a");
  } finally { globalThis.fetch = previousFetch; globalThis.localStorage = previousStorage; }
});
await asyncTest("桌面开着派单/历史/页面面板刷新，主区仍停在上次会话", async () => {
  const previousFetch = globalThis.fetch;
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  globalThis.document = { addEventListener() {} };
  globalThis.localStorage = { getItem: (key) => key === "workbench-last-session" ? "session-a" : null, setItem() {}, removeItem() {} };
  try {
    for (const [hash, alive] of [["#/dispatches", true], ["#/history", true], ["#/page/ai-usage", true], ["#/dispatches", false]]) {
      globalThis.fetch = async (path) => ({ json: async () => ({ code: 0, data: path === "/api/meta"
        ? { capabilities: {}, drivers: {} }
        : { sessions: alive ? [{ id: "session-a", seq: 0 }] : [] } }) });
      const { s } = navigationHarness({ mobile: false, hash });
      s.connect = () => {}; s.startClock = () => {}; s.refreshPages = async () => {};
      await s.init();
      assert.equal(s.currentId, alive ? "session-a" : null, hash);
      assert.equal(window.location.hash, hash, "面板保持打开");
      if (hash === "#/dispatches") {
        s.closeDispatches();
        assert.equal(window.location.hash, alive ? "#/session/session-a" : "#/");
      }
    }
  } finally { globalThis.fetch = previousFetch; globalThis.document = previousDocument; globalThis.localStorage = previousStorage; }
});
t("复核5：刷新后文件→Q→P→会话逐层 replace 保留全部来源", () => {
  const h = navigationHarness();
  h.s.navigate("session-a"); h.s.navigatePage("P"); h.s.navigatePage("Q"); h.s.setFilesOpen(true);
  const length = h.history.length;
  const reloaded = h.reload(); reloaded.setFilesOpen(false);
  assert.equal(reloaded.currentPageId, "Q"); reloaded.closeSidebarPanel();
  assert.equal(reloaded.currentPageId, "P"); reloaded.closeSidebarPanel();
  assert.equal(reloaded.currentPageId, null); assert.equal(reloaded.currentId, "session-a");
  reloaded.backFromSession(); assert.equal(reloaded.currentId, null);
  assert.equal(h.history.length, length); assert.equal(h.backCalls, 0);
});
const previewItem = (nativeSessionId, title = nativeSessionId) => ({
  agent: "claude", nativeSessionId, title, cwd: "/repo", source: "interactive",
  lastActivityAt: "2026-10-01T00:00:00Z", filePath: "/history",
});
t("复核6：列表→预览 push 同 hash，back 回列表、forward 回预览，列表再退回来源", () => {
  const h = navigationHarness(); const { s } = h;
  s.navigate("session-a"); s.navigateHistory(); const length = h.history.length;
  const listId = h.history.state.workbenchNavigation.id;
  s.selectHistory(previewItem("first"));
  assert.equal(h.history.length, length + 1); assert.equal(window.location.hash, "#/history");
  assert.equal(h.history.state.workbenchNavigation.source.id, listId);
  assert.equal(h.history.state.workbenchNavigation.source.route.historySelection, null);
  h.back(); assert.ok(s.historyOpen); assert.equal(s.historySelection, null);
  h.forward(); assert.equal(s.historySelection?.nativeSessionId, "first");
  s.backToHistoryList(); assert.equal(s.historySelection?.nativeSessionId, "first", "back 必须等待 popstate");
  h.flush(); assert.equal(s.historySelection, null); assert.ok(s.historyOpen);
  h.back(); assert.equal(s.currentId, "session-a"); assert.equal(s.historyOpen, false);
  h.forward(); assert.equal(s.historySelection, null); assert.ok(s.historyOpen);
  h.forward(); assert.equal(s.historySelection?.nativeSessionId, "first");
});
t("复核6：预览换选 replace 当前条目，back 一次回列表、forward 恢复最新选择", () => {
  const h = navigationHarness(); const { s } = h;
  s.navigateHistory(); s.selectHistory(previewItem("first"));
  const length = h.history.length; const entryId = h.history.state.workbenchNavigation.id;
  s.selectHistory(previewItem("second")); s.selectHistory(previewItem("second", "更新标题"));
  assert.equal(h.history.length, length); assert.equal(h.history.state.workbenchNavigation.id, entryId);
  h.back(); assert.equal(s.historySelection, null); assert.ok(s.historyOpen);
  h.forward(); assert.equal(s.historySelection?.nativeSessionId, "second"); assert.equal(s.historySelection?.title, "更新标题");
});
t("复核6：预览打开面板后返回预览，再返回列表不丢前进记录", () => {
  const h = navigationHarness(); const { s } = h;
  s.navigateHistory(); s.selectHistory(previewItem("first")); s.setFilesOpen(true);
  h.back(); assert.equal(s.historySelection?.nativeSessionId, "first"); noRightPanel(s);
  const length = h.history.length;
  s.backToHistoryList(); s.backToHistoryList(); h.flush();
  assert.equal(h.backCalls, 2); assert.equal(s.historySelection, null); assert.ok(s.historyOpen);
  h.forward(); assert.equal(s.historySelection?.nativeSessionId, "first");
  h.forward(); assert.equal(s.filesOpen, true); assert.equal(h.history.length, length);
});
t("复核6：刷新恢复预览，主动返回无法确认前条则 replace 回列表", () => {
  const h = navigationHarness();
  h.s.navigate("session-a"); h.s.navigateHistory(); h.s.selectHistory(previewItem("first"));
  const length = h.history.length;
  const reloaded = h.reload(); assert.equal(reloaded.historySelection?.nativeSessionId, "first");
  reloaded.backToHistoryList(); assert.equal(reloaded.historySelection, null); assert.ok(reloaded.historyOpen);
  assert.equal(h.backCalls, 0); assert.equal(h.history.length, length);
  assert.equal(h.reload().historySelection, null);
  assert.equal(h.history.state.workbenchNavigation.source.route.currentId, "session-a");
});
t("复核6：冷启动预览 state（无来源或旧版会话来源）返回只清预览，不退外部页", () => {
  for (const withLegacySource of [false, true]) {
    const route = { hash: "#/history", currentId: "session-a", currentPageId: null,
      historyOpen: true, historySelection: previewItem("cold"), dispatchesOpen: false, termOpen: false, filesOpen: false };
    const source = withLegacySource ? { id: "old-session", route: { ...route, hash: "#/session/session-a", historyOpen: false, historySelection: null } } : undefined;
    const h = navigationHarness({ hash: "#/history", state: { unrelated: true,
      workbenchNavigation: { version: 1, id: "cold-preview", route, source } } });
    assert.equal(h.s.historySelection?.nativeSessionId, "cold"); h.s.backToHistoryList();
    assert.equal(h.backCalls, 0); assert.equal(h.history.length, 1); assert.ok(h.s.historyOpen);
    assert.equal(h.s.historySelection, null); assert.ok(h.history.state.unrelated);
    assert.equal(h.reload().historySelection, null);
  }
});
t("复核6：桌面选择、换选和返回列表不写 history", () => {
  const h = navigationHarness({ mobile: false }); const { s } = h;
  s.navigateHistory(); const length = h.history.length;
  s.selectHistory(previewItem("first")); s.selectHistory(previewItem("second"));
  s.backToHistoryList(); assert.equal(s.historySelection, null); assert.ok(s.historyOpen);
  assert.equal(h.history.length, length); assert.equal(h.history.state, null);
});
globalThis.window = originalWindow;

// 筛选只作用于侧栏，完整 sessions 仍用于历史跳转、会话快照与发送。
const recentNow = Date.parse("2026-10-03T12:00:00Z");
const recentWindow = 72 * 60 * 60 * 1000;
const sidebarSession = (id, age, status = "idle") => ({
  id, title: `sidebar-${id}`, agent: "claude", cwd: "/repo", status, config: {},
  createdAt: new Date(recentNow - age).toISOString(),
  lastActivityAt: new Date(recentNow - age).toISOString(),
});
const withSidebarSessions = (sessions, fn, { currentId = null, pending = {} } = {}) => {
  const previous = {
    sessions: store.sessions, now: store.now, currentId: store.currentId,
    historyOpen: store.historyOpen, currentPageId: store.currentPageId,
    pendingCount: store.pendingCount,
  };
  Object.assign(store, { sessions, now: recentNow, currentId, historyOpen: false, currentPageId: null });
  store.pendingCount = (id) => pending[id] ?? 0;
  const render = () => renderToStaticMarkup(React.createElement(Sidebar, {
    collapsed: false, onToggle() {}, newOpen: false, onNewOpenChange() {},
  }));
  try { fn(render); }
  finally { Object.assign(store, previous); }
};

t("主列表：72 小时内及恰好边界保留，超过 1ms 隐藏", () => {
  withSidebarSessions([
    sidebarSession("inside", recentWindow - 1), sidebarSession("boundary", recentWindow),
    sidebarSession("outside", recentWindow + 1), sidebarSession("old-error", recentWindow + 1, "error"),
  ], (render) => {
    const html = render();
    assert.ok(html.includes("sidebar-inside"));
    assert.ok(html.includes("sidebar-boundary"));
    assert.ok(!html.includes("sidebar-outside"));
    assert.ok(!html.includes("sidebar-old-error"));
  });
});
t("主列表：dead 即使最近活动或当前打开也不显示", () => {
  withSidebarSessions([sidebarSession("dead-recent", 1, "dead"), sidebarSession("dead-old", recentWindow + 1, "dead")], (render) => {
    const html = render();
    assert.ok(!html.includes("sidebar-dead-recent"));
    assert.ok(!html.includes("sidebar-dead-old"));
  }, { currentId: "dead-recent" });
});
t("主列表：旧 running、starting 与当前打开的非 dead 会话仍在，保持活动时间倒序", () => {
  withSidebarSessions([
    sidebarSession("old-starting", recentWindow + 3, "starting"),
    sidebarSession("old-current", recentWindow + 4),
    sidebarSession("old-running", recentWindow + 2, "running"),
    sidebarSession("old-idle", recentWindow + 1),
  ], (render) => {
    const html = render();
    for (const id of ["old-running", "old-starting", "old-current"]) assert.ok(html.includes(`sidebar-${id}`));
    assert.ok(!html.includes("sidebar-old-idle"));
    assert.ok(html.indexOf("sidebar-old-running") < html.indexOf("sidebar-old-starting"));
    assert.ok(html.indexOf("sidebar-old-starting") < html.indexOf("sidebar-old-current"));
    assert.ok(html.includes('class="session-row agent-claude active"'), "打开的旧会话保留选中项");
  }, { currentId: "old-current" });
});
t("等待处理：旧会话未决闸门优先且不重复，异常 dead 未决计数也不隐藏", () => {
  withSidebarSessions([
    sidebarSession("recent", 1), sidebarSession("old-gate", recentWindow + 2),
    sidebarSession("dead-gate", recentWindow + 1, "dead"),
  ], (render) => {
    const html = render();
    assert.ok(html.includes("等待处理（2）"));
    for (const id of ["old-gate", "dead-gate"]) {
      // 行标题只出现一次（不重复进主列表）；⋮ 按钮 aria-label 含标题但不算行
      assert.equal((html.match(new RegExp(`<span class="row-title">sidebar-${id}</span>`, "g")) ?? []).length, 1);
      assert.ok(html.indexOf(`sidebar-${id}`) < html.indexOf("sidebar-recent"));
    }
  }, { pending: { "old-gate": 1, "dead-gate": 1 }, currentId: "old-gate" });
});
t("主列表：当前旧会话切走后隐藏，时钟越过 72 小时边界自动筛掉", () => {
  withSidebarSessions([sidebarSession("old-current", recentWindow + 1), sidebarSession("boundary", recentWindow)], (render) => {
    assert.ok(render().includes("sidebar-old-current"));
    store.currentId = null;
    assert.ok(!render().includes("sidebar-old-current"));
    assert.ok(render().includes("sidebar-boundary"));
    store.now += 1;
    const html = render();
    assert.ok(!html.includes("sidebar-boundary"));
    assert.ok(html.includes("最近 3 天没有会话"));
  }, { currentId: "old-current" });
});
t("侧栏：工作台会话折叠及其专用样式已移除，历史入口保留", () => {
  withSidebarSessions([sidebarSession("dead", 1, "dead")], (render) => {
    const html = render();
    assert.ok(!html.includes("个工作台会话"));
    assert.ok(!html.includes("session-dead-toggle"));
    assert.ok(!html.includes("session-dead-group"));
    assert.ok(html.includes('aria-label="历史会话"'));
  });
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  assert.ok(!css.includes(".session-dead-toggle"));
  assert.ok(!css.includes(".session-dead-group"));
});
t("历史打开：主列表外 released / dead 会话保留打开入口与现有会话页控件", () => {
  for (const status of ["idle", "dead"]) {
    const session = { ...sidebarSession(`history-${status}`, recentWindow + 1, status),
      nativeSessionId: `native-${status}`, ...(status === "idle" ? { released: true } : {}) };
    const previous = { historySelection: store.historySelection, ensureLoaded: store.ensureLoaded };
    try {
      store.historySelection = null;
      store.ensureLoaded = async () => {};
      withSidebarSessions([session], (render) => {
        assert.ok(!render().includes(session.title), "未打开时不在主列表");
        const item = { agent: session.agent, nativeSessionId: session.nativeSessionId, cwd: session.cwd,
          title: session.title, source: "workbench", lastActivityAt: session.lastActivityAt, filePath: "/history" };
        const preview = renderToStaticMarkup(React.createElement(HistoryPreviewPane, { item, onBack() {} }));
        assert.ok(preview.includes("工作台"));
        assert.ok(preview.includes("打开会话"));
        store.navigate(session.id);
        const main = mainOf(renderApp());
        assert.ok(main.includes(session.title));
        if (status === "dead") {
          assert.ok(main.includes("新建会话并续接"));
          assert.ok(!render().includes(session.title), "dead 打开后仍仅从历史进入");
        } else {
          assert.ok(main.includes("<textarea"), "已释放会话仍显示发送输入框");
          assert.ok(render().includes('class="session-row agent-claude active"'));
        }
      });
    } finally { Object.assign(store, previous); }
  }
});

await import('./sidebar-menu.test.mjs');

if (!process.exitCode) console.log(`✅ sidebar panels 回归全过（${pass} 例）`);
process.exit(process.exitCode ?? 0);
