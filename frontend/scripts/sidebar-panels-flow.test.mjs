#!/usr/bin/env node
// 静态渲染核对主区/侧栏分工；真实浏览器动画、点击与 iframe 网络另行验收。
import { strict as assert } from "node:assert";
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

globalThis.React = React;
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.window = { location: { hash: "#/", href: "http://127.0.0.1:8790/" }, addEventListener() {} };
const { store } = await import("../src/store.ts");
const { App } = await import("../src/App.tsx");
const { Sidebar } = await import("../src/components/Sidebar.tsx");

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
    terminalCapable: true, termOpen: false, onToggleTerm() {},
  }));
  assert.ok(!collapsed.includes("sidebar-page-open"), "页面路由下收起态不加宽");
});

t("收起面板恢复会话列表；图标态仍保留历史/页面/终端/设置入口", () => {
  store.closeSidebarPanel();
  const html = renderApp();
  assert.ok(!html.includes("sidebar-panel-expanded"));
  assert.ok(!html.includes("sidebar-page-open"), "收起面板移除加宽标记");
  const icons = renderToStaticMarkup(React.createElement(Sidebar, {
    collapsed: true, onToggle() {}, newOpen: false, onNewOpenChange() {},
    terminalCapable: true, termOpen: false, onToggleTerm() {},
  }));
  assert.ok(icons.includes('aria-label="所有来源会话"'));
  assert.ok(icons.includes('aria-label="AI 用量"'));
  assert.ok(icons.includes('aria-label="终端"'));
  assert.ok(icons.includes('class="settings"'));
});

t("入口留在底部原序，内容在独立覆盖区；不再把展开标题排到顶部", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const foot = (html) => sidebarOf(html)?.match(/<div class="sidebar-foot">([\s\S]*)/)?.[1];
  store.navigateHistory();
  const history = renderApp();
  assert.ok(sidebarOf(history).indexOf('id="sidebar-history-panel"') < sidebarOf(history).indexOf('class="sidebar-foot"'));
  assert.ok(!foot(history).includes('sidebar-panel-content'));
  assert.ok(foot(history).indexOf('aria-label="派单"') < foot(history).indexOf('aria-label="所有来源会话"'));
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

if (!process.exitCode) console.log(`✅ sidebar panels 回归全过（${pass} 例）`);
process.exit(process.exitCode ?? 0);
