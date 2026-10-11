import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryIndex, HistoryQueryError } from "./history.js";

const fixture = await mkdtemp(join(tmpdir(), "workbench-history-test-"));
const roots = {
  claude: join(fixture, "claude"),
  codex: join(fixture, "codex"),
  kimi: join(fixture, "kimi"),
  workbenchRegistry: join(fixture, "workbench", "sessions.json"),
};
await Promise.all([
  mkdir(join(roots.claude, "project"), { recursive: true }),
  mkdir(join(roots.codex, "2026", "08", "22"), { recursive: true }),
  mkdir(join(roots.kimi, "workspace", "session_kimi_test", "agents", "main"), { recursive: true }),
  mkdir(join(roots.kimi, "workspace", "session_kimi_legacy"), { recursive: true }),
  mkdir(join(fixture, "workbench"), { recursive: true }),
]);

const interactiveClaudeId = "11111111-1111-4111-8111-111111111111";
const workbenchClaudeId = "22222222-2222-4222-8222-222222222222";
const interactiveClaudePath = join(roots.claude, "project", `${interactiveClaudeId}.jsonl`);
const workbenchClaudePath = join(roots.claude, "project", `${workbenchClaudeId}.jsonl`);
const badClaudePath = join(roots.claude, "project", "33333333-3333-4333-8333-333333333333.jsonl");
const emptyClaudePath = join(roots.claude, "project", "44444444-4444-4444-8444-444444444444.jsonl");

await writeJsonl(interactiveClaudePath, [
  {
    type: "user",
    cwd: "/repo/interactive",
    entrypoint: "cli",
    isMeta: true,
    message: { role: "user", content: "<local-command-caveat>ignore me</local-command-caveat>" },
  },
  {
    type: "user",
    cwd: "/repo/interactive",
    entrypoint: "cli",
    message: { role: "user", content: "<system-reminder>hook injection</system-reminder>" },
  },
  {
    type: "user",
    cwd: "/repo/interactive",
    entrypoint: "cli",
    timestamp: "2026-08-22T00:00:00.000Z",
    message: { role: "user", content: "真正的人类标题" },
  },
  {
    type: "assistant",
    timestamp: "2026-08-22T00:00:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "预览回复" }] },
  },
  {
    type: "user",
    timestamp: "2026-08-22T00:00:02.000Z",
    message: { role: "user", content: "Claude 第二问" },
  },
  {
    type: "assistant",
    timestamp: "2026-08-22T00:00:03.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Claude 第二答" }] },
  },
  {
    type: "user",
    timestamp: "2026-08-22T00:00:04.000Z",
    message: { role: "user", content: "Claude 第三问" },
  },
  {
    type: "assistant",
    timestamp: "2026-08-22T00:00:05.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "Claude 第三答" }] },
  },
]);
await writeJsonl(workbenchClaudePath, [{
  type: "user",
  cwd: "/repo/workbench",
  entrypoint: "sdk-cli",
  message: { role: "user", content: [{ type: "text", text: "工作台标题" }] },
}]);
await writeFile(badClaudePath, "not json\n", "utf8");
await writeFile(emptyClaudePath, "", "utf8");

const codexId = "55555555-5555-4555-8555-555555555555";
const codexPath = join(roots.codex, "2026", "08", "22", `rollout-2026-08-22T00-00-00-${codexId}.jsonl`);
await writeJsonl(codexPath, [
  { type: "session_meta", payload: { id: codexId, cwd: "/repo/codex", originator: "codex-tui", source: "cli" } },
  {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>injected</environment_context>" }] },
  },
  {
    type: "response_item",
    timestamp: "2026-08-22T00:00:02.000Z",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex 真实标题" }] },
  },
  { type: "event_msg", timestamp: "2026-08-22T00:00:02.000Z", payload: { type: "user_message", message: "Codex 真实标题" } },
  {
    type: "response_item",
    timestamp: "2026-08-22T00:00:03.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex 第一答" }] },
  },
  { type: "event_msg", timestamp: "2026-08-22T00:00:03.000Z", payload: { type: "agent_message", message: "Codex 第一答" } },
  {
    type: "response_item",
    timestamp: "2026-08-22T00:00:04.000Z",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex 第二问" }] },
  },
  { type: "event_msg", timestamp: "2026-08-22T00:00:04.000Z", payload: { type: "user_message", message: "Codex 第二问" } },
  {
    type: "response_item",
    timestamp: "2026-08-22T00:00:05.000Z",
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex 第二答" }] },
  },
  { type: "event_msg", timestamp: "2026-08-22T00:00:05.000Z", payload: { type: "agent_message", message: "Codex 第二答" } },
]);

const kimiId = "session_kimi_test";
const kimiStatePath = join(roots.kimi, "workspace", kimiId, "state.json");
const kimiWirePath = join(roots.kimi, "workspace", kimiId, "agents", "main", "wire.jsonl");
const legacyKimiStatePath = join(roots.kimi, "workspace", "session_kimi_legacy", "state.json");
await writeFile(kimiStatePath, JSON.stringify({ id: kimiId, version: 2, cwd: "/repo/kimi", custom: {} }), "utf8");
await writeJsonl(kimiWirePath, [
  { type: "metadata", protocol_version: "1.5" },
  { type: "turn.prompt", input: [{ type: "text", text: "<system-reminder>injected</system-reminder>" }], time: 1_787_400_000_000 },
  { type: "turn.prompt", input: [{ type: "text", text: "Kimi 真实标题" }], time: 1_787_400_000_100 },
  { type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "Kimi 第一答" } }, time: 1_787_400_000_200 },
  { type: "turn.prompt", input: [{ type: "text", text: "Kimi 第二问" }], time: 1_787_400_000_300 },
  { type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "Kimi 第二答" } }, time: 1_787_400_000_400 },
]);
await writeFile(legacyKimiStatePath, JSON.stringify({
  workDir: "/repo/kimi-legacy",
  title: "Kimi 旧版标题",
  agents: {},
  custom: {},
}), "utf8");
await writeFile(roots.workbenchRegistry, `${JSON.stringify([{ agent: "kimi", nativeSessionId: kimiId }])}\n`, "utf8");

const now = Date.now() / 1_000;
await Promise.all([
  utimes(interactiveClaudePath, now - 1, now - 1),
  utimes(workbenchClaudePath, now - 2, now - 2),
  utimes(codexPath, now - 3, now - 3),
  utimes(kimiStatePath, now - 4, now - 4),
  utimes(legacyKimiStatePath, now - 4.5, now - 4.5),
  utimes(badClaudePath, now - 5, now - 5),
  utimes(emptyClaudePath, now - 6, now - 6),
]);

const history = new HistoryIndex({ roots, timeoutMs: 3_000 });
const all = await history.list({ limit: 20 });
assert.equal(all.discovered, 7);
assert.equal(all.sessions.length, 4);
assert.equal(all.empty, 1, "有标题但没有 wire 用户消息的旧 Kimi 会话隐藏");
assert.equal(all.skipped, 2);
assert.equal(all.truncated, false);
assert.deepEqual(all.sessions.map((session) => session.title), [
  "真正的人类标题",
  "工作台标题",
  "Codex 真实标题",
  "Kimi 真实标题",
]);
assert.equal(findSession(all, "claude", interactiveClaudeId).source, "interactive");
assert.equal(findSession(all, "claude", workbenchClaudeId).source, "workbench");
assert.equal(findSession(all, "codex", codexId).source, "interactive");
assert.equal(findSession(all, "kimi", kimiId).source, "workbench");

// claude-vscode 身份须靠注册表区分工作台新建与导入；Kimi 导入同样不能误标。
const vscodeCreatedId = "66666666-6666-4666-8666-666666666666";
const vscodeImportedId = "77777777-7777-4777-8777-777777777777";
for (const id of [vscodeCreatedId, vscodeImportedId]) {
  await writeJsonl(join(roots.claude, "project", `${id}.jsonl`), [{
    type: "user", cwd: "/repo/vscode", entrypoint: "claude-vscode",
    message: { role: "user", content: `会话 ${id}` },
  }]);
}
const importedKimiId = "session_kimi_imported";
await mkdir(join(roots.kimi, "workspace", importedKimiId, "agents", "main"), { recursive: true });
await writeFile(join(roots.kimi, "workspace", importedKimiId, "state.json"), JSON.stringify({
  id: importedKimiId, cwd: "/repo/kimi-imported", title: "导入的 Kimi 会话", custom: {},
}), "utf8");
await writeJsonl(join(roots.kimi, "workspace", importedKimiId, "agents", "main", "wire.jsonl"), [
  { type: "turn.prompt", input: [{ type: "text", text: "导入前" }] },
]);
await writeFile(roots.workbenchRegistry, JSON.stringify([
  { agent: "kimi", nativeSessionId: kimiId },
  { agent: "kimi", nativeSessionId: importedKimiId, resumedFrom: { agent: "kimi", nativeSessionId: importedKimiId } },
  { agent: "claude", nativeSessionId: vscodeCreatedId },
  { agent: "claude", nativeSessionId: vscodeImportedId, resumedFrom: { agent: "claude", nativeSessionId: vscodeImportedId } },
]), "utf8");
const classified = await history.list({ limit: 20 });
assert.equal(findSession(classified, "claude", vscodeCreatedId).source, "workbench");
assert.equal(findSession(classified, "claude", vscodeImportedId).source, "interactive");
assert.equal(findSession(classified, "claude", workbenchClaudeId).source, "workbench");
assert.equal(findSession(classified, "kimi", importedKimiId).source, "unknown");
assert.equal(findSession(classified, "kimi", kimiId).source, "workbench");

const filtered = await history.list({ q: "REPO/CODEX", limit: 20 });
assert.deepEqual(filtered.sessions.map((session) => session.nativeSessionId), [codexId]);

const firstPage = await history.list({ limit: 2 });
assert.equal(firstPage.sessions.length, 2);
assert.ok(firstPage.nextCursor);
const secondPage = await history.list({ limit: 20, cursor: firstPage.nextCursor });
assert.equal(secondPage.sessions.length, 5);
assert.equal(new Set([...firstPage.sessions, ...secondPage.sessions].map((session) => session.nativeSessionId)).size, 7);

const claudePages = await readAllMessages(history, "claude", interactiveClaudeId, 2);
assert.deepEqual(claudePages.map((message) => `${message.role}:${"text" in message ? message.text : message.tool.name}`), [
  "user:真正的人类标题",
  "assistant:预览回复",
  "user:Claude 第二问",
  "assistant:Claude 第二答",
  "user:Claude 第三问",
  "assistant:Claude 第三答",
]);
const codexMessages = await readAllMessages(history, "codex", codexId, 2);
assert.deepEqual(codexMessages.map((message) => `${message.role}:${"text" in message ? message.text : message.tool.name}`), [
  "user:Codex 真实标题",
  "assistant:Codex 第一答",
  "user:Codex 第二问",
  "assistant:Codex 第二答",
]);
const kimiMessages = await readAllMessages(history, "kimi", kimiId, 2);
assert.deepEqual(kimiMessages.map((message) => `${message.role}:${"text" in message ? message.text : message.tool.name}`), [
  "user:Kimi 真实标题",
  "assistant:Kimi 第一答",
  "user:Kimi 第二问",
  "assistant:Kimi 第二答",
]);
assert.ok([...claudePages, ...codexMessages, ...kimiMessages].every((message) => message.timestamp !== null));

await assert.rejects(
  () => history.messages("codex", codexId, {
    limit: 2,
    cursor: Buffer.from(JSON.stringify({
      version: 1,
      agent: "claude",
      nativeSessionId: interactiveClaudeId,
      offset: 1,
    })).toString("base64url"),
  }),
  (error: unknown) => error instanceof HistoryQueryError,
);

const capped = await new HistoryIndex({ roots, maxDiscovered: 2 }).list({ limit: 20 });
assert.equal(capped.discovered, 2);
assert.equal(capped.truncated, true);

await assert.rejects(
  () => history.list({ limit: 20, cursor: "bad-cursor" }),
  (error: unknown) => error instanceof HistoryQueryError,
);

console.log(JSON.stringify({
  fixture,
  discovered: all.discovered,
  returned: all.sessions.length,
  skipped: all.skipped,
  titles: all.sessions.map((session) => session.title),
  pagination: [firstPage.sessions.length, secondPage.sessions.length],
  historyMessages: {
    claude: claudePages.length,
    codex: codexMessages.length,
    kimi: kimiMessages.length,
  },
}));

async function writeJsonl(path: string, records: unknown[]): Promise<void> {
  await writeFile(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function findSession(result: { sessions: Array<{ agent: string; nativeSessionId: string; source: string }> }, agent: string, id: string) {
  const session = result.sessions.find((item) => item.agent === agent && item.nativeSessionId === id);
  assert.ok(session, `${agent}:${id} should exist`);
  return session;
}

async function readAllMessages(
  history: HistoryIndex,
  agent: "claude" | "codex" | "kimi",
  nativeSessionId: string,
  limit: number,
) {
  const pages: Array<NonNullable<Awaited<ReturnType<HistoryIndex["messages"]>>>> = [];
  let cursor: string | undefined;
  do {
    const page = await history.messages(agent, nativeSessionId, { limit, ...(cursor ? { cursor } : {}) });
    assert.ok(page);
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor);
  return pages.reverse().flatMap((page) => page.messages);
}

// Tools stay in native block order; result records never masquerade as users.
const { parseHistoryMessages } = await import("./history.js");
const parse = (agent: "claude" | "codex" | "kimi", rows: unknown[]) => parseHistoryMessages(agent,
  rows.map((row, startOffset) => ({ text: JSON.stringify(row), startOffset })));
const use = { type: "assistant", uuid: "tools", cwd: "/repo/tools", message: { role: "assistant", content: [
  { type: "text", text: "before" }, { type: "tool_use", id: "a", name: "Bash", input: { command: "pwd" } },
  { type: "text", text: "between" }, { type: "tool_use", id: "b", name: "Read", input: { file_path: "/repo/a" } },
  { type: "text", text: "after" },
] } };
const result = { type: "user", uuid: "result", toolUseResult: { stdout: "hello", stderr: "" }, message: { role: "user", content: [
  { type: "tool_result", tool_use_id: "a", content: "hello", is_error: false },
  { type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "missing" }], is_error: true },
] } };
const parsed = parse("claude", [use, result, { ...use, isSidechain: true }]);
assert.deepEqual(parsed.map(m => m.role), ["assistant", "tool", "assistant", "tool", "assistant"]);
assert.ok(parsed[1]?.role === "tool" && parsed[3]?.role === "tool");
assert.equal(parsed[1].tool.status, "ok");
assert.equal(parsed[1].tool.result, "hello");
assert.deepEqual(parsed[1].tool.rawResult, result.toolUseResult);
assert.equal(parsed[3].tool.status, "error");
const longTool = parse("claude", [
  { ...use, message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "x".repeat(10000) } }] } },
  { ...result, toolUseResult: { stdout: "x".repeat(10000) }, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "x".repeat(10000) }] } },
])[0]!;
assert.ok(longTool.role === "tool");
for (const value of [longTool.tool.input, longTool.tool.result, longTool.tool.rawResult]) {
  assert.ok(JSON.stringify(value).length <= 4010);
  assert.match(JSON.stringify(value), /truncated/);
}
const codexTools = parse("codex", [
  { type: "event_msg", payload: { type: "user_message", message: "run" } },
  { type: "response_item", payload: { type: "function_call", call_id: "c", name: "functions.exec_command", arguments: '{"cmd":"pwd"}' } },
  { type: "response_item", payload: { type: "function_call_output", call_id: "c", output: "Process exited with code 1\nerror" } },
  { type: "response_item", payload: { type: "custom_tool_call", call_id: "p", name: "apply_patch", input: "*** patch" } },
  { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "p", output: "done" } },
]);
assert.equal(codexTools.length, 3);
assert.ok(codexTools[1]?.role === "tool" && codexTools[2]?.role === "tool");
assert.equal(codexTools[1].tool.name, "commandExecution");
assert.equal(codexTools[1].tool.status, "error");
assert.equal((codexTools[1].tool.input as { command: string }).command, "pwd");
assert.equal(codexTools[2].tool.result, "done");
// 真实 rollout 2026-10-01T09-50-29-00000000-0000-4000-8000-000000000019:72 的首条调用。
// exec 保持现有 HistoryTool 字段形状；历史预览与派单详情在前端共用摘要器。
const execInput = 'const results = await Promise.allSettled([tools.exec_command({cmd:"npm run -s typecheck",max_output_tokens:3000,yield_time_ms:1000})]); results.forEach(text);';
const execTools = parse("codex", [
  { type: "response_item", payload: { type: "custom_tool_call", call_id: "exec", name: "exec", input: execInput } },
  { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "exec", output: "完整结果" } },
]);
assert.equal(execTools.length, 1);
assert.ok(execTools[0]?.role === "tool");
assert.equal(execTools[0].tool.name, "exec");
assert.equal(execTools[0].tool.input, execInput);
assert.equal(execTools[0].tool.result, "完整结果");
assert.equal(execTools[0].tool.status, "unknown");
const longExecInput = JSON.parse(readFileSync(new URL("../frontend/scripts/fixtures/tool-events/codex-exec.json", import.meta.url), "utf8")).patchLongString.input as string;
assert.ok(JSON.stringify(longExecInput).length > 4000);
const [longExec] = parse("codex", [
  { type: "response_item", payload: { type: "custom_tool_call", call_id: "long", name: "functions.exec", input: longExecInput } },
  { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "long", output: "x".repeat(10000) } },
]);
assert.ok(longExec?.role === "tool");
assert.equal(longExec.tool.input, longExecInput, "exec 入参保留完整 JS，不破坏长 patch 的闭合");
assert.ok(JSON.stringify(longExec.tool.result).length <= 4000, "exec 结果仍有界");
assert.match(longExec.tool.result!, /truncated/);
const kimiTools = parse("kimi", [
  { type: "context.append_loop_event", agentId: "main", event: { type: "tool.call", toolCallId: "k", name: "Read", args: { path: "a" } } },
  { type: "context.append_loop_event", agentId: "main", event: { type: "tool.result", toolCallId: "k", result: { output: "contents" } } },
]);
assert.ok(kimiTools[0]?.role === "tool");
assert.equal(kimiTools[0].tool.result, "contents");
assert.equal(kimiTools[0].tool.status, "ok");

// limit counts every block, even several blocks on the same JSONL line.
await writeJsonl(interactiveClaudePath, [
  { type: "user", cwd: "/repo/tools", message: { role: "user", content: "tools" } }, use, result,
]);
const oneAtATime = await readAllMessages(history, "claude", interactiveClaudeId, 1);
assert.deepEqual(oneAtATime.map(m => m.role), ["user", "assistant", "tool", "assistant", "tool", "assistant"]);
assert.ok(oneAtATime[2]?.role === "tool");
assert.equal(oneAtATime[2].tool.status, "unknown", "result in a newer page is outside the cursor window");
const fullTools = await history.messages("claude", interactiveClaudeId, { limit: 20 });
assert.ok(fullTools?.messages[2]?.role === "tool");
assert.equal(fullTools.messages[2].tool.status, "ok");

await writeJsonl(codexPath, [
  { type: "session_meta", payload: { id: codexId, cwd: "/repo/codex" } },
  { type: "event_msg", payload: { type: "user_message", message: "run" } },
  { type: "response_item", payload: { type: "function_call", call_id: "c", name: "exec_command", arguments: '{"cmd":"pwd"}' } },
  { type: "event_msg", payload: { type: "agent_message", message: "waiting" } },
  { type: "response_item", payload: { type: "function_call_output", call_id: "c", output: "Process exited with code 0\n/repo" } },
]);
const codexSplit = await readAllMessages(history, "codex", codexId, 1);
assert.ok(codexSplit[1]?.role === "tool");
assert.equal(codexSplit[1].tool.status, "unknown");
console.log("history tool pairing, bounded bodies and block pagination passed");

const patchTool = parse("codex", [{ type: "response_item", payload: {
  type: "custom_tool_call", call_id: "edit", name: "apply_patch",
  input: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch",
} }])[0]!;
assert.ok(patchTool.role === "tool");
assert.equal(patchTool.tool.name, "fileChange");
assert.equal((patchTool.tool.input as { changes: Array<{ path: string }> }).changes[0]?.path, "a.ts");

// Do not merge across a tool-bearing source line: that would lose its leading text at a byte cursor boundary.
await writeJsonl(interactiveClaudePath, [
  { type: "user", cwd: "/repo/tools", message: { role: "user", content: "tools" } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "earlier" }] } },
  use, result,
]);
const boundary = await readAllMessages(history, "claude", interactiveClaudeId, 1);
assert.equal(boundary.flatMap(m => m.role === "assistant" ? [m.text] : []).join(""), "earlierbeforebetweenafter");

// endCursor：偏移量 = 消息文件当前大小（Kimi 取 agents/main/wire.jsonl）；截止在该时刻，之后追加的消息不进这页。
const claudeEndCursor = await history.endCursor("claude", interactiveClaudeId);
const kimiEndCursor = await history.endCursor("kimi", kimiId);
assert.ok(claudeEndCursor);
assert.ok(kimiEndCursor);
assert.equal(await history.endCursor("claude", "ffffffff-ffff-4fff-8fff-ffffffffffff"), undefined);
await appendFile(interactiveClaudePath, `${JSON.stringify({
  type: "user", message: { role: "user", content: "导入后的追加问题" },
})}\n`, "utf8");
await appendFile(kimiWirePath, `${JSON.stringify({
  type: "turn.prompt", input: [{ type: "text", text: "导入后的追加问题" }],
})}\n`, "utf8");
const appended = (m: { role: string; text?: string }) => "text" in m && m.text === "导入后的追加问题";
const claudeAtImport = await history.messages("claude", interactiveClaudeId, { limit: 50, cursor: claudeEndCursor! });
const kimiAtImport = await history.messages("kimi", kimiId, { limit: 50, cursor: kimiEndCursor! });
assert.ok(claudeAtImport && !claudeAtImport.messages.some(appended), "claude：截止 cursor 的页不应含追加消息");
assert.ok(kimiAtImport && !kimiAtImport.messages.some(appended), "kimi：截止 cursor 的页不应含追加消息");
const claudeLatest = await history.messages("claude", interactiveClaudeId, { limit: 50 });
const kimiLatest = await history.messages("kimi", kimiId, { limit: 50 });
assert.ok(claudeLatest?.messages.some(appended), "claude：不带 cursor 应含追加消息");
assert.ok(kimiLatest?.messages.some(appended), "kimi：不带 cursor 应含追加消息");
console.log("history endCursor cutoff passed");

// 思考块：Claude thinking（空的不推）、Codex reasoning 摘要（空 summary 不推）、Kimi think part；相邻同类合并
const { mergeHistoryMessages } = await import("./history.js");
const claudeThought = parse("claude", [{ type: "assistant", message: { role: "assistant", content: [
  { type: "thinking", thinking: "", signature: "s" }, { type: "thinking", thinking: "想一想" }, { type: "text", text: "答" },
] } }]);
assert.deepEqual(claudeThought.map((m) => [m.role, "text" in m ? m.text : ""]), [["thought", "想一想"], ["assistant", "答"]]);
const codexThought = parse("codex", [
  { type: "response_item", payload: { type: "reasoning", summary: [], encrypted_content: "x" } },
  { type: "response_item", payload: { type: "reasoning", summary: [{ type: "summary_text", text: "甲" }, { type: "summary_text", text: "乙" }] } },
]);
assert.deepEqual(codexThought.map((m) => [m.role, "text" in m ? m.text : ""]), [["thought", "甲\n\n乙"]]);
const kimiThought = mergeHistoryMessages(parse("kimi", [
  { type: "context.append_loop_event", event: { type: "content.part", part: { type: "think", think: "先" } } },
  { type: "context.append_loop_event", event: { type: "content.part", part: { type: "think", think: "后" } } },
  { type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "答" } } },
]));
assert.deepEqual(kimiThought.map((m) => [m.role, "text" in m ? m.text : ""]), [["thought", "先后"], ["assistant", "答"]]);
console.log("history thoughts passed");

// 三家共用空会话过滤；现有目录原样保留。标题和消息的存在性分开判断。
const emptyCodexId = "88888888-8888-4888-8888-888888888888";
const emptyClaudeId = "99999999-9999-4999-8999-999999999999";
const emptyKimiId = "session_metadata_only";
const emptyClaude = join(roots.claude, "project", `${emptyClaudeId}.jsonl`);
const emptyCodex = join(roots.codex, "2026", "08", "22", `rollout-empty-${emptyCodexId}.jsonl`);
const emptyKimi = join(roots.kimi, "workspace", emptyKimiId);
await writeJsonl(emptyClaude, [{ type: "assistant", cwd: "/empty", message: { role: "assistant", content: "只有助手" } }]);
await writeJsonl(emptyCodex, [{ type: "session_meta", payload: { id: emptyCodexId, cwd: "/empty" } }]);
await mkdir(join(emptyKimi, "agents", "main"), { recursive: true });
await writeFile(join(emptyKimi, "state.json"), JSON.stringify({ id: emptyKimiId, cwd: "/empty", title: "已有标题仍为空" }));
await writeJsonl(join(emptyKimi, "agents", "main", "wire.jsonl"), [
  { type: "metadata" }, { type: "permission.set_mode" }, { type: "profile.bind" }, { type: "runtime.set_binding" },
]);
const hidden = await history.list({ limit: 100 });
assert.equal(hidden.empty, 4, "Claude/Codex/Kimi 加旧版无 wire 会话分别计数");
assert.ok(!hidden.sessions.some((session) => [emptyClaudeId, emptyCodexId, emptyKimiId].includes(session.nativeSessionId)));
const { readFile } = await import("node:fs/promises");
assert.equal(JSON.parse(await readFile(join(emptyKimi, "state.json"), "utf8")).id, emptyKimiId);
await appendFile(emptyClaude, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "image", source: {} }] } }) + "\n");
assert.ok((await history.list({ limit: 100 })).sessions.some((session) => session.nativeSessionId === emptyClaudeId), "只有图片的用户消息也保留，缓存随文件变化刷新");

const delegateRoot = join(fixture, "delegate");
const oldDelegateRoot = process.env.WB_DELEGATE_DIR;
process.env.WB_DELEGATE_DIR = delegateRoot;
try {
  for (const [sessionId, runId, name] of [
    [codexId, "20261001-230000-codex-history", "Codex 历史工单"],
    [kimiId, "20261001-230001-kimi-history", "Kimi 历史工单"],
  ]) {
    await mkdir(join(delegateRoot, runId!), { recursive: true });
    await writeFile(join(delegateRoot, runId!, "run.json"), JSON.stringify({ schema: 1, session: sessionId, name }));
  }
  const decorated = await history.list({ limit: 100 });
  assert.equal(decorated.sessions.find((session) => session.nativeSessionId === codexId)?.dispatch?.name, "Codex 历史工单");
  assert.equal(decorated.sessions.find((session) => session.nativeSessionId === kimiId)?.dispatch?.runId, "20261001-230001-kimi-history");
  assert.equal(decorated.sessions.find((session) => session.nativeSessionId === interactiveClaudeId)?.dispatch, undefined);
} finally {
  if (oldDelegateRoot === undefined) delete process.env.WB_DELEGATE_DIR;
  else process.env.WB_DELEGATE_DIR = oldDelegateRoot;
}
console.log("history empty filtering / dispatch decoration passed");

await writeJsonl(emptyCodex, [
  { type: "session_meta", payload: { id: emptyCodexId, cwd: "/empty" } },
  { type: "event_msg", payload: { type: "agent_message", message: "x".repeat(2000) } },
  { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "标题窗口之后的用户消息" }] } },
]);
const shortHead = await new HistoryIndex({ roots, headBytes: 256 }).list({ agent: "codex", limit: 100 });
assert.ok(shortHead.sessions.some((session) => session.nativeSessionId === emptyCodexId), "用户消息超出标题读取窗口仍不能当作空会话");

// 不匹配候选穿插在两页之间：必须在消费循环里筛选，再决定页大小与游标。
const cwdRoot = join(fixture, "cwd-filter");
await mkdir(cwdRoot);
const cwdRows = [
  ["/a/bc", "目标：相似前缀"],
  ["/a/b", "目标：本目录"],
  ["/else", "目标：其他目录"],
  ["/a/b/c", "目标：子目录"],
  ["/a/b/", "另一个标题"],
];
for (const [i, [cwd, title]] of cwdRows.entries()) {
  const path = join(cwdRoot, `cccccccc-cccc-4ccc-8ccc-${String(i).padStart(12, "0")}.jsonl`);
  await writeJsonl(path, [{ type: "user", cwd, message: { role: "user", content: title } }]);
  await utimes(path, now - i, now - i);
}
const cwdHistory = new HistoryIndex({ roots: { ...roots, claude: cwdRoot } });
const cwdMatches = await cwdHistory.list({ agent: "claude", cwd: "/a/b///", limit: 20 });
assert.deepEqual(cwdMatches.sessions.map(s => s.cwd), ["/a/b", "/a/b/c", "/a/b/"]);
assert.deepEqual((await cwdHistory.list({ agent: "claude", cwd: "/a/b", q: "目标", limit: 20 })).sessions.map(s => s.cwd), ["/a/b", "/a/b/c"]);
const cwdFirst = await cwdHistory.list({ agent: "claude", cwd: "/a/b/", q: "目标", limit: 1 });
assert.deepEqual(cwdFirst.sessions.map(s => s.cwd), ["/a/b"]);
assert.ok(cwdFirst.nextCursor);
const cwdSecond = await cwdHistory.list({ agent: "claude", cwd: "/a/b/", q: "目标", limit: 1, cursor: cwdFirst.nextCursor });
assert.deepEqual(cwdSecond.sessions.map(s => s.cwd), ["/a/b/c"]);
const cwdLast = await cwdHistory.list({ agent: "claude", cwd: "/a/b/", q: "目标", limit: 1, cursor: cwdSecond.nextCursor });
assert.equal(cwdLast.sessions.length, 0);
assert.equal(cwdLast.nextCursor, undefined);
assert.equal((await cwdHistory.list({ agent: "claude", cwd: "/", limit: 20 })).sessions.length, cwdRows.length);
assert.equal((await cwdHistory.list({ agent: "codex", cwd: "/a/b", limit: 20 })).sessions.length, 0);
console.log("history cwd segment filtering / combined query / cursor passed");

// 入口偏好关闭时：CLI 默认身份或缺少 entrypoint，创建/导入仍靠注册表正确区分。
const cliRoot = join(fixture, "cli-default");
const cliRoots = { ...roots, claude: cliRoot, workbenchRegistry: join(cliRoot, "sessions.json") };
await mkdir(join(cliRoot, "project"), { recursive: true });
for (const entrypoint of ["cli", undefined]) {
  const created = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const imported = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  for (const id of [created, imported]) {
    await writeJsonl(join(cliRoot, "project", `${id}.jsonl`), [{ type: "user", cwd: "/repo/cli-default", entrypoint,
      message: { role: "user", content: `会话 ${id}` } }]);
  }
  await writeFile(cliRoots.workbenchRegistry, JSON.stringify([
    { agent: "claude", nativeSessionId: created },
    { agent: "claude", nativeSessionId: imported, resumedFrom: { agent: "claude", nativeSessionId: imported } },
  ]));
  const cliHistory = new HistoryIndex({ roots: cliRoots });
  const listed = await cliHistory.list({ agent: "claude", limit: 20 });
  assert.equal(findSession(listed, "claude", created).source, "workbench");
  assert.equal(findSession(listed, "claude", imported).source, entrypoint ? "interactive" : "unknown");
}
console.log("history CLI default entrypoint creation/import classification passed");
