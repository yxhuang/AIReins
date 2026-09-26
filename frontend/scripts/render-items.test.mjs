#!/usr/bin/env node
// render-items.ts（文本合并 / 工具聚合 / gateFromEvent 三家命令提取）
// 与 commands.ts（filterCommands 筛选 + 最近使用）的纯函数单测——两处都是「代码复核」热点，
// 坏了不一定报错，只会静默渲染错/排序错。
import { strict as assert } from "node:assert";

// 用 tsx 把 TS 模块加载进来
const { buildRenderItems, gateFromEvent, promptCacheExpiry } = await import("../src/render-items.ts");
const {
  filterCommands,
  isSubsequence,
  readRecentCommands,
  noteCommandUsed,
  recentInTable,
  MAX_RECENT_COMMANDS,
} = await import("../src/commands.ts");

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

if (!process.exitCode) console.log(`✅ render-items / commands 单测全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
