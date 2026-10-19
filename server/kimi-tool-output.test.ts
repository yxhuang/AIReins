import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { collectKimiTerminalChunk, KimiDriver } from "./drivers/kimi.js";
import type { DriverOptions } from "./types.js";

interface TestTerminal {
  output: string;
  truncated: boolean;
  eventTail: Buffer;
  eventTruncated: boolean;
  exitCode?: number;
  signal?: string;
  process?: ChildProcessWithoutNullStreams;
}

function harness() {
  const events: Array<{ type: string; payload: Record<string, any> }> = [];
  const sent: any[] = [];
  const driver = new KimiDriver({
    sessionId: "test", cwd: process.cwd(), config: {},
    callbacks: {
      emit(type, payload = {}) { events.push({ type, payload }); return undefined; },
      metadata() {}, commands() {}, status() {}, exited() {},
    },
  } satisfies DriverOptions);
  driver.child = { stdin: { writable: true, write(line: string) { sent.push(JSON.parse(line)); } } } as unknown as ChildProcessWithoutNullStreams;
  const internals = driver as unknown as {
    terminals: Map<string, TestTerminal>;
    releasedTerminals: Map<string, TestTerminal>;
    handleStdoutLine(line: string): void;
    handleProcessExit(): void;
  };
  const receive = (message: unknown) => internals.handleStdoutLine(JSON.stringify(message));
  const update = (body: Record<string, unknown>) => receive({
    jsonrpc: "2.0", method: "session/update", params: { update: body },
  });
  const release = (terminalId: string) => receive({
    jsonrpc: "2.0", id: sent.length + 1, method: "terminal/release", params: { terminalId },
  });
  const put = (terminalId: string, state: Omit<TestTerminal, "eventTail" | "eventTruncated"> & Partial<Pick<TestTerminal, "eventTail" | "eventTruncated">>) =>
    internals.terminals.set(terminalId, {
      // 已退出的命令：release 的组清理对它直接完成。
      process: { pid: undefined, exitCode: 0, signalCode: null, once() {}, off() {} } as unknown as ChildProcessWithoutNullStreams,
      ...state,
      eventTail: state.eventTail ?? Buffer.from(state.output),
      eventTruncated: state.eventTruncated ?? state.truncated,
    });
  const completed = (terminalId: string, extra: Record<string, unknown> = {}) => update({
    sessionUpdate: "tool_call_update", toolCallId: terminalId, status: "completed",
    content: [{ type: "terminal", terminalId }], ...extra,
  });
  return { events, sent, internals, update, release, put, completed };
}

{
  const h = harness();
  h.put("released", { output: "命令输出\n", truncated: false, exitCode: 7, signal: "SIGTERM" });
  h.release("released");
  assert.deepEqual(h.sent.at(-1)?.result, {});
  h.completed("released", { status: "failed" });
  assert.equal(h.events.at(-1)?.type, "tool_call_completed");
  assert.deepEqual(h.events.at(-1)?.payload.terminalOutput, {
    terminalId: "released", output: "命令输出\n", truncated: false, exitCode: 7, signal: "SIGTERM",
  });
  assert.equal(h.events.at(-1)?.payload.isError, true);
  h.internals.handleProcessExit();
  assert.equal(h.internals.releasedTerminals.size, 0);
}

{
  const h = harness();
  h.put("live", { output: "部分输出", truncated: false });
  h.completed("live");
  assert.deepEqual(h.events.at(-1)?.payload.terminalOutput, {
    terminalId: "live", output: "部分输出", truncated: false, exitCode: null, signal: null,
  });
  h.release("live");
  assert.equal(h.internals.terminals.has("live"), false);
  assert.equal(h.internals.releasedTerminals.get("live")?.eventTail.toString("utf8"), "部分输出");
  assert.equal(Object.hasOwn(h.internals.releasedTerminals.get("live") ?? {}, "output"), false);
}

{
  const h = harness();
  const long = { output: "", truncated: false, eventTail: Buffer.alloc(0), eventTruncated: false, exitCode: 0 };
  collectKimiTerminalChunk(long, Buffer.from("a".repeat(10) + "界" + "b".repeat(65_535)), 4 * 1024 * 1024);
  h.put("long", long);
  h.completed("long");
  const result = h.events.at(-1)?.payload.terminalOutput;
  assert.equal(result.output, "b".repeat(65_535));
  assert.ok(Buffer.byteLength(result.output, "utf8") <= 64 * 1024);
  assert.equal(result.truncated, true);
  assert.equal(result.exitCode, 0);
  h.put("collected-limit", { output: "short", truncated: true });
  h.completed("collected-limit");
  assert.equal(h.events.at(-1)?.payload.terminalOutput.truncated, true);
}

{
  const h = harness();
  const split = { output: "", truncated: false, eventTail: Buffer.alloc(0), eventTruncated: false };
  const character = Buffer.from("尾");
  collectKimiTerminalChunk(split, character.subarray(0, 1), 1024);
  h.put("split", split);
  h.completed("split");
  assert.equal(h.events.at(-1)?.payload.terminalOutput.output, "");
  collectKimiTerminalChunk(h.internals.terminals.get("split")!, character.subarray(1), 1024);
  h.completed("split");
  assert.equal(h.events.at(-1)?.payload.terminalOutput.output, "尾");
}

{
  const h = harness();
  const limit = 4 * 1024 * 1024;
  const big = { output: "", truncated: false, eventTail: Buffer.alloc(0), eventTruncated: false, exitCode: 1 };
  collectKimiTerminalChunk(big, Buffer.from("x".repeat(limit)), limit);
  collectKimiTerminalChunk(big, Buffer.from("\n最后一行：fatal error\n"), limit);
  assert.equal(big.output, "x".repeat(limit)); // ACP terminal/output still keeps the head.
  assert.equal(big.truncated, true);
  h.put("beyond-acp-limit", big);
  h.release("beyond-acp-limit");
  assert.equal(Object.hasOwn(h.internals.releasedTerminals.get("beyond-acp-limit") ?? {}, "output"), false);
  h.completed("beyond-acp-limit", { status: "failed" });
  const result = h.events.at(-1)?.payload.terminalOutput;
  assert.ok(result.output.endsWith("最后一行：fatal error\n"));
  assert.equal(Buffer.byteLength(result.output, "utf8") <= 64 * 1024, true);
  assert.equal(result.truncated, true);
  assert.equal(result.exitCode, 1);
}

{
  const h = harness();
  h.update({ sessionUpdate: "tool_call_update", status: "completed", content: [{ type: "content" }] });
  assert.equal(Object.hasOwn(h.events.at(-1)?.payload ?? {}, "terminalOutput"), false);
  h.completed("unknown");
  assert.equal(Object.hasOwn(h.events.at(-1)?.payload ?? {}, "terminalOutput"), false);
  h.put("first", { output: "first", truncated: false });
  h.put("second", { output: "second", truncated: false });
  h.update({ sessionUpdate: "tool_call_update", status: "completed", content: [
    { type: "terminal", terminalId: "first" }, { type: "terminal", terminalId: "second" },
  ] });
  assert.equal(h.events.at(-1)?.payload.terminalOutput.output, "first");
}

{
  const h = harness();
  for (let i = 0; i < 65; i++) {
    h.put(`t${i}`, { output: String(i), truncated: false });
    h.release(`t${i}`);
  }
  assert.equal(h.internals.releasedTerminals.size, 64);
  assert.equal(h.internals.releasedTerminals.has("t0"), false);
  assert.equal(h.internals.releasedTerminals.has("t1"), true);
  h.completed("t0");
  assert.equal(Object.hasOwn(h.events.at(-1)?.payload ?? {}, "terminalOutput"), false);
  h.completed("t1");
  assert.equal(h.events.at(-1)?.payload.terminalOutput.output, "1");
}

{
  const h = harness();
  const locations = [{ path: "/repo/a.ts", line: 3 }];
  h.update({ sessionUpdate: "tool_call", toolCallId: "meta", title: "Read", status: "pending", kind: "read", locations });
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "meta", status: "in_progress", kind: "read", locations });
  h.update({ sessionUpdate: "tool_call_update", toolCallId: "meta", status: "completed", kind: "read", locations });
  assert.deepEqual(h.events.map((event) => event.type), ["tool_call_started", "tool_call_updated", "tool_call_completed"]);
  for (const event of h.events) {
    assert.equal(event.payload.kind, "read");
    assert.deepEqual(event.payload.locations, locations);
  }
  h.update({ sessionUpdate: "tool_call", toolCallId: "bare", title: "Bash", status: "pending" });
  assert.equal(Object.hasOwn(h.events.at(-1)?.payload ?? {}, "kind"), false);
  assert.equal(Object.hasOwn(h.events.at(-1)?.payload ?? {}, "locations"), false);
}
