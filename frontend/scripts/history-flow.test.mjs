#!/usr/bin/env node
// 历史会话浏览（#/history）前端逻辑的打桩回归测试：
// - buildHistoryQuery：空值省略、cursor 原样带回、中文 q 编码；
// - filterBySource：「全部」不过滤，按来源过滤只作用于给定条目；
// - findImportedSession：同一 agent + 同一 nativeSessionId 才算「已在工作台中」；
// - fetchHistory / fetchHistoryMessages：URL 组装与信封解析（fetch 打桩）；
// - store 路由：#/history 与 #/session/<id>、#/page/<id> 互斥。
// 浏览器依赖（window / WebSocket / fetch）全部打桩，不需要真实 server。
// 运行：npx tsx frontend/scripts/history-flow.test.mjs
import { strict as assert } from "node:assert";

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
await t("store 路由：#/history 置 historyOpen 且与 session/page 互斥", async () => {
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
  window.location.hash = "#/";
  s["onHashChange"]();
  assert.equal(s.historyOpen, false, "其余 hash 回空态");
  assert.equal(s.currentId, null);
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

console.log(`✅ history 前端逻辑回归全过（${pass} 例）`);
