import assert from "node:assert/strict";
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
assert.equal(all.sessions.length, 5);
assert.equal(all.skipped, 2);
assert.equal(all.truncated, false);
assert.deepEqual(all.sessions.map((session) => session.title), [
  "真正的人类标题",
  "工作台标题",
  "Codex 真实标题",
  "Kimi 真实标题",
  "Kimi 旧版标题",
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
assert.equal(secondPage.sessions.length, 6);
assert.equal(new Set([...firstPage.sessions, ...secondPage.sessions].map((session) => session.nativeSessionId)).size, 8);

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
