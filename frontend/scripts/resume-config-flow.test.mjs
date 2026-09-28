#!/usr/bin/env node
// M15 打桩回归：claude model/effort 重启切换（mutableVia:"restart"）与续接会话历史消息区。
// 覆盖：
//  1. mutableVia 项的「重启」旁注存在且只对 restart 项出现（config-view 纯逻辑 + SessionView 源码接线）；
//  2. config_update_started → 过渡态（configSwitching 置位），config_updated → 解除；
//  3. 两种拒绝文案（回合进行中 / 首轮前无 nativeSessionId）经 WS error 帧就地落在 configErrors，措辞原样；
//  4. 切换中途 session_error → 过渡态解除 + 错误就地显示；快照重取能重建未完成的过渡态；
//  5. fetchHistoryMessages URL 组装与信封透传；initialHistoryPage/prependHistoryPage 翻页 prepend 与 DOM 上限；
//  6. 源码接线：resumedFrom → 历史区挂载、分隔线文案、用户/助手两态（不伪造工具/思考块）。
// 浏览器依赖（WebSocket / fetch）全部打桩，不需要真实 server。运行：npm run test:resume
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

// --- 浏览器全局打桩（须在 import store 之前） ---
globalThis.WebSocket = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

const { Store } = await import("../src/store.ts");
const { needsRestartNote, RESTART_NOTE, pillText } = await import("../src/config-view.ts");
const {
  HISTORY_MAX_MESSAGES,
  HISTORY_PAGE_SIZE,
  historyCapReached,
  initialHistoryPage,
  prependHistoryPage,
} = await import("../src/resumed-history.ts");
const { fetchHistoryMessages } = await import("../src/api.ts");

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; }
};

const settle = () => new Promise((r) => setTimeout(r, 20));

function makeSession(id, over = {}) {
  const now = new Date().toISOString();
  return {
    id, agent: "claude", agentId: `${id}-agent`, cwd: "/tmp", status: "idle",
    createdAt: now, lastActivityAt: now, seq: 0, transcriptPath: `/tmp/${id}.jsonl`,
    nativeSessionId: `native-${id}`, processId: 1234,
    config: {}, riskyMode: false,
    ...over,
  };
}

function makeEvent(sessionId, seq, type, payload = {}) {
  return { type, sessionId, agentId: `${sessionId}-agent`, seq, timestamp: new Date().toISOString(), payload };
}

const envelope = (data) => ({ json: async () => ({ code: 0, msg: "", data, request_id: "t" }) });

function fakeSocket(sent) {
  return { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
}

/** 打桩 fetch：snapshot 可指定事件序列（默认空）。 */
function stubFetch(session, snapshotEvents = []) {
  globalThis.fetch = (path, init) => {
    path = String(path);
    if (path === "/api/sessions") return Promise.resolve(envelope({ sessions: [session] }));
    if (path.endsWith("/snapshot")) {
      return Promise.resolve(envelope({ session, seq: snapshotEvents.length, events: snapshotEvents }));
    }
    if (path.endsWith("/commands")) return Promise.resolve(envelope({ commands: [] }));
    return Promise.reject(new Error(`未打桩的请求：${path}`));
  };
}

// ============ 需求 1：claude model/effort 重启切换 ============

// --- 验收 1：mutableVia 项的「重启」旁注 ---
await t("needsRestartNote：仅 mutableVia:\"restart\" 需要旁注；文案逐字为「切换会重启底层进程并续接当前会话」", async () => {
  assert.equal(needsRestartNote({ mutableVia: "restart" }), true);
  assert.equal(needsRestartNote({}), false, "无 mutableVia 的项不应有旁注");
  assert.equal(needsRestartNote({ mutableVia: "restart" }), true);
  assert.equal(RESTART_NOTE, "切换会重启底层进程并续接当前会话", "旁注文案被改动");
  // 接线断言（打桩的代码复核）：ConfigControls 只在 needsRestartNote 命中时渲染旁注
  const source = readFileSync(new URL("../src/components/SessionView.tsx", import.meta.url), "utf8");
  assert.ok(
    /needsRestartNote\(option\)\s*&&\s*[\s\S]*?RESTART_NOTE/.test(source),
    "SessionView 未按 mutableVia 渲染旁注",
  );
  // mutable:true 即不再禁用：禁用条件里没有把 restart 项算进去（!option.mutable 是唯一 schema 闸门）
  assert.ok(
    source.includes("!option.mutable || !live || Boolean(switching)"),
    "禁用条件被改动，restart 项可能被重新禁用",
  );
});

await t("pillText：胶囊显示值按 覆盖 > 实际生效值 > default 取，精确 id 按别名认回标签，都没有写「默认」", async () => {
  const model = { default: null, values: [{ value: null, label: "跟随 Claude 配置" }, { value: "opus", label: "Opus 5.5" }] };
  assert.equal(pillText(model, "opus", "sonnet"), "Opus 5.5", "覆盖优先");
  assert.equal(pillText(model, undefined, "claude-opus-5-5"), "Opus 5.5", "init 精确 id 应认回别名标签");
  assert.equal(pillText(model, undefined, "claude-foo-9"), "claude-foo-9", "认不回就原样显示，不编造");
  assert.equal(pillText(model, undefined, null), "默认");
  assert.equal(pillText({ default: "high", values: [{ value: "high", label: "Thinking High" }] }, undefined), "Thinking High", "codex/kimi 用 default");
});

// --- 验收 2：config_update_started → 过渡态；config_updated → 恢复 ---
await t("config_update_started 置过渡态（payload.message 原样），config_updated 解除并应用新配置", async () => {
  const session = makeSession("s-sw-1");
  stubFetch(session);
  const sent = [];
  const s = new Store();
  s.socket = fakeSocket(sent);
  s.sessions = [session];
  await s.ensureLoaded(session.id);

  // 用户改 model：set_config 上行 → 控件 pending
  s.setConfig(session.id, { model: "opus" });
  assert.ok(sent.some((f) => f.type === "set_config" && f.config?.model === "opus"), "set_config 未上行");
  assert.ok(s.configPending.has(session.id), "set_config 后应进入发送中");

  // 后端先广播 config_update_started
  s.handleFrame(makeEvent(session.id, 1, "config_update_started", {
    message: "正在切换模型…",
    mutableVia: "restart",
    nativeSessionId: session.nativeSessionId,
    previousConfig: {},
    targetConfig: { model: "opus" },
  }));
  assert.equal(s.configSwitching.get(session.id), "正在切换模型…", "过渡文案未原样落 store");

  // 初始化成功后 config_updated（mutableVia:"restart" + workerRestarted:true）：恢复
  s.handleFrame(makeEvent(session.id, 2, "config_updated", {
    config: { model: "opus" },
    model: "opus",
    effort: null,
    permissionMode: null,
    riskyMode: false,
    effectiveFrom: "immediate",
    mutableVia: "restart",
    workerRestarted: true,
  }));
  assert.equal(s.configSwitching.has(session.id), false, "config_updated 后过渡态应解除");
  assert.equal(s.configPending.has(session.id), false, "config_updated 后发送中应解除");
  assert.equal(s.session(session.id).config.model, "opus", "新配置未应用");
});

// --- 验收 2b：两种拒绝文案就地落在控件旁（configErrors），措辞原样，不进全局错误条 ---
await t("回合进行中拒绝 + 首轮前无 nativeSessionId 拒绝：WS error 帧原样落 configErrors", async () => {
  const session = makeSession("s-sw-2", { nativeSessionId: undefined });
  stubFetch(session);
  const s = new Store();
  s.socket = fakeSocket([]);
  s.sessions = [session];
  await s.ensureLoaded(session.id);

  for (const msg of [
    "当前回合尚未结束，请等待或中断后再切换",
    "Claude 首轮完成前尚无 nativeSessionId，无法通过续接切换模型或推理强度",
  ]) {
    s.setConfig(session.id, { effort: "high" });
    s.handleFrame({ type: "error", sessionId: session.id, action: "set_config", msg });
    assert.equal(s.configErrors.get(session.id), msg, `拒绝文案未原样落在控件旁：${msg}`);
    assert.equal(s.configPending.has(session.id), false, "拒绝后发送中应解除");
    assert.equal(s.lastError, null, "拒绝不应污染全局错误条");
    s.clearConfigError(session.id);
    assert.equal(s.configErrors.has(session.id), false, "错误应可关闭");
  }
});

// --- 验收 2c：切换中途 session_error → 过渡态解除、错误就地显示 ---
await t("config_update_started 后 session_error：过渡态解除，错误落 configErrors 而非静默", async () => {
  const session = makeSession("s-sw-3");
  stubFetch(session);
  const s = new Store();
  s.socket = fakeSocket([]);
  s.sessions = [session];
  await s.ensureLoaded(session.id);

  s.handleFrame(makeEvent(session.id, 1, "config_update_started", { message: "正在切换模型…" }));
  assert.ok(s.configSwitching.has(session.id), "过渡态未置位");
  s.handleFrame(makeEvent(session.id, 2, "session_error", {
    message: "续接 worker 初始化失败：boom",
    source: "config_restart",
  }));
  assert.equal(s.configSwitching.has(session.id), false, "session_error 后过渡态应解除");
  assert.equal(
    s.configErrors.get(session.id),
    "续接 worker 初始化失败：boom",
    "切换失败错误未就地显示",
  );
});

// --- 验收 2d：快照重取能重建未完成的过渡态（断开重连场景） ---
await t("快照内夹着未完成的 config_update_started：过渡态被重建；已完成的不残留", async () => {
  const session = makeSession("s-sw-4");
  // 快照事件流：一条已完成切换 + 一条进行中切换
  stubFetch(session, [
    makeEvent(session.id, 1, "config_update_started", { message: "正在切换模型…" }),
    makeEvent(session.id, 2, "config_updated", { config: { model: "haiku" } }),
    makeEvent(session.id, 3, "config_update_started", { message: "正在切换模型…" }),
  ]);
  const s = new Store();
  await s.ensureLoaded(session.id);
  assert.equal(
    s.configSwitching.get(session.id),
    "正在切换模型…",
    "未完成的切换过渡态应被重建",
  );

  // 已全部完成的快照：不残留过渡态
  const s2 = new Store();
  stubFetch(session, [
    makeEvent(session.id, 1, "config_update_started", { message: "正在切换模型…" }),
    makeEvent(session.id, 2, "config_updated", { config: { model: "haiku" } }),
  ]);
  await s2.ensureLoaded(session.id);
  assert.equal(s2.configSwitching.has(session.id), false, "已完成切换不应残留过渡态");
});

// ============ 需求 2：续接会话历史消息 ============

const msg = (role, text, timestamp = "2026-08-22T10:00:00.000Z") => ({ role, text, timestamp });
const page = (messages, over = {}) => ({
  session: { agent: "claude", nativeSessionId: "n1", cwd: "/repo", title: "t", lastActivityAt: "2026-08-22T10:00:00.000Z", source: "workbench", filePath: "/x.jsonl" },
  messages,
  hasMore: false,
  truncated: false,
  durationMs: 5,
  ...over,
});

// --- 验收 3 打桩侧：fetchHistoryMessages URL 组装与信封透传 ---
await t("fetchHistoryMessages：limit/cursor 正确编码；hasMore/truncated/timestamp:null 原样透传", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return envelope(page([msg("user", "你好", null)], { nextCursor: "CUR/1+", hasMore: true, truncated: true }));
  };
  const data = await fetchHistoryMessages("claude", "abc-123", { limit: 50, cursor: "CUR/0=" });
  const url = new URL(calls[0], "http://x");
  assert.equal(url.pathname, "/api/history/claude/abc-123/messages");
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.get("cursor"), "CUR/0=", "cursor 应原样带回");
  assert.equal(data.hasMore, true);
  assert.equal(data.truncated, true, "truncated 应原样透传（中性说明，不是错误）");
  assert.equal(data.messages[0].timestamp, null, "timestamp:null 应保留（如实不显示时间）");
});

// --- 验收 3/4 打桩侧：最新一页打底 → nextCursor 翻页 prepend ---
await t("initialHistoryPage + prependHistoryPage：更早一页整页 prepend，页内顺序不动", async () => {
  const latest = page([msg("user", "第3条"), msg("assistant", "第4条")], {
    nextCursor: "C1",
    hasMore: true,
  });
  let state = initialHistoryPage(latest);
  assert.deepEqual(state.messages.map((m) => m.text), ["第3条", "第4条"], "首条应原样打底");
  assert.equal(state.nextCursor, "C1");

  const older = page([msg("user", "第1条"), msg("assistant", "第2条")], {
    hasMore: false,
    truncated: true,
  });
  state = prependHistoryPage(state, older);
  assert.deepEqual(
    state.messages.map((m) => m.text),
    ["第1条", "第2条", "第3条", "第4条"],
    "更早一页应整页 prepend 到最前",
  );
  assert.equal(state.nextCursor, undefined, "翻完后 nextCursor 应消失（按钮随之消失）");
  assert.equal(state.hasMore, false);
  assert.equal(state.truncated, true, "任一页 truncated 都应保留标注");
});

// --- 验收 4 打桩侧：DOM 上限 ---
await t("historyCapReached：达到上限后不再翻页（提示看原生文件）", async () => {
  const many = Array.from({ length: HISTORY_MAX_MESSAGES }, (_, i) => msg("user", `m${i}`));
  const state = initialHistoryPage(page(many, { nextCursor: "C9", hasMore: true }));
  assert.equal(historyCapReached(state), true, "达到上限应判 capped");
  assert.equal(historyCapReached(initialHistoryPage(page(many.slice(0, 10)))), false);
  assert.equal(HISTORY_PAGE_SIZE, 50, "默认页大小变了？（与后端默认对齐）");
});

// --- 验收 3/5 打桩侧：源码接线——resumedFrom → 历史区、分隔线、两态渲染 ---
await t("源码接线：resumedFrom 才挂历史区；分隔线文案；用户/助手两态，不伪造工具/思考块", async () => {
  const sessionView = readFileSync(new URL("../src/components/SessionView.tsx", import.meta.url), "utf8");
  assert.ok(
    /session\.resumedFrom\s*&&\s*<ResumedHistory/.test(sessionView),
    "SessionView 未按 resumedFrom 挂载历史区",
  );
  const history = readFileSync(new URL("../src/components/ResumedHistory.tsx", import.meta.url), "utf8");
  assert.ok(history.includes("以上为导入前的历史对话"), "分隔线文案缺失");
  assert.ok(history.includes("加载更早的消息"), "翻页按钮文案缺失");
  assert.ok(history.includes("加载中…"), "加载中文案缺失");
  assert.ok(history.includes("重试"), "失败重试缺失");
  assert.ok(history.includes("messageRoleLabel(message.role, session.agent)"), "应只有用户/助手两态");
  const { messageRoleLabel } = await import("../src/format.ts");
  assert.equal(messageRoleLabel("user", "claude"), "我");
  assert.equal(messageRoleLabel("assistant", "claude"), "Claude Code");
  assert.equal(messageRoleLabel("assistant", "codex"), "Codex");
  assert.equal(messageRoleLabel("assistant", "kimi"), "Kimi");
  assert.equal(messageRoleLabel("assistant", undefined), "助手");
  assert.ok(!/tool_call|thought/i.test(history), "历史区不应渲染工具调用/思考块");
  assert.ok(!/display:\s*"?none/.test(history), "历史区不应默认折叠隐藏");
});

// --- P1-6：prependHistoryPage 空页拦截（空页是补偿滞留的触发源） ---
await t("prependHistoryPage：空页不 prepend，messages 原样保留；cursor/hasMore/truncated 照常推进", async () => {
  const latest = page([msg("user", "第3条"), msg("assistant", "第4条")], {
    nextCursor: "C1",
    hasMore: true,
  });
  const state = initialHistoryPage(latest);

  // 空页带 nextCursor：不碰 messages（条数不变 → 不触发滚动补偿），cursor 推进避免卡死重取同一页
  const next = prependHistoryPage(state, page([], { nextCursor: "C0", hasMore: true, truncated: true }));
  assert.deepEqual(next.messages.map((m) => m.text), ["第3条", "第4条"], "空页不应改动已加载消息");
  assert.equal(next.messages, state.messages, "空页应保留原 messages 引用（长度不变才不触发补偿）");
  assert.equal(next.nextCursor, "C0", "空页的 cursor 应照常推进，否则按钮卡死在同一页");
  assert.equal(next.hasMore, true);
  assert.equal(next.truncated, true, "空页的 truncated 也应并入标注");

  // 空页且无 nextCursor：翻到尽头，cursor 清掉（按钮随之消失）
  const done = prependHistoryPage(state, page([], { hasMore: false }));
  assert.equal(done.messages.length, state.messages.length, "空页到尽头也不应改动消息");
  assert.equal(done.nextCursor, undefined, "空页到尽头应清掉 cursor");
  assert.equal(done.hasMore, false);

  // 空页拦截后，下一页非空仍正常 prepend（拦截不污染后续翻页）
  const older = page([msg("user", "第1条")], { hasMore: false });
  const resumed = prependHistoryPage(next, older);
  assert.deepEqual(
    resumed.messages.map((m) => m.text),
    ["第1条", "第3条", "第4条"],
    "空页之后非空页应正常 prepend",
  );
});

// --- P1-6 源码接线：补偿改 useLayoutEffect + offsetTop 基线 + 稳定 key ---
await t("源码接线：滚动补偿 useLayoutEffect；offsetTop 基线（非 scrollHeight）；key 不再是 key={index}", async () => {
  const history = readFileSync(new URL("../src/components/ResumedHistory.tsx", import.meta.url), "utf8");
  assert.ok(/useLayoutEffect/.test(history), "滚动补偿应改用 useLayoutEffect（绘制前执行，避免闪烁）");
  assert.ok(!/key=\{index\}/.test(history), "列表 key 不应再是 key={index}（prepend 后全量错位复用 DOM）");
  assert.ok(/key=\{`/.test(history), "列表 key 应为 role+timestamp+index 形式的稳定 key");
  assert.ok(!/prevScrollHeight|scrollHeight\s*-\s*/.test(history), "不应再以 scrollHeight 差作补偿基线");
  assert.ok(/offsetTop/.test(history), "补偿基线应改为底部参照节点的 offsetTop 差");
});

console.log(`✅ resume/config 前端逻辑回归全过（${pass} 例）`);
process.exit(process.exitCode ?? 0);
