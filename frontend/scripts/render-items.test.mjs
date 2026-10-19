#!/usr/bin/env node
// render-items.ts（文本合并 / 工具聚合 / gateFromEvent 三家命令提取）
// 与 commands.ts（filterCommands 筛选 + 最近使用）的纯函数单测——两处都是「代码复核」热点，
// 坏了不一定报错，只会静默渲染错/排序错。
import { strict as assert } from "node:assert";
// Included here so the existing npm test entry covers the Codex command/skill contract.
await import("./codex-commands.test.mjs");

// 用 tsx 把 TS 模块加载进来
const { buildRenderItems, buildHistoryRenderItems, createRenderItemsBuilder, focusVisible, groupReadOnlyTools, gateFromEvent, promptCacheExpiry } = await import("../src/render-items.ts");
const {
  filterCommands,
  isSubsequence,
  readRecentCommands,
  noteCommandUsed,
  recentInTable,
  MAX_RECENT_COMMANDS,
  withSideCommands,
  parseSideCommand,
} = await import("../src/commands.ts");
const { newSessionCommands } = await import("../src/new-session-input.ts");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; } };

const ev = (seq, type, payload = {}) => ({
  type,
  sessionId: "s1",
  agentId: "s1",
  seq,
  timestamp: "2026-08-23T00:00:00.000Z",
  payload,
});
const cmd = (name, description = "") => ({ name, description, source: "claude" });
const names = (list) => list.map((c) => c.name);
const commandSession = (id, agent, cwd, day) => ({ id, agent, cwd, lastActivityAt: `2026-10-${day}T00:00:00.000Z` });

t("新建命令：同目录优先于更新的其他目录，且不借用其他 agent", () => {
  const sessions = Object.freeze([
    commandSession("same", "claude", "/repo", "10"),
    commandSession("elsewhere", "claude", "/elsewhere", "17"),
    commandSession("other-agent", "kimi", "/repo", "18"),
  ]);
  const tables = new Map(sessions.map(session => [session.id, [cmd(session.id)]]));
  assert.deepEqual(names(newSessionCommands("claude", "/repo", sessions, tables)), ["same"]);
  assert.deepEqual(sessions.map(session => session.id), ["same", "elsewhere", "other-agent"], "选择候选不重排 store.sessions");
});

t("新建命令：同目录中取最近的可用命令表，盘符目录按现有入口规范化", () => {
  const sessions = [commandSession("old", "claude", "/mnt/c/repo", "10"), commandSession("new", "claude", "/mnt/c/repo", "17")];
  const tables = new Map([["old", [cmd("old-skill")]], ["new", [cmd("new-skill")]]]);
  assert.deepEqual(names(newSessionCommands("claude", '"C:\\repo"', sessions, tables)), ["new-skill"]);
});

t("新建命令：无同目录表时取同 agent 最近非空表，无可用表返回空", () => {
  const sessions = [
    commandSession("same-empty", "kimi", "/repo", "18"),
    commandSession("older", "kimi", "/older", "10"),
    commandSession("recent", "kimi", "/recent", "17"),
    commandSession("unloaded", "kimi", "/repo", "19"),
    commandSession("claude", "claude", "/repo", "20"),
  ];
  const tables = new Map([["same-empty", []], ["older", [cmd("older")]], ["recent", [cmd("recent")]], ["claude", [cmd("wrong-agent")]]]);
  assert.deepEqual(names(newSessionCommands("kimi", "/repo", sessions, tables)), ["recent"]);
  assert.deepEqual(newSessionCommands("codex", "/repo", sessions, tables), []);
  assert.deepEqual(newSessionCommands("kimi", "/repo", sessions, new Map()), []);
  assert.deepEqual(newSessionCommands("kimi", "/repo", [], tables), []);
});

t("新建命令：Claude/Kimi 排除依赖现有会话的操作，保留文本命令", () => {
  const sessionActions = ["status", "tasks", "compact", "context", "clear", "cost", "usage", "resume", "rewind", "export", "exit", "quit", "btw", "side", "mcp", "model", "permissions", "config", "settings", "thinking", "fast"];
  const commands = [...sessionActions.map(name => cmd(name)), cmd("help"), cmd("review"), cmd("project-skill")];
  for (const agent of ["claude", "kimi"]) {
    assert.deepEqual(names(newSessionCommands(agent, "/repo", [commandSession("source", agent, "/repo", "17")], new Map([["source", commands]]))), ["help", "review", "project-skill"]);
  }
});

t("新建命令：Codex 只保留 review 文本入口，不暴露 AIReins 会话动作", () => {
  const sessions = [commandSession("source", "codex", "/repo", "17")];
  const commands = [cmd("status"), cmd("review"), cmd("compact"), cmd("diff"), cmd("rename"), cmd("help"), cmd("resume"), cmd("unknown")];
  assert.deepEqual(names(newSessionCommands("codex", "/repo", sessions, new Map([["source", commands]]))), ["review"]);
  assert.deepEqual(newSessionCommands("codex", "/repo", sessions, new Map([["source", [cmd("status")]]])), []);
});

t("渲染层过滤已知无信息量 raw，不拆开文本；未知 method 仍可见", () => {
  for (const [agent, methods] of [
    ["codex", ["turn/diff/updated", "hook/started", "account/updated"]],
    ["claude", ["tool_progress", "command_lifecycle"]],
  ]) {
    const raw = methods.map((method, index) => ev(index + 2, "raw_event", agent === "codex"
      ? { source: agent, method, params: {} } : { source: agent, raw: { type: method } }));
    const events = [ev(1, "agent_text_delta", { text: "前" }), ...raw, ev(8, "agent_text_delta", { text: "后" })];
    const original = JSON.stringify(events);
    const items = buildRenderItems(events, agent);
    assert.deepEqual(items.map(item => item.kind), ["text"]);
    assert.equal(items[0].text, "前后");
    assert.equal(JSON.stringify(events), original, "原始事件不变");
    const unknown = buildRenderItems([ev(1, "raw_event", { source: agent, method: "future/method", raw: { type: "future_event" } })], agent);
    assert.equal(unknown[0].kind, "raw");
  }
});

t("正常会话隐藏收尾调试项，保留原始记录、错误和审批，缓存与视图切换不漏出调试项", () => {
  for (const agent of ["codex", "claude", "kimi"]) {
    const builder = createRenderItemsBuilder(agent);
    const raw = seq => ev(seq, "raw_event", { source: agent, method: "future/method", raw: { type: "future_event" } });
    const events = [ev(1, "user_message", { text: "问题" }), ev(2, "agent_text_delta", { text: "最终回答" }),
      ev(3, "turn_completed"), raw(4), raw(5)];
    const original = JSON.stringify(events);
    const normalized = builder.update(events);
    assert.equal(normalized.filter(item => item.kind === "raw").length, 2, "排错记录仍保留");
    assert.equal(JSON.stringify(events), original, "原始事件不变");
    for (const focus of [false, false, true, false]) {
      assert.deepEqual(builder.display(focus, "/repo").map(item => item.kind), ["user", "text"]);
    }
    events.push(raw(6));
    builder.update(events);
    assert.deepEqual(builder.display(false, "/repo").map(item => item.kind), ["user", "text"]);
    // 追加文本命中显示缓存；隐藏的原始通知不能在缓存复用时重新出现。
    events.push(ev(7, "agent_text_delta", { text: "补充" }));
    builder.update(events);
    assert.deepEqual(builder.display(false, "/repo").map(item => item.kind), ["user", "text", "text"]);
    events.push(ev(8, "session_error", { message: "连接失败" }),
      ev(9, "permission_request", { requestId: "approval", toolName: "commandExecution" }));
    builder.update(events);
    for (const focus of [false, true]) {
      const shown = builder.display(focus, "/repo");
      assert.equal(shown.some(item => item.kind === "raw"), false);
      assert.equal(shown.find(item => item.kind === "system")?.tone, "error");
      assert.ok(shown.some(item => item.kind === "gate"));
    }
  }
});

t("只隐藏明确成功的 hook；失败、错误条目、非零退出码和未知状态都保留", () => {
  const hook = run => ev(1, "raw_event", { source: "codex", method: "hook/completed", params: { run } });
  assert.deepEqual(buildRenderItems([hook({ status: "completed", entries: [] })], "codex"), []);
  for (const run of [
    { status: "failed" }, { status: "completed", error: { message: "失败" } },
    { status: "completed", entries: [{ level: "error", message: "失败" }] },
    { status: "completed", entries: [{ exitCode: 2 }] }, { status: "unknown" }, {},
  ]) assert.equal(buildRenderItems([hook(run)], "codex")[0].kind, "raw");
});

t("outputDelta 仅在对应工具卡片已含相同输出时隐藏；实时/独有/缺卡片输出保留", () => {
  const start = ev(1, "tool_call_started", { toolCallId: "cmd", toolName: "commandExecution", input: { command: "echo hello" } });
  const delta = text => ev(2, "raw_event", { source: "codex", method: "item/commandExecution/outputDelta", params: { itemId: "cmd", delta: text } });
  const done = ev(3, "tool_call_completed", { toolCallId: "cmd", result: { type: "commandExecution", aggregatedOutput: "hello\n", status: "completed" } });
  const items = buildRenderItems([start, delta("hello\n"), done], "codex");
  assert.deepEqual(items.map(item => item.kind), ["tool"]);
  assert.ok(items[0].result.includes("hello"));
  for (const events of [[start, delta("hello\n")], [start, delta("unique"), done], [delta("hello\n"), done]]) {
    assert.ok(buildRenderItems(events, "codex").some(item => item.kind === "raw"));
  }
});

t("Claude user 只过滤已显示文本回显；任务完成通知、跨会话回传及其他独有内容保留", () => {
  const user = content => ev(2, "raw_event", { source: "claude", raw: { type: "user", message: { content } } });
  const displayed = ev(1, "user_message", { text: "同一消息" });
  for (const content of ["同一消息", [{ type: "text", text: "同一消息" }]]) {
    assert.deepEqual(buildRenderItems([displayed, user(content)], "claude").map(item => item.kind), ["user"]);
  }
  for (const content of ["<task-notification><status>completed</status></task-notification>",
    'Another Claude session sent a message: <agent-message>回传</agent-message>', "Print 2",
    [{ type: "text", text: "同一消息" }, { type: "image", source: {} }]]) {
    assert.ok(buildRenderItems([displayed, user(content)], "claude").some(item => item.kind === "raw"));
  }
  const later = { ...user("同一消息"), seq: 4 };
  assert.ok(buildRenderItems([displayed, ev(3, "turn_completed"), later], "claude").some(item => item.kind === "raw"),
    "前一回合出现过同样文本不能证明新消息是回显");
});

t("插话保留标记且不拆开当前工具回合，普通消息仍开始新回合", () => {
  const items = buildRenderItems([
    ev(1, "user_message", { text: "开始" }),
    ev(2, "agent_text_delta", { text: "原计划" }),
    ev(3, "user_message", { text: "调整", steer: true }),
    ev(4, "agent_text_delta", { text: "新计划" }),
    ev(5, "turn_completed", {}),
    ev(6, "user_message", { text: "新回合" }),
    ev(7, "agent_text_delta", { text: "继续" }),
  ], "codex");
  const users = items.filter(item => item.kind === "user");
  const texts = items.filter(item => item.kind === "text");
  assert.equal(users[0].steer, undefined);
  assert.equal(users[1].steer, true);
  assert.equal(users[1].queued, undefined);
  assert.equal(texts[0].turn, texts[1].turn);
  assert.notEqual(texts[1].turn, texts[2].turn);
});

t("Kimi 排队标记读回保留，回合结束后生成的文本归入下一回合", () => {
  const items = buildRenderItems([
    ev(1, "user_message", { text: "开始" }),
    ev(2, "agent_text_delta", { text: "原回合" }),
    ev(3, "user_message", { text: "排队", steer: true, queued: true }),
    ev(4, "agent_text_delta", { text: "继续原回合" }),
    ev(5, "turn_completed", {}),
    ev(6, "agent_text_delta", { text: "处理排队消息" }),
  ], "kimi");
  const user = items.find(item => item.kind === "user" && item.steer);
  const texts = items.filter(item => item.kind === "text");
  assert.equal(user.queued, true);
  assert.equal(texts[0].turn, texts[1].turn);
  assert.notEqual(texts[1].turn, texts[2].turn);
});

// ══ 连续成功只读工具分组（实时流与历史共用） ══
const readTool = (id, extra = {}) => ({
  kind: "tool", key: `tool:${id}`, seq: id, toolCallId: String(id),
  toolName: "Read", baseToolName: "Read", input: "", result: "content",
  status: "ok", turn: 1, rawInput: { file_path: `/work/file-${id}.ts` }, ...extra,
});
const reads = (start, count) => Array.from({ length: count }, (_, i) => readTool(start + i));
const fold = (items, agent = "claude") => groupReadOnlyTools(items, agent, "/work");
const kinds = (items) => items.map((item) => item.kind);

t("3 个连续成功 read 合为一组，原工具引用/顺序与输入保持不变", () => {
  const input = reads(1, 3);
  input.forEach(Object.freeze);
  Object.freeze(input);
  const grouped = fold(input);
  assert.deepEqual(kinds(grouped), ["tool-group"]);
  assert.equal(grouped[0].summary, "读取 3 个文件");
  assert.deepEqual(grouped[0].tools, input);
  grouped[0].tools.forEach((tool, index) => assert.equal(tool, input[index]));
  assert.equal(grouped[0].turn, 1);
});

t("2 个连续成功 read 保持原逐行显示", () => {
  const input = reads(1, 2);
  assert.deepEqual(fold(input), input);
  assert.deepEqual(fold([]), []);
});

t("文本将连续工具断成两段，分别判断是否达到 3 个", () => {
  const text = { kind: "text", key: "text:4", seq: 4, text: "说明", turn: 1 };
  assert.deepEqual(kinds(fold([...reads(1, 3), text, ...reads(5, 2)])), ["tool-group", "text", "tool", "tool"]);
  assert.deepEqual(kinds(fold([...reads(1, 3), text, ...reads(5, 3)])), ["tool-group", "text", "tool-group"]);
});

t("中间 error 不入组且单独可见，前后成功段各自判断", () => {
  const error = readTool(4, { status: "error" });
  const grouped = fold([...reads(1, 3), error, ...reads(5, 3)]);
  assert.deepEqual(kinds(grouped), ["tool-group", "tool", "tool-group"]);
  assert.equal(grouped[1], error);
  assert.deepEqual(kinds(fold([readTool(1), error, ...reads(5, 2)])), ["tool", "tool", "tool", "tool"]);
});

t("末尾 running 始终单独显示，前面已成功的工具照常判断", () => {
  const running = readTool(4, { status: "running" });
  const grouped = fold([...reads(1, 3), running]);
  assert.deepEqual(kinds(grouped), ["tool-group", "tool"]);
  assert.equal(grouped[1], running);
  assert.deepEqual(kinds(fold([...reads(1, 2), running])), ["tool", "tool", "tool"]);
  const completed = fold([...reads(1, 3), { ...running, status: "ok" }]);
  assert.equal(completed[0].tools.length, 4);
  assert.equal(completed[0].key, grouped[0].key, "同组追加成功项不重置组件展开状态");
});

t("unknown 状态单独显示并断开，不能当作已成功", () => {
  const unknown = readTool(4, { status: "unknown" });
  const grouped = fold([...reads(1, 3), unknown, ...reads(5, 3)]);
  assert.deepEqual(kinds(grouped), ["tool-group", "tool", "tool-group"]);
  assert.equal(grouped[1], unknown);
});

t("三家按停止结束的回合显示中性打断行而非出错", () => {
  for (const [agent, payload] of [
    ["claude", { subtype: "error_during_execution", isError: true, interrupted: true }],
    ["codex", { status: "interrupted" }],
    ["kimi", { stopReason: "cancelled" }],
  ]) {
    const [item] = buildRenderItems([ev(1, "turn_completed", payload)], agent);
    assert.equal(item.text, "已打断，可直接发消息继续", agent);
    assert.equal(item.tone, "muted", agent);
  }
  assert.equal(buildRenderItems([ev(1, "turn_completed", { subtype: "error_during_execution", isError: true })], "claude")[0].tone, "error");
});

t("跨 turn 的工具不能合并（包括没有可见系统行的正常 turn_completed）", () => {
  const nextTurn = reads(4, 3).map((tool) => ({ ...tool, turn: 2 }));
  assert.deepEqual(kinds(fold([...reads(1, 3), ...nextTurn])), ["tool-group", "tool-group"]);
  assert.deepEqual(kinds(fold([...reads(1, 2), ...nextTurn.slice(0, 2)])), ["tool", "tool", "tool", "tool"]);
  const events = [];
  let seq = 0;
  for (let id = 1; id <= 6; id++) {
    if (id === 4) events.push(ev(++seq, "turn_completed", { subtype: "success" }));
    events.push(ev(++seq, "tool_call_started", { toolCallId: String(id), toolName: "Read", input: { file_path: `/work/${id}` } }));
    events.push(ev(++seq, "tool_call_completed", { toolCallId: String(id), result: "ok" }));
  }
  assert.deepEqual(kinds(fold(buildRenderItems(events, "claude"))), ["tool-group", "tool-group"]);
});

t("读取同一文件多次：按去重路径计文件数，括号补总次数", () => {
  const input = [...reads(1, 3), readTool(4, { rawInput: { path: "/work/file-1.ts" } }),
    readTool(5, { rawInput: { file_path: "file-2.ts" } })];
  assert.equal(fold(input)[0].summary, "读取 3 个文件（5 次）");
  assert.equal(fold([input[0], { ...input[0], key: "copy:1" }, { ...input[0], key: "copy:2" }])[0].summary, "读取 1 个文件（3 次）");
});

t("read/grep/glob 混合按类计数，摘要只列出现的类且顺序固定", () => {
  const grep = (id) => readTool(id, { toolName: "Grep", baseToolName: "Grep", rawInput: { pattern: "TODO" } });
  const glob = (id) => readTool(id, { toolName: "Glob", baseToolName: "Glob", rawInput: { pattern: "*.ts" } });
  assert.equal(fold([glob(1), grep(2), readTool(3), grep(4), glob(5)])[0].summary, "读取 1 个文件 · 搜索 2 次 · 列出 2 次");
  assert.equal(fold([grep(1), glob(2), glob(3)])[0].summary, "搜索 1 次 · 列出 2 次");
});

t("edit/command 及抓取、网页搜索、写入、删除、移动、未知工具均不入组", () => {
  const excluded = ["Edit", "MultiEdit", "Write", "Bash", "commandExecution", "fileChange", "WebFetch", "FetchURL", "webSearch", "TodoWrite", "Task", "mcpToolCall", "custom", "搜索", "列出"];
  for (const name of excluded) {
    const tool = readTool(4, { toolName: name, baseToolName: name });
    const grouped = fold([...reads(1, 3), tool, ...reads(5, 3)]);
    assert.deepEqual(kinds(grouped), ["tool-group", "tool", "tool-group"], name);
    assert.equal(grouped[1], tool, name);
  }
  for (const toolKind of ["execute", "fetch", "edit", "delete", "move"]) {
    const tool = readTool(4, { toolKind, baseToolName: "custom", toolName: "custom" });
    assert.equal(fold([...reads(1, 3), tool])[1], tool, toolKind);
  }
});

t("复用摘要器的 ACP kind、Kimi 人话标题和旧 JSON 入参分类", () => {
  const tools = [
    readTool(1, { baseToolName: "custom", toolName: "Reading /work/a.ts", rawInput: undefined }),
    readTool(2, { baseToolName: "custom", toolName: "Searching for 'TODO'", toolKind: "read" }),
    readTool(3, { baseToolName: "custom", toolName: "Searching *.ts", toolKind: "read" }),
  ];
  assert.equal(fold(tools, "kimi")[0].summary, "读取 1 个文件 · 搜索 1 次 · 列出 1 次");
  const old = readTool(1, { rawInput: undefined, input: '{"file_path":"/work/old.ts"}' });
  assert.equal(fold([old, { ...old, key: "old:2" }, { ...old, key: "old:3" }])[0].summary, "读取 1 个文件（3 次）");
  const search = readTool(1, { baseToolName: "webSearch", toolName: "webSearch", toolKind: "search" });
  assert.equal(fold([search, { ...search, key: "search:2" }, { ...search, key: "search:3" }])[0].summary, "搜索 3 次", "kind 优先的分类与摘要器一致");
});

t("所有非工具条目都断开，Focus 过滤不会让工具跨隐藏项合并", () => {
  const boundaries = [
    { kind: "thought", key: "thought:4", seq: 4, turn: 1, text: "思考" },
    { kind: "user", key: "user:4", seq: 4, text: "用户" },
    gateFromEvent(ev(4, "permission_request", { requestId: "r" }), "claude"),
    { kind: "system", key: "sys:4", seq: 4, text: "系统", tone: "muted" },
    { kind: "raw", key: "raw:4", seq: 4, text: "原始行" },
    { kind: "external-history", key: "history:4", seq: 4, messages: [], truncated: false },
  ];
  for (const boundary of boundaries) {
    const grouped = fold([...reads(1, 2), boundary, ...reads(5, 2)]);
    assert.deepEqual(kinds(grouped), ["tool", "tool", boundary.kind, "tool", "tool"], boundary.kind);
  }
  assert.deepEqual(fold(reads(1, 3)).filter(focusVisible), []);
  const text = { kind: "text", key: "text:4", seq: 4, turn: 1, text: "回复" };
  const error = { kind: "system", key: "sys:8", seq: 8, text: "错误", tone: "error" };
  assert.deepEqual(fold([...reads(1, 3), text, ...reads(5, 3), error]).filter(focusVisible), [text, error]);
});

t("历史与续聊消息归一后使用同一分组函数，保留文字/用户/unknown 边界", () => {
  const historyRead = (id, status = "ok") => ({ role: "tool", timestamp: null,
    tool: { id: String(id), name: "Read", input: { file_path: `/work/${id}` }, result: "ok", status } });
  const input = [historyRead(1), historyRead(2), historyRead(3),
    { role: "user", text: "下一回合", timestamp: null }, historyRead(4), historyRead(5), historyRead(6),
    { role: "assistant", text: "回复", timestamp: null }, historyRead(7), historyRead(8, "unknown"), historyRead(9)];
  const items = buildHistoryRenderItems(input);
  assert.notEqual(items[0].turn, items[4].turn);
  const grouped = fold(items);
  assert.deepEqual(kinds(grouped), ["tool-group", "user", "tool-group", "text", "tool", "tool", "tool"]);
  assert.equal(grouped[5].status, "unknown");
  assert.deepEqual(kinds(grouped.filter(focusVisible)), ["user", "text"]);
});

// ══ render-items：文本/思考合并 ══
t("连续 agent_text_delta 合并成一块", () => {
  const items = buildRenderItems(
    [ev(1, "agent_text_delta", { text: "你好" }), ev(2, "agent_text_delta", { text: "世界" })],
    "claude",
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "text");
  assert.equal(items[0].text, "你好世界");
});

t("user_message 打断文本合并（前后各成一块）", () => {
  const items = buildRenderItems(
    [
      ev(1, "agent_text_delta", { text: "前" }),
      ev(2, "user_message", { text: "插话" }),
      ev(3, "agent_text_delta", { text: "后" }),
    ],
    "claude",
  );
  assert.deepEqual(items.map((i) => i.kind), ["text", "user", "text"]);
  assert.equal(items[2].text, "后");
});

t("外部续聊事件归一成历史区，排在新一轮用户消息之前", () => {
  const items = buildRenderItems([
    ev(1, "agent_text_delta", { text: "旧回复" }),
    ev(2, "external_messages_added", {
      nativeSessionId: "native-1",
      messages: [
        { role: "user", text: "外部提问", timestamp: null },
        { role: "assistant", text: "外部回答", timestamp: "2026-09-27T00:00:00.000Z" },
      ],
      truncated: false,
    }),
    ev(3, "user_message", { text: "工作台续聊" }),
    ev(4, "agent_text_delta", { text: "新回复" }),
  ], "claude");
  assert.deepEqual(items.map((item) => item.kind), ["text", "external-history", "user", "text"]);
  assert.deepEqual(items[1].messages.map((message) => `${message.role}:${message.text}`), [
    "user:外部提问", "assistant:外部回答",
  ]);
  assert.equal(items[1].truncated, false);
  assert.equal(items[2].text, "工作台续聊");
});

t("worker_released 渲染成弱化系统行（手动 / 空闲带分钟数）", () => {
  const items = buildRenderItems([
    ev(1, "agent_text_delta", { text: "旧回复" }),
    ev(2, "worker_released", { reason: "manual", resumeCommand: "cd '/work' && claude --resume abc" }),
    ev(3, "worker_released", { reason: "idle", idleMinutes: 30, resumeCommand: "cd '/work' && claude --resume abc" }),
    ev(4, "user_message", { text: "续接发送" }),
  ], "claude");
  assert.deepEqual(items.map((item) => item.kind), ["text", "system", "system", "user"]);
  assert.equal(items[1].text, "已释放（手动）；下次发送时从磁盘续接");
  assert.equal(items[1].tone, "muted");
  assert.equal(items[2].text, "已释放（空闲 30 分钟）；下次发送时从磁盘续接");
});

t("thought_delta 独立合并，与文本互不混入", () => {
  const items = buildRenderItems(
    [
      ev(1, "thought_delta", { text: "想" }),
      ev(2, "thought_delta", { text: "想" }),
      ev(3, "agent_text_delta", { text: "说" }),
    ],
    "claude",
  );
  assert.deepEqual(items.map((i) => i.kind), ["thought", "text"]);
  assert.equal(items[0].text, "想想");
});

t("乱序到达的事件按 seq 排序后再折叠", () => {
  const items = buildRenderItems(
    [ev(3, "agent_text_delta", { text: "c" }), ev(1, "agent_text_delta", { text: "a" }), ev(2, "agent_text_delta", { text: "b" })],
    "claude",
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "abc");
});

// ══ render-items：工具调用按 toolCallId 聚合三阶段 ══
t("工具三阶段聚合为一张卡片（updated 补输入，completed 落定状态与结果）", () => {
  const items = buildRenderItems(
    [
      ev(1, "tool_call_started", { toolCallId: "t1", toolName: "Bash" }),
      ev(2, "tool_call_updated", { toolCallId: "t1", partialInput: "npm test" }),
      ev(3, "tool_call_completed", { toolCallId: "t1", result: "ok-done" }),
    ],
    "claude",
  );
  assert.equal(items.length, 1);
  const tool = items[0];
  assert.equal(tool.kind, "tool");
  assert.equal(tool.input, "npm test");
  assert.equal(tool.status, "ok");
  assert.equal(tool.result, "ok-done");
});

t("工具 isError 置 error 态；kimi 的 content 兜底作结果", () => {
  const items = buildRenderItems(
    [
      ev(1, "tool_call_started", { toolCallId: "t1", toolName: "terminal" }),
      ev(2, "tool_call_completed", { toolCallId: "t1", isError: true, content: "拒绝执行" }),
    ],
    "kimi",
  );
  assert.equal(items[0].status, "error");
  assert.equal(items[0].result, "拒绝执行");
});

t("claude 的 result 块数组提取 text 块并换行拼接", () => {
  const items = buildRenderItems(
    [
      ev(1, "tool_call_started", { toolCallId: "t1", toolName: "Read" }),
      ev(2, "tool_call_completed", {
        toolCallId: "t1",
        result: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }],
      }),
    ],
    "claude",
  );
  assert.equal(items[0].result, "甲\n乙");
});

t("闸门请求与结果按 requestId 聚合（permission_resolved 回写 decision）", () => {
  const items = buildRenderItems(
    [
      ev(1, "permission_request", { requestId: "r1", toolName: "Bash", input: { command: "rm x" } }),
      ev(2, "permission_resolved", { requestId: "r1", decision: "allow" }),
    ],
    "claude",
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "gate");
  assert.equal(items[0].decision, "allow");
});

// ══ render-items：gateFromEvent 三家命令提取 ══
t("claude Bash：input.command 字符串原样取", () => {
  const view = gateFromEvent(
    ev(1, "permission_request", { requestId: "r1", toolName: "Bash", input: { command: "npm test" } }),
    "claude",
  );
  assert.equal(view.command, "npm test");
  assert.equal(view.toolName, "Bash");
});

t("kimi terminal：input.command + args 拼接", () => {
  const view = gateFromEvent(
    ev(1, "permission_request", { requestId: "r1", toolName: "terminal", input: { command: "ls", args: ["-la", "/tmp"] } }),
    "kimi",
  );
  assert.equal(view.command, "ls -la /tmp");
});

t("codex commandExecution：input.command 字符串数组拼接", () => {
  const view = gateFromEvent(
    ev(1, "permission_request", { requestId: "r1", toolName: "commandExecution", input: { command: ["git", "status"] } }),
    "codex",
  );
  assert.equal(view.command, "git status");
});

t("路径提取：path 优先，file_path 兜底", () => {
  const byPath = gateFromEvent(ev(1, "permission_request", { requestId: "r", input: { path: "a.ts" } }), "claude");
  const byFilePath = gateFromEvent(ev(1, "permission_request", { requestId: "r", input: { file_path: "b.ts" } }), "claude");
  assert.equal(byPath.path, "a.ts");
  assert.equal(byFilePath.path, "b.ts");
});

t("claude Edit：old_string/new_string 进 removed/added，无 editChunks", () => {
  const view = gateFromEvent(
    ev(1, "permission_request", { requestId: "r", toolName: "Edit", input: { old_string: "旧", new_string: "新" } }),
    "claude",
  );
  assert.equal(view.removed, "旧");
  assert.equal(view.added, "新");
  assert.equal(view.editChunks, undefined);
});

t("claude MultiEdit：edits[] 按 edit 分组出「改动 #n」，removed/added 仍保留拼接兜底", () => {
  const view = gateFromEvent(
    ev(1, "permission_request", {
      requestId: "r",
      toolName: "MultiEdit",
      input: { edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] },
    }),
    "claude",
  );
  assert.equal(view.editChunks.length, 2);
  assert.equal(view.editChunks[0].title, "改动 #1");
  assert.deepEqual(view.editChunks.map((c) => [c.removed, c.added]), [["a", "b"], ["c", "d"]]);
  assert.equal(view.removed, "a\nc");
  assert.equal(view.added, "b\nd");
});

t("AskUserQuestion：interactionType + questions 归一成结构化提问", () => {
  const view = gateFromEvent(
    ev(1, "permission_request", {
      requestId: "r",
      toolName: "AskUserQuestion",
      interactionType: "ask_user_question",
      questions: [{ question: "继续吗？", options: [{ label: "是" }, { label: "否", description: "不继续" }] }],
    }),
    "claude",
  );
  assert.equal(view.questions.length, 1);
  assert.equal(view.questions[0].question, "继续吗？");
  assert.equal(view.questions[0].multiSelect, false);
  assert.equal(view.questions[0].options[1].description, "不继续");
});

t("questions 全部无效时回退普通审批卡片（questions 字段缺省）", () => {
  const view = gateFromEvent(
    ev(1, "permission_request", { requestId: "r", interactionType: "ask_user_question", questions: [{ question: "" }] }),
    "claude",
  );
  assert.equal(view.questions, undefined);
});

// ══ commands：isSubsequence ══
t("isSubsequence 基本判定", () => {
  assert.equal(isSubsequence("cmp", "compact"), true);
  assert.equal(isSubsequence("cpm", "compact"), false);
  assert.equal(isSubsequence("", "anything"), true);
});

// ══ commands：filterCommands 三段排序（原行为不变） ══
const TABLE = [
  cmd("compact", "压缩上下文"),
  cmd("commit", "提交更改"),
  cmd("review", "代码复核"),
  cmd("help", "显示帮助 compact 信息"),
];

t("空 query 无 recent：返回原表原序", () => {
  assert.deepEqual(names(filterCommands(TABLE, "")), ["compact", "commit", "review", "help"]);
});

t("名称前缀 > 名称子序列 > 描述子串", () => {
  // "com"：前缀命中 compact/commit；子序列命中无；描述命中 help（含 compact 字样）
  assert.deepEqual(names(filterCommands(TABLE, "com")), ["compact", "commit", "help"]);
  // "rvw"：仅 review 子序列命中
  assert.deepEqual(names(filterCommands(TABLE, "rvw")), ["review"]);
});

t("组内保持命令表原顺序", () => {
  assert.deepEqual(names(filterCommands(TABLE, "com", [])).slice(0, 2), ["compact", "commit"]);
});

t("客户端命令：Claude /btw 与 /mcp，Codex /side 与 /btw；同名 CLI 项去重，Kimi 不加", () => {
  assert.deepEqual(names(withSideCommands("claude", [cmd("btw", "CLI"), cmd("mcp", "CLI"), cmd("compact", "x")])), ["btw", "mcp", "compact"]);
  assert.equal(withSideCommands("claude", [cmd("btw", "CLI")])[0].argHint, "问题");
  assert.deepEqual(names(withSideCommands("codex", TABLE)).slice(0, 2), ["side", "btw"]);
  assert.deepEqual(names(withSideCommands("kimi", TABLE)), names(TABLE));
  assert.equal(parseSideCommand("claude", "/btw  这是什么？\n第二行 "), "这是什么？\n第二行");
  assert.equal(parseSideCommand("claude", "/btw"), "");
  assert.equal(parseSideCommand("claude", "/side 问题"), null);
  assert.equal(parseSideCommand("claude", "/mcp"), null);
  assert.equal(parseSideCommand("codex", "/side 问题"), "问题");
  assert.equal(parseSideCommand("codex", "/btw"), "");
  assert.equal(parseSideCommand("codex", "/btwx 问题"), null);
  assert.equal(parseSideCommand("kimi", "/btw 问题"), null);
  assert.equal(parseSideCommand("claude", "说 /btw 问题"), null);
});

// ══ commands：最近使用 ══
t("空 query 有 recent：最近使用置顶，其余保持表序；不在表内的名字跳过", () => {
  const out = filterCommands(TABLE, "", ["review", "已删除命令", "compact"]);
  assert.deepEqual(names(out), ["review", "compact", "commit", "help"]);
});

t("有 query 时 recent 作组内加权：同组内最近用过的先出", () => {
  const out = filterCommands(TABLE, "com", ["commit"]);
  assert.deepEqual(names(out), ["commit", "compact", "help"]);
});

t("recent 加权不跨段：只命中描述的 recent 不会越过前缀段", () => {
  const out = filterCommands(TABLE, "com", ["help"]);
  assert.deepEqual(names(out), ["compact", "commit", "help"]);
});

t("recentInTable 只保留仍在表内的命令，按最近序", () => {
  assert.deepEqual(names(recentInTable(TABLE, ["nope", "review", "compact"])), ["review", "compact"]);
});

// localStorage 纪律：node 环境通常没有 localStorage，必须无声降级（运行环境自带时此例不适用，跳过）
t("无 localStorage：读为空、写不抛", () => {
  if (typeof localStorage !== "undefined") return;
  assert.deepEqual(readRecentCommands("claude"), []);
  noteCommandUsed("claude", "compact"); // 不抛即过
});

// 打桩 localStorage：验证去重置顶、上限截断、坏数据兜底（恢复现场，不污染后续）
t("noteCommandUsed：去重置顶 + 截断到上限；坏 JSON 读为空", () => {
  const had = "localStorage" in globalThis;
  const original = globalThis.localStorage;
  const backing = new Map();
  globalThis.localStorage = {
    getItem: (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k, v) => backing.set(k, String(v)),
    removeItem: (k) => backing.delete(k),
  };
  try {
    noteCommandUsed("claude", "a");
    noteCommandUsed("claude", "b");
    noteCommandUsed("claude", "a"); // 重复使用：去重置顶
    assert.deepEqual(readRecentCommands("claude"), ["a", "b"]);
    for (let i = 0; i < 20; i++) noteCommandUsed("claude", `c${i}`);
    const recent = readRecentCommands("claude");
    assert.equal(recent.length, MAX_RECENT_COMMANDS, "超过上限必须截断");
    assert.equal(recent[0], "c19", "最新的在最前");
    // 每 agent 独立
    noteCommandUsed("kimi", "k1");
    assert.deepEqual(readRecentCommands("kimi"), ["k1"]);
    assert.notDeepEqual(readRecentCommands("claude"), ["k1"]);
    // 坏数据兜底
    backing.set("workbench-cmd-recent-codex", "{不是JSON");
    assert.deepEqual(readRecentCommands("codex"), []);
    backing.set("workbench-cmd-recent-codex", JSON.stringify({ nope: 1 }));
    assert.deepEqual(readRecentCommands("codex"), []);
  } finally {
    if (had) globalThis.localStorage = original;
    else delete globalThis.localStorage;
  }
});

t("promptCacheExpiry：起点取最近一次 usage，TTL 取最近一次写缓存的分项（1h/5m），没有 usage 或判定不了为 null", () => {
  const usage = (timestamp, cache_creation) => ({ type: "usage_updated", timestamp, payload: { usage: cache_creation ? { cache_creation } : {} } });
  const t0 = Date.parse("2026-09-26T10:00:00Z");
  assert.equal(promptCacheExpiry([]), null);
  assert.equal(
    promptCacheExpiry([usage("2026-09-26T09:00:00Z", { ephemeral_1h_input_tokens: 500, ephemeral_5m_input_tokens: 0 }), usage("2026-09-26T10:00:00Z", { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 })]),
    t0 + 3600_000,
    "只读缓存的回合也续期：起点是最近一次，TTL 来自更早写过的那次",
  );
  assert.equal(promptCacheExpiry([usage("2026-09-26T10:00:00Z", { ephemeral_5m_input_tokens: 9 })]), t0 + 300_000);
  assert.equal(promptCacheExpiry([usage("2026-09-26T10:00:00Z", null)]), null, "没有 cache_creation 分项就不猜");
});

t("正常与旧版无字段的 turn_completed 不显示，三家异常均带原因", () => {
  const cases = [
    ["claude", { subtype: "success", isError: false }, null],
    ["claude", { subtype: "error_max_turns", isError: true }, "已达到回合数上限", "error_max_turns"],
    ["codex", { status: "completed" }, null],
    ["codex", { status: "failed", error: { message: "执行失败" } }, "执行失败", "failed"],
    ["kimi", { stopReason: "end_turn" }, null],
    ["kimi", { stopReason: "max_tokens" }, "已达到输出长度上限", "max_tokens"],
    ["claude", { subtype: "constructor", isError: true }, "执行未正常完成", "constructor"],
    ["kimi", { stopReason: "unknown_reason" }, "执行未正常完成", "unknown_reason"],
    ["claude", {}, null], ["codex", {}, null], ["kimi", {}, null],
  ];
  for (const [agent, payload, reason, rawCode] of cases) {
    const items = buildRenderItems([ev(1, "turn_completed", payload)], agent);
    if (reason) {
      assert.match(items[0].text, new RegExp(reason));
      if (rawCode) assert.equal(items[0].rawCode, rawCode);
    }
    else assert.equal(items.length, 0);
  }
});

t("external history accepts old text events and new mixed tool events", () => {
  const old = { role: "assistant", text: "old", timestamp: null };
  const tool = { role: "tool", timestamp: null, tool: { id: "t", name: "Bash", input: { command: "pwd" }, result: "/repo", status: "ok" } };
  const items = buildRenderItems([
    ev(1, "external_messages_added", { messages: [old], truncated: false }),
    ev(2, "external_messages_added", { messages: [{ role: "user", text: "new" }, tool, old], truncated: true }),
  ], "claude");
  assert.equal(items[0].kind, "external-history");
  assert.deepEqual(items[0].messages, [old]);
  assert.deepEqual(items[1].messages.map(m => m.role), ["user", "tool", "assistant"]);
  assert.equal(items[1].messages[1].tool.result, "/repo");
  assert.equal(items[1].truncated, true);
});

if (!process.exitCode) console.log(`✅ render-items / commands 单测全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
