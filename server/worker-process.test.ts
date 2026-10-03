import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { captureWorkerIdentity, oldWorkerGone, readSystemBootTime } from "./worker-process.js";
import type { WorkerProcessIdentity } from "./types.js";

const absentPid = 2_000_000_000;
const current = captureWorkerIdentity(process.pid);
assert.ok(current, "Linux 当前进程身份应可读取");
const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
assert.equal(current.bootId, readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
assert.equal(current.startTime, stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]);
assert.equal(captureWorkerIdentity(absentPid), undefined);
for (const pid of [undefined, 0, -1, 1.5, NaN, Infinity, 0x80000000]) {
  assert.equal(captureWorkerIdentity(pid), undefined);
  assert.equal(oldWorkerGone({ processId: pid }), false, "非法或缺失 PID 无法证明 worker 已退出");
}
console.log("✅ worker process: captures-boot-start-time-and-rejects-invalid-pid");

function withKill<T>(kill: typeof process.kill, check: () => T): T {
  const original = process.kill;
  process.kill = kill;
  try { return check(); } finally { process.kill = original; }
}
const errno = (code: string) => Object.assign(new Error(code), { code });
withKill(() => { throw errno("ESRCH"); }, () => {
  assert.equal(oldWorkerGone({ processId: absentPid }), true, "legacy PID 明确不存在可恢复");
  assert.equal(oldWorkerGone({ processId: absentPid, processIdentity: { ...current, processGroupId: absentPid } }), true);
});
for (const code of ["EPERM", "EACCES", "EIO"]) {
  withKill(() => { throw errno(code); }, () => {
    assert.equal(oldWorkerGone({ processId: absentPid }), false, "权限或未知错误不能当作进程不存在");
    assert.equal(oldWorkerGone({ processId: absentPid, processIdentity: { ...current, processGroupId: absentPid } }), false);
  });
}
console.log("✅ worker process: esrch-proves-absence-and-permission-errors-block-recovery");

assert.equal(oldWorkerGone({ processId: process.pid, processIdentity: current }), false, "当前相同身份存活时禁止恢复");
assert.equal(oldWorkerGone({ processId: process.pid, processIdentity: { ...current, bootId: current.bootId.toUpperCase() } }), false,
  "大小写不同的相同 boot UUID 不能被误判为重启并授予恢复资格");
assert.equal(oldWorkerGone({ processId: process.pid }), false, "缺身份的存活 PID 同样禁止恢复");
const reused = { ...current, startTime: "0" };
assert.notEqual(reused.startTime, current.startTime);
assert.equal(oldWorkerGone({ processId: process.pid, processIdentity: reused }), false,
  "同 boot PID 复用但不知道旧进程组是否存活时，保持保守");
withKill((pid, signal) => {
  assert.equal(signal, 0);
  if (pid === -process.pid) throw errno("ESRCH");
  return true;
}, () => assert.equal(oldWorkerGone({ processId: process.pid, processIdentity: { ...reused, processGroupId: process.pid } }), true,
  "PID 身份不同且所属旧组明确消失才允许恢复"));
const previousBoot = { ...current, bootId: current.bootId[0] === "a" ? `b${current.bootId.slice(1)}` : `a${current.bootId.slice(1)}` };
assert.equal(oldWorkerGone({ processId: process.pid, processIdentity: previousBoot }), true, "boot 不同能证明旧进程树消失");
console.log("✅ worker process: live-identity-pid-reuse-and-previous-boot");

const malformed: unknown[] = [
  null, false, 0, "", [], {}, { bootId: "", startTime: "1" }, { ...current, startTime: "invalid" },
  { ...current, startTime: 123 }, { ...current, bootId: null }, { ...current, bootId: "-".repeat(36) },
  { ...current, processGroupId: absentPid + 1 }, { ...current, processGroupId: String(absentPid) },
];
withKill(() => { throw errno("ESRCH"); }, () => {
  for (const identity of malformed) {
    assert.equal(oldWorkerGone({ processId: absentPid, processIdentity: identity as WorkerProcessIdentity }), false,
      "持久化身份字段损坏时不能用宽松 coercion 获得恢复资格");
  }
});
console.log("✅ worker process: malformed-persisted-identities-block-recovery");

for (const groupResult of ["alive", "EPERM", "EIO"]) {
  const calls: number[] = [];
  withKill((pid, signal) => {
    assert.equal(signal, 0);
    calls.push(pid);
    if (pid === absentPid) throw errno("ESRCH");
    assert.equal(pid, -absentPid);
    if (groupResult !== "alive") throw errno(groupResult);
    return true;
  }, () => assert.equal(oldWorkerGone({ processId: absentPid, processIdentity: { ...current, processGroupId: absentPid } }), false,
    "leader 消失但 owned group 存活或状态未知时禁止续接"));
  assert.deepEqual(calls, [absentPid, -absentPid]);
}
withKill((pid) => {
  if (pid > 0) throw errno("EPERM");
  throw errno("ESRCH");
}, () => assert.equal(oldWorkerGone({ processId: process.pid, processIdentity: { ...reused, processGroupId: process.pid } }), false,
  "不能在 PID 存活未知时依赖 group ESRCH 绕过 EPERM"));
console.log("✅ worker process: surviving-or-unknown-owned-group-blocks-recovery");

// 仅读取模拟 /proc/stat；ESM builtin live binding 经同步更新，finally 完整恢复。
function withProcStat<T>(content: string | Error, check: () => T): T {
  const original = fs.readFileSync;
  fs.readFileSync = ((path: unknown, ...args: unknown[]) => {
    if (path === "/proc/stat") {
      if (content instanceof Error) throw content;
      return content;
    }
    return (original as (...args: unknown[]) => unknown)(path, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try { return check(); } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
}
for (const content of ["cpu 1 2 3\nbtime 1700000000\nprocesses 10\n", "btime\t1700000000", "btime 1700000000\n"]) {
  withProcStat(content, () => assert.equal(readSystemBootTime(), 1_700_000_000_000, "完整 btime 的秒数转换为毫秒"));
}
for (const content of ["", "cpu 1 2 3\n", "notbtime 1700000000\n", "btime 123junk\n", "btime -1\n",
  "btime NaN\n", "btime \n", "btime 1.5\n", "btime 10 trailing\n", "btime 9007199254740991\n",
  "btime 1700000000\nbtime 1700000001\n", `btime ${Math.ceil(Date.now() / 1_000) + 60}\n`]) {
  withProcStat(content, () => assert.equal(readSystemBootTime(), undefined, "缺失、不完整、重复、未来或溢出的 btime 不能证明系统重启"));
}
withProcStat(errno("EPERM"), () => assert.equal(readSystemBootTime(), undefined, "读取失败时不猜测系统 boot"));
console.log("✅ worker process: system-boot-time-parses-complete-btime-and-blocks-invalid-input");

// 单独拥有的 Node 进程组：leader 退出后 child 仍活着，不能因为 leader ESRCH 就恢复。
// child 自带 10 秒退出上限；finally 只操作本测试启动的组，并等输出管道关闭确认结束。
// 当前沙箱内 leader 两次未报告 child PID，实际进程冒烟留给明确开启的外部验收。
if (process.env.WORKBENCH_TEST_PROCESS_GROUP === "1") {
const childSource = "setTimeout(() => process.exit(0), 10000)";
const leaderSource = `
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.once('spawn', () => console.log(child.pid));
  process.stdin.once('data', () => process.exit(0));
`;
const leader = spawn(process.execPath, ["--input-type=commonjs", "-e", leaderSource], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
const leaderPid = leader.pid!;
const leaderExit = once(leader, "exit");
const outputClosed = once(leader.stdout!, "close");
let childPid: number | undefined;
let leaderErrors = "";
leader.stderr!.on("data", data => { leaderErrors += data.toString(); });
try {
  const leaderIdentity = captureWorkerIdentity(leaderPid);
  assert.ok(leaderIdentity);
  assert.equal(leaderIdentity.processGroupId, leaderPid, "detached leader 应拥有独立进程组");
  childPid = await new Promise<number>((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`fixture leader 未及时报告 child PID: ${leaderErrors}`)), 5_000);
    const cleanup = () => clearTimeout(timer);
    leader.once("error", reject);
    leader.once("exit", () => {
      if (!childPid) { cleanup(); reject(new Error(`fixture leader 提前退出: ${leaderErrors}`)); }
    });
    leader.stdout!.on("data", data => {
      text += data.toString();
      const pid = Number(text.split(/\r?\n/).find(line => /^\d+$/.test(line)));
      if (Number.isSafeInteger(pid) && pid > 0) { cleanup(); resolve(pid); }
    });
  });
  leader.stdin!.end("exit\n");
  await leaderExit;
  assert.throws(() => process.kill(leaderPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  assert.equal(process.kill(childPid, 0), true, "受控子进程仍存活");
  assert.equal(process.kill(-leaderPid, 0), true);
  assert.equal(oldWorkerGone({ processId: leaderPid, processIdentity: leaderIdentity }), false,
    "旧 leader 消失但组内 child 仍存活时，禁止第二个 worker 续接");
  console.log("✅ worker process: surviving-owned-group-child-blocks-recovery");
} finally {
  try { process.kill(-leaderPid, "SIGTERM"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  await leaderExit;
  await outputClosed;
}
} else {
  console.log("⏭ worker process: real-owned-group-child smoke skipped; WORKBENCH_TEST_PROCESS_GROUP=1 enables it");
}
