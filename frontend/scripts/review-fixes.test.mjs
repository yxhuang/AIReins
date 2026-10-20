import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformWithOxc } from "vite";
import { Store } from "../src/store.ts";
import { createRenderItemsBuilder } from "../src/render-items.ts";
import { selectSidebarSections, selectProjectSessions } from "../src/sidebar-sessions.ts";
import { fetchFiles } from "../src/api.ts";

globalThis.WebSocket = { OPEN: 1 };
const now = Date.parse("2026-10-19T10:00:00Z");
const session = (id) => ({ id, agent: "claude", agentId: id, cwd: "/tmp", status: "idle", config: {}, seq: 0,
  title: id, pendingGateCount: 0, createdAt: new Date(now).toISOString(), lastActivityAt: new Date(now).toISOString() });
const event = (id, seq, type, payload = {}, ms = 0) => ({ sessionId: id, agentId: id, seq, type, payload, timestamp: new Date(now + ms).toISOString() });
const envelope = (data) => ({ json: async () => ({ code: 0, data }) });
const snapshot = (id, events = [], hasMore = true) => ({ session: { ...session(id), seq: events.at(-1)?.seq ?? 0 },
  seq: events.at(-1)?.seq ?? 0, events, hasMore, firstSeq: events[0]?.seq ?? 0 });
const originalFetch = globalThis.fetch;
const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
const timers = new Map();
let timerId = 0;
globalThis.setTimeout = (fn) => { timers.set(++timerId, fn); return timerId; };
globalThis.clearTimeout = (id) => timers.delete(id);
try {
  const s = new Store();
  s.sessions = ["a", "b", "c", "d", "e", "f"].map(session);
  const requests = [];
  const snapshots = new Map();
  let pageRelease;
  globalThis.fetch = (path) => {
    requests.push(path);
    const id = String(path).split("/")[3];
    if (path.endsWith("/commands")) return Promise.resolve(envelope({ commands: [] }));
    if (path.includes("/events?")) return new Promise(resolve => { pageRelease = resolve; });
    if (snapshots.has(id)) return new Promise(resolve => snapshots.get(id).push(resolve));
    return Promise.resolve(envelope(snapshot(id, [event(id, 1, "permission_request", { requestId: `${id}-gate` })])));
  };
  s.currentId = "a";
  for (const id of ["a", "b", "c", "d"]) await s.ensureLoaded(id);
  // 最近访问顺序为 a/c/d/b；当前 a 即使最旧也不得淘汰。
  await s.ensureLoaded("b");
  const older = s.loadOlder("c");
  snapshots.set("c", []);
  const staleSnapshot = s.resync("c");
  const staleRelease = snapshots.get("c")[0];
  s.replayBuffers.set("c", [event("c", 2, "permission_request", { requestId: "buffered" })]);
  s.handleEvent(event("c", 3, "permission_resolved", { requestId: "c-gate" }));
  s.configPending.set("b", new Set(["model"]));
  s.configSwitching.set("b", "switching");
  s.sendStash.set("sent-c", { sessionId: "c", text: "restore after eviction", mentions: [] });
  await s.ensureLoaded("e");
  assert.equal(s.data.has("b"), true, "配置切换未落定的会话暂不淘汰");
  s.configPending.delete("b");
  s.configSwitching.delete("b");
  await s.ensureLoaded("e");
  s.configPending.set("c", new Set(["model"]));
  s.configSwitching.set("c", "switching");
  assert.equal(s.data.size, 4);
  assert.equal(s.data.has("a"), true);
  assert.equal(s.data.has("c"), false, "淘汰最近访问之外的后台会话");
  assert.equal(s.pendingCount("c"), 1, "缓冲中的请求与回执以未加载路径合并摘要");
  for (const map of [s.snapshotInflight, s.snapshotGen, s.snapshotBuffers, s.replayBuffers, s.olderInflight, s.commands]) {
    assert.equal(map.has("c"), false);
  }
  assert.equal(s.sendStash.has("sent-c"), true, "发送暂存独立于事件缓存");
  s.handleFrame({ type: "resync_required", sessionId: "c" });
  s.handleFrame({ type: "replay_complete", sessionId: "c" });
  assert.equal(snapshots.get("c").length, 1, "已淘汰会话不会因迟到控制帧重新加载");
  s.handleEvent(event("c", 4, "permission_request", { requestId: "new" }));
  s.handleEvent(event("c", 4, "permission_request", { requestId: "new" }));
  assert.equal(s.pendingCount("c"), 2, "摘要 seq 去重");
  s.handleFrame({ type: "error", clientRequestId: "sent-c", action: "user_message", sessionId: "c", msg: "rejected" });
  assert.equal(s.getDraft("c"), "restore after eviction");
  assert.equal(s.sendStash.size, 0);
  s.handleEvent(event("c", 5, "session_error", { message: "switch failed" }));
  assert.equal(s.configSwitching.has("c"), false);
  assert.equal(s.configPending.has("c"), false);
  assert.equal(s.configErrors.get("c"), "switch failed");
  s.configSwitching.set("c", "next switch");
  s.handleEvent(event("c", 5, "session_error", { message: "stale duplicate" }));
  assert.equal(s.configSwitching.get("c"), "next switch", "已淘汰会话也在副作用前去重");
  // 重新打开时旧快照与旧页先到，均不能取消/污染新的加载。
  s.currentId = "c";
  const reopened = s.ensureLoaded("c");
  const newInflight = s.snapshotInflight.get("c");
  staleRelease(envelope(snapshot("c")));
  pageRelease(envelope({ events: [], hasMore: false, firstSeq: 0 }));
  await Promise.all([staleSnapshot, older]);
  assert.equal(s.data.has("c"), false);
  assert.equal(s.snapshotInflight.get("c"), newInflight);
  snapshots.get("c")[1](envelope(snapshot("c", [event("c", 4, "permission_request", { requestId: "authoritative" }), event("c", 5, "session_error")])));
  await reopened;
  assert.equal(s.pendingCount("c"), 1);
  assert.equal(s.data.size, 4);
  assert.equal(requests.filter(path => path === "/api/sessions/c/snapshot?tail=1").length, 3);

  // 首次快照尚未落地也占预算；被淘汰的失败响应不产生全局错误或事件缓存。
  const loading = new Store();
  loading.sessions = ["a", "b", "c", "d", "e"].map(session);
  const releases = [];
  globalThis.fetch = () => new Promise((resolve, reject) => releases.push({ resolve, reject }));
  const pending = ["a", "b", "c", "d", "e"].map(id => loading.ensureLoaded(id));
  assert.equal(loading.snapshotInflight.size, 4);
  assert.equal(loading.snapshotBuffers.has("a"), false);
  releases[0].reject(new Error("stale failure"));
  await pending[0];
  assert.equal(loading.lastError, null);
  assert.equal(loading.data.has("a"), false);
  // 全部候选都在切换配置时暂超预算；落定事件到达后立即收敛。
  const settling = new Store();
  settling.sessions = ["a", "b", "c", "d", "e", "f"].map(session);
  globalThis.fetch = (path) => Promise.resolve(envelope(String(path).endsWith("/commands") ? { commands: [] } : snapshot(String(path).split("/")[3])));
  settling.currentId = "a";
  for (const id of ["a", "b", "c", "d"]) await settling.ensureLoaded(id);
  for (const id of ["b", "c", "d"]) { settling.configPending.set(id, new Set(["model"])); settling.configSwitching.set(id, "switching"); }
  await settling.ensureLoaded("e");
  assert.equal(settling.data.size, 5, "切换中的会话暂不淘汰");
  settling.handleEvent(event("b", 1, "config_updated", { config: {} }));
  assert.equal(settling.configPending.has("b"), false);
  assert.equal(settling.data.size, 4, "配置落定后立即回到预算");
  // 只有 configPending 的请求经 WS error 失败，也要收敛。
  settling.configSwitching.delete("c");
  settling.configPending.set("e", new Set(["model"]));
  await settling.ensureLoaded("f");
  assert.equal(settling.data.size, 5);
  settling.handleFrame({ type: "error", sessionId: "c", action: "set_config", msg: "bad value" });
  assert.equal(settling.configErrors.get("c"), "bad value");
  assert.equal(settling.data.size, 4, "WS 配置错误解除保护后回到预算");
  console.log("✅ cache budget: current/LRU, buffered gates, stale snapshot/page, reopen, send restore, in-flight budget, config settle");

  const stream = new Store();
  stream.applySnapshot("s", session("s"), 0, [], false, 0);
  const initial = stream.sessions;
  const listCalls = [];
  stream.scheduleListRefresh = () => listCalls.push(1);
  for (let seq = 1; seq <= 40; seq++) {
    stream.handleEvent(event("s", seq, ["agent_text_delta", "thought_delta", "tool_call_updated", "raw_event"][seq % 4], {}, seq * 10));
  }
  assert.equal(stream.sessions, initial, "秒内纯流式增量保持数组与行引用");
  assert.equal(stream.session("s").seq, 40, "seq 仍即时推进");
  assert.equal(listCalls.length, 0, "纯流式不触发完整列表刷新");
  stream.handleEvent(event("s", 41, "agent_text_delta", {}, 1000));
  assert.notEqual(stream.sessions, initial);
  assert.equal(stream.session("s").lastActivityAt, new Date(now + 1000).toISOString());
  globalThis.fetch = async () => envelope({ sessions: [{ ...session("s"), status: "dead" }] });
  await stream.refreshSessions();
  assert.equal(stream.session("s").seq, 41);
  assert.equal(stream.session("s").status, "idle", "旧列表不能覆盖较新 WS 摘要");
  stream.handleEvent(event("s", 42, "permission_request", { requestId: "gate" }));
  assert.equal(stream.pendingCount("s"), 1);
  assert.equal(listCalls.length, 1);
  stream.handleEvent(event("unknown", 1, "raw_event"));
  assert.equal(listCalls.length, 2, "未知会话仍请求列表");

  const counted = new Store();
  counted.sessions = [session("unloaded"), { ...session("dead"), status: "dead", pendingGateCount: 9 }, session("loaded")];
  counted.sessions[0].pendingGateCount = 2;
  counted.applySnapshot("loaded", session("loaded"), 1, [event("loaded", 1, "permission_request", { requestId: "gate" })]);
  assert.equal(counted.sessions.reduce((sum, item) => sum + counted.pendingCountFor(item), 0), 3);
  counted.session = () => { throw new Error("聚合不应重复按 id 查询"); };
  assert.equal(counted.sessions.reduce((sum, item) => sum + counted.pendingCountFor(item), 0), 3);
  const indexed = new Store();
  indexed.sessions = [session("old")];
  assert.equal(indexed.session("old"), indexed.sessions[0]);
  const replacement = { ...session("new"), seq: 10 };
  indexed.sessions = [replacement];
  assert.equal(indexed.session("old"), undefined);
  assert.equal(indexed.session("new"), replacement);
  replacement.seq++;
  assert.equal(indexed.session("new").seq, 11);
  indexed.sessions.push(session("added"));
  assert.equal(indexed.session("added"), indexed.sessions[1], "兼容公开数组的追加");

  const sorted = Array.from({ length: 100 }, (_, i) => ({ ...session(String(i)), lastActivityAt: new Date(now - i * 1000).toISOString() }));
  const realParse = Date.parse;
  let parses = 0;
  Date.parse = (text) => { parses++; return realParse(text); };
  try {
    const value = { sessions: sorted, now, currentId: null, projectOrder: [], pendingCount: () => 0 };
    assert.equal(selectSidebarSections(value).projects[0].sessions[0].id, "0");
    selectProjectSessions(sorted, { ...value, expanded: true, searching: false });
    assert.equal(parses, sorted.length, "同一摘要的排序/筛选共享解析结果");
  } finally { Date.parse = realParse; }
  console.log("✅ stream summaries/list refresh, pending aggregation/index and cached activity sorting");

  const toolStore = new Store();
  const events = Array.from({ length: 3000 }, (_, i) => event("t", i + 1, "user_message", { text: `turn ${i}` }));
  events.push(event("t", 3001, "tool_call_started", { toolCallId: "one", toolName: "Bash" }),
    event("t", 3002, "tool_call_started", { toolCallId: "two", toolName: "Bash" }),
    event("t", 3003, "agent_text_delta", { text: "tail" }));
  toolStore.applySnapshot("t", session("t"), 3003, events, false, 1);
  const builder = createRenderItemsBuilder("claude");
  const data = toolStore.data.get("t");
  const persistent = builder.update(data.events);
  const prefix = builder.prefixVersion;
  const shown = builder.display(false, "/tmp");
  const stableFirst = shown[0];
  for (let i = 0; i < 25; i++) {
    toolStore.handleEvent({ ...event("t", 9000, "tool_call_updated", { toolCallId: "one", partialInput: `cmd ${i}` }), ephemeral: true });
    const current = toolStore.data.get("t");
    assert.equal(current.events, data.events);
    assert.equal(builder.update(current.events), persistent);
    assert.equal(builder.display(false, "/tmp", current.toolFrames), shown);
    assert.equal(builder.prefixVersion, prefix, "临时帧不重建持久前缀");
    assert.equal(shown[0], stableFirst);
    assert.equal(shown[3000].input, `cmd ${i}`);
    assert.deepEqual(builder.changedDisplayIndices, [3000], "非尾部工具也只重绘对应行");
  }
  builder.display(true, "/tmp", toolStore.data.get("t").toolFrames);
  assert.deepEqual(builder.changedDisplayIndices, [], "专注视图隐藏的工具不产生目标行");
  builder.display(false, "/tmp", toolStore.data.get("t").toolFrames);
  toolStore.data.get("t").toolFrames.clear();
  builder.display(false, "/tmp", toolStore.data.get("t").toolFrames);
  assert.equal(shown[0], stableFirst);
  assert.equal(builder.display(false, "/tmp")[3000].input, "", "移除临时帧后还原持久参数");
  assert.equal(persistent[3000].input, "", "预览不修改持久 builder 结果");
  toolStore.handleEvent(event("t", 3004, "tool_call_updated", { toolCallId: "one", input: { command: "final" }, inputComplete: true }));
  toolStore.handleEvent({ ...event("t", 9999, "tool_call_updated", { toolCallId: "one", partialInput: "LATE" }), ephemeral: true });
  assert.equal(toolStore.data.get("t").toolFrames.has("one"), false);
  builder.update(data.events);
  assert.match(builder.display(false, "/tmp", toolStore.data.get("t").toolFrames)[3000].input, /final/);
  toolStore.handleEvent(event("t", 3005, "tool_call_completed", { toolCallId: "two", result: "done" }));
  toolStore.handleEvent({ ...event("t", 9999, "tool_call_updated", { toolCallId: "two", partialInput: "LATE" }), ephemeral: true });
  assert.equal(toolStore.data.get("t").toolFrames.has("two"), false);
  console.log("✅ ephemeral tools: stable event/reducer/display prefix, targeted rows, final input and completed guard");

  // 直接执行组件现用的 effect（仅打桩 hooks/timer），覆盖新查询、关闭和卸载的 cleanup。
  const view = readFileSync(new URL("../src/components/SessionView.tsx", import.meta.url), "utf8");
  const start = view.indexOf("  useEffect(() => {", view.indexOf("// @ 检索：250ms"));
  const end = view.indexOf("}, [mentionOpen, mentionQuery, session.id]);", start) + "}, [mentionOpen, mentionQuery, session.id]);".length;
  // Node 22.12（最低支持版本）没有 module.stripTypeScriptTypes，改用 Vite 自带的 Oxc 去类型。
  const effect = (await transformWithOxc(view.slice(start, end), "effect.ts")).code;
  const runEffect = new Function("useEffect", "searchSeq", "setFiles", "setFilesError", "setFilesLoading", "mentionOpen", "mentionQuery", "session", "fetchFiles", "store", effect);
  let cleanup, files, error, loadingState, noted = 0;
  const requestsForFiles = [];
  globalThis.fetch = (_path, init) => new Promise((resolve, reject) => {
    requestsForFiles.push({ signal: init.signal, resolve });
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  });
  const searchSeq = { current: 0 };
  const run = (open, query) => runEffect(fn => { cleanup = fn(); }, searchSeq, list => { files = list; }, value => { error = value; },
    value => { loadingState = value; }, open, query, session("files"), fetchFiles, { noteFiles() { noted++; } });
  const fire = () => { const id = timerId; const fn = timers.get(id); timers.delete(id); fn(); };
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  run(true, "old"); fire(); cleanup();
  assert.equal(requestsForFiles[0].signal.aborted, true);
  run(true, "new"); fire(); await flush();
  assert.equal(error, null, "取消旧查询不会显示错误");
  assert.equal(loadingState, true, "旧 catch 不得清除新查询加载态");
  requestsForFiles[1].resolve(envelope({ files: ["new.ts"] }));
  await flush();
  assert.deepEqual(files, ["new.ts"]); assert.equal(noted, 1);
  cleanup(); run(true, "unmount"); fire(); cleanup(); await flush();
  assert.equal(requestsForFiles[2].signal.aborted, true);
  run(true, "debounced"); cleanup();
  run(false, "closed");
  assert.equal(cleanup, undefined);
  assert.equal(requestsForFiles.length, 3, "防抖未到或面板关闭时不发送请求");
  console.log("✅ file completion: real effect/API signals, query replacement, late abort, close, debounce and unmount");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSet;
  globalThis.clearTimeout = originalClear;
}
