// 目录选择器、搜索与删除导航均使用合成会话，不访问真实用户配置。
import { strict as assert } from "node:assert";
import { selectSidebarSections, selectProjectSessions, projectDisplayPath, SIDEBAR_RECENT_WINDOW_MS } from "../src/sidebar-sessions.ts";
import { Store } from "../src/store.ts";
import { sessionTitle } from "../src/format.ts";
const now = Date.parse("2026-10-16T12:00:00Z");
const session = (id, cwd, age = 0, extra = {}) => ({ id, cwd, agent: "claude", status: "idle", config: {}, seq: 0,
  title: id, createdAt: new Date(now - age).toISOString(), lastActivityAt: new Date(now - age).toISOString(), ...extra });
const value = (sessions, extra = {}) => ({ sessions, now, currentId: null, projectOrder: [], pendingCount: () => 0, ...extra });
let passed = 0;
async function check(name, fn) {
  const fetch = globalThis.fetch;
  try { await fn(); passed++; }
  catch (error) { console.error(`❌ ${name}\n   ${error.stack}`); process.exitCode = 1; }
  finally { globalThis.fetch = fetch; }
}
await check("目录键规范化且保留大小写、父目录与子目录各自独立", () => {
  const result = selectSidebarSections(value([
    session("first", "/repo//paper/./"), session("second", "/repo/paper"),
    session("capital", "/repo/Paper"), session("parent", "/repo"), session("root", "//./"),
  ]));
  assert.deepEqual(result.projects.map(project => project.path), ["/repo/paper", "/repo/Paper", "/repo", "/"]);
  assert.deepEqual(result.projects[0].sessions.map(session => session.id), ["first", "second"]);
});
await check("链接工作树会话归到主仓库目录", () => {
  const result = selectSidebarSections(value([
    session("main", "/repo"), session("wt", "/tmp/wt-fix", 1, { worktree: { root: "/repo", branch: "fix" } }),
  ]));
  assert.deepEqual(result.projects.map(project => [project.path, project.sessions.map(session => session.id)]), [["/repo", ["main", "wt"]]]);
});
await check("服务端目录顺序优先且隐藏目录不占可见位置，异常未登记目录临时置前", () => {
  const input = value([session("a-old", "/a", 20), session("b", "/b", 1), session("a-new", "/a", 0), session("c", "/c", 3)],
    { projectOrder: ["/hidden", "/a", "/b"] });
  const result = selectSidebarSections(input);
  assert.deepEqual(result.projects.map(project => project.path), ["/c", "/a", "/b"]);
  assert.deepEqual(result.projects[1].sessions.map(session => session.id), ["a-new", "a-old"]);
  assert.deepEqual(input.projectOrder, ["/hidden", "/a", "/b"]);
});
await check("同名目录用最短父级消歧，home 显示 ~，Windows 路径仅转换显示", () => {
  const result = selectSidebarSections(value([
    session("one", "/teaching/paper"), session("two", "/research/paper"),
    session("deep-one", "/a/shared/report"), session("deep-two", "/b/shared/report"),
    session("short", "/x/end"), session("long", "/z/x/end"), session("home", "/home/me"),
    session("windows", "/mnt/c/Users/project"),
  ], { meta: { homeDir: "/home/me", capabilities: { windowsPaths: true } } }));
  assert.deepEqual(result.projects.map(project => project.label), ["paper · teaching", "paper · research",
    "report · a/shared", "report · b/shared", "end · /x", "end · z/x", "~", "project"]);
  assert.equal(result.projects.at(-1).path, "/mnt/c/Users/project");
  assert.equal(projectDisplayPath("/mnt/c/Users/project", true), "C:/Users/project");
  assert.equal(projectDisplayPath("/mnt/c/Users/project"), "/mnt/c/Users/project");
});
await check("等待处理完整且独占，置顶豁免72h和dead，目录候选规则保持", () => {
  const old = SIDEBAR_RECENT_WINDOW_MS + 1;
  const result = selectSidebarSections(value([
    session("waiting", "/a", old, { pinned: true, status: "dead" }), session("pin-dead", "/a", old, { pinned: true, status: "dead" }),
    session("pin-old", "/b", old, { pinned: true }), session("hidden", "/b", old),
    session("running", "/c", old, { status: "running" }), session("current", "/d", old),
    session("boundary", "/e", SIDEBAR_RECENT_WINDOW_MS), session("dead", "/e", 1, { status: "dead" }),
  ], { currentId: "current", pendingCount: id => id === "waiting" ? 1 : 0 }));
  assert.deepEqual(result.waiting.map(session => session.id), ["waiting"]);
  assert.deepEqual(result.pinned.map(session => session.id), ["pin-dead", "pin-old"]);
  assert.deepEqual(result.projects.flatMap(project => project.sessions.map(session => session.id)), ["boundary", "running", "current"]);
  assert.deepEqual(result.olderProjects.map(project => [project.path, project.sessions.map(session => session.id)]), [["/b", ["hidden"]]]);
  const all = [...result.waiting, ...result.pinned, ...result.projects.flatMap(project => project.sessions), ...result.olderProjects.flatMap(project => project.sessions)];
  assert.equal(new Set(all.map(session => session.id)).size, all.length);
});
await check("活跃/较早目录沿用 active 边界，较早目录按最新活动排序且不混入活跃目录超窗会话", () => {
  const old = SIDEBAR_RECENT_WINDOW_MS + 1;
  const sessions = [
    session("older-second", "/old-second", old + 5), session("older-first-old", "/old-first", old + 9),
    session("older-first-new", "/old-first//./", old), session("active-old", "/active", old + 1),
    session("boundary", "/active", SIDEBAR_RECENT_WINDOW_MS), session("running", "/running", old + 20, { status: "running" }),
    session("starting", "/starting", old + 30, { status: "starting" }), session("current", "/current", old + 40),
    session("background", "/background", old + 50, { backgroundTasks: [{ id: "task" }] }),
    session("old-error", "/error", old + 60, { status: "error" }), session("dead-only", "/dead", 1, { status: "dead" }),
    session("waiting-only", "/waiting", old + 70), session("pinned-only", "/pinned", old + 80, { pinned: true }),
  ];
  const result = selectSidebarSections(value(sessions, { currentId: "current", pendingCount: id => id === "waiting-only" ? 1 : 0,
    projectOrder: ["/current", "/starting", "/running", "/active", "/error", "/old-second", "/old-first"] }));
  assert.deepEqual(result.projects.map(project => project.path), ["/current", "/starting", "/running", "/active"]);
  assert.deepEqual(result.projects.at(-1).sessions.map(session => session.id), ["boundary"], "活跃目录只含 active 候选");
  assert.deepEqual(result.olderProjects.map(project => project.path), ["/old-first", "/old-second", "/background", "/error"], "较早目录忽略服务端排序，后台/错误不改变 active 原判定");
  assert.deepEqual(result.olderProjects[0].sessions.map(session => session.id), ["older-first-new", "older-first-old"]);
  const all = [...result.waiting, ...result.pinned, ...result.projects.flatMap(project => project.sessions), ...result.olderProjects.flatMap(project => project.sessions)];
  assert.equal(new Set(all.map(session => session.id)).size, all.length, "四区之间无重复会话");
  assert.ok(!all.some(session => ["active-old", "dead-only"].includes(session.id)));
  assert.deepEqual(sessions.slice(0, 3).map(session => session.id), ["older-second", "older-first-old", "older-first-new"], "不重排输入");
});
await check("越过72h边界或切走旧当前会话后目录进入较早区，再次工作移回活跃区", () => {
  const input = value([session("boundary", "/boundary", SIDEBAR_RECENT_WINDOW_MS), session("current", "/current", SIDEBAR_RECENT_WINDOW_MS + 1)], { currentId: "current" });
  assert.equal(selectSidebarSections(input).olderProjects.length, 0);
  const older = selectSidebarSections({ ...input, currentId: null, now: now + 1 });
  assert.deepEqual(older.projects, []);
  assert.deepEqual(older.olderProjects.map(project => project.path), ["/boundary", "/current"]);
  const working = selectSidebarSections({ ...input, currentId: null, now: now + 1,
    sessions: input.sessions.map(session => session.id === "current" ? { ...session, status: "running" } : session) });
  assert.deepEqual(working.projects.map(project => project.path), ["/current"]);
  assert.deepEqual(working.olderProjects.map(project => project.path), ["/boundary"]);
  assert.deepEqual(selectSidebarSections(value([])).olderProjects, []);
});
await check("活跃与较早目录共同消歧，搜索两区且保留完整候选与稳定名称", () => {
  const old = SIDEBAR_RECENT_WINDOW_MS + 1;
  const input = value([
    session("active", "/active/paper", 0, { nativeTitle: "Needle active" }),
    session("older", "/older/paper", old, { customTitle: "Needle older" }),
    session("older-hidden", "/older/paper", old + 1),
    session("windows-old", "/mnt/c/Users/archive", old + 2),
    session("event-old", "/events", old + 3, { title: undefined }),
    session("wait", "/waiting", old + 4),
  ], { pendingCount: id => id === "wait" ? 1 : 0, meta: { capabilities: { windowsPaths: true } },
    data: new Map([["event-old", { events: [{ type: "user_message", payload: { text: "Event Needle" } }] }]]) });
  const sections = selectSidebarSections(input);
  assert.equal(sections.projects[0].label, "paper · active");
  assert.equal(sections.olderProjects[0].label, "paper · older");
  assert.equal(sections.olderProjects[0].sessions.length, 2);
  const result = selectSidebarSections(input, "NEEDLE");
  assert.deepEqual(result.waiting.map(session => session.id), ["wait"]);
  assert.deepEqual(result.projects.map(project => [project.label, project.sessions.map(session => session.id)]), [["paper · active", ["active"]]]);
  assert.deepEqual(result.olderProjects.map(project => [project.label, project.sessions.map(session => session.id)]), [["paper · older", ["older"]], ["events", ["event-old"]]]);
  assert.equal(selectSidebarSections(input, "C:/USERS").olderProjects[0].path, "/mnt/c/Users/archive");
  assert.equal(selectSidebarSections(input, "/OLDER/PAPER").olderProjects[0].sessions.length, 2);
  const missing = selectSidebarSections(input, "missing");
  assert.deepEqual(missing.projects, []); assert.deepEqual(missing.olderProjects, []);
});
const projectOptions = extra => ({ now, currentId: null, pendingCount: () => 0, expanded: false, searching: false, ...extra });
await check("目录会话限8个普通项，运行/启动/后台/待处理/当前项豁免且不占名额，总体按时间合并", () => {
  const ordinary = Array.from({ length: 12 }, (_, index) => session(`normal-${index}`, "/repo", index * 1000));
  const sessions = [
    session("current", "/repo", 20000), ...ordinary.slice().reverse(),
    session("running", "/repo", 500, { status: "running" }), session("starting", "/repo", 1500, { status: "starting" }),
    session("background", "/repo", 2500, { backgroundTasks: [{ id: "task" }] }), session("pending", "/repo", 3500),
  ];
  const before = sessions.slice();
  const result = selectProjectSessions(sessions, projectOptions({ currentId: "current", pendingCount: id => id === "pending" ? 1 : 0 }));
  assert.deepEqual(result.sessions.map(session => session.id), ["normal-0", "running", "normal-1", "starting", "normal-2", "background", "normal-3", "pending", "normal-4", "normal-5", "normal-6", "normal-7", "current"]);
  assert.equal(result.hiddenCount, 4);
  assert.deepEqual(sessions, before, "限量不重排或改写目录完整候选");
});
await check("目录会话展开或搜索不截断，普通项恰好8个或全豁免不显示更多", () => {
  const sessions = Array.from({ length: 12 }, (_, index) => session(`normal-${index}`, "/repo", (11 - index) * 1000));
  for (const flags of [{ expanded: true }, { searching: true }]) {
    const result = selectProjectSessions(sessions, projectOptions(flags));
    assert.deepEqual(result.sessions.map(session => session.id), [...sessions].reverse().map(session => session.id));
    assert.equal(result.hiddenCount, 0);
  }
  assert.equal(selectProjectSessions(sessions.slice(0, 8), projectOptions()).hiddenCount, 0);
  assert.deepEqual(selectProjectSessions([], projectOptions()), { sessions: [], hiddenCount: 0 });
  const allWorking = sessions.map(session => ({ ...session, status: "starting" }));
  assert.equal(selectProjectSessions(allWorking, projectOptions()).sessions.length, 12);
  assert.equal(selectProjectSessions(allWorking, projectOptions()).hiddenCount, 0);
});
await check("目录计数保持完整；活跃与较早候选都在渲染选择时单独限量", () => {
  const sessions = Array.from({ length: 11 }, (_, index) => session(`active-${index}`, "/active", index));
  sessions.push(...Array.from({ length: 10 }, (_, index) => session(`older-${index}`, "/older", SIDEBAR_RECENT_WINDOW_MS + 1 + index)));
  const result = selectSidebarSections(value(sessions));
  assert.equal(result.projects[0].sessions.length, 11);
  assert.equal(result.olderProjects[0].sessions.length, 10);
  assert.equal(selectProjectSessions(result.projects[0].sessions, projectOptions()).hiddenCount, 3);
  assert.equal(selectProjectSessions(result.olderProjects[0].sessions, projectOptions()).hiddenCount, 2);
});
await check("搜索使用实际显示标题、事件回退与cwd，不隐藏等待处理且不改变消歧名", () => {
  const input = value([
    session("wait", "/no-match", 0, { pinned: true }), session("custom", "/a/paper", 0, { customTitle: "Needle renamed", pinned: true }),
    session("native", "/b/paper", 0, { nativeTitle: "Native needle" }), session("event", "/a/paper", 0, { title: undefined }),
    session("empty", "/empty", 0, { title: undefined }), session("windows", "/mnt/c/Users/test"),
  ], { pendingCount: id => id === "wait" ? 1 : 0, meta: { capabilities: { windowsPaths: true } },
    data: new Map([["event", { events: [{ type: "user_message", payload: { text: "Event Needle" } }] }]]) });
  const result = selectSidebarSections(input, "NEEDLE");
  assert.deepEqual(result.waiting.map(session => session.id), ["wait"]);
  assert.deepEqual(result.pinned.map(session => session.id), ["custom"]);
  assert.deepEqual(result.projects.map(project => project.label), ["paper · b", "paper · a"]);
  assert.deepEqual(result.projects.flatMap(project => project.sessions.map(session => session.id)), ["native", "event"]);
  assert.equal(selectSidebarSections(input, "C:/USERS").projects[0].path, "/mnt/c/Users/test");
  assert.equal(selectSidebarSections(input, "/B/PAPER").projects[0].path, "/b/paper");
  assert.equal(selectSidebarSections(input, sessionTitle({})).projects[0].sessions[0].id, "empty");
  assert.deepEqual(selectSidebarSections(input, "missing").projects, []);
});
await check("移除当前会话后的下一项遵守等待、置顶、活跃目录、较早目录顺序", async () => {
  const entries = [session("waiting", "/wait", 50), session("pin", "/pin", 40, { pinned: true, status: "dead" }),
    session("project-first", "/first", 30), session("project-recent", "/second", 1),
    session("hidden", "/old", SIDEBAR_RECENT_WINDOW_MS + 1)];
  for (const [skip, expected] of [[0, "waiting"], [1, "pin"], [2, "project-first"], [3, "project-recent"], [4, "hidden"], [5, null]]) {
    const store = new Store();
    store.now = now; store.currentId = "removed"; store.projectOrder = ["/first", "/second"];
    store.sessions = [session("removed", "/removed"), ...entries.slice(skip)];
    store.pendingCount = id => id === "waiting" ? 1 : 0;
    store.navigate = id => { store.currentId = id; };
    globalThis.fetch = async () => ({ json: async () => ({ code: 0, data: { nativeTranscriptPreserved: true } }) });
    await store.remove("removed");
    assert.equal(store.currentId, expected);
  }
});

// 与既有 history-flow 一样只打桩 hooks，执行真实 HistoryView 搜索与请求逻辑。
const React = await import("react");
const savedReact = globalThis.React;
globalThis.React = React;
const { HistoryView } = await import("../src/components/HistoryView.tsx");
const { store: historyStore } = await import("../src/store.ts");
function historyFixture() {
  const state = [], refs = [], memos = [], effects = [];
  let pending = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const render = () => {
    let si = 0, ri = 0, mi = 0, ei = 0;
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const previous = internals.H;
    const memo = (fn, deps) => {
      const i = mi++;
      if (!same(memos[i]?.deps, deps)) memos[i] = { deps, value: fn() };
      return memos[i].value;
    };
    internals.H = {
      useState(initial) { const i = si++; if (!(i in state)) state[i] = typeof initial === "function" ? initial() : initial;
        return [state[i], next => { state[i] = typeof next === "function" ? next(state[i]) : next; }]; },
      useRef(initial) { return refs[ri++] ??= { current: initial }; },
      useCallback(fn, deps) { return memo(() => fn, deps); }, useMemo: memo,
      useEffect(fn, deps) { const i = ei++; if (!same(effects[i]?.deps, deps)) pending.push(() => {
        effects[i]?.cleanup?.(); effects[i] = { deps, cleanup: fn() };
      }); },
      useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); },
    };
    try { return HistoryView(); } finally { internals.H = previous; }
  };
  render.flush = () => { const jobs = pending; pending = []; jobs.forEach(job => job()); };
  render.dispose = () => effects.forEach(effect => effect.cleanup?.());
  return render;
}
function searchInput(tree) {
  if (Array.isArray(tree)) return tree.map(searchInput).find(Boolean);
  if (!tree || typeof tree !== "object") return undefined;
  if (tree.type === "input" && tree.props.type === "search") return tree;
  return searchInput(tree.props?.children);
}
await check("在历史中搜索清旧目录并一次预填，普通词与路径都触发实际查询", async () => {
  const saved = { meta: historyStore.meta, cwd: historyStore.historyCwdFilter, request: historyStore.historySearchRequest,
    open: historyStore.historyOpen, page: historyStore.currentPageId, selection: historyStore.historySelection, mobile: historyStore.isMobileNavigation, sync: historyStore.syncDesktopPanels };
  historyStore.meta = { homeDir: "/home/me", capabilities: { windowsPaths: true } };
  historyStore.isMobileNavigation = () => false;
  historyStore.syncDesktopPanels = () => {};
  let render;
  try {
    const calls = [];
    globalThis.fetch = async url => {
      calls.push(new URL(String(url), "http://aireins.test"));
      return { json: async () => ({ code: 0, data: { sessions: [], truncated: false, skipped: 0, empty: 0, discovered: 0 } }) };
    };
    const settle = async () => { for (let i = 0; i < 3; i++) { render(); render.flush(); await new Promise(resolve => setImmediate(resolve)); } };
    historyStore.setHistoryCwdFilter("/old-filter");
    historyStore.navigateHistory(undefined, "Needle Query");
    assert.equal(historyStore.historyCwdFilter, "");
    render = historyFixture();
    await settle();
    assert.equal(searchInput(render()).props.value, "Needle Query");
    assert.equal(historyStore.historySearchRequest, null);
    await new Promise(resolve => setTimeout(resolve, 270));
    await settle();
    assert.equal(calls.at(-1).searchParams.get("q"), "Needle Query");
    assert.equal(calls.at(-1).searchParams.get("cwd"), null);
    historyStore.setHistoryCwdFilter("/old-again");
    historyStore.navigateHistory(undefined, "C:\\Users\\project\\");
    await settle();
    assert.equal(historyStore.historyCwdFilter, "/mnt/c/Users/project");
    assert.equal(searchInput(render()).props.value, "");
    assert.equal(calls.at(-1).searchParams.get("cwd"), "/mnt/c/Users/project");
    assert.equal(calls.at(-1).searchParams.get("q"), null);
    render.dispose(); render = historyFixture();
    await settle();
    assert.equal(searchInput(render()).props.value, "", "重新挂载不会重放一次性预填");
  } finally {
    render?.dispose();
    historyStore.meta = saved.meta; historyStore.historyCwdFilter = saved.cwd; historyStore.historySearchRequest = saved.request;
    historyStore.historyOpen = saved.open; historyStore.currentPageId = saved.page; historyStore.historySelection = saved.selection; historyStore.isMobileNavigation = saved.mobile; historyStore.syncDesktopPanels = saved.sync;
  }
});
globalThis.React = savedReact;
console.log(`✅ AIReins 目录侧栏与历史搜索累计：${passed} 项`);
