#!/usr/bin/env node
// pages/ 扩展机制前端逻辑的打桩回归测试（验收 3 与 5 的前端侧证据）：
// - health 信封解析与「不可达 → 降级面板」渲染分支（不渲染空白 iframe）；
// - embeddable 三态：true→iframe、false→blocked（完全不渲染 iframe）、null/缺省→uncertain（iframe+提示）；
// - 未知 type（如 "widget"）跳过 + 记录提示，绝不崩掉整个列表；
// - store 集成：refreshPages 分区结果、旧页面链接打开侧栏、会话导航关闭面板。
// 浏览器依赖（window / WebSocket / fetch）全部打桩，不需要真实 server。
// 运行：npx tsx frontend/scripts/pages-flow.test.mjs
import { strict as assert } from "node:assert";

// --- 浏览器全局打桩（须在 import store 之前） ---
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.window = { location: { hash: "#/" }, addEventListener() {} };

const { isInlineSvg, isLoopbackUrl, partitionPages, pageRenderMode } = await import("../src/pages.ts");
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

// --- 用例 2b：手机经 Tailscale 访问时，指向 127.0.0.1 的页面打不开，要能识别出来 ---
await t("isLoopbackUrl：127.0.0.1 / localhost / [::1] 是本机地址，ts.net 与非法 URL 不是", async () => {
  assert.equal(isLoopbackUrl("http://127.0.0.1:8788"), true);
  assert.equal(isLoopbackUrl("http://localhost:8788/x"), true);
  assert.equal(isLoopbackUrl("http://[::1]:8788"), true);
  assert.equal(isLoopbackUrl("https://desk.tail1234.ts.net/#/page/ai-usage"), false);
  assert.equal(isLoopbackUrl("不是网址"), false);
});

// --- 用例 3（验收 3 渲染分支）：reachable:false → fallback，不渲染空白 iframe ---
await t("pageRenderMode：不可达 → fallback（降级面板）", async () => {
  assert.equal(
    pageRenderMode({ id: "ai-usage", reachable: false, reason: "超过 2000 ms 未响应", durationMs: 2001 }),
    "fallback",
  );
  assert.equal(
    pageRenderMode({ id: "ai-usage", reachable: false, reason: "连接被拒绝", durationMs: 3 }),
    "fallback",
  );
});

// --- 用例 3b：embeddable 三态 → iframe / blocked / uncertain ---
await t("pageRenderMode：embeddable true→iframe，false→blocked，null/缺省→uncertain", async () => {
  const base = { id: "ai-usage", reachable: true, reason: "HTTP 200", status: 200, durationMs: 14 };
  assert.equal(pageRenderMode({ ...base, embeddable: true }), "iframe", "明确允许嵌入 → 正常 iframe");
  assert.equal(
    pageRenderMode({ ...base, embeddable: false, embedReason: "目标站点设置了 X-Frame-Options: DENY" }),
    "blocked",
    "明确拒绝嵌入 → 降级面板，不渲染 iframe",
  );
  assert.equal(pageRenderMode({ ...base, embeddable: null }), "uncertain", "无法确定 → iframe + 提示");
  // 旧后端没有 embeddable 字段：按「无法确定」处理（仍渲染 iframe + 提示），不猜
  assert.equal(pageRenderMode(base), "uncertain", "字段缺省同样按 uncertain");
  // 非 2xx 也算可达（后端语义：只回答「服务在不在」），可嵌性照常走 embeddable
  assert.equal(
    pageRenderMode({ id: "ai-usage", reachable: true, reason: "HTTP 503", status: 503, durationMs: 9, embeddable: true }),
    "iframe",
  );
  // embeddable:false 但不可达：不可达优先（服务都不在，谈不上嵌入）
  assert.equal(
    pageRenderMode({ id: "ai-usage", reachable: false, reason: "连接被拒绝", durationMs: 3, embeddable: false }),
    "fallback",
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
await t("store：refreshPages 分区进 pages/skippedPages；旧页面路由打开面板", async () => {
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
  assert.equal(s.currentId, null, "启动直达页面链接时没有当前会话");

  window.location.hash = "#/session/s1";
  s.onHashChange();
  assert.equal(s.currentPageId, null, "会话路由下应清掉页面选中");
  assert.equal(s.currentId, "s1");

  s.navigatePage("ai-usage");
  assert.equal(s.currentPageId, "ai-usage", "不等待 hashchange 即打开面板");
  assert.equal(s.currentId, "s1", "打开面板保留主区会话");
  s.closeSidebarPanel();
  assert.equal(window.location.hash, "#/session/s1", "收起恢复会话路由");
  assert.equal(s.currentPageId, null);
  assert.equal(s.currentId, "s1");

  window.location.hash = "#/";
  s.onHashChange();
  assert.equal(s.currentPageId, null);
  assert.equal(s.currentId, null);
});

if (!process.exitCode) console.log(`✅ pages 前端逻辑回归全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
process.exit(process.exitCode ?? 0);
