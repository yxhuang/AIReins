import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { busySessionCount, createPowerOff, powerOffEnabled } from "./power-off.js";

const root = await mkdtemp(join(tmpdir(), "wb-power-command-"));
const command = join(root, "power-command");
assert.equal(powerOffEnabled(), false);
assert.equal(powerOffEnabled(command), false, "不存在的命令不支持关机");
assert.equal(powerOffEnabled(root), false, "目录不能当命令");
assert.equal(powerOffEnabled("relative"), false);
await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
assert.equal(powerOffEnabled(command), false, "不可执行文件不支持关机");
await chmod(command, 0o700);
assert.equal(powerOffEnabled(command), true);

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
  const power = createPowerOff({ busy: () => 0, run: async (args) => { calls.push(args); }, now: () => 1000 });
  assert.deepEqual(await power.request(), { state: "scheduled", busy: 0, remainingMs: 60_000 });
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

// 倒计时：剩余时间随时钟递减；过了关机时刻加宽限仍活着，回到 idle 并带错误
{
  let clock = 0;
  const power = createPowerOff({ busy: () => 0, run: async () => undefined, delayMs: 60_000, graceMs: 30_000, now: () => clock });
  await power.request();
  clock = 45_000;
  assert.equal(power.status().remainingMs, 15_000);
  clock = 80_000;
  assert.deepEqual(power.status(), { state: "scheduled", busy: 0, remainingMs: 0 });
  clock = 90_001;
  const timedOut = power.status();
  assert.equal(timedOut.state, "idle");
  assert.equal(timedOut.remainingMs, undefined);
  assert.match(timedOut.error ?? "", /仍未关机/);
  assert.equal((await power.request()).state, "scheduled", "超时复位后可重新关机");
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
