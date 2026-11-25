import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { countActiveDispatchesBySession, listDispatches, listDispatchOverview, listParentDispatches, type DispatchParentSession } from "./dispatches.js";

const home = await mkdtemp(join(tmpdir(), "wb-antigravity-dispatch-"));
const brain = await mkdtemp(join(home, "brain-"));
const delegate = join(home, "delegate");
process.env.WORKBENCH_ANTIGRAVITY_BRAIN_DIR = brain;
const planner = "gemini-pro-orchestrator-neon";
const worker = "gemini-flash-worker-agy";
const now = Date.now();
const stamp = (age: number) => new Date(now - age).toISOString();
const row = (step_index: number, age: number, fields: object) => ({ step_index, created_at: stamp(age), ...fields });
const response = (model: string, name?: string, args?: object) => ({
  type: "PLANNER_RESPONSE", model, status: "DONE", ...(name ? { tool_calls: [{ name, args }] } : {}),
});
const jsonl = (...rows: unknown[]) => rows.map(value => JSON.stringify(value) + "\n").join("");
const log = (id: string) => join(brain, id, ".system_generated/logs/transcript.jsonl");
async function transcript(id: string, content: string) {
  await mkdir(dirname(log(id)), { recursive: true });
  await writeFile(log(id), content);
}
const session: DispatchParentSession = {
  id: "workbench", nativeSessionId: "native", agent: "antigravity", model: "orchestrator-neon",
  cwd: home, title: "父会话", status: "running",
};
const overview = (status = session.status) => listDispatchOverview(null, delegate, () => [{ ...session, status }], now);

await transcript("native", jsonl(row(1, 60_000, { type: "USER_INPUT", source: "USER_EXPLICIT" }),
  row(2, 58_000, response(planner, "think"))));
assert.deepEqual((await overview()).runtimeStates, [{ agent: "antigravity", sessionId: "workbench", nativeSessionId: "native",
  configuredModel: "orchestrator-neon", activeModel: planner, activePhase: "planning",
  plannerModel: planner, executorModel: null, updatedAt: stamp(58_000) }]);
assert.deepEqual(await listDispatches(null, delegate, () => [session]), []);

await appendFile(log("native"), jsonl(row(3, 55_000, response(planner, "exit_plan_mode", { plan: "\n  - ## 核对执行结果\n第二行" })),
  row(4, 54_000, { type: "SYSTEM_MESSAGE", content: "Plan mode is off: this turn runs on the execution model." })));
const pending = await overview();
assert.equal(pending.dispatches.length, 1);
assert.equal(pending.dispatches[0]?.runId, "antigravity-inner-native-3");
assert.equal(pending.dispatches[0]?.name, "核对执行结果");
assert.equal(pending.dispatches[0]?.model, null);
assert.equal(pending.runtimeStates[0]?.activePhase, "executing");
assert.equal(pending.runtimeStates[0]?.activeModel, null);

await appendFile(log("native"), "{bad row\n" + jsonl(row(5, 52_000, response(worker, "read_file")),
  row(6, 51_000, { type: "TOOL", status: "RUNNING" })));
const active = await overview();
assert.equal(active.dispatches[0]?.model, worker);
assert.equal(active.dispatches[0]?.status, "running");
assert.equal(active.dispatches[0]?.promptHead, "read_file");
assert.equal(active.runtimeStates[0]?.activeModel, worker);
assert.equal((await overview("idle")).dispatches[0]?.status, "unknown");
for (const id of ["workbench", "native"]) {
  assert.deepEqual((await listParentDispatches(id, delegate, "antigravity", () => [session]))
    .map(run => [run.runId, run.model, run.status]), [["antigravity-inner-native-3", worker, "running"]]);
}
assert.deepEqual(await listParentDispatches("workbench", delegate, "codex", () => [session]), []);
assert.equal((await countActiveDispatchesBySession([session], delegate)).size, 0);

await appendFile(log("native"), jsonl(row(6, 45_000, { type: "TOOL", status: "DONE" })));
assert.equal((await overview("idle")).dispatches[0]?.status, "OK", "无 RUNNING 步骤，确认父会话空闲");
await appendFile(log("native"), jsonl(row(7, 40_000, response(worker))));
const idle = await overview("idle");
assert.equal(idle.dispatches[0]?.status, "OK");
assert.equal(idle.dispatches[0]?.endedAt, stamp(40_000));
assert.equal(idle.dispatches[0]?.elapsedS, 15);
assert.equal((await overview()).dispatches[0]?.status, "running", "同一文件缓存按实时父状态重新投影");

await appendFile(log("native"), jsonl(row(8, 39_000, response(worker, "enter_plan_mode")),
  row(9, 38_000, { type: "GENERIC", content: "Plan mode is on." }), row(10, 37_000, response(planner, "think")),
  row(11, 35_000, { type: "GENERIC", content: "Plan mode is off." }),
  row(12, 32_000, response(worker, "read_file")), row(13, 31_000, { type: "USER_INPUT" })));
await appendFile(log("native"), '{"type":"PLANNER_RESPONSE","created_at":' + JSON.stringify(stamp(1_000)) + ',"model":"partial"}');
const returned = await overview();
assert.deepEqual(returned.dispatches.map(run => [run.runId, run.status, run.endedAt]), [
  ["antigravity-inner-native-11", "OK", stamp(31_000)], ["antigravity-inner-native-3", "OK", stamp(39_000)],
]);
assert.deepEqual(returned.dispatches[1]?.parent, { agent: "antigravity", sessionId: "native", model: planner, title: "父会话", entrypoint: null });
assert.deepEqual(await listParentDispatches("native", delegate, "antigravity", () => [session]), []);
assert.equal(returned.runtimeStates[0]?.activeModel, planner);
assert.equal(returned.runtimeStates[0]?.activePhase, "planning");
assert.equal(returned.runtimeStates[0]?.updatedAt, stamp(31_000));

const externalDelegate = join(home, "external-delegate");
const delegateRun = join(externalDelegate, "20200101-000000-codex-external");
await mkdir(delegateRun, { recursive: true });
await writeFile(join(delegateRun, "run.json"), JSON.stringify({ schema: 1, status: "OK",
  parent: { agent: "antigravity", sessionId: "external" } }));
await transcript("external", jsonl(row(1, 301_000, { type: "GENERIC", content: "Plan mode is off." }),
  row(2, 300_001, { ...response(worker, "run"), status: "RUNNING" })));
const standalone = await listDispatchOverview(null, externalDelegate, () => [], now);
assert.equal(standalone.dispatches.find(run => run.native)?.status, "unknown");
assert.equal(standalone.runtimeStates[0]?.sessionId, "external");
assert.equal(standalone.runtimeStates[0]?.activeModel, worker);
const recent = await listDispatchOverview(null, externalDelegate, () => [], now - 1);
assert.equal(recent.dispatches.find(run => run.native)?.status, "running");
const outsideWindow = await listDispatchOverview(null, externalDelegate, () => [], now + 30 * 60_000);
assert.equal(outsideWindow.dispatches.some(run => run.native), false);
assert.equal((await overview()).dispatches.every(run => run.status === "OK"), true);

const outside = join(home, "outside", ".system_generated/logs/transcript.jsonl");
await mkdir(dirname(outside), { recursive: true });
await writeFile(outside, jsonl(row(1, 1_000, response(planner, "exit_plan_mode"))));
await symlink(join(home, "outside"), join(brain, "linked-dir"));
await mkdir(dirname(log("linked-file")), { recursive: true });
await symlink(outside, log("linked-file"));
await transcript("bounded", jsonl(row(1, 200_000, response(planner, "exit_plan_mode"))) +
  "x".repeat(512 * 1024) + "\n" + jsonl(row(2, 100_000, response(planner))));
await transcript("single", jsonl(row(1, 1_000, response("gemini-3.8-flash"))));
await transcript("long-running", jsonl(row(1, 31 * 60_000, response(planner, "exit_plan_mode", { plan: "# " + "长".repeat(90) }))));
const isolated = await listDispatchOverview(null, join(home, "missing-delegate"), () =>
  ["linked-dir", "linked-file", "../outside", "missing", "bounded", "single", "long-running"]
    .map(nativeSessionId => ({ ...session, id: nativeSessionId, nativeSessionId })), now);
assert.deepEqual(isolated.dispatches.map(run => [run.session, run.name, run.status]), [["long-running--inner-1", "长".repeat(80), "running"]]);
assert.deepEqual(isolated.runtimeStates.map(state => state.nativeSessionId), ["bounded", "single", "long-running"]);
assert.equal(isolated.runtimeStates[1]?.activeModel, "gemini-3.8-flash");
assert.equal(isolated.runtimeStates[1]?.activePhase, null);

await transcript("real-envelope", jsonl(
  row(1, 50_000, { type: "USER_INPUT", source: "USER_EXPLICIT" }),
  row(2, 49_000, response(planner, "exit_plan_mode", { plan: "\"### 目标\\n修复第 29 行\\n<truncated 120 bytes>" })),
  row(3, 48_000, { type: "GENERIC", content: "Created At: 2026-11-20T00:48:38+08:00\nCompleted At: 2026-11-20T00:48:41+08:00\nPlan mode is off." }),
  row(4, 47_000, { type: "SYSTEM_MESSAGE", content: "The following is a <SYSTEM_MESSAGE>\n\n<SYSTEM_MESSAGE>\nPlan mode is off: this turn runs on the execution model.\n\n<plan>\nPlan mode is on.\n</plan>" }),
  row(5, 45_000, response(worker, "read_file")),
));
const realActive = await listDispatchOverview(null, join(home, "missing-delegate"), () =>
  [{ ...session, id: "real-envelope", nativeSessionId: "real-envelope", status: "running" }], now);
assert.equal(realActive.dispatches.length, 1);
assert.equal(realActive.dispatches[0]?.name, "目标");
assert.equal(realActive.dispatches[0]?.model, worker);
assert.equal(realActive.dispatches[0]?.status, "running");
assert.equal(realActive.runtimeStates[0]?.activePhase, "executing");

await appendFile(log("real-envelope"), jsonl(
  row(6, 43_000, { type: "GENERIC", content: "Created At: 2026-11-20T00:49:49+08:00\nCompleted At: 2026-11-20T00:49:51+08:00\nPlan mode is on." }),
));
const realHandedBack = await listDispatchOverview(null, join(home, "missing-delegate"), () =>
  [{ ...session, id: "real-envelope", nativeSessionId: "real-envelope", status: "running" }], now);
assert.equal(realHandedBack.dispatches[0]?.status, "OK");
assert.equal(realHandedBack.dispatches[0]?.endedAt, stamp(43_000));
assert.equal(realHandedBack.runtimeStates[0]?.activePhase, "planning");
assert.equal(realHandedBack.runtimeStates[0]?.activeModel, planner);

await appendFile(log("real-envelope"), jsonl(
  row(7, 42_500, { type: "SYSTEM_MESSAGE", content: "The following is a <SYSTEM_MESSAGE>\n\n<SYSTEM_MESSAGE>\n[Message] done\nPlan mode is off." }),
));
const realUnchanged = await listDispatchOverview(null, join(home, "missing-delegate"), () =>
  [{ ...session, id: "real-envelope", nativeSessionId: "real-envelope", status: "running" }], now);
assert.equal(realUnchanged.dispatches.length, 1);
assert.equal(realUnchanged.runtimeStates[0]?.activePhase, "planning");

await transcript("switch-back", jsonl(
  row(1, 50_000, { type: "USER_INPUT", source: "USER_EXPLICIT" }),
  row(2, 48_000, response(planner, "exit_plan_mode", { plan: JSON.stringify("### 切回单模型验证\n步骤") })),
  row(3, 46_000, { type: "GENERIC", content: "Created At: 2026-11-20T00:48:38+08:00\nPlan mode is off." }),
  row(4, 44_000, response(worker)),
  row(5, 42_000, { type: "SYSTEM_MESSAGE", content: "The following is a <SYSTEM_MESSAGE>\n\n<SYSTEM_MESSAGE>\n[plan review] Plan mode is on: this turn runs on the planning model." }),
  row(6, 40_000, { type: "USER_INPUT", source: "USER_EXPLICIT" }),
  row(7, 38_000, response("gemini-4-neon-high")),
));
const switched = await listDispatchOverview(null, join(home, "missing-delegate"), () =>
  [{ ...session, id: "switch-back", nativeSessionId: "switch-back", model: "gemini-4-neon-high", status: "idle" }], now);
assert.equal(switched.dispatches[0]?.name, "切回单模型验证");
assert.equal(switched.dispatches[0]?.status, "OK");
assert.equal(switched.dispatches[0]?.endedAt, stamp(42_000));
assert.equal(switched.runtimeStates[0]?.activeModel, "gemini-4-neon-high");
assert.equal(switched.runtimeStates[0]?.activePhase, null);

const swarmId = "swarm-parent";
const swarmFile = join(brain, swarmId, ".system_generated/swarm/members.json");
const opus = "claude-opus-5-5-high";
const swarmResult = (age: number, value: object) => ({ type: "GENERIC", source: "MODEL", status: "DONE",
  content: `Created At: ${stamp(age + 1000)}\nCompleted At: ${stamp(age)}\n${JSON.stringify(value)}` });
const coordinator = { role: "coordinator", conversation_id: swarmId, phase: "RUNNING", applied_model: planner };
const reviewer = { role: "worker", conversation_id: "opus-child", phase: "RUNNING", applied_model: opus,
  desired_model: worker, model: opus, killed: false };
await mkdir(dirname(swarmFile), { recursive: true });
await writeFile(swarmFile, JSON.stringify({ members: { coordinator, reviewer } }));
await transcript(swarmId, jsonl(row(1, 48_000, response(planner, "swarm", { action: '"add"', name: '"reviewer"', model: JSON.stringify(opus) })),
  row(2, 47_000, swarmResult(46_000, { status: "added", name: "reviewer", model: opus, conversation_id: "opus-child" }))));
const swarmParent: DispatchParentSession = { ...session, status: "idle", nativeSessionId: swarmId };
const swarmOverview = (at = now) => listDispatchOverview(null, delegate, () => [swarmParent], at);
const swarmActive = await swarmOverview();
assert.deepEqual(swarmActive.dispatches.map(run => [run.tool, run.native, run.agentType, run.name, run.model, run.status, run.session, run.startedAt, run.parent?.sessionId]),
  [["antigravity", true, "swarm", "reviewer", opus, "running", "opus-child", stamp(46_000), swarmId]]);
assert.equal(swarmActive.runtimeStates[0]?.activeModel, planner);
assert.deepEqual((await listParentDispatches(swarmId, delegate, undefined, () => [swarmParent])).map(run => run.model), [opus]);
assert.deepEqual(await listParentDispatches("native", delegate, "antigravity", () => [session, { ...swarmParent, id: "other" }]), []);
const releasedSwarmParent = { ...swarmParent, released: true };
assert.deepEqual((await listDispatchOverview(null, delegate, () => [releasedSwarmParent], now)).dispatches
  .map(run => [run.status, run.endedAt]), [["unknown", null]], "父会话已释放时旧成员快照不算运行，也不猜结束时间");
assert.deepEqual((await listDispatchOverview(null, delegate, () => [releasedSwarmParent], now + 30 * 60_000)).dispatches, []);
assert.deepEqual(await listParentDispatches(swarmId, delegate, "antigravity", () => [releasedSwarmParent]), []);
assert.equal((await listDispatchOverview(null, delegate, () => [
  swarmParent, { ...releasedSwarmParent, id: "released-alias" },
], now)).dispatches[0]?.status, "running", "旧工作台记录不能覆盖同一原生会话当前有效的父会话");
await writeFile(swarmFile, JSON.stringify({ members: { coordinator, reviewer: { ...reviewer, phase: "KILLED", killed: true } } }));
await appendFile(log(swarmId), jsonl(row(3, 35_000, response(planner, "swarm", { action: '"kill"', name: '"reviewer"' })),
  row(4, 34_000, swarmResult(30_000, { status: "killed", name: "reviewer" }))));
assert.deepEqual((await swarmOverview()).dispatches.map(run => [run.status, run.endedAt, run.elapsedS]), [["stopped", stamp(30_000), 16]]);
assert.deepEqual(await listParentDispatches(swarmId, delegate, "antigravity", () => [swarmParent]), []);
assert.deepEqual((await swarmOverview(now + 30 * 60_000)).dispatches, []);
assert.deepEqual((await listDispatchOverview(null, delegate, () => [], now)).dispatches, []);

await writeFile(join(home, "sessions.json"), JSON.stringify([{ ...session, agentId: "main", status: "idle", released: true,
  createdAt: stamp(65_000), lastActivityAt: stamp(31_000), seq: 0, config: { model: session.model },
  transcriptPath: join(home, "workbench.jsonl") }]));
const releasedBoard = join(brain, "native", ".system_generated/swarm/members.json");
await mkdir(dirname(releasedBoard), { recursive: true });
await writeFile(releasedBoard, JSON.stringify({ members: { monitor: reviewer } }));
const listener = createServer();
await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
const address = listener.address();
assert(address && typeof address === "object");
const port = address.port;
await new Promise<void>(resolve => listener.close(() => resolve()));
const cliPath = join(home, "bin");
await mkdir(cliPath);
for (const cli of ["claude", "codex", "kimi", "agy"]) {
  await writeFile(join(cliPath, cli), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}
const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  env: { ...process.env, HOME: home, PATH: `${cliPath}:/usr/bin:/bin`, WORKBENCH_HOME: home, WORKBENCH_PORT: String(port), WB_DELEGATE_DIR: externalDelegate },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = once(child, "exit");
const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
let output = "";
try {
  await new Promise<void>((resolve, reject) => {
    const read = (chunk: Buffer) => { output += chunk; if (output.includes("workbench server started")) resolve(); };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("error", reject);
    child.once("exit", () => reject(new Error(output)));
  });
  const request = async (query: string) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dispatches${query}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(res.status, 200);
    return (await res.json()).data;
  };
  const data = await request("?limit=50");
  assert(data.dispatches.some((run: { runId: string }) => run.runId === "antigravity-inner-native-3"));
  assert(!data.dispatches.some((run: { runId: string }) => run.runId === "antigravity-swarm-opus-child"));
  assert.equal(data.runtimeStates.find((state: { sessionId: string }) => state.sessionId === "workbench")?.activeModel, planner);
  assert.deepEqual(await request("?parent=workbench&agent=antigravity"), { dispatches: [] });
} finally {
  clearTimeout(timeout);
  child.kill("SIGTERM");
  await exited;
}
