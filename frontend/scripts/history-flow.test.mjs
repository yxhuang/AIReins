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
  isHistoryDirectoryInput,
  normalizeHistoryDirectory,
} = await import("../src/history.ts");
const { fetchHistory, fetchHistoryMessages } = await import("../src/api.ts");
const { Store, store } = await import("../src/store.ts");
store.meta = { capabilities: { terminal: true, windowsPaths: true }, drivers: {} };
const { HistoryRow, HistoryPreviewPane, HistoryView } = await import("../src/components/HistoryView.tsx");
const { Sidebar } = await import("../src/components/Sidebar.tsx");
const { App } = await import("../src/App.tsx");
const { NewSessionForm } = await import("../src/components/NewSessionForm.tsx");
const { FilePanel } = await import("../src/components/FilePanel.tsx");
const { DirectoryBrowser, DirectoryContents } = await import("../src/components/DirectoryBrowser.tsx");

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
  const combined = new URLSearchParams(buildHistoryQuery({ cwd: " /a/b/ ", q: "标题" }));
  assert.equal(combined.get("cwd"), "/a/b/");
  assert.equal(combined.get("q"), "标题");
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
  const data = await fetchHistory({ agent: "claude", cwd: "/a/b", q: "opus", limit: 5, cursor: "CUR0" });
  const url = new URL(calls[0], "http://x");
  assert.equal(url.pathname, "/api/history");
  assert.equal(url.searchParams.get("agent"), "claude");
  assert.equal(url.searchParams.get("q"), "opus");
  assert.equal(url.searchParams.get("cwd"), "/a/b");
  assert.equal(url.searchParams.get("cursor"), "CUR0");
  assert.equal(data.nextCursor, "CUR1");
  assert.equal(data.skipped, 32, "skipped 要原样透传（前端只做中性说明）");
  assert.equal(data.discovered, 467);
  assert.equal(data.empty, 12);
});

await t("文件目录跳历史：共享筛选生效，关闭保留，显式清除", () => {
  const s = new Store();
  s.meta = { capabilities: { terminal: true, windowsPaths: true }, drivers: {} };
  s.navigateHistory("C:\\Users\\project\\");
  assert.equal(s.historyOpen, true);
  assert.equal(s.historyCwdFilter, "/mnt/c/Users/project");
  s.closeSidebarPanel();
  assert.equal(s.historyCwdFilter, "/mnt/c/Users/project");
  s.setHistoryCwdFilter("");
  assert.equal(s.historyCwdFilter, "");
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
  assert.ok(list.includes('aria-label="历史会话"'));
  assert.ok(list.includes('aria-label="搜索历史会话"'));
  assert.ok(preview.includes("‹ 历史会话"));
  assert.ok(!list.includes("所有来源会话") && !preview.includes("所有来源会话"));
});

// 仅打桩 hooks 以装载响应状态与触发真实按钮，组件树仍交给 React 渲染。
function historyViewFixture(list, phase = "ready") {
  return componentFixture(() => HistoryView(), ["", "all", "", "", list, phase, false, null]);
}

function componentFixture(component, values = []) {
  const refs = [];
  const memos = [];
  const effects = [];
  let pending = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const render = () => {
    let stateIndex = 0;
    let refIndex = 0;
    let memoIndex = 0;
    let effectIndex = 0;
    const previous = internals.H;
    const memo = (fn, deps) => {
      const index = memoIndex++;
      if (!same(memos[index]?.deps, deps)) memos[index] = { deps, value: fn() };
      return memos[index].value;
    };
    const effect = (fn, deps) => {
      const index = effectIndex++;
      if (!same(effects[index]?.deps, deps)) {
        pending.push(() => { effects[index]?.cleanup?.(); effects[index] = { deps, cleanup: fn() }; });
      }
    };
    internals.H = {
      useState(initial) {
        const index = stateIndex++;
        if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
        return [values[index], (next) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
      },
      useRef(initial) { return refs[refIndex++] ??= { current: initial }; },
      useCallback(fn, deps) { return memo(() => fn, deps); },
      useMemo: memo,
      useId() { return "fixture-id"; },
      useEffect: effect,
      useLayoutEffect: effect,
      useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
    };
    try { return component(); }
    finally { internals.H = previous; }
  };
  render.flushEffects = () => { const jobs = pending; pending = []; jobs.forEach(fn => fn()); };
  render.dispose = () => effects.forEach(effect => effect?.cleanup?.());
  return render;
}

function treeButtons(tree) {
  if (Array.isArray(tree)) return tree.flatMap(treeButtons);
  if (!tree || typeof tree !== "object") return [];
  return [...(tree.type === "button" ? [tree] : []), ...treeButtons(tree.props?.children)];
}

function treeFind(tree, match) {
  if (Array.isArray(tree)) return tree.map(child => treeFind(child, match)).find(Boolean);
  if (!tree || typeof tree !== "object") return undefined;
  return match(tree) ? tree : treeFind(tree.props?.children, match);
}
const searchInput = tree => treeFind(tree, node => node.props?.["aria-label"] === "搜索历史会话");
const key = (name) => ({ key: name, preventDefault() {}, nativeEvent: { isComposing: false } });

await t("路径判别与转换：Linux、Windows、~、普通关键词和根目录", () => {
  for (const path of ["/a/b", " ~/project", "~", "C:\\Users\\project", "D:/project"]) assert.equal(isHistoryDirectoryInput(path), true);
  for (const q of ["关键词", "project/repo", "C:", ""]) assert.equal(isHistoryDirectoryInput(q), false);
  assert.equal(normalizeHistoryDirectory("C:\\Users\\project\\"), "/mnt/c/Users/project");
  assert.equal(normalizeHistoryDirectory("~/project/", "/home/me"), "/home/me/project");
  assert.equal(normalizeHistoryDirectory("~", "/home/me"), "/home/me");
  assert.equal(normalizeHistoryDirectory("~/project"), "~/project");
  assert.equal(normalizeHistoryDirectory("///"), "/");
});

await t("Enter 生成目录胶囊，完整路径 title，× 和空输入 Backspace 清除", () => {
  store.setHistoryCwdFilter("");
  const render = componentFixture(() => HistoryView());
  searchInput(render()).props.onChange({ target: { value: "C:\\Users\\project\\" } });
  searchInput(render()).props.onKeyDown(key("Enter"));
  assert.equal(store.historyCwdFilter, "/mnt/c/Users/project");
  assert.equal(searchInput(render()).props.value, "");
  const html = renderToStaticMarkup(render());
  assert.match(html, /title="\/mnt\/c\/Users\/project"/);
  assert.match(html, />project</);
  searchInput(render()).props.onChange({ target: { value: "关键词" } });
  searchInput(render()).props.onKeyDown(key("Backspace"));
  assert.equal(store.historyCwdFilter, "/mnt/c/Users/project", "非空输入不能清胶囊");
  treeButtons(render()).find(node => node.props["aria-label"] === "清除目录筛选").props.onClick();
  assert.equal(store.historyCwdFilter, "");
  store.setHistoryCwdFilter("/a/b");
  searchInput(render()).props.onChange({ target: { value: "" } });
  searchInput(render()).props.onKeyDown(key("Backspace"));
  assert.equal(store.historyCwdFilter, "");
});

await t("关键词仍按 250ms 防抖；路径草稿不请求；胶囊与 q/cursor 叠加", async () => {
  store.setHistoryCwdFilter("/a/b");
  const calls = [];
  globalThis.fetch = async url => { calls.push(new URL(String(url), "http://x")); return envelope({ sessions: [], nextCursor: "NEXT", truncated: false, skipped: 0, empty: 0, discovered: 2 }); };
  const render = componentFixture(() => HistoryView());
  render(); render.flushEffects();
  await new Promise(resolve => setImmediate(resolve));
  searchInput(render()).props.onChange({ target: { value: "关键词" } });
  render(); render.flushEffects();
  assert.equal(calls.length, 1);
  await new Promise(resolve => setTimeout(resolve, 270));
  render(); render.flushEffects();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1).searchParams.get("q"), "关键词");
  assert.equal(calls.at(-1).searchParams.get("cwd"), "/a/b");
  treeButtons(render()).find(node => node.props["aria-label"] === "加载更多").props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1).searchParams.get("cursor"), "NEXT");
  assert.equal(calls.at(-1).searchParams.get("cwd"), "/a/b");
  const before = calls.length;
  searchInput(render()).props.onChange({ target: { value: "/half/path" } });
  render(); render.flushEffects();
  await new Promise(resolve => setTimeout(resolve, 270));
  render(); render.flushEffects();
  assert.equal(calls.length, before);
  searchInput(render()).props.onKeyDown(key("Enter"));
  render(); render.flushEffects();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1).searchParams.get("cwd"), "/half/path");
  assert.equal(calls.at(-1).searchParams.get("q"), null);
  render.dispose();
  store.setHistoryCwdFilter("");
});

await t("目录按钮：手机/无能力用 DirectoryBrowser，桌面有能力用 Windows picker", async () => {
  const oldMeta = store.meta;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return envelope({ path: "D:\\project" }); };
  for (const [mobile, capable] of [[true, true], [false, false], [false, true]]) {
    window.matchMedia = () => ({ matches: mobile });
    store.meta = { ...oldMeta, capabilities: { windowsDirectoryPicker: capable, windowsPaths: true } };
    store.setHistoryCwdFilter("/a/b");
    const render = componentFixture(() => HistoryView());
    await treeButtons(render()).find(node => node.props["aria-label"] === "选择目录筛选").props.onClick();
    const browser = treeFind(render(), node => node.type === DirectoryBrowser);
    if (mobile || !capable) {
      assert.ok(browser);
      assert.equal(browser.props.initialPath, "/a/b");
      assert.ok(!browser.props.allowWindowsPicker && !browser.props.mode);
      browser.props.onSelect("/picked/path");
      assert.equal(store.historyCwdFilter, "/picked/path");
    } else {
      assert.equal(browser, undefined);
      assert.equal(calls.at(-1).url, "/api/fs/pick-directory");
      assert.equal(JSON.parse(calls.at(-1).init.body).path, "/a/b");
      assert.equal(store.historyCwdFilter, "/mnt/d/project");
    }
  }
  store.meta = oldMeta;
  store.setHistoryCwdFilter("");
});

await t("文件面板当前浏览目录按钮触发历史共享筛选", () => {
  window.innerWidth = 1280;
  window.matchMedia = () => ({ matches: false });
  store.filePreview = null;
  const panel = componentFixture(() => FilePanel({ onClose() {} }))();
  const contents = treeFind(panel, node => node.type === DirectoryContents);
  const render = componentFixture(() => DirectoryContents(contents.props), [{ path: "/browsed/child", parent: "/browsed", dirs: [], files: [] }, false, null, "/uncommitted/address"]);
  treeButtons(render()).find(node => node.props.children === "会话").props.onClick();
  assert.equal(store.historyOpen, true);
  assert.equal(store.historyCwdFilter, "/browsed/child", "取成功浏览目录而非地址草稿");
});

await t("历史目录新建：桌面/手机跳主页、预选目录并挂载主输入框", () => {
  const oldMeta = store.meta;
  const oldHistory = window.history;
  const oldLoad = store.ensureLoaded;
  store.ensureLoaded = async () => {};
  store.meta = { defaultCwd: "/fallback", drivers: {}, capabilities: {} };
  for (const mobile of [false, true]) {
    window.location.hash = "#/session/previous";
    const entries = [{ state: null, hash: window.location.hash }];
    let entryIndex = 0;
    window.history = {
      get state() { return entries[entryIndex].state; },
      replaceState(state, _title, hash) { entries[entryIndex] = { state, hash }; window.location.hash = hash; },
      pushState(state, _title, hash) { entries.splice(entryIndex + 1); entries.push({ state, hash }); entryIndex++; window.location.hash = hash; },
      back() { if (entryIndex) { entryIndex--; window.location.hash = entries[entryIndex].hash; store.onPopState(); store.onHashChange(); } },
    };
    window.matchMedia = () => ({ matches: mobile });
    store.currentId = "previous";
    store.newSessionOpen = false;
    store.navigateHistory("/a/b");
    const sidebar = componentFixture(() => Sidebar({ collapsed: false, onToggle() {} }));
    assert.ok(!treeButtons(componentFixture(() => HistoryView())()).some(node => node.props.children === "在此目录新建会话"), "已并入左上角新建");
    treeButtons(sidebar()).find(node => node.props["aria-label"] === "新建会话").props.onClick();
    assert.equal(window.location.hash, "#/new");
    assert.equal(store.newSessionOpen, true);
    assert.equal(store.historyOpen, false);
    assert.equal(store.currentId, null, "主页不保留当前会话选择");
    assert.equal(store.newSessionCwd, "/a/b", "历史目录显式传给主页");
    const app = componentFixture(() => App())();
    assert.match(app.props.className, /(?:^| )has-main(?: |$)/, "手机CSS必须显示新建主区");
    assert.ok(treeFind(app, node => node.type?.name === "NewSessionForm"), "主页挂载新建表单");
    assert.equal(treeFind(sidebar(), node => node.type?.name === "NewSessionForm"), undefined, "侧栏不再内嵌表单");
    store.historyOpen = true;
    assert.doesNotMatch(componentFixture(() => App())().props.className, /(?:^| )has-main(?: |$)/, "新建页上打开历史列表时，手机仍显示侧栏面板");
    store.historyOpen = false;
    store.currentPageId = "synthetic-page";
    assert.doesNotMatch(componentFixture(() => App())().props.className, /(?:^| )has-main(?: |$)/, "新建页上打开扩展页时，手机仍显示侧栏面板");
    store.currentPageId = null;
  }
  store.meta = oldMeta;
  store.ensureLoaded = oldLoad;
  window.history = oldHistory;
  window.matchMedia = () => ({ matches: false });
  store.setHistoryCwdFilter("");
  store.newSessionOpen = false;
});

await t("未完成扫描：14px 提示、重试沿 cursor 续扫，加载更多保留且不宣告空结果", async () => {
  const page = { items: [], nextCursor: "START", truncated: true, skipped: 0, empty: 0, discovered: 2 };
  const render = historyViewFixture(page);
  const tree = render();
  const html = renderToStaticMarkup(tree);
  assert.match(html, /扫描未完成，可/);
  assert.match(html, /font-size:var\(--detail-font-size\)/);
  assert.ok(!html.includes("没有匹配") && !html.includes("没有更多"));
  const buttons = treeButtons(tree);
  const retry = buttons.find((button) => button.props.children === "重试");
  assert.ok(retry, "提示中的重试可点击");
  assert.ok(buttons.some((button) => button.props["aria-label"] === "加载更多"));
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return envelope({ sessions: [historyItem()], truncated: false, skipped: 0, empty: 0, discovered: 2 });
  };
  retry.props.onClick();
  assert.equal(treeButtons(render()).find((button) => button.props.children === "重试").props.disabled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(new URL(calls[0], "http://x").searchParams.get("cursor"), "START");
  const completed = renderToStaticMarkup(render());
  assert.ok(completed.includes("示例") && completed.includes("没有更多了"));
  assert.ok(!completed.includes("扫描未完成"));
});

await t("已加载条目仍未完成扫描时不显示没有更多；完成后的空结果如实显示", () => {
  const base = { items: [historyItem()], truncated: true, skipped: 0, empty: 0, discovered: 1 };
  const incomplete = renderToStaticMarkup(historyViewFixture(base)());
  assert.ok(!incomplete.includes("没有更多"));
  const empty = renderToStaticMarkup(historyViewFixture({ ...base, items: [], truncated: false })());
  assert.ok(empty.includes("没有匹配的历史会话"));
});


// 无 DOM 的真实主页组件交互；只替换会话 API/导航和浏览器存储，不代替截图验收。
async function withNewForm({ saved = "", cwd, sessions = [], meta = { defaultCwd: "/meta", drivers: {}, capabilities: {} }, create } = {}, run) {
  const fields = ["meta", "sessions", "newSessionCwd", "newSessionRequest", "create", "navigateCreatedSession", "setNewSessionCwd", "sendComposerInput", "commands"];
  const previous = Object.fromEntries(fields.map(name => [name, store[name]]));
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map(saved ? [["workbench-last-cwd", saved]] : []);
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: name => storage.get(name) ?? null,
    setItem: (name, value) => storage.set(name, String(value)),
  } });
  const calls = [], navigations = [], sends = [];
  Object.assign(store, { meta, sessions, newSessionCwd: cwd, newSessionRequest: 0, commands: new Map() });
  store.create = async input => { calls.push(input); return create ? create(input) : { id: "created-home", cwd: input.cwd }; };
  store.sendComposerInput = async (sessionId, text, mentions) => { sends.push({ sessionId, text, mentions }); return true; };
  store.navigateCreatedSession = id => navigations.push(id);
  store.setNewSessionCwd = path => { store.newSessionCwd = path; };
  const render = componentFixture(() => NewSessionForm({}));
  const update = () => {
    render(); render.flushEffects();
    render(); render.flushEffects();
    return render();
  };
  const contents = () => treeFind(update(), node => node.type === DirectoryContents);
  const currentCwd = () => { update(); return store.newSessionCwd; };
  const textarea = () => treeFind(update(), node => node.type === "textarea");
  const submit = () => treeFind(update(), node => node.props?.type === "submit");
  const agent = kind => treeButtons(update()).find(node => node.props.className?.split(" ").includes(`agent-${kind}`));
  try { await run({ render, update, contents, cwd: currentCwd, textarea, submit, agent, storage, calls, sends, navigations }); }
  finally {
    render.dispose();
    Object.assign(store, previous);
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else delete globalThis.localStorage;
  }
}
const finishNewCreate = () => new Promise(resolve => setImmediate(resolve));

await t("主页新建：Enter 空白创建后统一发送 trim 首条消息，保留目录与配置并导航", async () => {
  await withNewForm({ cwd: " /project/child " }, async f => {
    f.agent("codex").props.onClick();
    const pills = treeFind(f.update(), node => node.type?.name === "NewConfigPills");
    pills.props.onChange(previous => ({ ...previous, model: "chosen-model", effort: "high", sandboxMode: "" }));
    f.textarea().props.onChange({ target: { value: "  第一条\n消息  " } });
    let prevented = 0;
    f.textarea().props.onKeyDown({ ...key("Enter"), preventDefault() { prevented++; } });
    assert.equal(f.submit().props.disabled, true, "提交期间禁用重复创建");
    f.textarea().props.onKeyDown(key("Enter"));
    assert.equal(f.calls.length, 1);
    await finishNewCreate();
    assert.equal(prevented, 1);
    assert.deepEqual(f.calls[0], {
      snapshot: "skip", agent: "codex", cwd: "/project/child",
      config: { permissionMode: "auto-review", model: "chosen-model", effort: "high" },
    });
    assert.equal(Object.hasOwn(f.calls[0], "initialMessage"), false, "创建接口不发送 initialMessage");
    assert.deepEqual(f.sends, [{ sessionId: "created-home", text: "第一条\n消息", mentions: [] }], "首条消息走会话输入框同一发送入口");
    assert.equal(f.storage.get("workbench-last-cwd"), "/project/child");
    assert.deepEqual(f.navigations, ["created-home"]);
    assert.equal(f.submit().props.disabled, false);
  });
});

await t("主页新建：触屏回车换行，按钮与 Ctrl/⌘+Enter 创建并发送", async () => {
  const original = window.matchMedia;
  window.matchMedia = () => ({ matches: true });
  try {
    for (const shortcut of ["button", "ctrlKey", "metaKey"]) {
      await withNewForm({ cwd: "/project" }, async f => {
        f.textarea().props.onChange({ target: { value: "第一行" } });
        f.textarea().props.onKeyDown({ ...key("Enter"), preventDefault() { assert.fail("触屏回车应保留默认换行"); } });
        await finishNewCreate();
        assert.equal(f.calls.length, 0);
        f.textarea().props.onChange({ target: { value: "第一行\n第二行" } });
        if (shortcut === "button") f.update().props.onSubmit({ preventDefault() {} });
        else f.textarea().props.onKeyDown({ ...key("Enter"), [shortcut]: true });
        await finishNewCreate();
        assert.equal(f.calls.length, 1);
        assert.equal(f.sends[0].text, "第一行\n第二行");
      });
    }
  } finally { window.matchMedia = original; }
});

await t("主页新建：Shift+Enter/IME 不提交；空目录禁用且表单和键盘守卫均生效", async () => {
  await withNewForm({ cwd: "/project" }, async f => {
    for (const event of [
      { ...key("Enter"), shiftKey: true },
      { ...key("Enter"), nativeEvent: { isComposing: true } },
      { ...key("Enter"), keyCode: 229 },
    ]) f.textarea().props.onKeyDown(event);
    await finishNewCreate();
    assert.equal(f.calls.length, 0);
  });
  await withNewForm({ meta: { drivers: {}, capabilities: {} } }, async f => {
    assert.equal(f.cwd(), "");
    assert.equal(f.contents().props.initialPath, "", "空目录不让地址栏自动打开主目录");
    assert.equal(f.submit().props.disabled, true);
    assert.ok(treeFind(f.update(), node => node.props?.className === "new-hint"));
    f.update().props.onSubmit({ preventDefault() {} });
    f.textarea().props.onKeyDown(key("Enter"));
    await finishNewCreate();
    assert.equal(f.calls.length, 0);
  });
});

await t("主页新建：显式目录优先，其次 saved → 最近活动目录 → meta", async () => {
  const sessions = [
    { id: "old", cwd: "/older", lastActivityAt: "2026-10-15T00:00:00Z" },
    { id: "latest", cwd: "/latest", lastActivityAt: "2026-10-17T00:00:00Z" },
  ];
  for (const [options, expected] of [
    [{ cwd: "/explicit", saved: "/saved", sessions }, "/explicit"],
    [{ saved: " /saved ", sessions }, "/saved"],
    [{ sessions }, "/latest"],
    [{}, "/meta"],
  ]) await withNewForm(options, async f => {
    assert.equal(f.cwd(), expected, "初始化目录同步到导航状态");
    assert.equal(f.contents().props.initialPath, expected);
  });
});

await t("主页新建：晚到 meta/sessions 补填，用户选择不覆盖；显式重选保留消息和 agent/config", async () => {
  for (const source of ["meta", "sessions"]) await withNewForm({ meta: null }, async f => {
    assert.equal(f.cwd(), "");
    if (source === "meta") store.meta = { defaultCwd: "/late-meta", drivers: {}, capabilities: {} };
    else store.sessions = [{ id: "late", cwd: "/late-session", lastActivityAt: "2026-10-17T00:00:00Z" }];
    assert.equal(f.cwd(), source === "meta" ? "/late-meta" : "/late-session");
    assert.equal(f.contents().props.initialPath, f.cwd(), "回填后地址栏重新打开");
  });
  await withNewForm({ cwd: "/initial", saved: "/saved-default" }, async f => {
    f.contents().props.onPathChange("/manual");
    f.agent("kimi").props.onClick();
    f.textarea().props.onChange({ target: { value: "保留草稿" } });
    store.meta = { defaultCwd: "/new-meta", drivers: {}, capabilities: {} };
    store.sessions = [{ id: "late", cwd: "/new-session", lastActivityAt: "2026-10-17T00:00:00Z" }];
    assert.equal(f.cwd(), "/manual", "后来的缺省目录不覆盖手选");
    for (const path of ["/explicit-again", "/explicit-repeat"]) {
      store.newSessionCwd = path; store.newSessionRequest++;
      assert.equal(f.cwd(), path);
      assert.equal(f.contents().props.initialPath, path);
      assert.equal(f.textarea().props.value, "保留草稿");
      assert.equal(f.agent("kimi").props["aria-pressed"], true);
      assert.deepEqual(treeFind(f.update(), node => node.type?.name === "NewConfigPills").props.selected, { permissionMode: "auto" });
    }
    store.newSessionCwd = undefined; store.newSessionRequest++;
    assert.equal(f.cwd(), "/saved-default", "通用新建重新走三级回退，不沿用上一显式或手动目录");
    assert.equal(f.textarea().props.value, "保留草稿");
    assert.equal(f.agent("kimi").props["aria-pressed"], true);
  });
});

await t("主页新建：内嵌地址栏即目录选择，导航不重挂载，读不了清空，外部换目录才重挂载", async () => {
  await withNewForm({ cwd: "/initial" }, async f => {
    const first = f.contents();
    assert.equal(first.props.collapsible, true);
    assert.equal(first.props.allowWindowsPicker, true);
    assert.equal(first.props.initialPath, "/initial");
    assert.equal(treeFind(f.update(), node => node.type === DirectoryBrowser), undefined, "不再弹窗");
    first.props.onPathChange("/initial/child");
    assert.equal(f.cwd(), "/initial/child", "地址栏导航即选定");
    assert.equal(f.contents().key, first.key, "内部导航不重挂载");
    assert.equal(f.contents().props.initialPath, "/initial");
    f.contents().props.onPathLost();
    assert.equal(f.cwd(), "", "读不了的目录清空选择");
    assert.equal(f.submit().props.disabled, true);
    store.newSessionCwd = "/group"; store.newSessionRequest++;
    assert.equal(f.cwd(), "/group");
    assert.notEqual(f.contents().key, first.key, "组「+」等外部换目录重新挂载地址栏");
    assert.equal(f.contents().props.initialPath, "/group");
  });
});

await t("主页新建：创建失败显示错误、恢复提交且不写成功目录或导航", async () => {
  await withNewForm({ cwd: "/project", saved: "/previous", create: async () => { throw new Error("创建被拒绝"); } }, async f => {
    f.update().props.onSubmit({ preventDefault() {} });
    assert.equal(f.submit().props.disabled, true);
    await finishNewCreate();
    assert.equal(treeFind(f.update(), node => node.props?.role === "alert").props.children, "创建被拒绝");
    assert.equal(f.submit().props.disabled, false);
    assert.equal(f.storage.get("workbench-last-cwd"), "/previous");
    assert.deepEqual(f.navigations, []);
    assert.deepEqual(f.sends, [], "创建失败不发送首条消息");
  });
});

if (!process.exitCode) console.log(`✅ history 前端逻辑回归全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
