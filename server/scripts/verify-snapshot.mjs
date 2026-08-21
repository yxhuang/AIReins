#!/usr/bin/env node

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const sessionId = args.find((arg) => !arg.startsWith("--"));
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const probeMessage = option("--probe-message");

if (!sessionId) {
  console.error("用法：node server/scripts/verify-snapshot.mjs <sessionId> [--probe-message 文本]");
  process.exit(2);
}

const response = await fetch(`http://127.0.0.1:8790/api/sessions/${encodeURIComponent(sessionId)}/snapshot`);
const envelope = await response.json();
if (!response.ok || envelope.code !== 0) throw new Error(envelope.msg ?? "snapshot 请求失败");
const { session, seq, events } = envelope.data;
const diskEvents = readFileSync(session.transcriptPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

if (events.length !== diskEvents.length) throw new Error(`snapshot=${events.length}，NDJSON=${diskEvents.length}`);
for (let index = 0; index < events.length; index += 1) {
  if (events[index].seq !== index + 1) throw new Error(`seq 在事件 ${index} 处不连续`);
  if (events[index].sessionId !== sessionId) throw new Error(`seq=${events[index].seq} 串入其他 sessionId`);
  if (events[index].agentId !== session.agentId) throw new Error(`seq=${events[index].seq} agentId 不一致`);
  if (JSON.stringify(events[index]) !== JSON.stringify(diskEvents[index])) {
    throw new Error(`snapshot 与 NDJSON 在 seq=${events[index].seq} 不一致`);
  }
}
if ((events.at(-1)?.seq ?? 0) !== seq || session.seq !== seq) throw new Error("snapshot 顶层 seq、session.seq 与末事件不一致");

if (!probeMessage) {
  console.log(JSON.stringify({ ok: true, sessionId, seq, events: events.length, transcriptPath: session.transcriptPath }));
  process.exit(0);
}

const socket = new WebSocket(`ws://127.0.0.1:8790/ws?sessionId=${encodeURIComponent(sessionId)}&afterSeq=${seq}`);
let firstIncrementalSeq;
let completed = false;
const timer = setTimeout(() => {
  socket.close();
  console.error("增量续传验证 240 秒超时");
  process.exitCode = 1;
}, 240_000);

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ type: "user_message", sessionId, text: probeMessage }));
});
socket.addEventListener("message", (messageEvent) => {
  const event = JSON.parse(String(messageEvent.data));
  if (typeof event.seq === "number") {
    firstIncrementalSeq ??= event.seq;
    if (event.seq <= seq) throw new Error(`收到非增量事件 seq=${event.seq} <= ${seq}`);
  }
  if (event.type === "turn_completed") {
    completed = true;
    clearTimeout(timer);
    socket.close();
    if (firstIncrementalSeq !== seq + 1) throw new Error(`增量首 seq=${firstIncrementalSeq}，预期 ${seq + 1}`);
    console.log(JSON.stringify({ ok: true, sessionId, snapshotSeq: seq, firstIncrementalSeq, finalSeq: event.seq }));
  }
});
socket.addEventListener("close", () => {
  clearTimeout(timer);
  if (!completed) process.exitCode = 1;
});
