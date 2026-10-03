import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sendWs, type EventClient } from "./event-stream.js";
import { tryReadMentionText, withTimeout } from "./drivers/base.js";
import { CodexDriver } from "./drivers/codex.js";
import type { DriverCallbacks } from "./types.js";

const limit = 1024 * 1024;

test("K4: 拥堵客户端断开，健康客户端继续收到帧", () => {
  let terminated = 0;
  const slowFrames: string[] = [];
  const fastFrames: string[] = [];
  const slow: EventClient = {
    socket: { readyState: 1, bufferedAmount: limit + 1, send: (data) => { slowFrames.push(String(data)); }, terminate: () => { terminated++; } },
    lastSeq: new Map(),
  };
  const fast: EventClient = {
    socket: { readyState: 1, bufferedAmount: limit, send: (data) => { fastFrames.push(String(data)); }, terminate: () => assert.fail("健康客户端不应断开") },
    lastSeq: new Map(),
  };
  sendWs(slow, { type: "test" });
  sendWs(fast, { type: "test" });
  assert.equal(terminated, 1);
  assert.deepEqual(slowFrames, []);
  assert.deepEqual(fastFrames, ['{"type":"test"}']);
});

test("K5: 引用按 fd 检查大小，读取有界并关闭，增长文件仍降级", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "wb-bounded-mention-"));
  const path = join(root, "mention.txt");
  fs.writeFileSync(path, "文本");
  const mention = { type: "file" as const, path };
  const original = { openSync: fs.openSync, fstatSync: fs.fstatSync, readSync: fs.readSync, closeSync: fs.closeSync, readFileSync: fs.readFileSync };
  let opens = 0;
  let closes = 0;
  let reads = 0;
  let bytes = 0;
  let pretendSmall = false;
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { opens++; return original.openSync(...args); }) as typeof fs.openSync;
  fs.closeSync = ((fd: number) => { closes++; original.closeSync(fd); }) as typeof fs.closeSync;
  fs.fstatSync = ((fd: number) => {
    const stat = original.fstatSync(fd);
    if (pretendSmall) stat.size = 3;
    return stat;
  }) as typeof fs.fstatSync;
  fs.readFileSync = ((...args: Parameters<typeof fs.readFileSync>) => {
    assert.notEqual(args[0], path, "不得用 readFileSync 整读引用");
    return original.readFileSync(...args);
  }) as typeof fs.readFileSync;
  fs.readSync = ((fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    assert.ok(bytes + length <= limit + 1, "最多读取 1 MiB + 1 字节");
    reads++;
    const count = original.readSync(fd, buffer, offset, Math.min(length, 64 * 1024), position);
    bytes += count;
    return count;
  }) as typeof fs.readSync;
  syncBuiltinESMExports();
  try {
    assert.equal(tryReadMentionText(mention), "文本");
    assert.equal(opens, 1, "先打开 fd");
    assert.equal(closes, opens);
    fs.writeFileSync(path, Buffer.alloc(limit + 100, 97));
    reads = 0; bytes = 0;
    assert.equal(tryReadMentionText(mention), null);
    assert.equal(reads, 0, "已知超限时不读正文");
    pretendSmall = true;
    assert.equal(tryReadMentionText(mention), null, "检查后增长仍不得整读或嵌入");
    assert.equal(bytes, limit + 1);
    assert.equal(closes, opens);
    pretendSmall = false;
    fs.writeFileSync(path, Buffer.from([0xff]));
    bytes = 0;
    assert.equal(tryReadMentionText(mention), null);
    assert.equal(closes, opens, "解码失败也关闭 fd");
    fs.writeFileSync(path, Buffer.alloc(limit, 97));
    bytes = 0;
    assert.equal(tryReadMentionText(mention)?.length, limit, "恰好 1 MiB 可嵌入");
    assert.equal(closes, opens);
  } finally {
    Object.assign(fs, original);
    syncBuiltinESMExports();
  }
});

function codexHarness() {
  const frames: Array<{ method: string; params: any }> = [];
  const events: Array<{ type: string; payload: any }> = [];
  const statuses: string[] = [];
  const callbacks: DriverCallbacks = {
    emit: (type, payload) => { events.push({ type, payload }); },
    metadata: () => {}, commands: () => {}, exited: () => {}, status: (value) => { statuses.push(value); },
  };
  const driver = new CodexDriver({ sessionId: "hardening", cwd: process.cwd(), config: {}, callbacks });
  const internal = driver as any;
  internal.threadId = "thread-test";
  internal.request = async (method: string, params: any) => {
    frames.push({ method, params });
    return method === "skills/list" ? { data: [] } : { turn: { id: "turn-test" } };
  };
  return { driver, internal, frames, events, statuses };
}

test("K7: 发送美元文本使用 skills 缓存，面板仍强制刷新", async () => {
  const h = codexHarness();
  await h.driver.sendUserMessage({ text: "$HOME" });
  await h.internal.startingTurn;
  await h.driver.sendUserMessage({ text: "$HOME again" });
  await h.internal.startingTurn;
  await h.driver.queryInfo("skills");
  assert.deepEqual(h.frames.filter((frame) => frame.method === "skills/list").map((frame) => frame.params.forceReload), [false, false, true]);
});

function fakeTimers() {
  const originalSet = globalThis.setTimeout;
  const originalClear = globalThis.clearTimeout;
  const timers: Array<{ ms: number; fire(): void; cleared: boolean }> = [];
  globalThis.setTimeout = ((callback: () => void, ms: number) => {
    const timer = { ms, fire: callback, cleared: false, unref() { return this; } };
    timers.push(timer);
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: typeof timers[number]) => { timer.cleared = true; }) as unknown as typeof clearTimeout;
  return { timers, restore() { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear; } };
}

test("K8: turn/start 60 秒超时进入现有 error 路径，成功与拒绝保持原语义", async () => {
  const h = codexHarness();
  const clock = fakeTimers();
  let finish!: (value: unknown) => void;
  h.internal.request = () => new Promise((resolve) => { finish = resolve; });
  try {
    await h.driver.sendUserMessage({ text: "pending" });
    assert.equal(clock.timers.length, 1, "turn/start 必须设置超时");
    assert.equal(clock.timers[0]!.ms, 60_000);
    clock.timers[0]!.fire();
    await h.internal.startingTurn;
    assert.deepEqual(h.statuses, ["running", "error"]);
    assert.equal(h.events[0]!.type, "session_error");
    assert.equal(h.events[0]!.payload.source, "turn/start");
    assert.match(h.events[0]!.payload.message, /60000ms/);
    finish({ turn: { id: "late-turn" } });
    await Promise.resolve();
    assert.equal(h.internal.turnId, "", "迟到响应不得激活已超时回合");
    h.internal.request = async () => ({ turn: { id: "ok-turn" } });
    await h.driver.sendUserMessage({ text: "ok" });
    await h.internal.startingTurn;
    assert.equal(h.internal.turnId, "ok-turn");
    assert.equal(clock.timers.at(-1)!.cleared, true);
    h.internal.request = async () => { throw new Error("rejected"); };
    await h.driver.sendUserMessage({ text: "reject" });
    await h.internal.startingTurn;
    assert.equal(h.events.at(-1)!.payload.message, "rejected");
    assert.equal(h.statuses.at(-1), "error");
  } finally { clock.restore(); }
});

test("K9: withTimeout 成功、拒绝与超时均清理定时器", async () => {
  const clock = fakeTimers();
  try {
    assert.equal(await withTimeout(Promise.resolve("ok"), 60_000, "success"), "ok");
    assert.equal(clock.timers[0]!.cleared, true);
    const error = new Error("original rejection");
    await assert.rejects(withTimeout(Promise.reject(error), 60_000, "reject"), (value) => value === error);
    assert.equal(clock.timers[1]!.cleared, true);
    const pending = withTimeout(new Promise<never>(() => {}), 60_000, "pending");
    const rejection = assert.rejects(pending, /pending 超时（60000ms）/);
    clock.timers[2]!.fire();
    await rejection;
    assert.equal(clock.timers[2]!.cleared, true);
  } finally { clock.restore(); }
});
