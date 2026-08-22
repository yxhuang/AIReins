#!/usr/bin/env node
// pages/ 扩展机制前端逻辑的打桩回归测试（验收 3 与 5 的前端侧证据）：
// - health 信封解析与「不可达 → 降级面板」渲染分支（不渲染空白 iframe）；
// - 未知 type（如 "widget"）跳过 + 记录提示，绝不崩掉整个列表；
// - store 集成：refreshPages 分区结果、#/page/<id> 与 #/session/<id> 路由互斥。
// 浏览器依赖（window / WebSocket / fetch）全部打桩，不需要真实 server。
// 运行：npx tsx frontend/scripts/pages-flow.test.mjs
import { strict as assert } from "node:assert";

// --- 浏览器全局打桩（须在 import store 之前） ---
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.window = { location: { hash: "#/" }, addEventListener() {} };

const { isInlineSvg, partitionPages, pageRenderMode } = await import("../src/pages.ts");
const { fetchPageHealth } = await import("../src/api.ts");
const { Store } = await import("../src/store.ts");

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
};

const envelope = (data) => ({ json: async () => ({ code: 0, msg: "", data, request_id: "t" }) });

const AI_USAGE = {
  id: "ai-usage", name: "AI 用量", icon: "📊", type: "iframe",
  url: "http://127.0.0.1:8788", healthCheck: "http://127.0.0.1:8788",
  description: "此面板按需启动，未启动时整页不可达。",
};

// --- 用例 1（验收 5）：未知 type "widget" 跳过 + 记录，列表不崩 ---
await t("未知 type 跳过：widget 不进支持列表，skipped 带 id/name/type 供提示", async () => {
  const list = [
    AI_USAGE,
    { id: "w1", name: "挂件", icon: "🧩", type: "widget", url: "http://x" },
    { id: "bad", name: "缺 url", icon: "❓", type: "iframe" }, // 字段残缺同样跳过
  ];
  const { supported, skipped } = partitionPages(list);
  assert.deepEqual(supported.map((p) => p.id), ["ai-usage"], "iframe 页面应保留");
  assert.deepEqual(
    skipped,
    [
      { id: "w1", name: "挂件", type: "widget" },
      { id: "bad", name: "缺 url", type: "iframe" },
    ],
    "未知类型/残缺条目应进 skipped 供小字提示",
  );
});

// --- 用例 2：icon 两种形态都能识别（emoji 文本 / 内联 SVG 字符串） ---
await t("isInlineSvg：emoji 为 false，内联 SVG 字符串为 true", async () => {
  assert.equal(isInlineSvg("📊"), false);
  assert.equal(isInlineSvg('<svg viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></svg>'), true);
  assert.equal(isInlineSvg('  <svg viewBox="0 0 16 16"></svg>'), true, "前导空白也应识别");
});

// --- 用例 3（验收 3 渲染分支）：reachable:false → fallback，不渲染空白 iframe ---
await t("pageRenderMode：不可达 → fallback（降级面板），可达 → iframe", async () => {
  assert.equal(
    pageRenderMode({ id: "ai-usage", reachable: false, reason: "超过 2000 ms 未响应", durationMs: 2001 }),
    "fallback",
  );
  assert.equal(
    pageRenderMode({ id: "ai-usage", reachable: false, reason: "连接被拒绝", durationMs: 3 }),
    "fallback",
  );
  assert.equal(
    pageRenderMode({ id: "ai-usage", reachable: true, reason: "HTTP 200", status: 200, durationMs: 14 }),
    "iframe",
  );
  // 非 2xx 也算可达（后端语义：只回答「服务在不在」）
  assert.equal(
    pageRenderMode({ id: "ai-usage", reachable: true, reason: "HTTP 503", status: 503, durationMs: 9 }),
    "iframe",
  );
});

// --- 用例 4（验收 3 解析）：health 信封解析 + 错误信封抛中文 msg ---
await t("fetchPageHealth：信封解析出 reachable/reason；code 非 0 抛 msg", async () => {
  globalThis.fetch = (path) => {
    assert.equal(path, "/api/pages/ai-usage/health");
    return Promise.resolve(
      envelope({ id: "ai-usage", reachable: false, reason: "连接被拒绝", durationMs: 3 }),
    );
  };
  const health = await fetchPageHealth("ai-usage");
  assert.equal(health.reachable, false);
  assert.equal(health.reason, "连接被拒绝");

  globalThis.fetch = () =>
    Promise.resolve({ json: async () => ({ code: 40404, msg: "页面不存在", data: null, request_id: "t" }) });
  await assert.rejects(fetchPageHealth("gone"), /页面不存在/);
});

// --- 用例 5：store 集成——refreshPages 分区 + 两类 hash 路由互斥 ---
await t("store：refreshPages 分区进 pages/skippedPages；#/page 与 #/session 互斥", async () => {
  globalThis.fetch = (path) => {
    if (path === "/api/pages") {
      return Promise.resolve(
        envelope({ pages: [AI_USAGE, { id: "w1", name: "挂件", icon: "🧩", type: "widget", url: "http://x" }] }),
      );
    }
    return Promise.reject(new Error(`未打桩的请求：${path}`));
  };
  const s = new Store();
  await s.refreshPages();
  assert.deepEqual(s.pages.map((p) => p.id), ["ai-usage"]);
  assert.deepEqual(s.skippedPages, [{ id: "w1", name: "挂件", type: "widget" }]);

  window.location.hash = "#/page/ai-usage";
  s.onHashChange();
  assert.equal(s.currentPageId, "ai-usage");
  assert.equal(s.currentId, null, "页面路由下不应残留会话选中");

  window.location.hash = "#/session/s1";
  s.onHashChange();
  assert.equal(s.currentPageId, null, "会话路由下应清掉页面选中");
  assert.equal(s.currentId, "s1");

  window.location.hash = "#/";
  s.onHashChange();
  assert.equal(s.currentPageId, null);
  assert.equal(s.currentId, null);
});

if (!process.exitCode) console.log(`✅ pages 前端逻辑回归全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
process.exit(process.exitCode ?? 0);
