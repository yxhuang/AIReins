#!/usr/bin/env node
// 历史会话浏览（#/history）前端逻辑的打桩回归测试：
// - buildHistoryQuery：空值省略、cursor 原样带回、中文 q 编码；
// - filterBySource：「全部」不过滤，按来源过滤只作用于给定条目；
// - findImportedSession：同一 agent + 同一 nativeSessionId 才算「已在工作台中」；
// - fetchHistory / fetchHistoryMessages：URL 组装与信封解析（fetch 打桩）；
// - store 路由：历史/页面面板互斥、保留主区会话，移动端预览返回保留面板。
// 浏览器依赖（window / WebSocket / fetch）全部打桩，不需要真实 server。
// 运行：npx tsx frontend/scripts/history-flow.test.mjs
import { strict as assert } from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
globalThis.React = React;

// --- 浏览器全局打桩（须在 import store 之前） ---
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.window = { location: { hash: "#/" }, addEventListener() {} };

const {
  buildHistoryQuery,
  filterBySource,
  findImportedSession,
  SOURCE_LABELS,
} = await import("../src/history.ts");
const { fetchHistory, fetchHistoryMessages } = await import("../src/api.ts");
const { Store } = await import("../src/store.ts");
const { HistoryRow, HistoryPreviewPane, HistoryView } = await import("../src/components/HistoryView.tsx");

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
};

const envelope = (data) => ({ json: async () => ({ code: 0, msg: "", data, request_id: "t" }) });

const historyItem = (over = {}) => ({
  agent: "claude",
  nativeSessionId: "abc-123",
  cwd: "/repo",
  title: "示例",
  lastActivityAt: "2026-08-22T00:00:00.000Z",
  source: "interactive",
  filePath: "/x.jsonl",
  ...over,
});

// --- 用例 1：buildHistoryQuery 空值省略、cursor 原样带回 ---
await t("buildHistoryQuery：空 agent/q 省略，limit/cursor 带上，中文 q 正确编码", async () => {
  assert.equal(buildHistoryQuery({}), "", "全空应为空串");
  assert.equal(buildHistoryQuery({ agent: "claude", limit: 150 }), "agent=claude&limit=150");
  const withCursor = buildHistoryQuery({ agent: "kimi", q: " 历史 ", limit: 100, cursor: "a+b/c=" });
  const params = new URLSearchParams(withCursor);
  assert.equal(params.get("agent"), "kimi");
  assert.equal(params.get("q"), "历史", "q 应 trim 后编码");
  assert.equal(params.get("cursor"), "a+b/c=", "cursor 应原样带回（解码后不变）");
  assert.equal(params.get("limit"), "100");
});

// --- 用例 2：来源筛选只作用于给定条目；「全部」原样返回 ---
await t("filterBySource：all 不过滤；按来源过滤；unknown 也是可选项", async () => {
  const items = [
    historyItem({ nativeSessionId: "a", source: "interactive" }),
    historyItem({ nativeSessionId: "b", source: "workbench" }),
    historyItem({ nativeSessionId: "c", source: "unknown", agent: "kimi" }),
  ];
  assert.equal(filterBySource(items, "all"), items, "all 应原样返回同一数组");
  assert.deepEqual(
    filterBySource(items, "workbench").map((s) => s.nativeSessionId),
    ["b"],
  );
  assert.deepEqual(
    filterBySource(items, "interactive").map((s) => s.nativeSessionId),
    ["a"],
  );
  assert.equal(SOURCE_LABELS.unknown, "未知", "unknown 如实显示「未知」");
});

// --- 用例 3（验收 4 逻辑）：已导入对照要 agent + nativeSessionId 都匹配 ---
await t("findImportedSession：agent 与 nativeSessionId 都匹配才算已导入", async () => {
  const registry = [
    { id: "s1", agent: "claude", nativeSessionId: "abc-123" },
    { id: "s2", agent: "kimi", nativeSessionId: "abc-123" }, // 同 id 不同 agent：不算
    { id: "s3", agent: "claude" }, // 无 nativeSessionId：不算
  ];
  assert.equal(
    findImportedSession(registry, { agent: "claude", nativeSessionId: "abc-123" })?.id,
    "s1",
  );
  assert.equal(
    findImportedSession(registry, { agent: "codex", nativeSessionId: "abc-123" }),
    undefined,
    "agent 不匹配不能算已导入",
  );
  assert.equal(
    findImportedSession(registry, { agent: "claude", nativeSessionId: "zzz" }),
    undefined,
  );
});

// --- 用例 4：fetchHistory URL 组装与信封字段透传（truncated/skipped 原样，不丢） ---
await t("fetchHistory：query 正确，data 字段（含 nextCursor/truncated/skipped）原样透传", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return envelope({
      sessions: [historyItem()],
      nextCursor: "CUR1",
      truncated: false,
      skipped: 32,
      empty: 12,
      discovered: 467,
      durationMs: 9,
    });
  };
  const data = await fetchHistory({ agent: "claude", q: "opus", limit: 5, cursor: "CUR0" });
  const url = new URL(calls[0], "http://x");
  assert.equal(url.pathname, "/api/history");
  assert.equal(url.searchParams.get("agent"), "claude");
  assert.equal(url.searchParams.get("q"), "opus");
  assert.equal(url.searchParams.get("cursor"), "CUR0");
  assert.equal(data.nextCursor, "CUR1");
  assert.equal(data.skipped, 32, "skipped 要原样透传（前端只做中性说明）");
  assert.equal(data.discovered, 467);
  assert.equal(data.empty, 12);
});

// --- 用例 5：fetchHistoryMessages URL 编码与错误信封抛中文 msg ---
await t("fetchHistoryMessages：路径编码正确；错误信封抛出中文 msg", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return envelope({ session: historyItem(), messages: [], truncated: true });
  };
  const preview = await fetchHistoryMessages("kimi", "session_ab-c_1");
  assert.equal(calls[0], "/api/history/kimi/session_ab-c_1/messages");
  assert.equal(preview.truncated, true, "truncated:true 是常态，原样透传");
  assert.deepEqual(preview.messages, []);
  globalThis.fetch = async () => ({
    json: async () => ({ code: 40404, msg: "历史会话不存在", data: null, request_id: "t" }),
  });
  await assert.rejects(fetchHistoryMessages("claude", "gone"), /历史会话不存在/);
});

// --- 用例 6：#/history 与既有两类路由互斥 ---
await t("store 路由：旧 #/history 打开面板，session 导航关闭面板", async () => {
  globalThis.fetch = async () => envelope({ sessions: [] });
  const s = new Store();
  window.location.hash = "#/history";
  s["onHashChange"](); // private 方法运行时仍可触达（本文件是 tsx 直跑的 .mjs，不做类型检查）
  assert.equal(s.historyOpen, true);
  assert.equal(s.currentId, null);
  assert.equal(s.currentPageId, null);
  window.location.hash = "#/session/abc";
  s["onHashChange"]();
  assert.equal(s.historyOpen, false, "离开 #/history 应清除 historyOpen");
  assert.equal(s.currentId, "abc");
  window.location.hash = "#/page/ai-usage";
  s["onHashChange"]();
  assert.equal(s.historyOpen, false);
  assert.equal(s.currentPageId, "ai-usage");
  assert.equal(s.currentId, "abc", "页面面板保留之前的主区会话");
  window.location.hash = "#/";
  s["onHashChange"]();
  assert.equal(s.historyOpen, false, "其余 hash 回空态");
  assert.equal(s.currentId, null);
});

await t("面板互斥：历史切页面/页面切页面；关闭后恢复会话", () => {
  const s = new Store();
  // 不发快照请求，隔离本用例只验证面板与路由。
  s.ensureLoaded = async () => {};
  s.navigate("s/1");
  s.navigateHistory();
  assert.equal(s.currentId, "s/1");
  assert.equal(s.historyOpen, true);
  s.selectHistory(historyItem());
  assert.equal(s.historySelection.nativeSessionId, "abc-123");
  s.navigatePage("用量/页");
  assert.equal(window.location.hash, "#/page/%E7%94%A8%E9%87%8F%2F%E9%A1%B5");
  assert.equal(s.historyOpen, false);
  assert.equal(s.historySelection, null, "切页面清除主区历史预览");
  s.navigatePage("other");
  assert.equal(s.currentPageId, "other");
  s.navigateHistory();
  assert.equal(s.currentPageId, null);
  s.closeSidebarPanel();
  assert.equal(s.historyOpen, false);
  assert.equal(window.location.hash, "#/session/s%2F1");
  assert.equal(s.currentId, "s/1");
});

await t("历史预览返回保留历史面板，重复打开与空主页收起即时生效", () => {
  const s = new Store();
  s.navigate(null);
  s.navigateHistory();
  const item = historyItem();
  s.selectHistory(item);
  assert.equal(s.historySelection, item);
  s.backToHistoryList();
  assert.equal(s.historySelection, null);
  assert.equal(s.historyOpen, true);
  assert.equal(window.location.hash, "#/history");
  s.selectHistory(item);
  s.closeSidebarPanel();
  assert.equal(s.historySelection, null);
  assert.equal(s.historyOpen, false);
  assert.equal(window.location.hash, "#/");
  s.selectHistory(item);
  assert.equal(s.historySelection, null, "关闭后不允许迟到的选中重开预览");
  s.navigateHistory();
  s.navigateHistory();
  assert.equal(s.historyOpen, true, "相同 hash 重开无需等待浏览器事件");
  s.navigate(null);
  assert.equal(s.historyOpen, false);
});

await t("浏览器前进后退重放旧链接，面板与预览状态同步", () => {
  const s = new Store();
  s.ensureLoaded = async () => {};
  for (const hash of ["#/history", "#/page/ai-usage", "#/history", "#/session/live", "#/"]) {
    window.location.hash = hash;
    s.onHashChange();
    assert.equal(s.historyOpen, hash === "#/history");
    assert.equal(s.currentPageId, hash.startsWith("#/page/") ? "ai-usage" : null);
    assert.equal(s.historySelection, null);
  }
});

await t("窄屏收起面板返回侧栏列表，即使此前桌面保留过当前会话", () => {
  const s = new Store();
  s.ensureLoaded = async () => {};
  s.navigate("desktop-session");
  s.navigateHistory();
  s.selectHistory(historyItem());
  s.closeSidebarPanel(true);
  assert.equal(window.location.hash, "#/");
  assert.equal(s.currentId, null);
  assert.equal(s.historyOpen, false);
  assert.equal(s.historySelection, null);
});

await t("跳转优先存活会话，同类选择最新活动，缺省使用创建时间", () => {
  const base = { agent: "claude", nativeSessionId: "abc-123", createdAt: "2026-01-01" };
  const rows = [
    { ...base, id: "dead-new", status: "dead", lastActivityAt: "2026-09-30" },
    { ...base, id: "live-old", status: "idle", lastActivityAt: "2026-08-01" },
    { ...base, id: "live-new", status: "running", createdAt: "2026-09-01" },
  ];
  assert.equal(findImportedSession(rows, historyItem()).id, "live-new");
  assert.equal(findImportedSession(rows.map(r => ({ ...r, status: "dead" })), historyItem()).id, "dead-new");
  assert.equal(rows[0].id, "dead-new", "must not mutate registry order");
});

await t("历史行渲染：两行、品牌图标、工单/来源/时间、路径/已导入", () => {
  const item = historyItem({ dispatch: { name: "测试派单", runId: "run-123" } });
  const html = renderToStaticMarkup(React.createElement(HistoryRow, { item, active: true, imported: true, now: Date.parse(item.lastActivityAt) + 120000, onSelect() {} }));
  assert.equal((html.match(/class="history-row-line[12]"/g) ?? []).length, 2);
  assert.ok(/history-row-line1[\s\S]*agent-icon[\s\S]*history-row-title[\s\S]*dispatch-badge[\s\S]*source-badge[\s\S]*history-row-time/.test(html));
  assert.ok(html.includes('title="测试派单 · run-123">工单'));
  assert.ok(html.includes('class="history-row-time" title='));
  assert.ok(html.includes("2分钟"));
  assert.ok(/history-row-line2[\s\S]*history-row-cwd[\s\S]*imported-badge/.test(html));
  assert.ok(!html.includes("history-row-meta"));
  assert.ok(!html.includes("claude ·"));
  const plain = renderToStaticMarkup(React.createElement(HistoryRow, { item: historyItem(), active: false, imported: false, now: Date.now(), onSelect() {} }));
  assert.ok(!plain.includes("dispatch-badge") && !plain.includes("imported-badge"));
});
await t("改名后的列表/预览返回文案", () => {
  const list = renderToStaticMarkup(React.createElement(HistoryView));
  const preview = renderToStaticMarkup(React.createElement(HistoryPreviewPane, { item: historyItem(), onBack() {} }));
  assert.ok(list.includes('aria-label="所有来源会话"'));
  assert.ok(list.includes('aria-label="搜索所有来源会话"'));
  assert.ok(preview.includes("‹ 所有来源会话"));
  assert.ok(!list.includes("历史会话") && !preview.includes("历史会话列表"));
});

if (!process.exitCode) console.log(`✅ history 前端逻辑回归全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
