import { strict as assert } from "node:assert";
import { restartAndReconnect, restartBusyCount } from "../src/restart.ts";

assert.equal(restartBusyCount([
  { status: "running" },
  { status: "idle", backgroundTasks: [{ id: "bg" }] },
  { status: "running", backgroundTasks: [{ id: "bg" }] },
  { status: "idle", backgroundTasks: [] },
  { status: "dead" },
]), 3);
assert.equal(restartBusyCount([]), 0);

function source() {
  const listeners = new Set();
  return {
    wsState: "open",
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    state(value) { this.wsState = value; for (const listener of listeners) listener(); },
    get listenerCount() { return listeners.size; },
  };
}

const s = source();
let completed = false;
const done = restartAndReconnect(s, async () => {}, new AbortController().signal, 1000)
  .then(() => { completed = true; });
await new Promise((resolve) => setTimeout(resolve, 0));
s.state("open");
assert.equal(completed, false, "旧 open 不算重启完成");
s.state("closed");
s.state("connecting");
s.state("open");
await done;
assert.equal(completed, true);
assert.equal(s.listenerCount, 0);

const early = source();
let accept;
const earlyDone = restartAndReconnect(early, () => new Promise((resolve) => { accept = resolve; }), new AbortController().signal, 1000);
early.state("closed");
early.state("open");
accept();
await earlyDone;
assert.equal(early.listenerCount, 0, "202 处理前已断线重连也能恢复");

const timeout = source();
await assert.rejects(restartAndReconnect(timeout, async () => {}, new AbortController().signal, 5), /未恢复连接/);
assert.equal(timeout.listenerCount, 0);
const failed = source();
await assert.rejects(restartAndReconnect(failed, async () => { throw new Error("403"); }, new AbortController().signal), /403/);
assert.equal(failed.listenerCount, 0);
const aborted = source();
const controller = new AbortController();
const abortDone = restartAndReconnect(aborted, async () => {}, controller.signal);
controller.abort();
await assert.rejects(abortDone, /取消/);
assert.equal(aborted.listenerCount, 0);
console.log("✅ 重启确认与恢复回归全过（计数、旧连接、202 竞态、超时、拒绝、取消）");
