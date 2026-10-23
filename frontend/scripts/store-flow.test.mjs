#!/usr/bin/env node
// store.ts 新建会话 / 快照对齐流程的回归测试。
// 背景缺陷：新建会话后发送没反应、界面永远空白（首次快照被静默丢弃 + create 未等加载 + finally 误删 in-flight）。
// 浏览器依赖（WebSocket / fetch）全部打桩，不需要真实 server；用 tsx 跑：npm run test:store
import { strict as assert } from "node:assert";

// --- 浏览器全局打桩（须在 import store 之前） ---
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

const { Store } = await import("../src/store.ts");
const { SIDEBAR_RECENT_WINDOW_MS, selectSidebarSessions } = await import("../src/sidebar-sessions.ts");

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
};

const settle = () => new Promise((r) => setTimeout(r, 20));

function makeSession(id) {
  const now = new Date().toISOString();
  return {
    id, agent: "kimi", agentId: `${id}-agent`, cwd: "/tmp", status: "idle",
    createdAt: now, lastActivityAt: now, seq: 0, transcriptPath: `/tmp/${id}.jsonl`,
    config: {}, riskyMode: false,
  };
}

function makeEvent(sessionId, seq, type = "agent_text", payload = {}) {
  return { type, sessionId, agentId: `${sessionId}-agent`, seq, timestamp: new Date().toISOString(), payload };
}

function envelope(data) {
  return { json: async () => ({ code: 0, msg: "", data, request_id: "t" }) };
}

/** 假 WS：记录上行帧，readyState 恒 OPEN。 */
function fakeSocket(sent) {
  return { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
}

/**
 * 打桩 fetch。snapshotGate 给了就走手动闸门（数组收集 resolve，测试自己决定何时放行），
 * 否则立即返回空快照（seq 0、无事件）。
 */
function stubFetch(session, snapshotGate) {
  globalThis.fetch = (path, init) => {
    path = String(path);
    if (path === "/api/sessions" && init?.method === "POST") return Promise.resolve(envelope({ session }));
    if (path === "/api/sessions") return Promise.resolve(envelope({ sessions: [session] }));
    if (path.endsWith("/snapshot?tail=1")) {
      if (snapshotGate) return new Promise((resolve) => snapshotGate.push(resolve));
      return Promise.resolve(envelope({ session, seq: 0, events: [] }));
    }
    if (path.endsWith("/commands")) return Promise.resolve(envelope({ commands: [] }));
    return Promise.reject(new Error(`未打桩的请求：${path}`));
  };
}

/**
 * 打桩 fetch（全功能版）：在 stubFetch 基础上补 /files 精确检索与 DELETE。
 * knownFiles 模拟会话 cwd 下真实存在的文件；返回子串匹配列表（与后端检索语义一致），
 * resolveFile 的「精确 includes 才算存在」判定在 store 内完成。queries 传入数组可记录查询顺序。
 */
function stubFetchFull(session, { knownFiles = [], queries = null } = {}) {
  globalThis.fetch = (path, init) => {
    path = String(path);
    if (path === "/api/sessions" && init?.method === "POST") return Promise.resolve(envelope({ session }));
    if (path === "/api/sessions") return Promise.resolve(envelope({ sessions: [session] }));
    if (path.endsWith("/snapshot?tail=1")) return Promise.resolve(envelope({ session, seq: 0, events: [] }));
    if (path.endsWith("/commands")) return Promise.resolve(envelope({ commands: [] }));
    if (path.includes("/files?")) {
      const q = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("q") ?? "";
      queries?.push(q);
      return Promise.resolve(envelope({ files: knownFiles.filter((f) => f.includes(q)) }));
    }
    if (init?.method === "DELETE") return Promise.resolve(envelope({}));
    return Promise.reject(new Error(`未打桩的请求：${path}`));
  };
}

// --- P0-4：全局 tick 按活跃状态变频 ---
await t("tick 变频：空闲 30 秒，running/starting 1 秒，回到空闲立即降频", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const delays = [];
  let timerId = 0;
  globalThis.setTimeout = (_fn, delay) => {
    delays.push(delay);
    return ++timerId;
  };
  globalThis.clearTimeout = () => {};
  try {
    const s = new Store();
    s.sessions = [makeSession("s-tick-idle")];
    s["startClock"]();
    assert.equal(delays.at(-1), 30_000, "全局空闲时应使用 30 秒 tick");

    s.sessions = [{ ...s.sessions[0], status: "running" }];
    s["notify"]();
    assert.equal(delays.at(-1), 1000, "存在 running 会话时应切到 1 秒 tick");

    s.sessions = [{ ...s.sessions[0], status: "starting" }];
    s["notify"]();
    assert.equal(delays.filter((delay) => delay === 1000).length, 1, "同档位不应反复重置 timer");

    s.sessions = [{ ...s.sessions[0], status: "idle" }];
    s["notify"]();
    assert.equal(delays.at(-1), 30_000, "离开活跃态后应立即恢复 30 秒 tick");
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
});

// --- P2-8：pendingGates 不因事件窗口截断而失去可定位的闸门事件 ---
await t("缺失闸门 ref 的恢复：先提示并 resync，快照窗口额外保留旧未决闸门", async () => {
  const session = makeSession("s-old-gate");
  const gate = [];
  stubFetch(session, gate);
  const s = new Store();
  s.sessions = [session];
  const oldData = {
    events: [makeEvent(session.id, 1, "permission_request", { requestId: "gate-old" })],
    seq: 1,
    dropped: 0,
    pendingGates: new Map([["gate-old", 1]]),
  };
  s.data.set(session.id, oldData);

  const recovering = s.recoverMissingPendingGate(session.id);
  assert.match(s.lastError?.message ?? "", /闸门.*事件窗口.*重新载入/, "找不到 ref 时必须有用户可见提示");
  assert.equal(s.lastError?.sessionId, session.id, "恢复提示必须带会话上下文（toast 可点击跳转）");
  assert.equal(gate.length, 1, "找不到 ref 时必须发起快照 resync");
  assert.equal(s.data.get(session.id), oldData, "resync 等待期间不得删掉旧 data");

  const events = [
    makeEvent(session.id, 1, "permission_request", { requestId: "gate-old" }),
    ...Array.from({ length: 2001 }, (_, index) => makeEvent(session.id, index + 2)),
  ];
  gate[0](envelope({ session, seq: 2002, events }));
  await recovering;
  const data = s.data.get(session.id);
  assert.equal(data.pendingGates.size, 1, "窗口截断不得少算未决闸门");
  assert.ok(data.events.some((event) => event.seq === 1), "旧未决闸门请求必须留在渲染窗口");
  assert.equal(data.events.length, 2001, "常规 2000 条窗口外只额外保留未决闸门保护项");
});

await t("WS open 对齐：已加载会话 afterSeq 补发，未加载会话只刷新列表", async () => {
  const session = makeSession("s-open-align");
  let snapshotCalls = 0;
  globalThis.fetch = (path) => {
    path = String(path);
    if (path === "/api/sessions") return Promise.resolve(envelope({ sessions: [session, { ...makeSession("other"), pendingGateCount: 1, title: "未加载" }] }));
    if (path.endsWith("/snapshot?tail=1")) {
      snapshotCalls++;
      return Promise.resolve(envelope({ session, seq: 0, events: [] }));
    }
    if (path.endsWith("/commands")) return Promise.resolve(envelope({ commands: [] }));
    return Promise.reject(new Error(`未打桩的请求：${path}`));
  };
  const s = new Store();
  const sent = [];
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.data.set(session.id, { events: [], seq: 7, dropped: 0, pendingGates: new Map() });
  await s.alignAfterSocketOpen(false);
  await s.alignAfterSocketOpen(true);
  assert.equal(snapshotCalls, 0);
  assert.deepEqual(sent, Array(2).fill({ type: "replay", sessionId: session.id, afterSeq: 7 }));
  assert.equal(s.pendingCount("other"), 1, "断线期间未加载会话新增审批由列表恢复");
  assert.equal(s.data.has("other"), false);
  const missing = new Store();
  missing.currentId = session.id;
  await missing.alignAfterSocketOpen(false);
  assert.equal(snapshotCalls, 1, "只为当前会话补快照");
});

await t("快照在途期间持续来事件：一次请求、完整且无重复", async () => {
  const session = makeSession("stream-snapshot");
  const gates = [];
  stubFetch(session, gates);
  const s = new Store();
  s.sessions = [session];
  s.data.set(session.id, { events: [makeEvent(session.id, 1)], seq: 1, dropped: 0, pendingGates: new Map() });
  for (const seq of [3, 4, 5, 5, 6, 7, 8]) s.handleEvent(makeEvent(session.id, seq));
  assert.equal(gates.length, 1);
  gates[0](envelope({ session, seq: 4, events: [1, 2, 3, 4].map((seq) => makeEvent(session.id, seq)) }));
  await settle();
  assert.equal(gates.length, 1);
  assert.deepEqual(s.data.get(session.id).events.map((event) => event.seq), [1,2,3,4,5,6,7,8]);
  assert.equal(s.data.get(session.id).seq, 8);
});

await t("临时事件不推进 seq、不 resync；最终参数取代临时参数", async () => {
  const session = makeSession("ephemeral");
  const s = new Store(); s.sessions = [session];
  s.data.set(session.id, { events: [makeEvent(session.id, 1, "tool_call_started", { toolCallId: "t" })], seq: 1, dropped: 0, pendingGates: new Map() });
  s.resync = () => { throw new Error("临时事件触发了 resync"); };
  globalThis.fetch = () => { throw new Error("临时事件请求了快照"); };
  for (const partialInput of ["{", '{"x":']) s.handleEvent({ ...makeEvent(session.id, 99, "tool_call_updated", { toolCallId: "t", partialInput }), ephemeral: true });
  assert.equal(s.data.get(session.id).seq, 1);
  assert.equal(s.data.get(session.id).toolFrames.size, 1);
  assert.equal(s.data.get(session.id).events.length, 1);
  s.handleEvent(makeEvent(session.id, 2, "tool_call_updated", { toolCallId: "t", input: { x: 1 }, inputComplete: true }));
  assert.equal(s.data.get(session.id).toolFrames.size, 0);
});

await t("重连补发与实时帧交错：先缓存、后按序去重，审批不漏", async () => {
  const session = makeSession("replay");
  const s = new Store(); s.sessions = [session];
  s.data.set(session.id, { events: [], seq: 2, dropped: 0, pendingGates: new Map() });
  s.replayBuffers.set(session.id, []);
  s.handleEvent(makeEvent(session.id, 4));
  s.handleEvent(makeEvent(session.id, 3, "permission_request", { requestId: "gate" }));
  s.handleEvent(makeEvent(session.id, 4));
  s.handleFrame({ type: "replay_complete", sessionId: session.id, currentSeq: 4 });
  assert.deepEqual(s.data.get(session.id).events.map((event) => event.seq), [3,4]);
  assert.equal(s.pendingCount(session.id), 1);
});

await t("未加载会话标题采用 WS 权威值，空首条消息不被后续覆盖", async () => {
  const session = { ...makeSession("title-summary"), title: "新会话" };
  const s = new Store(); s.sessions = [session];
  s.handleEvent({ ...makeEvent(session.id, 1, "user_message", { text: "later" }), title: "新会话" });
  assert.equal(s.session(session.id).title, "新会话");
  assert.equal(s.data.has(session.id), false);
});

await t("慢元数据、项目排序和扩展页不阻塞当前会话与连接", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  const session = makeSession("startup-fast");
  globalThis.window = { location: { hash: `#/session/${session.id}` }, addEventListener() {} };
  globalThis.document = { addEventListener() {} };
  globalThis.localStorage = { getItem() { return null; }, setItem() {} };
  const gates = new Map();
  const requests = [];
  let connected = false;
  globalThis.fetch = async (path) => {
    requests.push(path);
    if (["/api/meta", "/api/project-order", "/api/pages"].includes(path)) {
      return new Promise((resolve) => gates.set(path, resolve));
    }
    if (path === "/api/sessions") return envelope({ sessions: [session] });
    if (path.endsWith("/snapshot?tail=1")) return envelope({ session, seq: 0, events: [] });
    throw new Error(`未打桩 ${path}`);
  };
  const s = new Store();
  s.connect = () => { connected = true; };
  const initializing = s.init();
  try {
    await settle();
    assert.ok(requests.includes("/api/sessions"), "列表不能等元数据");
    assert.ok(gates.has("/api/project-order") && gates.has("/api/pages"), "独立请求同时开始");
    assert.ok(s.data.has(session.id), "会话快照已可显示");
    assert.equal(connected, true, "实时连接不能等扩展页或排序");
  } finally {
    // 即使断言失败也放行所有请求，让旧实现也能完整退出。
    for (let i = 0; i < 4; i++) {
      gates.get("/api/meta")?.(envelope({ capabilities: {} }));
      gates.get("/api/project-order")?.(envelope({ paths: [] }));
      gates.get("/api/pages")?.(envelope({ pages: [] }));
      await settle();
    }
    await initializing;
    clearTimeout(s.tickTimer);
    globalThis.window = previousWindow;
    globalThis.document = previousDocument;
    globalThis.localStorage = previousStorage;
  }
});

await t("CLI 探测通知会刷新元数据，迟到的旧响应不能覆盖新结果", async () => {
  const s = new Store();
  const pending = [];
  globalThis.fetch = () => new Promise((resolve) => pending.push(resolve));
  s.handleFrame({ type: "meta_updated" });
  s.handleFrame({ type: "meta_updated" });
  assert.equal(pending.length, 2);
  pending[1](envelope({ metadataPending: false, drivers: { marker: "new" } }));
  await settle();
  pending[0](envelope({ metadataPending: true, drivers: { marker: "old" } }));
  await settle();
  assert.equal(s.meta.drivers.marker, "new");
});

await t("连接建立后补取 pending 元数据，覆盖错过探测通知的情况", async () => {
  const previousSocket = globalThis.WebSocket;
  const previousWindow = globalThis.window;
  globalThis.window = { location: { protocol: "http:", host: "localhost" } };
  class Socket {
    static OPEN = 1;
    readyState = 0;
    listeners = new Map();
    addEventListener(type, fn) { this.listeners.set(type, fn); }
  }
  globalThis.WebSocket = Socket;
  let requests = 0;
  globalThis.fetch = async (path) => {
    assert.equal(path, "/api/meta");
    requests++;
    return envelope({ metadataPending: false, drivers: { marker: "ready" } });
  };
  try {
    for (const meta of [null, { metadataPending: true }, { metadataPending: false }, {}]) {
      const s = new Store();
      s.meta = meta;
      s.refreshCodexResets = async () => {};
      s.alignAfterSocketOpen = async () => {};
      s.connect();
      s.socket.listeners.get("open")();
      await settle();
      if (meta === null || meta.metadataPending) assert.equal(s.meta.drivers.marker, "ready");
    }
    assert.equal(requests, 2, "最终状态和旧后端不重复请求");
  } finally {
    globalThis.WebSocket = previousSocket;
    globalThis.window = previousWindow;
  }
});

await t("启动只加载当前会话的一份快照", async () => {
  const sessions = [makeSession("active"), makeSession("unopened")];
  globalThis.window = { location: { hash: "#/session/active" }, addEventListener() {} };
  globalThis.document = { addEventListener() {} };
  globalThis.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
  const snapshots = [];
  globalThis.fetch = async (path) => {
    if (path === "/api/meta") return envelope({});
    if (path === "/api/sessions") return envelope({ sessions });
    if (path === "/api/pages") return envelope({ pages: [] });
    if (path.endsWith("/snapshot?tail=1")) { snapshots.push(path); return envelope({ session: sessions[0], seq: 0, events: [] }); }
    if (path.endsWith("/commands")) return envelope({ commands: [] });
    throw new Error(`未打桩 ${path}`);
  };
  const s = new Store(); s.connect = () => {};
  await s.init();
  assert.deepEqual(snapshots, ["/api/sessions/active/snapshot?tail=1"]);
  assert.equal(s.data.has("unopened"), false);
  clearTimeout(s.tickTimer);
});

await t("手机 init 无 hash 恢复上次会话（replace），真实注册的 popstate 可恢复面板", async () => {
  const previousWindow = globalThis.window;
  const previousStorage = globalThis.localStorage;
  const session = makeSession("restored");
  const listeners = new Map();
  const stored = new Map([["workbench-last-session", session.id]]);
  let pushes = 0;
  const entries = [{ hash: "", state: null }];
  let index = 0;
  const pending = [];
  const location = { get hash() { return entries[index].hash; } };
  const history = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    replaceState(state, _title, hash) { entries[index] = { hash, state: structuredClone(state) }; },
    pushState(state, _title, hash) {
      pushes++; entries.splice(index + 1); entries.push({ hash, state: structuredClone(state) }); index++;
    },
    back() { pending.push(() => {
      if (!index) return;
      const hash = location.hash; index--; listeners.get("popstate")();
      if (hash !== location.hash) pending.unshift(() => listeners.get("hashchange")());
    }); },
  };
  globalThis.window = {
    location, history, matchMedia: () => ({ matches: true }),
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  globalThis.localStorage = {
    getItem(key) { return stored.get(key) ?? null; },
    setItem(key, value) { stored.set(key, value); }, removeItem(key) { stored.delete(key); },
  };
  globalThis.fetch = async (path) => {
    if (path === "/api/meta") return envelope({});
    if (path === "/api/sessions") return envelope({ sessions: [session] });
    if (path === "/api/pages") return envelope({ pages: [] });
    if (path.endsWith("/snapshot?tail=1")) return envelope({ session, seq: 0, events: [] });
    if (path.endsWith("/commands")) return envelope({ commands: [] });
    throw new Error(`未打桩 ${path}`);
  };
  const s = new Store(); s.connect = () => {};
  try {
    await s.init();
    assert.equal(s.currentId, session.id);
    assert.equal(location.hash, "#/session/restored"); assert.equal(pushes, 0);
    assert.ok(listeners.has("popstate")); assert.ok(listeners.has("hashchange"));
    s.setFilesOpen(true);
    s.sessions.push(makeSession("new-session")); // 新建后 refreshSessions 已包含目的会话
    s.navigate("new-session"); assert.equal(pushes, 2); assert.equal(s.filesOpen, false);
    assert.equal(history.length, 3); history.back();
    assert.equal(s.currentId, "new-session", "back 必须异步");
    while (pending.length) pending.shift()();
    assert.ok(s.filesOpen); assert.equal(s.currentId, session.id);
    assert.equal(stored.get("workbench-last-session"), session.id);
  } finally {
    clearTimeout(s.tickTimer);
    globalThis.window = previousWindow;
    globalThis.localStorage = previousStorage;
  }
});

/** 历史入口使用完整注册表；假 history 保留同 hash 预览条目并异步触发导航事件。 */
async function withHistoryNavigation(sessions, mobile, run) {
  const previous = {
    window: globalThis.window, document: globalThis.document,
    localStorage: globalThis.localStorage, fetch: globalThis.fetch,
  };
  const listeners = new Map();
  const entries = [{ hash: "#/", state: null }];
  const pending = [];
  const requests = [];
  const sent = [];
  const stored = new Map();
  let index = 0;
  const location = {
    get hash() { return entries[index].hash; },
    set hash(hash) { entries[index].hash = hash; },
  };
  const travel = (offset) => pending.push(() => {
    const next = index + offset;
    if (next < 0 || next >= entries.length) return;
    const oldHash = location.hash;
    index = next;
    listeners.get("popstate")();
    if (oldHash !== location.hash) pending.unshift(() => listeners.get("hashchange")());
  });
  const history = {
    get state() { return entries[index].state; },
    get length() { return entries.length; },
    replaceState(state, _title, hash) { entries[index] = { hash, state: structuredClone(state) }; },
    pushState(state, _title, hash) {
      entries.splice(index + 1);
      entries.push({ hash, state: structuredClone(state) });
      index++;
    },
    back() { travel(-1); }, forward() { travel(1); },
  };
  globalThis.window = {
    location, history, matchMedia: () => ({ matches: mobile }),
    addEventListener(name, listener) { listeners.set(name, listener); },
  };
  globalThis.document = { addEventListener() {} };
  globalThis.localStorage = {
    getItem(key) { return stored.get(key) ?? null; },
    setItem(key, value) { stored.set(key, value); }, removeItem(key) { stored.delete(key); },
  };
  globalThis.fetch = async (path, init) => {
    path = String(path);
    requests.push({ path, method: init?.method ?? "GET", body: init?.body });
    if (path === "/api/meta") return envelope({});
    if (path === "/api/pages") return envelope({ pages: [] });
    if (path === "/api/sessions" && init?.method === "POST") {
      const input = JSON.parse(init.body);
      const next = {
        ...makeSession("history-resumed"), agent: input.agent, cwd: input.cwd,
        nativeSessionId: input.resumeSessionId,
      };
      sessions.push(next);
      return envelope({ session: next });
    }
    if (path === "/api/sessions") return envelope({ sessions });
    const snapshot = path.match(/^\/api\/sessions\/([^/]+)\/snapshot\?tail=1$/);
    if (snapshot) {
      const session = sessions.find((item) => item.id === decodeURIComponent(snapshot[1]));
      assert.ok(session, "历史打开必须请求原会话快照");
      const event = { ...makeEvent(session.id, 1, "agent_text", { text: "旧会话内容" }), timestamp: session.lastActivityAt };
      return envelope({ session, seq: 1, events: [event] });
    }
    if (path.endsWith("/commands")) return envelope({ commands: [] });
    throw new Error(`未打桩 ${path}`);
  };
  const s = new Store();
  s.connect = () => {};
  try {
    await s.init();
    s.socket = fakeSocket(sent);
    await run({
      s, location, history, requests, sent, stored,
      async flushNavigation() {
        while (pending.length) pending.shift()();
        if (s.currentId) await s.ensureLoaded(s.currentId);
      },
    });
  } finally {
    clearTimeout(s.tickTimer);
    clearTimeout(s.listRefreshTimer);
    Object.assign(globalThis, previous);
  }
}

function oldHistorySession(id, extra = {}) {
  const old = "2026-01-01T00:00:00.000Z";
  return { ...makeSession(id), nativeSessionId: `${id}-native`, createdAt: old, lastActivityAt: old, seq: 1, ...extra };
}

function historyItem(session) {
  return {
    agent: session.agent, nativeSessionId: session.nativeSessionId,
    cwd: session.cwd, title: "旧会话", lastActivityAt: session.lastActivityAt,
    source: "workbench", filePath: session.transcriptPath,
  };
}

await t("历史入口：主列表外旧 idle、已释放和 dead 会话均可打开原快照", async () => {
  const sessions = [
    oldHistorySession("history-old"),
    oldHistorySession("history-released", { released: true }),
    oldHistorySession("history-dead", { status: "dead" }),
  ];
  await withHistoryNavigation(sessions, false, async ({ s, location, requests }) => {
    assert.deepEqual(selectSidebarSessions(s), { waiting: [], active: [] });
    for (const session of sessions) {
      assert.ok(s.now - Date.parse(session.lastActivityAt) > SIDEBAR_RECENT_WINDOW_MS);
      s.navigateHistory();
      s.selectHistory(historyItem(session));
      s.navigate(session.id); // HistoryView 已导入预览的「打开会话」入口
      await s.ensureLoaded(session.id);
      assert.equal(s.currentId, session.id);
      assert.equal(location.hash, `#/session/${session.id}`);
      assert.equal(s.historyOpen, false);
      assert.equal(s.historySelection, null);
      assert.equal(s.data.get(session.id).events[0].payload.text, "旧会话内容");
      assert.equal(s.session(session.id).status, session.status);
      assert.deepEqual(selectSidebarSessions(s).active.map((item) => item.id), session.status === "dead" ? [] : [session.id],
        "当前非 dead 旧会话应临时回到侧栏，dead 打开后仍留在历史入口");
      s.navigate(null);
      assert.deepEqual(selectSidebarSessions(s), { waiting: [], active: [] }, "切走后，未新增活动的旧会话再次隐藏");
    }
    assert.equal(s.sessions.length, 3, "侧栏筛选不得删掉完整注册表中的旧会话");
    assert.equal(requests.filter((request) => request.method === "POST").length, 0, "打开旧会话不得重建或重新导入");
  });
});

await t("历史已释放会话：发送沿用原 id，回显与助手事件刷新 lastActivityAt", async () => {
  const session = oldHistorySession("history-released-send", { released: true });
  await withHistoryNavigation([session], false, async ({ s, requests, sent }) => {
    assert.equal(selectSidebarSessions(s).active.length, 0);
    s.navigateHistory(); s.selectHistory(historyItem(session)); s.navigate(session.id);
    await s.ensureLoaded(session.id);
    assert.deepEqual(selectSidebarSessions(s).active.map((item) => item.id), [session.id]);
    assert.equal(s.sendUserMessage(session.id, "继续旧会话"), true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sessionId, session.id);
    assert.equal(sent[0].text, "继续旧会话");
    assert.equal(requests.filter((request) => request.method === "POST").length, 0, "已释放续接应由发送唤醒原 worker");
    const userAt = new Date(s.now).toISOString();
    const assistantAt = new Date(s.now + 1000).toISOString();
    s.handleFrame({
      ...makeEvent(session.id, 2, "user_message", { text: "继续旧会话", clientRequestId: sent[0].clientRequestId }),
      timestamp: userAt,
    });
    assert.equal(s.session(session.id).lastActivityAt, userAt);
    s.handleFrame({ ...makeEvent(session.id, 3, "agent_text", { text: "已续接" }), timestamp: assistantAt });
    assert.equal(s.session(session.id).lastActivityAt, assistantAt);
    assert.deepEqual(s.sessions.map((item) => item.id), [session.id]);
    assert.equal(s.data.get(session.id).seq, 3);
    assert.equal(s.sendStash.size, 0, "原 id 回显应确认发送");
    // 模拟回合完成后的权威摘要，排除 running 和 currentId 两个保留例外。
    Object.assign(session, { status: "idle", released: false, seq: 3, lastActivityAt: assistantAt });
    await s.refreshSessions();
    s.navigate(null);
    assert.equal(s.session(session.id).status, "idle");
    assert.deepEqual(selectSidebarSessions(s).active.map((item) => item.id), [session.id], "有新活动的旧会话切走后仍常规显示");
  });
});

await t("手机历史导航：旧 dead 会话打开后，后退前进完整恢复预览与历史列表", async () => {
  const session = oldHistorySession("history-mobile-dead", { status: "dead" });
  const item = historyItem(session);
  await withHistoryNavigation([session], true, async ({ s, location, history, requests, flushNavigation }) => {
    assert.deepEqual(selectSidebarSessions(s), { waiting: [], active: [] });
    s.navigateHistory();
    const listEntryId = history.state.workbenchNavigation.id;
    s.selectHistory(item);
    const previewEntry = structuredClone(history.state.workbenchNavigation);
    assert.equal(previewEntry.version, 1);
    assert.equal(previewEntry.route.hash, "#/history");
    assert.deepEqual(previewEntry.route.historySelection, item);
    assert.equal(previewEntry.source.id, listEntryId);
    assert.equal(previewEntry.source.route.historySelection, null);
    s.navigate(session.id);
    await s.ensureLoaded(session.id);
    assert.equal(s.currentId, session.id);
    assert.equal(s.session(session.id).status, "dead");
    assert.deepEqual(selectSidebarSessions(s), { waiting: [], active: [] }, "手机当前打开的 dead 会话也不得进入主列表");
    assert.equal(history.state.workbenchNavigation.route.historyOpen, false);
    assert.equal(history.state.workbenchNavigation.source.id, previewEntry.id);
    assert.deepEqual(history.state.workbenchNavigation.source.route.historySelection, item);
    history.back();
    assert.equal(s.currentId, session.id, "浏览器后退保持异步");
    await flushNavigation();
    assert.equal(location.hash, "#/history");
    assert.equal(s.currentId, null);
    assert.deepEqual(s.historySelection, item);
    assert.equal(history.state.workbenchNavigation.id, previewEntry.id);
    s.backToHistoryList(); await flushNavigation();
    assert.equal(location.hash, "#/history", "列表与预览共享 hash，由 state 区分");
    assert.equal(s.historyOpen, true); assert.equal(s.historySelection, null);
    assert.equal(history.state.workbenchNavigation.id, listEntryId);
    s.historySelection = { ...item, title: "故意清空来源以外的残留状态" };
    history.forward(); await flushNavigation();
    assert.deepEqual(s.historySelection, item, "前进应从 history.state 恢复完整预览");
    history.forward(); await flushNavigation();
    assert.equal(s.currentId, session.id); assert.equal(s.historyOpen, false);
    assert.equal(s.historySelection, null); assert.equal(location.hash, `#/session/${session.id}`);
    assert.deepEqual(selectSidebarSessions(s), { waiting: [], active: [] });
    s.backFromSession(); await flushNavigation();
    assert.deepEqual(s.historySelection, item, "会话内后退也应返回来源预览");
    s.backToHistoryList(); await flushNavigation();
    s.closeSidebarPanel(); await flushNavigation();
    assert.equal(location.hash, "#/"); assert.equal(s.historyOpen, false);
    history.forward(); await flushNavigation();
    assert.equal(s.historyOpen, true); assert.equal(s.historySelection, null);
    assert.equal(requests.filter((request) => request.method === "POST").length, 0, "dead 打开不得自动重建");
  });
});

await t("历史 dead 会话：显式新建续接保留 agent、cwd 和原生会话 id", async () => {
  const session = oldHistorySession("history-dead-resume", { status: "dead" });
  await withHistoryNavigation([session], true, async ({ s, requests }) => {
    s.navigateHistory(); s.selectHistory(historyItem(session)); s.navigate(session.id);
    await s.ensureLoaded(session.id);
    const next = await s.create({ agent: session.agent, cwd: session.cwd, resumeSessionId: session.nativeSessionId });
    s.navigate(next.id); // SessionView 现有「新建会话并续接」入口
    const request = requests.find((item) => item.method === "POST");
    assert.deepEqual(JSON.parse(request.body), { agent: session.agent, cwd: session.cwd, resumeSessionId: session.nativeSessionId });
    assert.equal(s.currentId, next.id);
    assert.equal(s.session(session.id).status, "dead", "显式续接不能覆盖原 dead 记录");
    assert.equal(s.session(next.id).nativeSessionId, session.nativeSessionId);
    assert.ok(s.data.has(next.id), "新建续接返回前快照已就绪");
    assert.deepEqual(selectSidebarSessions(s).active.map((item) => item.id), [next.id], "侧栏只显示新续接会话，原 dead 记录仍可从历史打开");
  });
});

await t("新建会话后立即发送：data 建起、事件按 seq 累积、上行帧写出", async () => {
  const session = makeSession("s-new-1");
  stubFetch(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent); // 私有字段，测试直接写

  const created = await s.create({ agent: "kimi", cwd: "/tmp" });
  // 用户立刻发送：上行帧 + 服务端 echo / 后续事件紧随而来
  s.sendUserMessage(created.id, "hello");
  s.handleFrame(makeEvent(created.id, 1, "user_message"));
  s.handleFrame(makeEvent(created.id, 2));
  await settle();

  assert.ok(
    sent.some((f) => f.type === "user_message" && f.sessionId === created.id && f.text === "hello"),
    "上行 user_message 帧未写出",
  );
  const data = s.data.get(created.id);
  assert.ok(data, "create 返回后 data 没有该会话条目（事件落进「未加载」分支被吞）");
  assert.equal(data.seq, 2, `seq 应推进到 2，实际 ${data.seq}`);
  assert.deepEqual(data.events.map((e) => e.seq), [1, 2], "事件未按 seq 累积");
});

// --- 用例 2：新建会话后等一拍再发送 ---
await t("新建会话后等待再发送：同样通过", async () => {
  const session = makeSession("s-new-2");
  stubFetch(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);

  const created = await s.create({ agent: "kimi", cwd: "/tmp" });
  await settle();
  s.sendUserMessage(created.id, "world");
  s.handleFrame(makeEvent(created.id, 1, "user_message"));
  await settle();

  const data = s.data.get(created.id);
  assert.ok(data, "等待后 data 仍没有该会话条目（首次快照被静默丢弃）");
  assert.equal(data.seq, 1, `seq 应为 1，实际 ${data.seq}`);
  assert.deepEqual(data.events.map((e) => e.seq), [1]);
  assert.ok(sent.some((f) => f.type === "user_message" && f.text === "world"), "上行帧未写出");
});

// --- 用例 3：旧快照晚到不回滚已推进的 seq（finally 所有权校验回归） ---
await t("旧快照晚到不回滚已推进的 seq（in-flight 所有权）", async () => {
  const session = makeSession("s-race");
  const gate = []; // 手动放行的快照响应
  stubFetch(session, gate);
  const s = new Store();

  // A：首次加载；B：resync 发起的新快照（A 的响应应被版本戳作废，且 A 的 finally 不得误删 B 的条目）
  const pA = s.ensureLoaded(session.id);
  assert.equal(gate.length, 1, "A 快照请求未发出");
  const pB = s.resync(session.id);
  assert.equal(gate.length, 2, "B 快照请求未发出");

  // A 先回来（旧快照 seq=2）
  gate[0](envelope({ session, seq: 2, events: [makeEvent(session.id, 1), makeEvent(session.id, 2)] }));
  await pA;
  assert.ok(s.snapshotInflight.has(session.id), "旧请求的 finally 误删了新请求的 in-flight 条目");

  // B 回来（新快照 seq=3）：正常落地
  gate[1](envelope({ session, seq: 3, events: [1, 2, 3].map((n) => makeEvent(session.id, n)) }));
  await pB;
  assert.equal(s.data.get(session.id)?.seq, 3, "新快照未落地");

  // 再来一轮：D（seq=5）先落地，C（seq=4）晚到——不得把状态回滚
  const pC = s.resync(session.id);
  const pD = s.resync(session.id);
  assert.equal(gate.length, 4, "C/D 快照请求未发出");
  gate[3](envelope({ session, seq: 5, events: [1, 2, 3, 4, 5].map((n) => makeEvent(session.id, n)) }));
  await pD;
  gate[2](envelope({ session, seq: 4, events: [1, 2, 3, 4].map((n) => makeEvent(session.id, n)) }));
  await pC;
  const data = s.data.get(session.id);
  assert.equal(data?.seq, 5, `旧快照晚到把 seq 回滚成 ${data?.seq}`);
  assert.equal(data?.events.length, 5, "旧快照晚到改写了事件列表");
});

// --- 用例 4：socket 非 OPEN 时发送不静默——所有发送路径返回 false、不上行、置 lastError ---
// 背景缺陷：send() 在非 OPEN 时丢帧只置 lastError，Composer 却已清空输入框，文本凭空消失。
// store 层契约：发送方法返回 false，UI 据此把文本还回输入框（本用例只测 store 层）。
await t("socket 非 OPEN：sendUserMessage / sendCommand / sendComposerInput 全路径返回失败", async () => {
  const session = makeSession("s-off");
  stubFetch(session);
  const s = new Store();
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: true, mentions: true } } };
  s.commands.set(session.id, [{ name: "help", description: "", source: "kimi" }]);

  // 两种非 OPEN 形态：socket 未建立（null）与已关闭（readyState=CLOSED）
  for (const socket of [null, { readyState: 3, send() { sent.push("不应触达"); } }]) {
    const sent = [];
    s.socket = socket;
    s.lastError = null;

    assert.equal(s.sendUserMessage(session.id, "hi"), false, "sendUserMessage 未返回 false");
    assert.ok(s.lastError, "失败后未置 lastError 提示");
    assert.equal(s.sendCommand(session.id, "help", ""), false, "sendCommand 未返回 false");

    // sendComposerInput 三分支：纯文本 / 命中命令表的结构化 command / mentions 异步路径
    assert.equal(await s.sendComposerInput(session.id, "普通文本"), false, "纯文本分支未返回 false");
    assert.equal(await s.sendComposerInput(session.id, "/help"), false, "结构化命令分支未返回 false");
    // @a.ts 不存在（files 接口未打桩，resolveFile 失败不缓存结论），mentions 为空仍要发出文本
    assert.equal(await s.sendComposerInput(session.id, "看看 @a.ts 这个"), false, "mentions 分支未返回 false");
    assert.equal(sent.length, 0, "非 OPEN 时不应有任何上行帧");
  }

  // 对照：OPEN 时同一调用返回 true 且帧写出
  const sent = [];
  s.socket = fakeSocket(sent);
  assert.equal(s.sendUserMessage(session.id, "hi"), true, "OPEN 时 sendUserMessage 应返回 true");
  assert.equal(await s.sendComposerInput(session.id, "/help"), true, "OPEN 时命令分支应返回 true");
  assert.equal(sent.length, 2, "OPEN 时上行帧未写出");
});

// --- 用例 5：@ 引用尾部标点剥离——整 token 优先，剥后命中才采纳 ---
await t("整 token 命中不剥离（文件名真带标点不冤枉）", async () => {
  const session = makeSession("s-punct-1");
  const queries = [];
  stubFetchFull(session, { knownFiles: ["report，final.txt"], queries });
  const s = new Store();
  const resolved = await s.resolveMentionPath(session.id, "report，final.txt");
  assert.equal(resolved, "report，final.txt", "整 token 命中应原样采用");
  assert.deepEqual(queries, ["report，final.txt"], "整 token 命中后不应再发剥离查询");
});

await t("剥后命中才采纳：句末逗号剥掉后命中真实文件", async () => {
  const session = makeSession("s-punct-2");
  const queries = [];
  stubFetchFull(session, { knownFiles: ["a.ts"], queries });
  const s = new Store();
  const resolved = await s.resolveMentionPath(session.id, "a.ts，");
  assert.equal(resolved, "a.ts", "剥掉尾部逗号后应命中 a.ts");
  assert.deepEqual(queries, ["a.ts，", "a.ts"], "应先查整 token 再查剥离候选");
});

await t("剥到底仍不中维持未找到（结论缓存为 null）", async () => {
  const session = makeSession("s-punct-3");
  stubFetchFull(session, { knownFiles: [] });
  const s = new Store();
  const resolved = await s.resolveMentionPath(session.id, "ghost.txt，。");
  assert.equal(resolved, null, "剥到底仍不中应返回 null");
  assert.equal(s.mentionPathSync(session.id, "ghost.txt，。"), null, "未找到结论应缓存");
});

await t("发送帧 mentions 用生效路径，文本原样保留", async () => {
  const session = makeSession("s-punct-4");
  stubFetchFull(session, { knownFiles: ["a.ts"] });
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: true } } };
  const ok = await s.sendComposerInput(session.id, "看看 @a.ts， 然后");
  assert.equal(ok, true, "OPEN 下应发送成功");
  const frame = sent.find((f) => f.type === "user_message");
  assert.ok(frame, "上行帧未写出");
  assert.equal(frame.text, "看看 @a.ts， 然后", "文本应原样发送（@ 锚点不动）");
  assert.deepEqual(frame.mentions, [{ type: "file", path: "a.ts" }], "mentions 应用剥离后的生效路径");
});

// --- 用例 6：per-session 草稿缓存 ---
await t("草稿按会话隔离：A 存草稿切 B 再切回 A 仍在", async () => {
  const sA = makeSession("s-draft-a");
  const sB = makeSession("s-draft-b");
  stubFetchFull(sA);
  const s = new Store();
  s.setDraft(sA.id, "给 A 的草稿");
  s.setDraft(sB.id, "给 B 的草稿");
  assert.equal(s.getDraft(sB.id), "给 B 的草稿", "B 草稿不对（串台）");
  assert.equal(s.getDraft(sA.id), "给 A 的草稿", "切回 A 草稿丢了");
});

await t("发送成功清草稿（草稿带首尾空白也认得）", async () => {
  const session = makeSession("s-draft-ok");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: false } } };
  s.setDraft(session.id, "  发出去了  ");
  assert.equal(await s.sendComposerInput(session.id, "发出去了"), true, "OPEN 下应发送成功");
  assert.equal(s.getDraft(session.id), "", "发送成功后草稿应清空");
});

await t("发送失败草稿保留", async () => {
  const session = makeSession("s-draft-fail");
  stubFetchFull(session);
  const s = new Store();
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: false } } };
  s.socket = { readyState: 3, send() { throw new Error("不应触达"); } };
  s.setDraft(session.id, "别丢我");
  assert.equal(await s.sendComposerInput(session.id, "别丢我"), false, "非 OPEN 应失败");
  assert.equal(s.getDraft(session.id), "别丢我", "发送失败草稿应保留");
});

await t("发送成功不清掉间隙新输入的草稿", async () => {
  // mentions 路径是异步的：模拟解析间隙用户又输入了新内容
  const session = makeSession("s-draft-race");
  stubFetchFull(session, { knownFiles: ["a.ts"] });
  const s = new Store();
  s.socket = fakeSocket([]);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: true } } };
  s.setDraft(session.id, "@a.ts 看看");
  const p = s.sendComposerInput(session.id, "@a.ts 看看");
  s.setDraft(session.id, "间隙新内容"); // 用户在发送间隙又输入
  assert.equal(await p, true, "OPEN 下应发送成功");
  assert.equal(s.getDraft(session.id), "间隙新内容", "间隙新输入的草稿不应被误清");
});

await t("remove 后草稿清除不泄漏", async () => {
  const session = makeSession("s-draft-rm");
  stubFetchFull(session);
  const s = new Store();
  s.sessions = [session];
  s.socket = fakeSocket([]);
  s.setDraft(session.id, "将随会话删除");
  await s.remove(session.id);
  assert.equal(s.getDraft(session.id), "", "remove 后草稿应清掉");
  assert.equal(s.drafts.has(session.id), false, "drafts 条目应删除");
});

// --- 用例 7：resolvePermission 暴露发送结果（闸门「提交中…」永久卡死的回归防线） ---
// 背景缺陷：resolvePermission 返回 void 丢掉 send() 的结果，UI 先无条件进提交中态——
// 断线瞬间点「允许」帧没发出去、按钮却永久禁用。契约：非 OPEN 返回 false，OPEN 返回 true。
await t("socket 非 OPEN：resolvePermission 返回 false 且不上行；OPEN 返回 true 且帧写出", async () => {
  const s = new Store();
  s.socket = { readyState: 3, send() { throw new Error("不应触达"); } };
  s.lastError = null;
  assert.equal(s.resolvePermission("s-gate", "req-1", "allow"), false, "非 OPEN 应返回 false");
  assert.ok(s.lastError, "失败后未置 lastError 提示");

  const sent = [];
  s.socket = fakeSocket(sent);
  assert.equal(s.resolvePermission("s-gate", "req-1", "deny"), true, "OPEN 应返回 true");
  assert.equal(sent.length, 1, "OPEN 时上行帧未写出");
  assert.equal(sent[0].type, "permission_resolved", "帧类型应为 permission_resolved");
  assert.equal(sent[0].requestId, "req-1");
  assert.equal(sent[0].decision, "deny");
});

// --- K13：删除会话后，旧的列表请求不得把它复活成打不开的残行 ---
await t("refreshSessions 过滤 removed：已删会话不被列表刷新复活", async () => {
  const session = makeSession("s-removed");
  stubFetchFull(session); // /api/sessions 仍返回它（删除前的旧响应 / 服务端尚未生效）
  const s = new Store();
  s.sessions = [session];
  s.socket = fakeSocket([]);
  await s.remove(session.id);
  assert.equal(s.session(session.id), undefined, "remove 后会话应已不在列表");
  await s.refreshSessions();
  assert.equal(s.session(session.id), undefined, "已删会话不得被列表刷新复活");
  assert.equal(s.sessions.length, 0, "列表里不应留下打不开的残行");
});

// --- K15：RC / 后台任务事件只写一遍，且不是原地改旧对象 ---
await t("remote_control_updated / background_tasks_updated：替换列表项，不原地改旧对象", async () => {
  const session = makeSession("s-rc-immutable");
  const s = new Store();
  s.sessions = [session];
  s.data.set(session.id, { events: [makeEvent(session.id, 1)], seq: 1, dropped: 0, pendingGates: new Map() });

  const beforeRc = s.session(session.id);
  s.handleEvent(makeEvent(session.id, 2, "remote_control_updated", { status: "connected", sessionUrl: "https://example.invalid" }));
  const afterRc = s.session(session.id);
  assert.notEqual(afterRc, beforeRc, "RC 事件后应替换列表项引用（selector 才能观察到）");
  assert.equal(beforeRc.remoteControl, undefined, "旧列表项不得被原地改写");
  assert.equal(afterRc.remoteControl?.status, "connected", "RC 状态未落列表项");

  const beforeTasks = s.session(session.id);
  s.handleEvent(makeEvent(session.id, 3, "background_tasks_updated", { tasks: [{ taskId: "t1", status: "running" }] }));
  const afterTasks = s.session(session.id);
  assert.notEqual(afterTasks, beforeTasks, "后台任务事件后应替换列表项引用");
  assert.equal(beforeTasks.backgroundTasks, undefined, "旧列表项不得被原地改写");
  assert.equal(afterTasks.backgroundTasks?.length, 1, "后台任务列表未落列表项");
});

// --- K11①：本地拦掉服务端必拒的发送（有待决闸门 / 配置切换中），文字保留、就地提示 ---
await t("有待决闸门时发送被本地拦下：零上行帧、就地提示、不污染全局错误条", async () => {
  const session = makeSession("s-block-gate");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: false } } };
  s.data.set(session.id, {
    events: [makeEvent(session.id, 1, "permission_request", { requestId: "g1" })],
    seq: 1, dropped: 0, pendingGates: new Map([["g1", 1]]),
  });
  s.lastError = null;
  assert.equal(await s.sendComposerInput(session.id, "闸门还开着"), false, "有待决闸门时本地应拦下");
  assert.equal(sent.length, 0, "被拦时不应有任何上行帧");
  assert.match(s.sendNotices.get(session.id) ?? "", /闸门/, "拦下原因应就地提示");
  assert.equal(s.lastError, null, "本地拦截不应污染全局错误条");
  assert.equal(s.sendCommand(session.id, "help", ""), false, "结构化命令同样应被拦下");
  assert.equal(sent.length, 0, "被拦时命令帧也不应上行");
  // 闸门处理完（permission_resolved）后同一文本可正常发出
  s.handleEvent(makeEvent(session.id, 2, "permission_resolved", { requestId: "g1" }));
  assert.equal(await s.sendComposerInput(session.id, "闸门还开着"), true, "闸门解除后应能发送");
  assert.equal(sent.length, 1, "解除后上行帧应写出");
  assert.equal(s.sendNotices.has(session.id), false, "再次发送后上一次的拦截提示应清除");
});

await t("配置切换中发送被本地拦下；新建会话启动等待不拦", async () => {
  const session = makeSession("s-block-switch");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: false, mentions: false } } };
  s.data.set(session.id, { events: [], seq: 0, dropped: 0, pendingGates: new Map() });
  s.configSwitching.set(session.id, "正在切换模型…");
  assert.equal(await s.sendComposerInput(session.id, "切换中别发"), false, "配置切换中本地应拦下");
  assert.equal(sent.length, 0, "被拦时不应有上行帧");
  assert.match(s.sendNotices.get(session.id) ?? "", /切换/, "拦下原因应就地提示");

  // 新建会话启动等待不是拒因（服务端会等启动完成再发），本地不得拦
  const starting = { ...makeSession("s-block-starting"), status: "starting" };
  const s2 = new Store();
  const sent2 = [];
  s2.socket = fakeSocket(sent2);
  s2.sessions = [starting];
  s2.meta = { drivers: { kimi: { commands: false, mentions: false } } };
  s2.data.set(starting.id, { events: [], seq: 0, dropped: 0, pendingGates: new Map() });
  assert.equal(await s2.sendComposerInput(starting.id, "首发"), true, "启动等待不应被本地拦截");
  assert.equal(sent2.length, 1, "启动等待时上行帧应写出");
});

// --- K11②：user_message 带 clientRequestId 暂存；ack 丢弃；error 还回；回显兜底丢弃 ---
await t("上行帧带 clientRequestId 并暂存；ack 回执丢弃暂存", async () => {
  const session = makeSession("s-crid-ack");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  assert.equal(s.sendUserMessage(session.id, "hello"), true);
  const frame = sent.find((f) => f.type === "user_message");
  assert.ok(typeof frame.clientRequestId === "string" && frame.clientRequestId, "上行帧必须带 clientRequestId");
  assert.equal(s.sendStash.size, 1, "发送后应有一条暂存");
  s.handleFrame({ type: "ack", sessionId: session.id, action: "user_message", clientRequestId: frame.clientRequestId });
  assert.equal(s.sendStash.size, 0, "ack 回执应丢弃对应暂存");
  // 未知 id 的 ack / 重复 ack：静默忽略不抛错
  s.handleFrame({ type: "ack", sessionId: session.id, action: "user_message", clientRequestId: "no-such-id" });
});

await t("服务端带 id 的 error：文字写回草稿并发布还回请求，错误仍告知用户", async () => {
  const session = makeSession("s-crid-error");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.sendUserMessage(session.id, "别丢我");
  const { clientRequestId } = sent[0];
  assert.equal(s.getDraft(session.id), "", "发送后草稿本已清空");
  s.handleFrame({
    type: "error", code: 40003, sessionId: session.id, action: "user_message",
    msg: "会话有待处理的审批闸门，处理后才能发送或插话", clientRequestId,
  });
  assert.equal(s.sendStash.size, 0, "error 后暂存应丢弃");
  assert.equal(s.getDraft(session.id), "别丢我", "被拒文本应写回草稿");
  assert.equal(s.sendTextRestore?.sessionId, session.id, "应发布输入框还回请求");
  assert.equal(s.sendTextRestore?.text, "别丢我", "还回文本应为被拒原文");
  assert.equal(s.lastError?.message, "会话有待处理的审批闸门，处理后才能发送或插话", "拒绝原因仍应告知用户");
  assert.equal(s.lastError?.sessionId, session.id, "错误应带会话上下文");
  const { version } = s.sendTextRestore;
  assert.deepEqual(s.consumeSendTextRestore(version), { text: "别丢我", mentions: [] }, "Composer 应能消费完整还回请求");
  assert.equal(s.consumeSendTextRestore(version), null, "还回请求只能消费一次");
  assert.equal(s.sendTextRestore, null, "消费后还回请求应清空");
});

await t("发送间隙用户新打的字不被覆盖：草稿不动、不发布还回", async () => {
  const session = makeSession("s-crid-race");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.sendUserMessage(session.id, "旧文本", [{ type: "image", path: "/uploads/old.png", mimeType: "image/png", name: "旧附件.png" }]);
  const { clientRequestId } = sent[0];
  s.setDraft(session.id, "间隙新打的");
  s.handleFrame({ type: "error", code: 40003, sessionId: session.id, action: "user_message", msg: "boom", clientRequestId });
  assert.equal(s.getDraft(session.id), "间隙新打的", "间隙新草稿不得被被拒原文覆盖");
  assert.equal(s.sendTextRestore, null, "间隙有输入时不应发布还回请求");
  assert.equal(s.sendStash.size, 0, "error 后暂存仍应丢弃");
  assert.equal(s.lastError?.message, "boom", "拒绝原因仍应告知用户");
});

await t("同会话 user_message 回显只按请求 id 丢弃暂存，无 id 的同文本不能确认", async () => {
  const session = makeSession("s-crid-echo");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.sendUserMessage(session.id, "回显我");
  s.sendUserMessage(session.id, "回显我"); // 同文本第二条：只许丢弃最早一条
  assert.equal(s.sendStash.size, 2);
  s.handleFrame(makeEvent(session.id, 1, "user_message", { text: "回显我" }));
  assert.equal(s.sendStash.size, 2, "无请求 id 的回显不能按相同文本清暂存");
  s.handleFrame(makeEvent(session.id, 2, "user_message", { text: "回显我", clientRequestId: sent[0].clientRequestId }));
  assert.equal(s.sendStash.size, 1, "只应丢弃 id 匹配的暂存");
  const firstAck = { type: "ack", sessionId: session.id, action: "user_message", clientRequestId: sent[0].clientRequestId };
  s.handleFrame(firstAck); // 迟到/重复的 ack：暂存已被回显收走，静默忽略
  // 剩下的那条被 error 拒掉：仍能按 id 还回
  s.handleFrame({ type: "error", code: 40003, sessionId: session.id, action: "user_message", msg: "x", clientRequestId: sent[1].clientRequestId });
  assert.equal(s.getDraft(session.id), "回显我", "剩余暂存被拒后应写回草稿");
  // 已被回显收走的暂存再被拒：不还回（服务端已受理过）
  s.clearDraft(session.id);
  s.handleFrame({ type: "error", code: 40003, sessionId: session.id, action: "user_message", msg: "x", clientRequestId: sent[0].clientRequestId });
  assert.equal(s.getDraft(session.id), "", "已受理消息的迟到 error 不应还回文本");
});

await t("按 action 归因：set_config 失败仍归配置控件，user_message 错误进全局条", async () => {
  const session = makeSession("s-crid-config");
  stubFetchFull(session);
  const s = new Store();
  s.socket = fakeSocket([]);
  s.sessions = [session];
  s.configPending.set(session.id, new Set(["model"]));
  s.handleFrame({ type: "error", sessionId: session.id, action: "set_config", msg: "bad config" });
  assert.equal(s.configErrors.get(session.id), "bad config", "配置失败应落在配置控件旁");
  assert.equal(s.lastError, null, "配置失败不应进全局错误条");
  assert.equal(s.sendTextRestore, null, "配置失败不应触发文本还回");
  // configPending 挂起期间，别的动作的报错不得再误归配置控件
  s.clearConfigError(session.id);
  s.configPending.set(session.id, new Set(["model"]));
  s.handleFrame({ type: "error", sessionId: session.id, action: "user_message", msg: "会话有待处理的审批闸门" });
  assert.equal(s.configErrors.has(session.id), false, "user_message 错误不得落配置控件");
  assert.equal(s.lastError?.message, "会话有待处理的审批闸门", "user_message 错误应进全局错误条");
  assert.equal(s.configPending.has(session.id), true, "非配置错误不应解除配置发送中状态");
});

await t("remove 清空该会话的发送暂存与就地提示", async () => {
  const session = makeSession("s-crid-remove");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.sendUserMessage(session.id, "将随会话删除");
  s.sendNotices.set(session.id, "x");
  await s.remove(session.id);
  assert.equal(s.sendStash.size, 0, "remove 后发送暂存应清空");
  assert.equal(s.sendNotices.has(session.id), false, "remove 后就地提示应清空");
  // 迟到的拒绝帧：会话已删，静默忽略（不还原、不报错）
  s.handleFrame({ type: "error", code: 40003, sessionId: session.id, action: "user_message", msg: "x", clientRequestId: sent[0].clientRequestId });
  assert.equal(s.getDraft(session.id), "", "已删会话的迟到 error 不应还回文本");
});

// --- 返工 2：逐条复现 R-review-findings 第 5–7 项 ---
await t("K11复核5：结构化 /compact note 被拒后恢复原命令草稿", async () => {
  const session = makeSession("s-review-command");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  s.meta = { drivers: { kimi: { commands: true, mentions: false } } };
  s.commands.set(session.id, [{ name: "compact", description: "", source: "kimi" }]);
  const original = "/compact   note  ";
  s.setDraft(session.id, original);
  assert.equal(await s.sendComposerInput(session.id, original), true);
  assert.deepEqual(sent[0].command, { name: "compact", arguments: "note" });
  assert.equal(s.getDraft(session.id), "", "上行后原草稿已清空");
  s.handleFrame({ type: "error", sessionId: session.id, action: "user_message", clientRequestId: sent[0].clientRequestId, msg: "原生检查中" });
  assert.equal(s.getDraft(session.id), original, "拒绝后应恢复包括原空格在内的命令输入");
  assert.ok(sent[0].clientRequestId);
  assert.equal(s.sendTextRestore?.text, original);
  assert.equal(sent.length, 1, "恢复不能自动重发");
});

await t("K11复核6：同文本历史重复帧不能误删待确认的新发送", async () => {
  const session = makeSession("s-review-old-echo");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  const old = makeEvent(session.id, 1, "user_message", { text: "重复发送的文字" });
  s.applySnapshot(session.id, session, 1, [old]);
  assert.equal(s.sendUserMessage(session.id, old.payload.text), true);
  s.handleFrame(old);
  assert.equal(s.data.get(session.id).seq, 1, "旧帧应被 seq 去重");
  s.handleFrame({ type: "error", sessionId: session.id, action: "user_message", clientRequestId: sent[0].clientRequestId, msg: "发送被拒" });
  assert.equal(s.getDraft(session.id), old.payload.text, "旧帧不应阻断新发送的拒绝恢复");
  assert.equal(s.sendTextRestore?.text, old.payload.text);
  assert.equal(sent.length, 1);
});

await t("K11复核7：纯图片与文件引用被拒后完整交还 mentions，不自动重发", async () => {
  for (const [suffix, text, mentions] of [
    ["image", "", [{ type: "image", path: "/uploads/picture.png", mimeType: "image/png", name: "截图.png" }]],
    ["files", "看看 @notes.txt", [{ type: "file", path: "notes.txt" }, { type: "file", path: "/uploads/report.pdf", name: "报告.pdf" }]],
  ]) {
    const session = makeSession(`s-review-mentions-${suffix}`);
    stubFetchFull(session, { knownFiles: ["notes.txt"] });
    const sent = [];
    const s = new Store();
    s.socket = fakeSocket(sent);
    s.sessions = [session];
    s.meta = { drivers: { kimi: { commands: false, mentions: true } } };
    s.setDraft(session.id, text);
    assert.equal(await s.sendComposerInput(session.id, text, mentions), true);
    const frame = sent[0];
    assert.deepEqual(frame.mentions, mentions);
    s.handleFrame({ type: "error", sessionId: session.id, action: "user_message", clientRequestId: frame.clientRequestId, msg: "拒绝附件发送" });
    assert.deepEqual(s.sendTextRestore?.mentions, mentions, "暂存引用不能在发布恢复时丢失");
    const version = s.sendTextRestore.version;
    assert.deepEqual(s.consumeSendTextRestore(version), { text, mentions });
    assert.equal(s.consumeSendTextRestore(version), null, "附件恢复只能消费一次");
    assert.equal(sent.length, 1, "纯图片恢复也不能自动发送");
  }
});

await t("K11复核7：输入框恢复引用为 ready 附件，保留上传中附件且不覆盖新文字", async () => {
  globalThis.React = (await import("react")).default;
  const { restoreComposerInput } = await import("../src/components/SessionView.tsx");
  assert.equal(typeof restoreComposerInput, "function", "输入框应有可核验的完整恢复入口");
  const current = [
    { id: "uploading", source: "upload", name: "还在上传.pdf", status: "uploading" },
    { id: "existing", source: "local", name: "已有.pdf", status: "ready", path: "/uploads/existing.pdf" },
  ];
  const restore = { version: 3, text: "被拒原文", mentions: [
    { type: "file", path: "/uploads/existing.pdf", name: "已有.pdf" },
    { type: "image", path: "/uploads/screenshot.png", mimeType: "image/png", name: "截图.png" },
    { type: "file", path: "notes.txt" },
  ] };
  const plan = restoreComposerInput("", current, restore);
  assert.equal(plan.text, restore.text);
  assert.deepEqual(plan.attachments.slice(0, 2), current, "原上传中和已有附件不能丢失");
  assert.equal(plan.attachments.length, 4, "相同路径去重");
  assert.equal(plan.attachments[2].status, "ready");
  assert.equal(plan.attachments[2].path, restore.mentions[1].path);
  assert.equal(plan.attachments[2].mimeType, "image/png");
  const { attachmentMention } = await import("../src/attachments.ts");
  assert.deepEqual(attachmentMention(plan.attachments[2]), restore.mentions[1], "恢复的图片引用仍可再次手动发送");
  assert.equal(restoreComposerInput("新打的内容", current, restore), null, "输入框已有文字时附件与文字都不写回");
  const imageOnly = restoreComposerInput("", [], { ...restore, text: "", mentions: [restore.mentions[1]] });
  assert.equal(imageOnly.text, "");
  assert.deepEqual(attachmentMention(imageOnly.attachments[0]), restore.mentions[1]);
});

await t("K11复核：重复文本只确认指定请求，旧 seq 与其他会话不能清暂存", async () => {
  const session = makeSession("s-review-exact-echo");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.applySnapshot(session.id, session, 1, [makeEvent(session.id, 1, "user_message", { text: "相同" })]);
  s.sendUserMessage(session.id, "相同");
  s.sendUserMessage(session.id, "相同");
  const first = sent[0].clientRequestId, second = sent[1].clientRequestId;
  s.handleFrame(makeEvent(session.id, 1, "user_message", { text: "相同", clientRequestId: second }));
  assert.equal(s.sendStash.size, 2, "旧 seq 即便带 id 也不能确认当前发送");
  s.handleFrame(makeEvent("other-session", 1, "user_message", { text: "相同", clientRequestId: second }));
  assert.equal(s.sendStash.size, 2, "别的会话不能清理当前会话暂存");
  s.handleFrame(makeEvent(session.id, 2, "user_message", { text: "相同", clientRequestId: second }));
  assert.equal(s.sendStash.has(second), false);
  assert.equal(s.sendStash.has(first), true, "不能因为同文本误删更早的另一条暂存");
  s.handleFrame({ type: "ack", sessionId: "other-session", action: "user_message", clientRequestId: first });
  s.handleFrame({ type: "ack", sessionId: session.id, action: "set_config", clientRequestId: first });
  assert.equal(s.sendStash.has(first), true, "非本会话或非发送动作的回执不能确认");
  s.handleFrame({ type: "ack", sessionId: session.id, action: "user_message", clientRequestId: first });
  assert.equal(s.sendStash.size, 0);
});

await t("K11复核：直接发送命令被拒可恢复，断线失败不暂存", async () => {
  const session = makeSession("s-review-direct-command");
  stubFetchFull(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  assert.equal(s.sendCommand(session.id, "compact", "note"), true);
  s.handleFrame({ type: "error", sessionId: session.id, action: "user_message", clientRequestId: sent[0].clientRequestId, msg: "启动失败" });
  assert.equal(s.getDraft(session.id), "/compact note");
  assert.equal(s.sendStash.size, 0);
  s.clearDraft(session.id);
  s.socket.readyState = WebSocket.CLOSED;
  assert.equal(s.sendCommand(session.id, "compact", "again"), false);
  assert.equal(s.sendStash.size, 0, "socket 未接收的命令没有待确认暂存");
  assert.equal(sent.length, 1, "被拒或断线都不能自动重发");
});

await import("./snapshot-paging.test.mjs");
await import("./session-organization-flow.test.mjs");
if (!process.exitCode) console.log(`✅ store 流程回归全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
// store 内部有 2s 防抖计时器，直接退出不等它
process.exit(process.exitCode ?? 0);
