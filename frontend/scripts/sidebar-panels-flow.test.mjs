#!/usr/bin/env node
// 静态渲染核对主区/侧栏分工；真实浏览器动画、点击与 iframe 网络另行验收。
import { strict as assert } from "node:assert";
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.window = { location: { hash: "#/", href: "http://127.0.0.1:8790/" }, innerWidth: 1280, addEventListener() {} };
const { store } = await import("../src/store.ts");
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
  assert.ok(sidebarOf(html)?.includes('aria-label="所有来源会话"'));
  assert.ok(sidebarOf(html)?.includes('aria-expanded="true"'));
  assert.ok(!mainOf(html)?.includes('aria-label="所有来源会话"'));
  assert.ok(!html.includes('class="app has-main"'));
  assert.ok(sidebarOf(html)?.includes('aria-label="收起所有来源会话"'));
  assert.ok(!html.includes('sidebar-page-open'), "历史面板不加宽");
});

t("选所有来源会话：只有主区显示预览与导入，列表仍挂载便于手机返回", () => {
  store.selectHistory({ agent: "claude", nativeSessionId: "native-id", cwd: "/repo", title: "预览标题", source: "interactive", lastActivityAt: "2026-10-01T00:00:00Z", filePath: "/history" });
  const html = renderApp();
  assert.ok(html.includes('class="app has-main"'));
  assert.ok(mainOf(html)?.includes('aria-label="会话预览"'));
  assert.ok(mainOf(html)?.includes("导入并续接"));
  assert.ok(sidebarOf(html)?.includes('aria-label="所有来源会话"'));
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

t("收起面板恢复会话列表；图标态只保留历史/页面/设置入口", () => {
  store.closeSidebarPanel();
  const html = renderApp();
  assert.ok(!html.includes("sidebar-panel-expanded"));
  assert.ok(!html.includes("sidebar-page-open"), "收起面板移除加宽标记");
  const icons = renderToStaticMarkup(React.createElement(Sidebar, {
    collapsed: true, onToggle() {}, newOpen: false, onNewOpenChange() {},
  }));
  assert.ok(icons.includes('aria-label="所有来源会话"'));
  assert.ok(icons.includes('aria-label="AI 用量"'));
  for (const label of ["终端", "派单", "文件", "浏览文件"]) assert.ok(!icons.includes(`aria-label="${label}"`));
  assert.ok(icons.includes('class="settings"'));
});

t("入口留在底部原序，内容在独立覆盖区；不再把展开标题排到顶部", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const foot = (html) => sidebarOf(html)?.match(/<div class="sidebar-foot">([\s\S]*)/)?.[1];
  store.navigateHistory();
  const history = renderApp();
  assert.ok(sidebarOf(history).indexOf('id="sidebar-history-panel"') < sidebarOf(history).indexOf('class="sidebar-foot"'));
  assert.ok(!foot(history).includes('sidebar-panel-content'));
  for (const label of ["终端", "派单", "文件", "浏览文件"]) assert.ok(!foot(history).includes(`aria-label="${label}"`));
  assert.ok(foot(history).indexOf('aria-label="所有来源会话"') < foot(history).indexOf('aria-label="AI 用量"'));
  assert.ok(history.includes('inert=""'), "覆盖时会话区不可聚焦");
  store.navigatePage("ai-usage");
  const pageHtml = renderApp();
  assert.ok(!foot(pageHtml).includes('sidebar-panel-content'));
  assert.ok(foot(pageHtml).indexOf('aria-label="所有来源会话"') < foot(pageHtml).indexOf('aria-label="AI 用量"'));
  assert.match(css, /\.sidebar-session-area \{\s*grid-area: 1 \/ 1;/);
  assert.match(css, /\.sidebar-foot \{\s*grid-area: 2 \/ 1;/);
  const overlayCss = css.match(/\.sidebar-panel-expanded \{([\s\S]*?)\}/)[1];
  assert.ok(overlayCss.includes("grid-area: 1 / 1"));
  assert.ok(!overlayCss.includes("order:"));
  assert.ok(!css.includes(".sidebar-foot.has-panel"));
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
  assert.ok(html.includes('class="mobile-topbar mobile-panel-launcher"'));
  assert.ok(!sidebarOf(html).includes('aria-label="派单"'));
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

if (!process.exitCode) console.log(`✅ sidebar panels 回归全过（${pass} 例）`);
process.exit(process.exitCode ?? 0);
