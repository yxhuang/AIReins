import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { DriverOptions, SessionRecord, UnifiedEvent } from "./types.js";
import type { NativeConversationReader } from "./native-conversation.js";

const home = mkdtempSync(join(tmpdir(), "wb-round2-"));
process.env.WORKBENCH_HOME = home;
const [{ SessionManager }, { ClaudeDriver, claudeLaunchArgs }, storage, { createDispatchScanCache }, { createGzipQueue }] = await Promise.all([
  import("./session-manager.js"), import("./drivers/claude.js"), import("./persistence.js"),
  import("./dispatches.js"), import("./response-compression.js"),
]);

class FakeCLI extends ClaudeDriver {
  readonly requests: Record<string, any>[] = [];
  launchArgs: string[] = [];
  stopped = false;
  failure: "error" | "timeout" | null = null;
  onRequest?: () => void;
  async start() {
    this.launchArgs = claudeLaunchArgs(this.config, this.resumeSessionId);
    this.callbacks.metadata({ config: { ...this.config }, nativeSessionId: this.resumeSessionId ?? "native-fixture" });
    this.callbacks.status("idle");
  }
  protected send(message: unknown) {
    const frame = message as Record<string, any>;
    this.requests.push(frame.request);
    this.onRequest?.();
    if (this.failure === "timeout") return;
    queueMicrotask(() => this.handleStdoutLine(JSON.stringify({ type: "control_response", response: {
      request_id: frame.request_id, subtype: this.failure ? "error" : "success",
      ...(this.failure ? { error: "fixture unsupported" } : { response: {} }),
    } })));
  }
  async stop() { this.stopped = true; }
  async sendUserMessage() { this.callbacks.status("running"); }
  async resolvePermission() {}
  finish() { this.callbacks.status("idle"); }
  gate() { this.callbacks.emit("permission_request", { requestId: "gate" }); }
}
const drivers: FakeCLI[] = [];
const factory = (_agent: unknown, options: DriverOptions) => { const driver = new FakeCLI(options); drivers.push(driver); return driver; };
const settings = () => ({ model: "opus", effort: "high", remoteControlAtStartup: false });
const nativeReader = { capture: async () => ({ path: join(home, "native.jsonl"), nativeSessionId: "native-fixture", size: 0 }),
  changed: async () => undefined } as unknown as NativeConversationReader;
const manager = new SessionManager(factory, settings, async () => null, nativeReader);
const frames: UnifiedEvent[] = [];
manager.onEvent((event) => frames.push(event));
const session = await manager.create({ agent: "claude", cwd: home, snapshot: "skip" });
const cli = drivers[0]!;
const changed = await manager.setConfig(session.id, { model: "sonnet", effort: "low" });
assert.equal(drivers.length, 1);
assert.equal(cli.stopped, false);
assert.deepEqual(cli.requests, [{ subtype: "set_model", model: "sonnet" }, { subtype: "apply_flag_settings", settings: { effortLevel: "low" } }]);
assert.equal(changed.config.model, "sonnet");
assert.equal(changed.effectiveModel, "sonnet");
assert.equal(changed.effectiveEffort, "low");
assert.equal(frames.at(-1)!.payload.effectiveModel, "sonnet");
assert.equal(frames.at(-1)!.payload.workerRestarted, false);
assert.equal(manager.getSnapshot(session.id)!.session.effectiveEffort, "low");
await manager.setConfig(session.id, { model: null, effort: null });
assert.deepEqual(cli.requests.slice(-2), [{ subtype: "set_model", model: null }, { subtype: "apply_flag_settings", settings: { effortLevel: null } }]);
assert.equal(manager.get(session.id)!.effectiveModel, "opus");
assert.equal(manager.get(session.id)!.effectiveEffortSource, "settings");
cli.onRequest = () => {
  assert.equal((manager as any).releaseBlocker(session.id, manager.get(session.id)!), "会话正在切换配置或续接，请稍候");
};
await manager.setConfig(session.id, { model: "haiku" });
cli.onRequest = undefined;
await manager.sendUserMessage(session.id, { text: "fixture" });
await assert.rejects(manager.setConfig(session.id, { effort: "high" }), /当前回合尚未结束/);
cli.finish();
cli.failure = "error";
await manager.setConfig(session.id, { model: "sonnet", effort: "medium" });
assert.equal(cli.stopped, true);
assert.equal(drivers.length, 2, "错误回落到重启");
assert.equal(frames.at(-1)!.payload.workerRestarted, true);
assert.equal(manager.get(session.id)!.effectiveEffort, "medium");
const timeoutCLI = drivers.at(-1)!;
timeoutCLI.failure = "timeout";
const realTimeout = globalThis.setTimeout;
const keepAlive = realTimeout(() => undefined, 100);
globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => realTimeout(callback, ms === 15000 ? 1 : ms, ...args)) as typeof setTimeout;
try { await manager.setConfig(session.id, { effort: "low" }); }
finally { globalThis.setTimeout = realTimeout; clearTimeout(keepAlive); }
assert.equal(timeoutCLI.stopped, true);
assert.equal(drivers.length, 3, "超时回落到重启");
await manager.release(session.id, "manual");
const count = drivers.length;
const deferred = await manager.setConfig(session.id, { model: "haiku", effort: "high" });
assert.equal(drivers.length, count, "释放后改配置不拉起 worker");
assert.equal(deferred.released, true);
assert.equal(frames.at(-1)!.payload.effectiveFrom, "next_turn");
await manager.sendUserMessage(session.id, { text: "next" });
assert.equal(drivers.length, count + 1);
const args = drivers.at(-1)!.launchArgs;
assert.equal(args[args.indexOf("--model") + 1], "haiku");
assert.equal(args[args.indexOf("--effort") + 1], "high");
assert.equal(args[args.indexOf("--resume") + 1], "native-fixture");
drivers.at(-1)!.finish();
drivers.at(-1)!.gate();
await assert.rejects(manager.setConfig(session.id, { model: "opus" }), /审批结束/);
await manager.resolvePermission(session.id, "gate", "deny");
await manager.shutdown();

// 流式清理：按 agent 排除其它驱动，结构匹配、末行/权限/原 seq/幂等与恢复均锁住。
const fixture = (agent: "claude" | "codex" | "kimi", id: string) => {
  const path = storage.transcriptPathFor(id);
  const events = [
    { seq: 1, type: "user_message", payload: { text: "partialInput 文本不是结构字段" } },
    { seq: 2, type: "tool_call_updated", payload: { toolCallId: "tool", partialInput: "中".repeat(40000) } },
    { seq: 3, type: "tool_call_updated", payload: { partialInput: "complete", inputComplete: true } },
    { seq: 4, type: "raw_event", payload: { partialInput: "not tool update" } },
    { seq: 5, type: "permission_request", payload: { requestId: "replay-gate" } },
    { seq: 6, type: "tool_call_updated", payload: { partialInput: "last" } },
  ].map((event) => ({ ...event, sessionId: id, agentId: "main", timestamp: new Date().toISOString() }));
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n\n", { mode: 0o600 });
  return { id, agent, seq: 6, status: "idle", released: true, nativeSessionId: id,
    config: {}, cwd: home, createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), transcriptPath: path } as SessionRecord;
};
const records = [fixture("claude", "old-claude"), fixture("codex", "old-codex"), fixture("kimi", "old-kimi")];
const original = records.map((record) => readFileSync(record.transcriptPath));
storage.saveRegistry(records);
const result = storage.compactClaudeTranscripts(records);
assert.deepEqual({ files: result.files, rewrittenFiles: result.rewrittenFiles, removedLines: result.removedLines }, { files: 1, rewrittenFiles: 1, removedLines: 1 });
assert.equal(result.removedBytes, original[0]!.length - readFileSync(records[0]!.transcriptPath).length);
assert.deepEqual(storage.readTranscript(records[0]!.transcriptPath).map((event) => event.seq), [1,3,4,5,6]);
assert.equal(statSync(records[0]!.transcriptPath).mode & 0o777, 0o600);
for (let i = 1; i < records.length; i++) assert.deepEqual(readFileSync(records[i]!.transcriptPath), original[i]);
const before = statSync(records[0]!.transcriptPath);
assert.equal(storage.compactClaudeTranscripts(records).rewrittenFiles, 0);
assert.equal(statSync(records[0]!.transcriptPath).ino, before.ino);
assert.equal(statSync(records[0]!.transcriptPath).mtimeMs, before.mtimeMs);
const restored = new SessionManager(factory, settings, async () => null, nativeReader);
const snapshot = restored.getSnapshot("old-claude")!;
assert.equal(snapshot.seq, 6);
assert.equal(restored.list().find((item) => item.id === "old-claude")!.pendingGateCount, 1);
assert.equal(snapshot.events.at(-1)!.seq, 6);
assert.deepEqual(restored.getEventsAfter("old-claude", 1), { events: [], requiresSnapshot: true, currentSeq: 6 });
assert.equal(restored.getEventsAfter("old-claude", 3)!.requiresSnapshot, false);
assert.deepEqual(restored.getEventsAfter("old-claude", 3)!.events.map((event) => event.seq), [4,5,6]);
const getAfter = SessionManager.prototype.getEventsAfter;
const ringFixture = { sessions: new Map([["s", { seq: 4 }]]), rings: new Map([["s", [1,3,4].map((seq) => ({ seq }))]]) };
assert.deepEqual(getAfter.call(ringFixture as any, "s", 1), { events: [], requiresSnapshot: true, currentSeq: 4 });
ringFixture.rings.set("s", [1,2,3,4].map((seq) => ({ seq })));
assert.equal(getAfter.call(ringFixture as any, "s", 1)!.requiresSnapshot, false);
await restored.shutdown();

let scans = 0, now = 0;
let finish!: (runs: any[]) => void;
const cached = createDispatchScanCache(async () => { scans++; return new Promise((resolve) => { finish = resolve; }); }, () => now);
const first = cached("root"), second = cached("root");
await Promise.resolve();
assert.equal(scans, 1);
finish([{ runId: "one", parent: { model: "original" } }]);
const [a, b] = await Promise.all([first, second]);
a[0]!.parent!.model = "mutated";
assert.equal(b[0]!.parent!.model, "original");
now = 1999; await cached("root"); assert.equal(scans, 1);
now = 2000; const expired = cached("root"); await Promise.resolve(); assert.equal(scans, 2); finish([]); await expired;
const other = cached("other"); await Promise.resolve(); assert.equal(scans, 3); finish([]); await other;

let active = 0, max = 0;
const releases: Array<() => void> = [];
const queue = createGzipQueue(async (json) => {
  active++; max = Math.max(max, active);
  await new Promise<void>((resolve) => releases.push(resolve));
  active--; if (json === "bad") throw new Error("compression failure");
  return Buffer.from(json);
});
const zipped = [queue("first"), queue("second")];
await Promise.resolve(); assert.equal(active, 1); releases.shift()!(); await zipped[0];
await Promise.resolve(); assert.equal(active, 1); releases.shift()!(); await zipped[1]; assert.equal(max, 1);
const bad = queue("bad"); const rejected = assert.rejects(bad, /compression failure/);
const next = queue("after error"); await Promise.resolve(); releases.shift()!(); await rejected;
await Promise.resolve(); releases.shift()!(); assert.equal((await next).toString(), "after error");
const asyncGzip = createGzipQueue();
const text = JSON.stringify(snapshot);
assert.equal(gunzipSync(await asyncGzip(text)).toString(), text);
console.log("✅ round2: Claude control/error/timeout/deferred/gates, migration/seq/replay, shared scan TTL, async gzip serialization");
