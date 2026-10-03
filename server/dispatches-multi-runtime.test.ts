import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKimiSubagentReader, listDispatches, listParentDispatches, type DispatchParentSession } from "./dispatches.js";

const root = await mkdtemp(join(tmpdir(), "wb-runtime-dispatches-"));
const delegate = join(root, "delegate");
const codex = join(root, "codex");
const kimi = join(root, "kimi");
const claude = join(root, "claude");
const now = Date.now();
const time = new Date(now - 1000).toISOString();
const sessions: DispatchParentSession[] = [
  { id: "wb-codex", agent: "codex", nativeSessionId: "codex-main", cwd: "/repo", model: "gpt-6.1-sol", createdAt: time },
  { id: "wb-kimi", agent: "kimi", nativeSessionId: "kimi-main", cwd: "/repo", model: "kimi-code/k3", createdAt: time },
];
await mkdir(delegate);
await mkdir(claude);
const day = new Date(now).toISOString().slice(0, 10).replaceAll("-", "/");
await mkdir(join(codex, day), { recursive: true });
for (const [id, parent] of [["luna", "codex-main"], ["nested", "luna"], ["foreign", "unregistered"]]) {
  await writeFile(join(codex, day, `rollout-${id}.jsonl`), [
    { type: "session_meta", payload: { id, timestamp: time, thread_source: "subagent", parent_thread_id: parent, agent_nickname: id, agent_role: "luna" } },
    { type: "turn_context", payload: { model: "gpt-6-luna", effort: "max" } },
    { type: "event_msg", timestamp: time, payload: { type: "task_started" } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
}
const directory = join(kimi, "workspace", "kimi-main");
await mkdir(join(directory, "agents"), { recursive: true });
const metadata = { id: "kimi-main", cwd: "/repo", agents: {
  main: { type: "main" }, bad: { type: "coder" }, "agent-0": { type: "coder", name: "代码任务" },
  "agent-1": { type: "explore", parentAgentId: "agent-0" }, "agent-2": { type: "plan" },
} };
await writeFile(join(directory, "state.json"), JSON.stringify(metadata));
await symlink(root, join(directory, "agents", "bad"));
for (const id of ["agent-0", "agent-1", "agent-2"]) {
  const agent = join(directory, "agents", id);
  await mkdir(agent);
  await writeFile(join(agent, "wire.jsonl"), [
    { type: "metadata", created_at: time },
    { type: "agent.turn.started", agentId: id, time },
    { type: "usage.record", model: "kimi-code/k3", time },
    { type: "context.append_loop_event", time, event: { type: "step.begin" } },
    ...(id === "agent-2" ? [{ type: "context.append_loop_event", time, event: { type: "step.end", finishReason: "stop" } }] : []),
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
}
const kimiReader = createKimiSubagentReader();
const nativeKimi = await kimiReader(kimi, sessions, now);
assert.equal(nativeKimi.length, 3, "symlinked child isolated, other registered agents remain visible");
assert.equal(nativeKimi.find((run) => run.name === "代码任务")?.parent?.sessionId, "kimi-main");
assert.equal(nativeKimi.find((run) => run.agentType === "explore")?.parent?.sessionId, "kimi-main--agent-0");
assert.equal(nativeKimi.find((run) => run.agentType === "plan")?.status, "OK");
assert.equal((await kimiReader(kimi, [])).length, 0);
assert.equal((await kimiReader(kimi, [{ ...sessions[1]!, cwd: "/other" }])).length, 0);
await utimes(join(directory, "agents", "agent-0", "wire.jsonl"), new Date(now - 400_000), new Date(now - 400_000));
assert.equal((await kimiReader(kimi, sessions, now)).find((run) => run.agentType === "coder")?.status, "unknown");
await utimes(join(directory, "agents", "agent-0", "wire.jsonl"), new Date(now), new Date(now));

const runs = [
  { id: "20261003-120000-kimi-from-codex", parent: { agent: "codex", sessionId: "codex-main" } },
  { id: "20261003-120001-copilot-from-kimi", parent: { agent: "kimi", sessionId: "kimi-main" } },
  { id: "20261003-120002-copilot-from-luna", parent: { agent: "codex", sessionId: "luna" } },
  { id: "20261003-120003-copilot-nested", parent: { agent: "kimi", runId: "20261003-120000-kimi-from-codex" } },
];
for (const run of runs) {
  const path = join(delegate, run.id);
  await mkdir(path);
  await writeFile(join(path, "run.json"), JSON.stringify({ schema: 1, status: "running", pid: process.pid, startedAt: time, parent: run.parent }));
}
const keys = ["WORKBENCH_CODEX_HISTORY_DIR", "WORKBENCH_KIMI_HISTORY_DIR", "WORKBENCH_CLAUDE_PROJECTS_DIR"] as const;
const previous = keys.map((key) => process.env[key]);
for (const [index, key] of keys.entries()) process.env[key] = [codex, kimi, claude][index];
try {
  const list = await listDispatches(50, delegate, () => sessions);
  assert.equal(list.filter((run) => run.native && run.tool === "codex").length, 2);
  assert.equal(list.find((run) => run.session === "luna")?.model, "gpt-6-luna");
  assert.equal(list.find((run) => run.session === "luna")?.parent?.sessionId, "codex-main");
  assert.equal(list.filter((run) => run.native && run.tool === "kimi").length, 3);
  assert.ok(!list.some((run) => run.session === "foreign"));
  const fromCodex = await listParentDispatches("codex-main", delegate, "codex", () => sessions);
  assert.equal(fromCodex.length, 5, "direct delegate + native Luna + nested native + Luna delegate + nested external delegate");
  assert.equal((await listParentDispatches("wb-codex", delegate, "codex", () => sessions)).length, 5, "WB ID alias resolves to native parent");
  const fromKimi = await listParentDispatches("kimi-main", delegate, "kimi", () => sessions);
  assert.equal(fromKimi.length, 3, "Copilot plus two running Kimi native children");
  assert.ok(!fromKimi.some((run) => run.parent?.agent === "codex"));
  assert.equal((await listDispatches(50, delegate, () => [])).filter((run) => run.native).length, 0,
    "candidate provider changes invalidate native cache");
} finally {
  for (const [index, key] of keys.entries()) {
    if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
  }
}
console.log("✅ 三家派单：独立 Codex/Luna、Kimi 原生子代理、跨工具与嵌套委派、父会话隔离/别名、只读路径与缓存");
