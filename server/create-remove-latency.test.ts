import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 新建不等 CLI 握手、发送等启动完成、移除不等进程退出（10-01 用户反馈新建/移除卡 2–5 秒）。
const fixture = await mkdtemp(join(tmpdir(), "workbench-latency-test-"));
process.env.WORKBENCH_HOME = join(fixture, "wb");
const { SessionManager } = await import("./session-manager.js");

let releaseStart!: () => void;
const sent: string[] = [];
let stopCalled = false;
const manager = new SessionManager((_kind, options) => ({
  child: { pid: 4242 },
  start: () => new Promise<void>((resolve) => { releaseStart = () => { options.callbacks.status("idle"); resolve(); }; }),
  stop: () => { stopCalled = true; return new Promise<void>(() => undefined); }, // 永不退出
  sendUserMessage: async (message: { text?: string }) => { sent.push(message.text ?? ""); },
  interrupt: async () => undefined,
}) as any);

const created = await Promise.race([
  manager.create({ agent: "codex", cwd: fixture }),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("create waited for worker.start")), 500)),
]);
assert.equal(created.status, "starting");

const sending = manager.sendUserMessage(created.id, { text: "hi" });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.deepEqual(sent, [], "send must wait for startup");
releaseStart();
await sending;
assert.deepEqual(sent, ["hi"]);

const removed = await Promise.race([
  manager.remove(created.id),
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error("remove waited for worker.stop")), 500)),
]);
assert.equal(removed?.status, "dead");
assert.ok(stopCalled);
assert.equal(manager.list().some((session) => session.id === created.id), false);
// 启动中被移除：晚到的启动完成不复活会话。
const removedEarly = await manager.create({ agent: "codex", cwd: fixture });
await manager.remove(removedEarly.id);
releaseStart();
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(manager.get(removedEarly.id), undefined);

// 启动失败：状态停在 error（不被 stop 触发的 exited 改成 dead），发送拿到启动错误。
let finishStop!: () => void;
const failing = new SessionManager((_kind, options) => ({
  child: { pid: 4343 },
  start: () => Promise.reject(new Error("握手失败")),
  stop: () => { options.callbacks.exited({ code: 1, signal: null, expected: false }); return Promise.resolve(); },
  sendUserMessage: async () => undefined,
  interrupt: async () => undefined,
}) as any);
const broken = await failing.create({ agent: "codex", cwd: fixture });
await assert.rejects(() => failing.sendUserMessage(broken.id, { text: "x" }), /握手失败/);
assert.equal(failing.get(broken.id)!.status, "error");
assert.equal(failing.getSnapshot(broken.id)!.events.some((event) => event.type === "session_error"), true);

// shutdown 等移除时在后台停的进程。
const slow = new SessionManager(() => ({
  child: { pid: 4444 },
  start: async () => undefined,
  stop: () => new Promise<void>((resolve) => { finishStop = resolve; }),
  sendUserMessage: async () => undefined,
  interrupt: async () => undefined,
}) as any);
const slowSession = await slow.create({ agent: "codex", cwd: fixture });
await new Promise((resolve) => setTimeout(resolve, 10));
await slow.remove(slowSession.id);
let shutDown = false;
const shutting = slow.shutdown().then(() => { shutDown = true; });
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(shutDown, false, "shutdown must wait for background stop");
finishStop();
await shutting;

console.log("create/remove latency ok");
process.exit(0);
