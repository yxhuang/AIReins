import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexSubagentReader, createDispatchScanCache, getDispatch, listDispatches, readCodexSubagent, type Dispatch } from "./dispatches.js";

const root = await mkdtemp(join(tmpdir(), "wb-subagents-"));
const history = join(root, "history");
const now = Date.parse("2026-10-01T10:00:00Z");
const timestamp = new Date(now).toISOString();
const event = (type: string, extra = {}) => ({ timestamp, type: "event_msg", payload: { type, ...extra } });
async function fixture(id: string, parent: string, events: unknown[] = [], day = "2026/10/01", nested = false) {
  const directory = join(history, day);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-${id}.jsonl`);
  const payload = nested
    ? { id, session_id: "inherited-root-not-thread-id", timestamp, source: { subagent: { thread_spawn: { parent_thread_id: parent, depth: 7, agent_nickname: id, agent_role: "luna" } } } }
    : { id, session_id: "inherited-root-not-thread-id", timestamp, thread_source: "subagent", parent_thread_id: parent, agent_nickname: id, agent_role: "sol" };
  await writeFile(path, [JSON.stringify({ type: "session_meta", payload }), ...events.map((row) => JSON.stringify(row)), ""].join("\n"));
  await utimes(path, now / 1000, now / 1000);
  return path;
}
const makeRun = (session = "parent"): Dispatch => ({ runId: "20261001-180000-codex-fixture", tool: "codex", name: "fixture", cwd: null,
  model: null, effort: null, status: "running", startedAt: "2026-10-01T18:00:00+08:00", endedAt: null,
  elapsedS: null, exit: null, files: null, session, parent: null, promptHead: null });
const active = await fixture("active", "parent", [event("task_started"), event("item_completed"), event("agent_message", { message: "正在\n核对数据" })]);
await fixture("finished", "parent", [event("task_complete"), event("token_count")], "2026/09/30");
await fixture("nested", "active", [event("task_complete"), event("task_started"), event("item_completed")], "2026/10/02", true);
await fixture("too-deep", "nested", [event("task_started")]);
await fixture("unrelated", "other-parent", [event("task_started")]);
await fixture("outside-dates", "parent", [event("task_started")], "2026/10/03");
await fixture("unknown", "parent", [event("token_count")]);
const stale = await fixture("stale", "parent", [event("item_completed")]);
await utimes(stale, (now - 300_001) / 1000, (now - 300_001) / 1000);
await fixture("final", "parent", [{ timestamp, type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "完成" }] } }, event("token_count")]);
await fixture("aborted", "parent", [event("turn_aborted")]);
await fixture("cycle", "cycle", [event("task_started")]);
const partial = await fixture("partial", "parent", [event("task_started")]);
await appendFile(partial, JSON.stringify(event("task_complete"))); // complete JSON but no newline: not flushed
await utimes(partial, now / 1000, now / 1000);
const bounded = await fixture("bounded", "parent", []);
await appendFile(bounded, JSON.stringify(event("task_complete")) + "\n" + "x".repeat(100_000) + "\n" + JSON.stringify(event("item_completed")) + "\n");
await utimes(bounded, now / 1000, now / 1000);
const broken = join(history, "2026/10/01/rollout-broken.jsonl");
await writeFile(broken, "{bad}\n");
await writeFile(join(history, "2026/10/01/rollout-oversized.jsonl"), " ".repeat(65536) + "\n");
await symlink(active, join(history, "2026/10/01/rollout-symlink.jsonl"));
let reads = 0;
const reader = createCodexSubagentReader(async (path) => { reads++; return readCodexSubagent(path); });
const run = makeRun();
const kimi = { ...makeRun(), tool: "kimi" };
await reader([run, kimi], history, now);
assert.equal(kimi.subagents, undefined);
const byId = new Map(run.subagents!.map((agent) => [agent.threadId, agent]));
assert.equal(byId.get("active")?.status, "running");
assert.equal(byId.get("active")?.activity, "正在 核对数据");
assert.equal(byId.get("active")?.nickname, "active");
assert.equal(byId.get("active")?.startedAt, timestamp);
assert.equal(byId.get("active")?.lastActivityAt, timestamp);
assert.equal(byId.get("finished")?.status, "finished");
assert.equal(byId.get("nested")?.depth, 2, "depth is relative to Dispatch.session, not untrusted metadata");
assert.equal(byId.get("nested")?.role, "luna");
assert.equal(byId.get("nested")?.parentThreadId, "active");
assert.equal(byId.get("nested")?.status, "running", "a new turn reopens a completed agent");
for (const id of ["unknown", "stale"]) assert.equal(byId.get(id)?.status, "unknown");
for (const id of ["final", "aborted"]) assert.equal(byId.get(id)?.status, "finished");
for (const id of ["partial", "bounded"]) assert.equal(byId.get(id)?.status, "running");
for (const id of ["unrelated", "outside-dates", "too-deep", "cycle", "inherited-root-not-thread-id"]) assert.ok(!byId.has(id));
assert.equal(await readCodexSubagent(join(history, "2026/10/01/rollout-oversized.jsonl")), null);
assert.equal(await readCodexSubagent(join(history, "missing.jsonl")), null);
await assert.rejects(readCodexSubagent(join(history, "2026/10/01/rollout-symlink.jsonl")));
const firstReads = reads;
run.subagents![0]!.nickname = "mutated";
await reader([run], history, now);
assert.equal(reads, firstReads, "unchanged path/mtime/size and invalid files hit parse cache");
assert.ok(!run.subagents!.some((agent) => agent.nickname === "mutated"));
await reader([run], history, now + 300_001);
assert.equal(reads, firstReads);
assert.equal(run.subagents!.find((agent) => agent.threadId === "active")?.status, "unknown", "freshness recomputed on cache hits");
const before = await stat(active);
await utimes(active, now / 1000, (now + 1000) / 1000);
await reader([run], history, now);
assert.equal(reads, firstReads + 1, "mtime-only changes invalidate");
await appendFile(active, JSON.stringify(event("task_complete")) + "\n");
await utimes(active, before.atime, new Date(now + 1000));
await reader([run], history, now);
assert.equal(reads, firstReads + 2, "size changes invalidate with identical mtime");
assert.equal(run.subagents!.find((agent) => agent.threadId === "active")?.status, "finished");
const shared = createDispatchScanCache(async () => [run]);
const [one, two] = await Promise.all([shared(root), shared(root)]);
one[0]!.subagents![0]!.nickname = "changed";
assert.notEqual(two[0]!.subagents![0]!.nickname, "changed", "shared scans clone subagent records");
const empty = makeRun("missing-parent");
await reader([empty], history, now); assert.deepEqual(empty.subagents, []);
await reader([makeRun()], join(root, "missing-root"), now);

// Public API integration uses the same shared scan and environment override.
const delegate = join(root, "delegate");
const directory = join(delegate, run.runId);
await mkdir(directory, { recursive: true });
await writeFile(join(directory, "run.json"), JSON.stringify({ schema: 1, session: "parent", startedAt: run.startedAt, status: "OK" }));
const previous = process.env.WORKBENCH_CODEX_HISTORY_DIR;
process.env.WORKBENCH_CODEX_HISTORY_DIR = history;
try {
  const items = await listDispatches(null, delegate);
  assert.equal(items[0]?.subagents?.find((agent) => agent.threadId === "nested")?.parentThreadId, "active");
  assert.deepEqual((await getDispatch(run.runId, delegate))?.subagents, items[0]?.subagents);
} finally {
  if (previous === undefined) delete process.env.WORKBENCH_CODEX_HISTORY_DIR; else process.env.WORKBENCH_CODEX_HISTORY_DIR = previous;
}
console.log("✅ dispatch subagents: bounded parsing, recursion, lifecycle/freshness, partial lines, file fingerprints, shared API cache");
