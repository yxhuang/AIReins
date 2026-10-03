import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CodexDriver } from "./drivers/codex.js";
import { KimiDriver } from "./drivers/kimi.js";
import type { DriverOptions } from "./types.js";

function harness<T extends CodexDriver | KimiDriver>(Driver: new (options: DriverOptions) => T) {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const sent: any[] = [];
  const driver = new Driver({
    sessionId: "test", cwd: process.cwd(), config: {},
    callbacks: {
      emit(type, payload = {}) { events.push({ type, payload }); return undefined; },
      metadata() {}, commands() {}, status() {}, exited() {},
    },
  });
  driver.child = { stdin: { writable: true, write(line: string) { sent.push(JSON.parse(line)); } } } as unknown as ChildProcessWithoutNullStreams;
  const receive = (message: unknown) =>
    (driver as unknown as { handleStdoutLine(line: string): void }).handleStdoutLine(JSON.stringify(message));
  const exit = () =>
    (driver as unknown as { handleProcessExit(): void }).handleProcessExit();
  return { driver, events, sent, receive, exit };
}

{
  const h = harness(CodexDriver);
  h.receive({ jsonrpc: "2.0", id: 41, method: "item/tool/requestUserInput", params: {
    threadId: "t", turnId: "u", itemId: "i", isBlocking: true,
    questions: [
      { id: "food", question: "吃什么？", header: "午餐", isOther: true,
        options: [{ label: "面", description: "热" }, { label: "饭", description: "饱" }] },
      { id: "drink", question: "喝什么？", header: "饮料", isOther: true,
        options: [{ label: "水", description: "清淡" }] },
    ],
  } });
  const event = h.events.at(-1)!;
  assert.equal(event.type, "permission_request");
  assert.equal(event.payload.interactionType, "ask_user_question");
  assert.deepEqual((event.payload.questions as any[]).map((q) => q.question), ["吃什么？", "喝什么？"]);
  assert.deepEqual((event.payload.questions as any[]).map((q) => q.multiSelect), [false, false]);
  await h.driver.resolvePermission("codex:question:41", "allow", undefined, {
    "吃什么？": "面", "喝什么？": "自制饮料",
  });
  assert.deepEqual(h.sent.at(-1), { jsonrpc: "2.0", id: 41, result: {
    answers: { food: { answers: ["面"] }, drink: { answers: ["自制饮料"] } },
  } });
  h.receive({ jsonrpc: "2.0", id: 42, method: "item/tool/requestUserInput", params: {
    threadId: "t", turnId: "u", itemId: "i2", isBlocking: true,
    questions: [{ id: "x", question: "继续？", header: "确认", options: [{ label: "是", description: "继续" }] }],
  } });
  await assert.rejects(h.driver.resolvePermission("codex:question:42", "allow", undefined, { "继续？": "其他" }), /不接受自由文本/);
  await h.driver.resolvePermission("codex:question:42", "deny");
  assert.deepEqual(h.sent.at(-1).result, { answers: {} });
  h.receive({ jsonrpc: "2.0", id: 43, method: "item/tool/requestUserInput", params: {
    threadId: "t", turnId: "u", itemId: "i3", isBlocking: true,
    questions: [{ id: "y", question: "选项？", header: "确认", options: [{ label: "甲", description: "选甲" }] }],
  } });
  await h.driver.interrupt();
  assert.deepEqual(h.sent.at(-1), { jsonrpc: "2.0", id: 43, result: { answers: {} } });
  await assert.rejects(h.driver.resolvePermission("codex:question:43", "deny"), /不存在/);
  h.receive({ jsonrpc: "2.0", id: 44, method: "item/tool/requestUserInput", params: {
    threadId: "t", turnId: "u", itemId: "i4", isBlocking: true,
    questions: [{ id: "z", question: "已退出？", header: "状态", options: [{ label: "是", description: "退出" }] }],
  } });
  h.exit();
  await assert.rejects(h.driver.resolvePermission("codex:question:44", "deny"), /不存在/);
}

{
  const h = harness(KimiDriver);
  const form = (id: number) => ({ jsonrpc: "2.0", id, method: "elicitation/create", params: {
    sessionId: "s", mode: "form", message: "吃什么？\n喝什么？",
    requestedSchema: { type: "object", required: ["q0", "q1"], properties: {
      q0: { type: "string", title: "午餐", oneOf: [
        { const: "面", title: "面", description: "热" }, { const: "饭", title: "饭", description: "饱" },
      ] },
      q1: { type: "array", title: "饮料", minItems: 1, items: { anyOf: [
        { const: "茶", title: "茶" }, { const: "水", title: "水" },
      ] } },
    } },
  } });
  h.receive(form(51));
  const event = h.events.at(-1)!;
  assert.equal(event.type, "permission_request");
  assert.equal(event.payload.interactionType, "ask_user_question");
  assert.equal(event.payload.otherSupported, false);
  assert.deepEqual((event.payload.questions as any[]).map((q) => q.multiSelect), [false, true]);
  await h.driver.resolvePermission("kimi:elicitation:51", "allow", undefined, {
    "吃什么？": "面", "喝什么？": "水,茶",
  });
  assert.deepEqual(h.sent.at(-1), { jsonrpc: "2.0", id: 51, result: {
    action: "accept", content: { q0: "面", q1: ["茶", "水"] },
  } });
  h.receive(form(52));
  await assert.rejects(h.driver.resolvePermission("kimi:elicitation:52", "allow", undefined, {
    "吃什么？": "自制饭", "喝什么？": "茶",
  }), /不支持「其他」/);
  await h.driver.resolvePermission("kimi:elicitation:52", "deny");
  assert.deepEqual(h.sent.at(-1).result, { action: "decline" });
  h.receive(form(53));
  await h.driver.interrupt();
  assert.deepEqual(h.sent.at(-1), { jsonrpc: "2.0", id: 53, result: { action: "cancel" } });
  h.receive(form(54));
  h.exit();
  await assert.rejects(h.driver.resolvePermission("kimi:elicitation:54", "deny"), /不存在/);

  // Form 能力不影响 CLI 原生审批；Workbench 仍转发它并回传拒绝。
  h.receive({ jsonrpc: "2.0", id: 55, method: "session/request_permission", params: {
    toolCall: { title: "Shell" }, options: [{ kind: "reject_once", optionId: "reject" }],
  } });
  assert.equal(h.events.at(-1)?.payload.gate, "session/request_permission");
  await h.driver.resolvePermission("kimi:session/request_permission:55", "deny");
  assert.equal(h.sent.at(-1).id, 55);
  assert.deepEqual(h.sent.at(-1).result, { outcome: { outcome: "selected", optionId: "reject" } });
}
