#!/usr/bin/env node

const args = process.argv.slice(2);
const sessionId = args.find((arg) => !arg.startsWith("--"));
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const autoAllow = args.includes("--auto-allow");
const untilComplete = args.includes("--until-complete");
const message = option("--message");
const explicitAfter = option("--after");
const timeoutMs = Number(option("--timeout") ?? 240_000);

if (!sessionId) {
  console.error("用法：node server/scripts/ws-demo.mjs <sessionId> [--message 文本] [--auto-allow] [--until-complete] [--after seq]");
  process.exit(2);
}

const baseUrl = "http://127.0.0.1:8790";
const snapshotResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/snapshot`);
const snapshotEnvelope = await snapshotResponse.json();
if (!snapshotResponse.ok || snapshotEnvelope.code !== 0) {
  console.error(JSON.stringify(snapshotEnvelope));
  process.exit(1);
}
const snapshot = snapshotEnvelope.data;
const afterSeq = explicitAfter === undefined ? snapshot.seq : Number(explicitAfter);
console.log(JSON.stringify({
  type: "snapshot_loaded",
  sessionId,
  seq: snapshot.seq,
  eventCount: snapshot.events.length,
  status: snapshot.session.status,
}));

const wsUrl = `ws://127.0.0.1:8790/ws?sessionId=${encodeURIComponent(sessionId)}&afterSeq=${afterSeq}`;
const socket = new WebSocket(wsUrl);
let sentMessage = false;
let completed = false;
const timer = setTimeout(() => {
  console.error(JSON.stringify({ type: "timeout", timeoutMs }));
  socket.close();
  process.exitCode = 1;
}, timeoutMs);

socket.addEventListener("open", () => {
  if (message && !sentMessage) {
    sentMessage = true;
    socket.send(JSON.stringify({ type: "user_message", sessionId, text: message }));
  }
});

socket.addEventListener("message", (messageEvent) => {
  const event = JSON.parse(String(messageEvent.data));
  console.log(JSON.stringify(event));
  if (autoAllow && event.type === "permission_request") {
    socket.send(JSON.stringify({
      type: "permission_resolved",
      sessionId,
      requestId: event.payload.requestId,
      decision: "allow",
    }));
  }
  if (untilComplete && event.type === "turn_completed") {
    completed = true;
    clearTimeout(timer);
    socket.close();
  }
});

socket.addEventListener("error", () => {
  console.error(JSON.stringify({ type: "websocket_error", sessionId }));
  process.exitCode = 1;
});

socket.addEventListener("close", () => {
  clearTimeout(timer);
  if (untilComplete && !completed) process.exitCode = 1;
});
