import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSubagentReader, createCodexSubagentReader, listDispatches, readClaudeSubagent, type Dispatch } from "./dispatches.js";

const root = await mkdtemp(join(tmpdir(), "wb-claude-subagents-"));
const projects = join(root, "projects");
const cwd = "/fixture/project";
const project = join(projects, "-fixture-project");
const now = Date.now();
const stamp = (ago: number) => new Date(now - ago).toISOString();
async function parent(id: string, parentCwd = cwd) {
  await mkdir(join(project, id, "subagents"), { recursive: true });
  await writeFile(join(project, `${id}.jsonl`), `${JSON.stringify({ type: "user", sessionId: id, cwd: parentCwd, timestamp: stamp(120_000), message: { content: "parent" } })}\n${JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5" } })}\n`);
}
async function agent(parentId: string, id: string, rows: unknown[], meta: unknown = {}) {
  const path = join(project, parentId, "subagents", `agent-${id}.jsonl`);
  await writeFile(path, `${[
    { isSidechain: true, agentId: id, sessionId: parentId, cwd, type: "user", timestamp: stamp(90_000), message: { content: "委派任务第一行\n完整提示" } },
    ...rows,
  ].map((row) => typeof row === "string" ? row : JSON.stringify(row)).join("\n")}\n`);
  await writeFile(path.replace(/\.jsonl$/u, ".meta.json"), JSON.stringify(meta));
  return path;
}
await parent("parent-a");
const finished = await agent("parent-a", "finished", [
  "{bad line",
  { type: "assistant", timestamp: stamp(60_000), message: { model: "claude-sonnet-5-5", stop_reason: "end_turn", content: [{ type: "text", text: "完成" }] } },
], { agentType: "general-purpose", description: "检查服务端", model: "opus", spawnDepth: 1 });
await appendFile(finished, '{"type":"assistant","timestamp":');
const raw = await readClaudeSubagent(finished);
assert.equal(raw?.lifecycle, "finished", "坏行与半行不掩盖最终回复");
assert.equal(raw?.agent.model, "sonnet-5.5", "模型来自 assistant.model，不能由 meta.model 覆盖");
assert.equal(raw?.agent.agentType, "general-purpose");
assert.equal(raw?.agent.startedAt, stamp(90_000));
assert.equal(raw?.agent.lastActivityAt, stamp(60_000));
assert.equal(raw?.agent.promptHead, "委派任务第一行");
assert.equal(raw?.agent.parentSessionId, "parent-a");

await agent("parent-a", "running", [{ type: "assistant", timestamp: stamp(20_000), message: { model: "claude-sonnet-5-5", stop_reason: "tool_use", content: [{ type: "tool_use", name: "Read" }] } }]);
const stale = await agent("parent-a", "stale", [{ type: "assistant", timestamp: stamp(400_000), message: { model: "claude-sonnet-5-5", stop_reason: "tool_use" } }]);
await utimes(stale, new Date(now - 400_000), new Date(now - 400_000));
await agent("parent-a", "reopened", [
  { type: "assistant", timestamp: stamp(50_000), message: { model: "claude-sonnet-5-5", stop_reason: "end_turn" } },
  { type: "user", timestamp: stamp(10_000), message: { content: "follow-up" } },
]);
await agent("parent-a", "old", [{ type: "assistant", timestamp: stamp(1900_000), message: { model: "claude-sonnet-5-5", stop_reason: "end_turn" } }]);
await agent("parent-a", "failed", [{ type: "assistant", isApiErrorMessage: true, timestamp: stamp(1000), message: { content: [{ type: "text", text: "API failure" }] } }]);
const modelThenError = await agent("parent-a", "model-error", [
  { type: "assistant", timestamp: stamp(1000), message: { model: "claude-sonnet-5-5", stop_reason: "tool_use" } },
  { type: "assistant", isApiErrorMessage: true, timestamp: stamp(500), message: { content: [{ type: "text", text: "API failure" }] } },
]);
assert.equal((await readClaudeSubagent(modelThenError))?.agent.model, "sonnet-5.5", "缺失 model 的错误消息保留最后已知模型");
await parent("wrong-parent", "/other/project");
await agent("wrong-parent", "wrong", [{ type: "assistant", timestamp: stamp(1000), message: { stop_reason: "end_turn" } }]);
await mkdir(join(project, "orphan", "subagents"), { recursive: true });
await agent("orphan", "orphan", []);
await symlink(finished, join(project, "parent-a", "subagents", "agent-link.jsonl"));
for (const path of [join(project, "parent-a.jsonl"), join(project, "parent-a"), join(project, "parent-a", "subagents")]) {
  await utimes(path, new Date(now - 2000_000), new Date(now - 2000_000));
}
let reads = 0;
const read = createClaudeSubagentReader(async (path) => { reads++; return readClaudeSubagent(path); });
const sessions = ["parent-a", "wrong-parent", "orphan"].map(nativeSessionId => ({ cwd, nativeSessionId }));
const runs = await read([], projects, now, sessions);
assert.equal(runs.length, 6, "只纳入时间窗口内且父会话对应注册项目的记录，无 delegate/旧父目录冷启动也可读取");
assert.equal(runs.find((run) => run.session === "finished")?.status, "OK");
assert.equal(runs.find((run) => run.session === "running")?.status, "running");
assert.equal(runs.find((run) => run.session === "stale")?.status, "unknown", "过期 active 不猜测 finished");
assert.equal(runs.find((run) => run.session === "reopened")?.status, "running", "最终回复之后有 user 会重开");
assert.equal(runs.find((run) => run.session === "failed")?.status, "TOOL_FAIL");
const done = runs.find((run) => run.session === "finished")!;
assert.equal(done.tool, "claude");
assert.equal(done.parent?.sessionId, "parent-a");
assert.equal(done.parent?.model, "claude-opus-5-5");
assert.equal(done.elapsedS, 30);
assert.equal(done.endedAt, stamp(60_000));
const firstReads = reads;
await read([], projects, now, sessions);
assert.equal(reads, firstReads, "mtime/size 未变时不重复解析 jsonl/meta");
await writeFile(finished.replace(/\.jsonl$/u, ".meta.json"), JSON.stringify({ agentType: "Explore", description: "新的任务说明" }));
assert.equal((await read([], projects, now, sessions)).find((run) => run.session === "finished")?.name, "新的任务说明");
assert.equal(reads, firstReads + 1, "meta 指纹变化仅失效对应条目");
await appendFile(finished, '\n{"type":"user","timestamp":"' + stamp(0) + '","message":{"content":"再处理"}}\n');
assert.equal((await read([], projects, now, sessions)).find((run) => run.session === "finished")?.status, "running");
assert.equal(reads, firstReads + 2, "jsonl 指纹变化重新解析");

const previous = process.env.WORKBENCH_CLAUDE_PROJECTS_DIR;
const previousCwd = process.cwd();
try {
  process.env.WORKBENCH_CLAUDE_PROJECTS_DIR = projects;
  // Integration locates the delegate's Claude parent ID independently of executor cwd.
  const delegate = join(root, "delegate");
  const id = "20261003-120000-codex-fixture";
  await mkdir(join(delegate, id), { recursive: true });
  await writeFile(join(delegate, id, "run.json"), JSON.stringify({ schema: 1, cwd, status: "OK", startedAt: stamp(90_000), parent: { agent: "claude", sessionId: "parent-a" } }));
  const listed = await listDispatches(20, delegate);
  assert.ok(listed.some((run) => run.tool === "claude"), "现有 listDispatches 返回兼容合成 Claude Dispatch");
} finally {
  if (previous === undefined) delete process.env.WORKBENCH_CLAUDE_PROJECTS_DIR; else process.env.WORKBENCH_CLAUDE_PROJECTS_DIR = previous;
  assert.equal(process.cwd(), previousCwd);
}

const codexRoot = join(root, "codex");
const day = new Date(now).toISOString().slice(0, 10).replaceAll("-", "/");
await mkdir(join(codexRoot, day), { recursive: true });
for (const [id, parentId] of [["one", "root-thread"], ["two", "one"], ["three", "two"], ["four", "three"], ["root-thread", "four"], ["orphan", "other-root"]]) {
  await writeFile(join(codexRoot, day, `rollout-${id}.jsonl`), `${JSON.stringify({ type: "session_meta", timestamp: stamp(90_000), payload: { id, parent_thread_id: parentId, thread_source: "subagent" } })}\n`);
}
const codexRun = { ...done, tool: "codex", session: "root-thread", startedAt: stamp(90_000) } as Dispatch;
await createCodexSubagentReader()([codexRun], codexRoot, now);
assert.deepEqual(codexRun.subagents?.map((child) => [child.threadId, child.depth]), [["one", 1], ["two", 2], ["three", 3], ["four", 4]], "Codex 多层递归无固定两层上限，不跨根收孤儿");
assert.ok((await stat(finished)).isFile());
console.log("✅ Claude 子代理读取、模型/时间/状态、父会话/窗口、坏行/半行、缓存、listDispatches 集成与 Codex 多层递归通过");
