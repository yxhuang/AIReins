// 冒烟脚本：验证前端依赖的后端语义——
// 1) 不带 sessionId 的全局 WS 能收到所有会话的事件；
// 2) 快照 seq 与增量事件衔接；
// 3) 审批链路真实闭环：消息必然触发 permission_request，自动 allow 后
//    收到 resolved 广播、turn_completed，且文件确实落盘。
// 用法：node frontend/scripts/smoke-ws.mjs
import { readFile, unlink } from "node:fs/promises";

const base = "http://127.0.0.1:8790";
const sandbox = `${process.cwd()}/server/test-sandbox`;
const fileName = `smoke-${Date.now()}.txt`;
const filePath = `${sandbox}/${fileName}`;

const created = await fetch(`${base}/api/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    agent: "kimi",
    cwd: sandbox,
    kimiMode: "default",
  }),
}).then((r) => r.json());
if (created.code !== 0) throw new Error(created.msg);
const sessionId = created.data.session.id;
console.log("created", sessionId, "| target file:", fileName);

// 全局 WS：不带 sessionId，应收到所有会话事件。
const socket = new WebSocket(`ws://127.0.0.1:8790/ws`);
const seen = [];
let gotReady = false;
let acked = false;
let resolvedBroadcast = false;
let sawPermission = false;
let turnCompleted = false;

socket.addEventListener("message", (event) => {
  const frame = JSON.parse(String(event.data));
  if (frame.type === "ready") {
    gotReady = true;
    return;
  }
  if (frame.type === "ack") {
    console.log("ack", frame.action);
    acked = true;
    return;
  }
  if (typeof frame.seq !== "number") return;
  if (frame.sessionId !== sessionId) {
    console.log("unexpected other-session event", frame.sessionId);
    return;
  }
  seen.push(`${frame.seq}:${frame.type}`);
  if (frame.type === "permission_request") {
    sawPermission = true;
    // 自动放行所有闸门（kimi 有 request_permission + terminal/create 最终闸门两道）。
    socket.send(JSON.stringify({
      type: "permission_resolved",
      sessionId,
      requestId: frame.payload.requestId,
      decision: "allow",
    }));
  }
  if (frame.type === "permission_resolved") resolvedBroadcast = true;
  if (frame.type === "turn_completed") turnCompleted = true;
});

await new Promise((resolve) => socket.addEventListener("open", resolve));
socket.send(JSON.stringify({
  type: "user_message",
  sessionId,
  text: `使用 Shell 在当前目录写入文件 ${fileName}，内容只写 SMOKE，完成后只回复 OK`,
}));

// 等到 turn_completed（上限 90s），再静置半秒让落盘生效。
const deadline = Date.now() + 90_000;
while (!turnCompleted && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 500));
}
await new Promise((resolve) => setTimeout(resolve, 500));
socket.close();

// 文件必须真实落盘且内容正确。
let fileCreated = false;
try {
  fileCreated = (await readFile(filePath, "utf8")).trim() === "SMOKE";
} catch {
  fileCreated = false;
}

// 快照应覆盖 WS 上见过的事件。
const snapshot = await fetch(`${base}/api/sessions/${sessionId}/snapshot`).then((r) => r.json());
const snapSeqs = snapshot.data.events.map((e) => e.seq);
const contiguous = snapSeqs.every((seq, i) => i === 0 || seq === snapSeqs[i - 1] + 1);

console.log("ready:", gotReady);
console.log("ack:", acked, "| permission seen:", sawPermission, "| resolved broadcast:", resolvedBroadcast);
console.log("turn completed:", turnCompleted, "| file created:", fileCreated);
console.log("snapshot events:", snapSeqs.length, "contiguous:", contiguous);
console.log("seen:", seen.join(" "));

await fetch(`${base}/api/sessions/${sessionId}`, { method: "DELETE" });
// 只清理本脚本刚创建的这个文件。
await unlink(filePath).catch(() => {});

const ok = gotReady && acked && sawPermission && resolvedBroadcast && turnCompleted
  && fileCreated && contiguous && snapshot.data.events.length > 0;
console.log(ok ? "SMOKE_OK" : "SMOKE_FAIL");
process.exit(ok ? 0 : 1);
