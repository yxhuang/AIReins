import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { busySessionCount, createPowerOff } from "./power-off.js";

assert.equal(busySessionCount([
  { status: "running" },
  { status: "idle", backgroundTasks: [{ id: "t" } as never] },
  { status: "running", backgroundTasks: [{ id: "t" } as never] },
  { status: "idle" },
  { status: "starting" },
]), 4);

// 空闲：直接关机
{
  const calls: string[][] = [];
  const power = createPowerOff({ busy: () => 0, run: async (args) => { calls.push(args); } });
  assert.deepEqual(await power.request(), { state: "scheduled", busy: 0 });
  assert.deepEqual(calls, [[]]);
  await power.request();
  assert.equal(calls.length, 1, "已排定时重复请求不再执行");
  assert.equal((await power.cancel()).state, "idle");
  assert.deepEqual(calls, [[], ["abort"]]);
}

// 有任务：等全部空闲后关机
{
  let busy = 2;
  const calls: string[][] = [];
  const power = createPowerOff({ busy: () => busy, run: async (args) => { calls.push(args); }, pollMs: 5 });
  assert.deepEqual(await power.request(), { state: "waiting", busy: 2 });
  await sleep(20);
  assert.equal(calls.length, 0);
  busy = 0;
  await sleep(20);
  assert.deepEqual(calls, [[]]);
  assert.equal(power.status().state, "scheduled");
}

// 等待中取消：不执行任何命令
{
  let busy = 1;
  const calls: string[][] = [];
  const power = createPowerOff({ busy: () => busy, run: async (args) => { calls.push(args); }, pollMs: 5 });
  await power.request();
  assert.equal((await power.cancel()).state, "idle");
  busy = 0;
  await sleep(20);
  assert.deepEqual(calls, []);
}

// 命令失败：回到 idle 并带错误
{
  const power = createPowerOff({ busy: () => 0, run: async () => { throw new Error("boom"); } });
  assert.deepEqual(await power.request(), { state: "idle", busy: 0, error: "boom" });
}

// 排定命令未返回时：取消排队等它落地再 abort；两处同时取消只 abort 一次；取消后的新请求重新排定
{
  const calls: string[][] = [];
  const releases: Array<(ok: boolean) => void> = [];
  const power = createPowerOff({ busy: () => 0, run: (args) => {
    calls.push(args);
    return args.length ? Promise.resolve() : new Promise((resolve, reject) => releases.push((ok) => ok ? resolve(undefined) : reject(new Error("late"))));
  } });
  void power.request();
  const cancelA = power.cancel();
  const cancelB = power.cancel();
  const again = power.request();
  await sleep(5);
  assert.deepEqual(calls, [[]], "排定未返回前不发 abort");
  releases[0](true);
  assert.equal((await cancelA).state, "idle");
  await cancelB;
  await sleep(5);
  assert.deepEqual(calls, [[], ["abort"], []], "只 abort 一次，随后重新排定");
  assert.equal(power.status().state, "scheduled");
  releases[1](false);
  assert.deepEqual(await again, { state: "idle", busy: 0, error: "late" });
}

console.log("power-off ok");
