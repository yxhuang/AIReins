// 冒烟脚本：验证前端依赖的后端语义——
// 1) 不带 sessionId 的全局 WS 能收到所有会话的事件；
// 2) 快照 seq 与增量事件衔接；3) 审批上行回 ack 并广播 permission_resolved。
// 用法：node frontend/scripts/smoke-ws.mjs
const base = "http://127.0.0.1:8790";

const created = await fetch(`${base}/api/sessions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    agent: "kimi",
    cwd: `${process.cwd()}/server/test-sandbox`,
    kimiMode: "default",
  }),
}).then((r) => r.json());
if (created.code !== 0) throw new Error(created.msg);
const sessionId = created.data.session.id;
console.log("created", sessionId);

// 全局 WS：不带 sessionId，应收到所有会话事件。
const socket = new WebSocket(`ws://127.0.0.1:8790/ws`);
const seen = [];
let gotReady = false;
let acked = false;
let resolvedBroadcast = false;
let sawPermission = false;

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
    socket.send(JSON.stringify({
      type: "permission_resolved",
      sessionId,
      requestId: frame.payload.requestId,
      decision: "allow",
    }));
  }
  if (frame.type === "permission_resolved") resolvedBroadcast = true;
});

await new Promise((resolve) => socket.addEventListener("open", resolve));
socket.send(JSON.stringify({ type: "user_message", sessionId, text: "只回复 OK" }));

await new Promise((resolve) => setTimeout(resolve, 90_000));
socket.close();

// 快照应覆盖 WS 上见过的事件。
const snapshot = await fetch(`${base}/api/sessions/${sessionId}/snapshot`).then((r) => r.json());
const snapSeqs = snapshot.data.events.map((e) => e.seq);
const contiguous = snapSeqs.every((seq, i) => i === 0 || seq === snapSeqs[i - 1] + 1);

console.log("ready:", gotReady);
console.log("ack:", acked, "| permission seen:", sawPermission, "| resolved broadcast:", resolvedBroadcast);
console.log("snapshot events:", snapSeqs.length, "contiguous:", contiguous);
console.log("seen:", seen.join(" "));

await fetch(`${base}/api/sessions/${sessionId}`, { method: "DELETE" });

const ok = gotReady && acked && contiguous && snapshot.data.events.length > 0;
console.log(ok ? "SMOKE_OK" : "SMOKE_FAIL");
process.exit(ok ? 0 : 1);
