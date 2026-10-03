import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dispatchSessionMap, getDispatch, getDispatchLog, getDispatchMessages, listDispatches, listDispatchHistory,
  listParentDispatches } from "./dispatches.js";
import { NativeConversationReader } from "./native-conversation.js";

const { dispatchForests } = await import(new URL("../frontend/src/dispatch-flow.ts", import.meta.url).href);
const root = await mkdtemp(join(tmpdir(), "wb-claude-runtime-"));
const delegate = join(root, "delegate");
const runId = "20261003-153931-claude-codex-parent-smoke";
// Verified from the real 2026-10-03 15:39 Codex session metadata; no archive is required to run this test.
const parentId = "00000000-0000-4000-8000-000000000063";
const fixtureRun = { schema: 1, agent: "claude", name: "codex-parent-smoke", cwd: "/fixture/delegate-claude",
  model: "opus", effort: "high", status: "OK", startedAt: "2026-10-03T07:39:31.298Z",
  endedAt: "2026-10-03T07:39:32.298Z", elapsed_s: 1, exit: 0, files: 0,
  session: "ca11de55-1003-4000-8000-000000000001", parent: { agent: "codex", sessionId: parentId, entrypoint: "cli" } };
await mkdir(join(delegate, runId), { recursive: true });
for (const [name, content] of Object.entries({ "run.json": JSON.stringify(fixtureRun), "prompt.txt": "只读检查并回复 OK。\n",
  "stdout.log": "OK\n", "last.txt": "OK\n", "summary.txt": `STATUS OK\nRESUME delegate claude --resume ${runId}\n` })) {
  await writeFile(join(delegate, runId, name), content);
}
assert.equal(fixtureRun.parent.sessionId, parentId, "fixture uses the real 2026-10-03 15:39 Codex parent ID");
const claudeId = fixtureRun.session;
const codex = join(root, "codex");
const kimi = join(root, "kimi");
const claude = join(root, "claude");
const now = Date.now();
const timestamp = new Date(now - 1000).toISOString();
const line = (value: unknown) => JSON.stringify(value) + "\n";
const codexPath = join(codex, "2026", "10", "03", `rollout-2026-10-03T15-39-31-${parentId}.jsonl`);
await mkdir(dirname(codexPath), { recursive: true });
await writeFile(codexPath, line({ type: "session_meta", payload: { id: parentId, cwd: "/fixture/parent" } })
  + line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Codex 独立主会话" }] } }));
const kimiSession = join(kimi, "workspace", "kimi-root");
await mkdir(join(kimiSession, "agents", "main"), { recursive: true });
await writeFile(join(kimiSession, "state.json"), JSON.stringify({ id: "kimi-root", cwd: "/fixture/parent", title: "Kimi 独立主会话" }));
await writeFile(join(kimiSession, "agents", "main", "wire.jsonl"), "");
const project = join(claude, fixtureRun.cwd.replace(/[^A-Za-z0-9]/gu, "-"));
await mkdir(join(project, claudeId, "subagents"), { recursive: true });
await writeFile(join(project, `${claudeId}.jsonl`), line({ type: "user", uuid: "prompt", sessionId: claudeId, cwd: fixtureRun.cwd,
  timestamp, message: { role: "user", content: "检查" } }) + line({ type: "assistant", uuid: "answer", sessionId: claudeId, timestamp,
  message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "OK" }] } }));
await writeFile(join(project, claudeId, "subagents", "agent-reviewer.jsonl"), line({ type: "user", isSidechain: true,
  agentId: "reviewer", sessionId: claudeId, cwd: fixtureRun.cwd, timestamp, message: { content: "只读子任务" } })
  + line({ type: "assistant", timestamp, message: { model: "claude-sonnet-5-5", stop_reason: "tool_use" } }));
const active = { ...fixtureRun, status: "running", pid: process.pid, startedAt: timestamp, endedAt: null };
await writeFile(join(delegate, runId, "run.json"), JSON.stringify(active));
for (const [id, agent, sessionId] of [
  ["20261003-153932-codex-from-claude", "claude", "claude-root"],
  ["20261003-153933-copilot-from-kimi", "kimi", "kimi-root"],
]) {
  await mkdir(join(delegate, id!));
  await writeFile(join(delegate, id!, "run.json"), JSON.stringify({ schema: 1, status: "running", pid: process.pid,
    startedAt: timestamp, parent: { agent, sessionId } }));
}
const finishedId = "20261003-153934-claude-finished";
await mkdir(join(delegate, finishedId));
await writeFile(join(delegate, finishedId, "run.json"), JSON.stringify({ ...fixtureRun, endedAt: timestamp }));
const keys = ["WORKBENCH_CODEX_HISTORY_DIR", "WORKBENCH_KIMI_HISTORY_DIR", "WORKBENCH_CLAUDE_PROJECTS_DIR", "WORKBENCH_CLAUDE_HISTORY_DIR"] as const;
const previous = keys.map(key => process.env[key]);
for (const [index, key] of keys.entries()) process.env[key] = [codex, kimi, claude, claude][index];
try {
  const list = await listDispatches(50, delegate);
  const delegated = list.find(run => run.runId === runId)!;
  assert.equal(delegated.tool, "claude");
  assert.equal(delegated.model, "opus");
  assert.equal(delegated.effort, "high");
  assert.equal(delegated.session, claudeId);
  assert.equal(delegated.parent?.title, "Codex 独立主会话");
  assert.equal(list.find(run => run.tool === "copilot")?.parent?.title, "Kimi 独立主会话", "state title survives an empty native conversation");
  const child = list.find(run => run.native && run.tool === "claude")!;
  assert.ok(child, "Claude executor's own session discovers its native children");
  assert.equal(child.parent?.sessionId, claudeId);
  assert.equal(child.parent?.runId, runId);
  const trees = dispatchForests(list, []);
  assert.deepEqual(trees.map((tree: { agent: string }) => tree.agent), ["claude", "codex", "kimi"]);
  const codexTree = trees.find((tree: { agent: string }) => tree.agent === "codex");
  assert.ok(codexTree.runs.some((run: { runId: string }) => run.runId === runId), "delegate Claude stays under Codex root");
  assert.ok(codexTree.runs.some((run: { runId: string }) => run.runId === child.runId), "native Claude child inherits Codex root through delegate");
  assert.deepEqual((await listParentDispatches(parentId, delegate, "codex")).map(run => run.runId).sort(), [runId, child.runId].sort());
  assert.equal((await dispatchSessionMap(delegate)).get(claudeId)?.runId, finishedId);
  const detail = await getDispatch(runId, delegate);
  assert.equal(detail?.session, claudeId);
  assert.equal(detail?.parent?.sessionId, parentId);
  assert.equal(detail?.final, "OK\n");
  assert.equal((await getDispatchLog(runId, "stdout", 0, delegate))?.text, "OK\n");
  const messages = await getDispatchMessages(runId, null, delegate, new NativeConversationReader({ claude }));
  assert.equal(messages?.source, "native");
  assert.equal(messages?.agent, "claude");
  assert.ok(messages?.messages.some(message => message.role === "assistant" && message.text === "OK"));
  assert.ok((await listDispatchHistory(null, delegate, now)).dispatches.some(run => run.runId === finishedId && run.tool === "claude"));
} finally {
  for (const [index, key] of keys.entries()) {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  }
}
console.log("✅ delegate Claude: real Codex parent fixture, three runtime trees, native children, titles, detail/history/messages");
