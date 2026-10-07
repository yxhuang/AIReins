import assert from "node:assert/strict";
import { CodexDriver } from "./drivers/codex.js";
import type { DriverCallbacks } from "./types.js";

// /side：ephemeral fork + 边界提示 + 独立回合；侧聊事件不进主线，取消即 interrupt + unsubscribe。
const frames: any[] = [], events: any[] = [];
const callbacks: DriverCallbacks = {
  emit(type, payload) { events.push({ type, payload }); }, metadata() {}, commands() {}, status() {}, exited() {},
};
const driver = new CodexDriver({ sessionId: "wb-side", cwd: "/tmp", config: { model: "main-model", effort: "high" }, resumeSessionId: "main", callbacks });
const internal = driver as any;
let forks = 0, holdTurnStart = false;
internal.spawnProcess = () => undefined;
internal.child = { stdin: { writable: true } };
internal.send = (frame: any) => {
  frames.push(frame);
  if (frame.id === undefined || !frame.method) return;
  if (holdTurnStart && frame.method === "turn/start") return;
  const result = frame.method === "model/list" ? { data: [{ model: "main-model", supportedReasoningEfforts: [{ reasoningEffort: "high" }] }] }
    : frame.method === "config/read" ? { config: { developer_instructions: "Existing policy." } }
    : frame.method === "thread/resume" ? { thread: { id: "main" } }
    : frame.method === "thread/fork" ? { thread: { id: `side-${++forks}` } }
    : frame.method === "turn/start" ? { turn: { id: `turn-${frames.length}` } } : {};
  queueMicrotask(() => internal.handleStdoutLine(JSON.stringify({ id: frame.id, result })));
};
await driver.start();
const notify = (method: string, params: any) => internal.handleStdoutLine(JSON.stringify({ method, params }));
const waitFor = async (method: string, after: number) => {
  for (let i = 0; i < 50; i++) {
    const frame = frames.slice(after).find(f => f.method === method);
    if (frame) return frame;
    await new Promise(r => setTimeout(r, 1));
  }
  throw new Error(`no ${method}`);
};

let mark = frames.length;
const first = driver.askSideQuestion({ question: "what is X?" }, new AbortController().signal);
const fork = await waitFor("thread/fork", mark);
assert.equal(fork.params.threadId, "main");
assert.equal(fork.params.ephemeral, true);
assert.equal(fork.params.approvalPolicy, "never");
assert.match(fork.params.developerInstructions, /^Existing policy\.\n\nYou are in a side conversation/);
const inject = await waitFor("thread/inject_items", mark);
assert.match(inject.params.items[0].content[0].text, /^Side conversation boundary\./);
const turn = await waitFor("turn/start", mark);
assert.equal(turn.params.threadId, "side-1");
assert.equal(turn.params.input[0].text, "what is X?");
const before = events.length;
notify("item/agentMessage/delta", { threadId: "side-1", itemId: "a", delta: "partial" });
notify("item/completed", { threadId: "side-1", item: { type: "agentMessage", id: "a", text: "X is Y." } });
internal.handleStdoutLine(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: { threadId: "side-1" } }));
assert.equal(frames.at(-1).error?.code, -32601, "侧聊审批请求必须拒绝");
notify("turn/completed", { threadId: "side-1", turn: { status: "completed" } });
assert.deepEqual(await first, { response: "X is Y.", sideId: "side-1" });
assert.equal(events.length, before, "侧聊事件不得进入主线");

// 续问复用同一侧聊线程，不再 fork
mark = frames.length;
const second = driver.askSideQuestion({ question: "and Z?", history: [{ question: "what is X?", response: "X is Y." }], sideId: "side-1" }, new AbortController().signal);
const turn2 = await waitFor("turn/start", mark);
assert.equal(turn2.params.threadId, "side-1");
assert.equal(frames.slice(mark).some(f => f.method === "thread/fork"), false);
notify("item/completed", { threadId: "side-1", item: { type: "agentMessage", id: "b", text: "Z." } });
notify("turn/completed", { threadId: "side-1", turn: { status: "completed" } });
assert.deepEqual(await second, { response: "Z.", sideId: "side-1" });

// 取消：interrupt + unsubscribe，下次带历史时重新 fork 并以文字续上历史
mark = frames.length;
const cancel = new AbortController();
holdTurnStart = true; // turn/start 响应未到、但 turn/started 已告知回合 ID 时取消，须立即 interrupt
const third = driver.askSideQuestion({ question: "slow?", history: [{ question: "and Z?", response: "Z." }], sideId: "side-1" }, cancel.signal);
await waitFor("turn/start", mark);
assert.equal(frames.slice(mark).some(f => f.method === "thread/fork"), false, "sideId 一致时续用");
notify("turn/started", { threadId: "side-1", turn: { id: "held-turn" } });
cancel.abort();
await assert.rejects(third, /取消/);
holdTurnStart = false;
assert.deepEqual(frames.slice(mark).find(f => f.method === "turn/interrupt")?.params, { threadId: "side-1", turnId: "held-turn" });
assert.equal(frames.slice(mark).find(f => f.method === "thread/unsubscribe")?.params.threadId, "side-1");
mark = frames.length;
const fourth = driver.askSideQuestion({ question: "again", history: [{ question: "what is X?", response: "X is Y." }], sideId: "side-1" }, new AbortController().signal);
const turn4 = await waitFor("turn/start", mark);
assert.equal(turn4.params.threadId, "side-2");
assert.match(turn4.params.input[0].text, /Q: what is X\?\nA: X is Y\.[\s\S]*New question:\nagain$/);
notify("turn/completed", { threadId: "side-2", turn: { status: "failed", error: { message: "boom" } } });
await assert.rejects(fourth, /boom/);

// 另一窗口开过新侧聊：本面板 sideId 对不上当前侧聊线程，重新 fork 而不串线
mark = frames.length;
const fifth = driver.askSideQuestion({ question: "B" }, new AbortController().signal);
await waitFor("turn/start", mark);
notify("item/completed", { threadId: "side-3", item: { type: "agentMessage", id: "c", text: "B answer" } });
notify("turn/completed", { threadId: "side-3", turn: { status: "completed" } });
await fifth;
mark = frames.length;
const sixth = driver.askSideQuestion({ question: "A again", history: [{ question: "what is X?", response: "X is Y." }], sideId: "side-2" }, new AbortController().signal);
const turn6 = await waitFor("turn/start", mark);
assert.equal(turn6.params.threadId, "side-4");
notify("turn/completed", { threadId: "side-4", turn: { status: "completed" } });
await sixth;

// fork / inject 等待期间取消：立即返回，迟到的成功 fork 被 unsubscribe
let releaseFork: () => void = () => {};
const saved = internal.send;
internal.send = (frame: any) => {
  if (frame.method === "thread/fork") {
    frames.push(frame);
    releaseFork = () => internal.handleStdoutLine(JSON.stringify({ id: frame.id, result: { thread: { id: "late-side" } } }));
    return;
  }
  saved(frame);
};
const forkCancel = new AbortController();
mark = frames.length;
const seventh = driver.askSideQuestion({ question: "cancel during fork" }, forkCancel.signal);
await waitFor("thread/fork", mark);
forkCancel.abort();
await assert.rejects(seventh, /取消/);
releaseFork();
assert.equal((await waitFor("thread/unsubscribe", mark + 1)).params.threadId, "late-side");
internal.send = saved;

// 首条消息前 fork 失败给出可读提示
internal.send = (frame: any) => {
  if (frame.id === undefined || !frame.method) return;
  const reply = frame.method === "thread/fork" ? { error: { message: "no rollout found for thread id main" } } : { result: { config: {} } };
  queueMicrotask(() => internal.handleStdoutLine(JSON.stringify({ id: frame.id, ...reply })));
};
await assert.rejects(driver.askSideQuestion({ question: "q" }, new AbortController().signal), /先发一条消息/);
console.log("PASS: Codex /side fork, boundary, isolation, reuse, cancel, refork with history, errors");
