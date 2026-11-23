import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const isEnglishRun = process.argv.includes("--en");
if (isEnglishRun) {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "en-US" } });
}

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, val) => storage.set(key, String(val)),
  removeItem: (key) => storage.delete(key),
};
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };
globalThis.React = React;

const listeners = new Map();
globalThis.window = {
  location: { hash: "#/", href: "http://127.0.0.1:18000/#/" },
  history: {
    state: null,
    pushState(state, _title, url) {
      this.state = state;
      if (url) globalThis.window.location.hash = url;
    },
    replaceState(state, _title, url) {
      this.state = state;
      if (url) globalThis.window.location.hash = url;
    },
    back() {},
  },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  addEventListener(type, fn) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(fn);
  },
  removeEventListener(type, fn) {
    listeners.get(type)?.delete(fn);
  },
};

const { getLocale } = await import("../src/i18n.ts");
const {
  BUILTIN_USAGE_ID,
  barLevel,
  formatCreditExpiry,
  formatUsageAgo,
  formatUsageError,
  formatUsageReset,
  formatUsageWindowLabel,
  formatUsageWindowNote,
  groupUsageWindows,
  pacePct,
  windowDurationMs,
} = await import("../src/usage.ts");
const { Store, store: appStore } = await import("../src/store.ts");
const { UsageView } = await import("../src/components/UsageView.tsx");

// 1. Pure usage calculation helpers (pace caliper, warning thresholds, reset countdowns, credit expiry, multi-group grouping).
{
  const now = Date.parse("2026-11-18T08:00:00Z");
  assert.equal(windowDurationMs({ id: "5h", duration_ms: null }), 5 * 3_600_000);
  assert.equal(windowDurationMs({ id: "week_sonnet", duration_ms: null }), 7 * 86_400_000);
  assert.equal(windowDurationMs({ id: "300m", duration_ms: null }), 300 * 60_000);
  assert.equal(windowDurationMs({ id: "custom", duration_ms: 7_200_000 }), 7_200_000);

  // Halfway through a 5h window -> 50% pace.
  const mid5h = pacePct({ id: "5h", duration_ms: 18_000_000, resets_at: new Date(now + 9_000_000).toISOString() }, now);
  assert.ok(mid5h !== null && Math.abs(mid5h - 50) < 0.01);
  // Boundary <= 1% or >= 99% or already past reset -> null.
  assert.equal(pacePct({ id: "5h", duration_ms: 18_000_000, resets_at: new Date(now + 17_950_000).toISOString() }, now), null);
  assert.equal(pacePct({ id: "5h", duration_ms: 18_000_000, resets_at: new Date(now - 1_000).toISOString() }, now), null);
  assert.equal(pacePct({ id: "extra_credits", duration_ms: null, resets_at: null }, now), null);

  assert.equal(barLevel(69.9), "");
  assert.equal(barLevel(70), "warn");
  assert.equal(barLevel(89.9), "warn");
  assert.equal(barLevel(90), "danger");

  if (!isEnglishRun) {
    assert.equal(getLocale(), "zh-CN");
    assert.equal(formatUsageAgo(new Date(now - 30_000).toISOString(), now), "刚刚");
    assert.equal(formatUsageAgo(new Date(now - 12 * 60_000).toISOString(), now), "12 分钟前");
    const shortReset = formatUsageReset({ id: "5h", duration_ms: 18_000_000, resets_at: new Date(now + 90 * 60_000).toISOString() }, now);
    assert.equal(shortReset.text, "剩 1h 30m");
    const dueReset = formatUsageReset({ id: "5h", duration_ms: 18_000_000, resets_at: new Date(now - 1_000).toISOString() }, now);
    assert.equal(dueReset.text, "已到点");

    const soonCredit = formatCreditExpiry({ expires_at: new Date(now + 3 * 86_400_000).toISOString() }, now);
    assert.equal(soonCredit.warn, true);
    assert.match(soonCredit.text, /3 天/);
    const neverCredit = formatCreditExpiry({ expires_at: null }, now);
    assert.equal(neverCredit.warn, false);
    assert.equal(neverCredit.text, "不过期");
  } else {
    assert.equal(getLocale(), "en");
    assert.equal(formatUsageAgo(new Date(now - 30_000).toISOString(), now), "just now");
    const shortReset = formatUsageReset({ id: "5h", duration_ms: 18_000_000, resets_at: new Date(now + 90 * 60_000).toISOString() }, now);
    assert.equal(shortReset.text, "1h 30m left");
  }

  const grouped = groupUsageWindows([
    { id: "g1_a", label: "A", group: "Gemini Models", used_pct: 10, resets_at: null, note: null },
    { id: "g1_b", label: "B", group: "Gemini Models", used_pct: 20, resets_at: null, note: null },
    { id: "g2_a", label: "C", group: "Claude and GPT Models", used_pct: 30, resets_at: null, note: null },
  ]);
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].group, "Gemini Models");
  assert.equal(grouped[0].items.length, 2);
  assert.equal(grouped[1].group, "Claude and GPT Models");
}

// 2. Store: POST /api/usage/open, monotonic revision safety, refreshAllUsage, settings sync, and #/usage routing.
{
  const s = new Store();
  const calls = [];
  let resolveInitialOpen;
  const envelope = (data) => ({ json: async () => ({ code: 0, msg: "success", data, request_id: "u1" }) });
  const wsSnapshot = {
    revision: 5,
    updated_at: "2026-11-18T08:05:00.000Z",
    providers: [{ id: "codex", name: "Codex", plan: "Pro", status: "ok", error: null, fetched_at: "2026-11-18T08:05:00.000Z", reset_credits: null, windows: [] }],
  };
  const staleHttpSnapshot = {
    revision: 2,
    updated_at: "2026-11-18T08:00:00.000Z",
    providers: [],
  };

  globalThis.fetch = (url, init) => {
    calls.push([url, init?.method ?? "GET", init?.body ?? null]);
    if (url === "/api/usage/open" && init?.method === "POST") {
      return new Promise((r) => { resolveInitialOpen = r; });
    }
    if (url === "/api/usage/refresh?provider=antigravity") {
      return Promise.resolve(envelope({ ...wsSnapshot, revision: 6 }));
    }
    if (url === "/api/usage/settings" && (!init?.method || init.method === "GET")) {
      return Promise.resolve(envelope({
        providers: { claude: { enabled: true }, antigravity: { enabled: true }, codex: { enabled: true }, kimi: { enabled: true } },
        kimi: { keyConfigured: false, keySource: "none", apiKeyEnv: "KIMI_API_KEY", apiKeyFile: null, useProxy: false },
        claude: { resetCredits: [] },
      }));
    }
    if (url === "/api/usage/settings" && init?.method === "PUT") {
      return Promise.resolve(envelope({
        settings: {
          providers: { claude: { enabled: true }, antigravity: { enabled: true }, codex: { enabled: true }, kimi: { enabled: true } },
          kimi: { keyConfigured: true, keySource: "config", apiKeyEnv: "KIMI_API_KEY", apiKeyFile: null, useProxy: true },
          claude: { resetCredits: [] },
        },
        summary: { ...wsSnapshot, revision: 7 },
      }));
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  const pendingLoad = s.loadUsage(true);
  assert.equal(s.usageLoading, true);
  // Newer WS broadcast (revision 5 + synced settings) arrives while initial POST /api/usage/open (revision 2) is in flight.
  s.handleFrame({
    type: "ai_usage_updated",
    data: wsSnapshot,
    settings: {
      providers: { claude: { enabled: false }, antigravity: { enabled: true }, codex: { enabled: true }, kimi: { enabled: true } },
      kimi: { keyConfigured: false, keySource: "none", apiKeyEnv: "KIMI_API_KEY", apiKeyFile: null, useProxy: false },
      claude: { resetCredits: [] },
    },
  });
  assert.equal(s.usageSettings?.providers.claude.enabled, false, "ai_usage_updated syncs settings across tabs");
  resolveInitialOpen(envelope(staleHttpSnapshot));
  await pendingLoad;
  assert.equal(s.usageLoading, false);
  assert.equal(s.usageSummary?.revision, 5, "lower-revision HTTP response must not overwrite newer WS snapshot");

  // Out-of-order older WS frame (revision 3 on same instance) is also ignored.
  s.handleFrame({ type: "ai_usage_updated", data: { ...staleHttpSnapshot, instance_id: "inst-1", revision: 3 } });
  assert.equal(s.usageSummary?.revision, 5, "older WS frame must not roll back newer revision");

  // New backend process instance_id resets revision baseline cleanly even when revision starts at 1,
  // and permanently retires inst-1 so late inst-1 responses cannot bounce the UI back.
  s.handleFrame({ type: "ai_usage_updated", data: { ...wsSnapshot, instance_id: "inst-1", revision: 10 } });
  assert.equal(s.usageSummary?.revision, 10);
  s.handleFrame({ type: "ai_usage_updated", data: { ...wsSnapshot, instance_id: "inst-2", revision: 1 } });
  assert.equal(s.usageSummary?.instance_id, "inst-2");
  assert.equal(s.usageSummary?.revision, 1, "restarted server instance_id must be accepted when revision resets to 1");
  s.handleFrame({ type: "ai_usage_updated", data: { ...staleHttpSnapshot, instance_id: "inst-1", revision: 99 } });
  assert.equal(s.usageSummary?.instance_id, "inst-2", "retired server instance_id must never be accepted again");

  await s.refreshAllUsage("antigravity");
  assert.ok(calls.some(([u, m]) => u === "/api/usage/refresh?provider=antigravity" && m === "POST"));

  await s.loadUsageSettings();
  assert.equal(s.usageSettings?.kimi.keySource, "none");
  await s.updateUsageSettings({ kimi: { apiKey: "sk-new", useProxy: true } });
  assert.equal(s.usageSettings?.kimi.keyConfigured, true);
  assert.equal(s.usageSettings?.kimi.useProxy, true);

  // Route navigation: navigatePage(BUILTIN_USAGE_ID) and #/usage both activate BUILTIN_USAGE_ID.
  s.navigatePage(BUILTIN_USAGE_ID);
  assert.equal(s.currentPageId, BUILTIN_USAGE_ID);
  s.closeSidebarPanel();
  assert.equal(s.currentPageId, null);
  globalThis.window.location.hash = "#/usage";
  s.onHashChange();
  assert.equal(s.currentPageId, BUILTIN_USAGE_ID);
}

// 3. Manual refresh renders each HTTP result while other providers are still pending, even without WS.
{
  const s = new Store();
  const requests = new Map();
  const calls = [];
  globalThis.fetch = (url, init) => {
    assert.equal(init?.method, "POST");
    const id = new URL(url, "http://localhost").searchParams.get("provider");
    calls.push(id);
    return new Promise((resolve) => { requests.set(id, resolve); });
  };
  const fetchedAt = "2026-11-18T08:00:00.000Z";
  const finish = (id, revision, providerIds) => {
    requests.get(id)({ json: async () => ({ code: 0, data: {
      instance_id: "progressive",
      revision,
      updated_at: fetchedAt,
      providers: providerIds.map((provider) => ({ id: provider, fetched_at: fetchedAt })),
    } }) });
  };

  const pending = s.refreshAllUsage();
  assert.deepEqual(calls, ["claude", "antigravity", "codex", "kimi"]);
  void s.refreshAllUsage("antigravity");
  assert.equal(calls.length, 4, "repeat clicks reuse the in-flight provider refresh");

  finish("codex", 2, ["codex"]);
  await new Promise(setImmediate);
  assert.deepEqual(s.usageSummary?.providers.map((provider) => provider.id), ["codex"]);
  assert.equal(s.usageRefreshing.has("codex"), false);
  assert.equal(s.usageRefreshing.has("antigravity"), true);

  finish("kimi", 3, ["codex", "kimi"]);
  await new Promise(setImmediate);
  assert.deepEqual(s.usageSummary?.providers.map((provider) => provider.id), ["codex", "kimi"]);
  assert.equal(s.usageRefreshing.has("kimi"), false);

  finish("claude", 1, ["claude"]);
  await new Promise(setImmediate);
  assert.equal(s.usageSummary?.revision, 3, "a late HTTP response keeps the newer snapshot");
  finish("antigravity", 4, ["claude", "antigravity", "codex", "kimi"]);
  await pending;
  assert.equal(s.usageSummary?.revision, 4);
  assert.equal(s.usageRefreshing.size, 0);
}

// 4. UsageView SSR rendering across all 4 providers (Claude, Antigravity, Codex, Kimi) in zh-CN & en.
{
  const now = Date.parse("2026-11-18T08:00:00Z");
  appStore.now = now;
  appStore.codexResets = { enabled: false, lastSuccessAt: null, stale: false, monitor: { status: "healthy" }, pending: [], recent: [], alerts: [] };
  appStore.usageSummary = {
    updated_at: "2026-11-18T07:59:00Z",
    providers: [
      {
        id: "claude",
        name: "Claude",
        plan: "Max",
        status: "ok",
        error: null,
        fetched_at: "2026-11-18T07:59:00Z",
        reset_credits: null,
        windows: [
          { id: "5h", label: "5h", duration_ms: 18_000_000, used_pct: 32, resets_at: "2026-11-18T10:30:00Z", note: null },
          { id: "week_sonnet", label: "Weekly Sonnet", window_label: "Sonnet", duration_ms: 604_800_000, used_pct: 75, resets_at: "2026-11-22T00:00:00Z", note: "Up to 80% of weekly", note_code: { code: "weekly_cap", cap: 80 } },
        ],
      },
      {
        id: "antigravity",
        name: "Antigravity",
        plan: "Google AI Ultra",
        status: "ok",
        error: null,
        fetched_at: "2026-11-18T07:59:00Z",
        reset_credits: null,
        credits_note: "420",
        on_demand: true,
        windows: [
          { id: "gemini_week", label: "Gemini Models · Weekly", group: "Gemini Models", window_label: "Weekly", duration_ms: 604_800_000, used_pct: 71, resets_at: null, note: null },
          { id: "gemini_5h", label: "Gemini Models · 5h", group: "Gemini Models", window_label: "5h", duration_ms: 18_000_000, used_pct: 24, resets_at: "2026-11-18T11:00:00Z", note: null },
          { id: "claude_5h", label: "Claude and GPT Models · 5h", group: "Claude and GPT Models", window_label: "5h", duration_ms: 18_000_000, used_pct: 92, resets_at: "2026-11-18T11:00:00Z", note: "Remaining: 8", note_code: { code: "remaining_amount", amount: "8" } },
        ],
      },
      {
        id: "codex",
        name: "Codex",
        plan: "Pro",
        status: "ok",
        error: null,
        fetched_at: "2026-11-18T07:58:00Z",
        reset_credits: {
          available_count: 2,
          credits: [
            { expires_at: "2026-11-21T00:00:00Z" },
            { expires_at: "2026-11-29T00:00:00Z" },
          ],
        },
        windows: [
          { id: "5h", label: "5h", duration_ms: 18_000_000, used_pct: 14, resets_at: "2026-11-18T11:30:00Z", note: null },
        ],
      },
      {
        id: "kimi",
        name: "Kimi",
        plan: null,
        status: "error",
        error: "Missing key",
        error_code: "kimi_no_key",
        fetched_at: "2026-11-18T07:58:00Z",
        reset_credits: null,
        windows: [],
      },
    ],
  };

  const html = renderToStaticMarkup(React.createElement(UsageView));
  for (const id of ["claude", "antigravity", "codex", "kimi"]) {
    assert.match(html, new RegExp(`data-provider="${id}"`), `${getLocale()} markup renders ${id} card`);
  }
  appStore.usageRefreshing = new Set(["antigravity"]);
  const refreshingHtml = renderToStaticMarkup(React.createElement(UsageView));
  assert.match(refreshingHtml, /data-provider="antigravity"[^>]*aria-busy="true"/);
  assert.match(refreshingHtml, /data-provider="codex"[^>]*aria-busy="false"/);
  appStore.usageRefreshing = new Set();
  assert.match(html, /Google AI Ultra/);
  assert.match(html, /Gemini Models[^]*?24%[^]*?71%[^]*?Claude and GPT Models/, "Antigravity renders the 5h bar above the weekly bar in its group");
  assert.match(html, /Gemini Models/);
  assert.match(html, /Claude and GPT Models/);
  assert.match(html, /usage-bar-fill warn/);
  assert.match(html, /usage-bar-fill danger/);

  if (!isEnglishRun) {
    assert.match(
      formatUsageError({ id: "kimi", name: "Kimi", plan: null, windows: [], status: "error", error: "HTTP 502", error_code: "http_error", http_status: 502, fetched_at: "2026-11-18T08:00:00Z", reset_credits: null }),
      /HTTP 502/,
    );
    assert.doesNotMatch(
      formatUsageError({ id: "kimi", name: "Kimi", plan: null, windows: [], status: "error", error: "Internal error", error_code: "internal_error", fetched_at: "2026-11-18T08:00:00Z", reset_credits: null }),
      /Internal error/,
    );
    assert.match(html, /AI credits 剩余 420/);
    assert.match(html, /时间已过去/);
    assert.match(html, /上限为周额度 80%/);
    assert.match(html, /剩余 8/);
    assert.match(html, /🎫 2 张/);
    assert.match(html, /配置密钥/);
  } else {
    assert.equal(formatUsageWindowLabel(appStore.usageSummary.providers[0].windows[1]), "Weekly Sonnet");
    assert.equal(formatUsageWindowNote(appStore.usageSummary.providers[0].windows[1]), "Up to 80% of weekly");
    assert.match(formatUsageError(appStore.usageSummary.providers[3], "KIMI_API_KEY"), /KIMI_API_KEY/);
    assert.match(html, /AI usage/);
    assert.match(html, /AI credits remaining: 420/);
    assert.match(html, /of window elapsed/);
    assert.match(html, /🎫 2 credits/);
    assert.match(html, /Configure key/);
    assert.doesNotMatch(html, /[\u4e00-\u9fff]/, "English UsageView markup must contain zero Han characters");
  }
  // Empty Antigravity windows with credits_note: "0" still renders the known 0 credits balance alongside the error message.
  appStore.usageSummary = {
    updated_at: "2026-11-18T08:00:00Z",
    providers: [{
      id: "antigravity",
      name: "Antigravity",
      plan: "Pro",
      status: "error",
      error: "No quota windows",
      error_code: "antigravity_no_limits",
      fetched_at: "2026-11-18T08:00:00Z",
      reset_credits: null,
      credits_note: "0",
      on_demand: true,
      windows: [],
    }],
  };
  const zeroCreditsHtml = renderToStaticMarkup(React.createElement(UsageView));
  assert.match(zeroCreditsHtml, !isEnglishRun ? /AI credits 剩余 0/ : /AI credits remaining: 0/);
}

console.log("✅ usage frontend flow & bilingual 4-provider SSR tests passed");
