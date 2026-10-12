import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { WebSocket } from "ws";

const home = mkdtempSync(join(tmpdir(), "wb-performance-routes-"));
const assets = join(home, "dist", "assets");
mkdirSync(assets, { recursive: true });
const source = Buffer.from("console.log('compressed');");
writeFileSync(join(assets, "test.js"), source);
writeFileSync(join(assets, "test.js.gz"), gzipSync(source));
writeFileSync(join(assets, "plain.css"), "body{}");
const mockBin = join(home, "mock-bin"); mkdirSync(mockBin);
for (const cli of ["claude", "codex", "kimi"]) writeFileSync(join(mockBin, cli), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
mkdirSync(join(home, "transcripts"));
const transcriptPath = join(home, "transcripts", "test.jsonl");
const now = new Date().toISOString();
const events = Array.from({ length: 1002 }, (_, index) => ({
  type: index === 1001 ? "permission_request" : index % 25 === 0 ? "user_message" : "agent_text_delta",
  sessionId: "test", agentId: "main", seq: index + 1, timestamp: now,
  payload: index === 1001 ? { requestId: "gate" } : { text: "测试标题" },
}));
writeFileSync(transcriptPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
writeFileSync(join(home, "sessions.json"), JSON.stringify([{ id: "test", agent: "claude", agentId: "main", cwd: home,
  status: "idle", createdAt: now, lastActivityAt: now, seq: 1002, transcriptPath, config: {}, riskyMode: false }]));
const listener = createServer();
await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
const address = listener.address(); assert(address && typeof address !== "string");
const port = address.port; assert(![8790, 8793].includes(port));
await new Promise<void>((resolve) => listener.close(() => resolve()));
const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
  cwd: process.cwd(), env: { ...process.env, HOME: home, WORKBENCH_HOME: home, WORKBENCH_PORT: String(port),
    WORKBENCH_STATIC_DIR: join(home, "dist"), PATH: `${mockBin}:${process.env.PATH}` }, stdio: ["ignore", "pipe", "pipe"],
});
const exited = once(child, "exit");
let output = "";
const ready = new Promise<void>((resolve, reject) => {
  child.stdout.on("data", (data) => { output += String(data); if (output.includes("workbench server started")) resolve(); });
  child.stderr.on("data", (data) => { output += String(data); });
  child.once("exit", () => reject(new Error(output)));
});
const timeout = setTimeout(() => child.kill("SIGTERM"), 15000);
const get = (path: string, encoding = "") => new Promise<{ headers: import("node:http").IncomingHttpHeaders; data: Buffer }>((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path, headers: { "accept-encoding": encoding } }, (response) => {
    const chunks: Buffer[] = []; response.on("data", (data) => chunks.push(data));
    response.on("end", () => resolve({ headers: response.headers, data: Buffer.concat(chunks) }));
  }); req.on("error", reject); req.end();
});
let ws: WebSocket | undefined;
try {
  await ready;
  const compressed = await get("/assets/test.js", "br, gzip");
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.equal(compressed.headers.vary, "accept-encoding");
  assert.match(String(compressed.headers["cache-control"]), /immutable/);
  assert.match(String(compressed.headers["content-type"]), /javascript/);
  assert.deepEqual(gunzipSync(compressed.data), source);
  for (const encoding of ["", "gzip;q=0", "gzip;q=0.0"]) {
    const plain = await get("/assets/test.js", encoding);
    assert.equal(plain.headers["content-encoding"], undefined); assert.deepEqual(plain.data, source);
  }
  const fallback = await get("/assets/plain.css", "gzip");
  assert.equal(fallback.headers["content-encoding"], undefined); assert.equal(fallback.data.toString(), "body{}");
  const sessions = JSON.parse((await get("/api/sessions")).data.toString()).data.sessions;
  assert.equal(sessions[0].title, "测试标题"); assert.equal(sessions[0].pendingGateCount, 0);
  const snapshots = await Promise.all(Array.from({ length: 3 }, () => get("/api/sessions/test/snapshot", "gzip")));
  const requestIds = new Set<string>();
  for (const result of snapshots) {
    assert.equal(result.headers["content-encoding"], "gzip");
    assert.equal(result.headers.vary, "accept-encoding");
    assert.equal(result.headers["cache-control"], "no-store");
    assert.equal(Number(result.headers["content-length"]), result.data.length);
    const envelope = JSON.parse(gunzipSync(result.data).toString());
    assert.equal(envelope.code, 0);
    assert.equal(envelope.data.seq, 1002);
    assert.deepEqual(envelope.data.events, events);
    requestIds.add(envelope.request_id);
  }
  assert.equal(requestIds.size, 3, "并发压缩仍保留各自请求信封");
  const plainSnapshot = await get("/api/sessions/test/snapshot");
  assert.equal(plainSnapshot.headers["content-encoding"], undefined);
  assert.equal(JSON.parse(plainSnapshot.data.toString()).data.seq, 1002);
  const full = JSON.parse(plainSnapshot.data.toString()).data;
  assert.deepEqual(Object.keys(full).sort(), ["events", "seq", "session"]);
  const tailResponse = await get("/api/sessions/test/snapshot?tail=1", "gzip");
  const tail = JSON.parse(gunzipSync(tailResponse.data).toString()).data;
  assert.equal(tail.seq, full.seq);
  assert.equal(tail.hasMore, true);
  assert.equal(tail.firstSeq, tail.events[0].seq);
  assert.equal(tail.session.title, "测试标题");
  assert(tail.session.snapshotState);
  const previous = JSON.parse((await get(`/api/sessions/test/events?beforeSeq=${tail.firstSeq}`)).data.toString()).data;
  assert.equal(previous.hasMore, false);
  assert.equal(previous.firstSeq, 1);
  assert(previous.events.every((event: { seq: number }) => event.seq < tail.firstSeq));
  assert.deepEqual([...previous.events, ...tail.events], full.events);
  const head = JSON.parse((await get("/api/sessions/test/events?beforeSeq=1")).data.toString()).data;
  assert.deepEqual(head, { events: [], hasMore: false, firstSeq: 0 });
  for (const cursor of ["", "0", "2", "1.5", "NaN", "9007199254740992"]) {
    assert.equal(JSON.parse((await get(`/api/sessions/test/events?beforeSeq=${cursor}`)).data.toString()).code, 40068);
  }
  ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const frames: Record<string, any>[] = [];
  const waitFrame = (predicate: (frame: Record<string, any>) => boolean) => new Promise<void>((resolve) => {
    const receive = (data: import("ws").RawData) => {
      const frame = JSON.parse(String(data)); if (!predicate(frame)) return;
      ws!.off("message", receive); resolve();
    }; ws!.on("message", receive);
  });
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  await once(ws, "open");
  const completed = waitFrame((frame) => frame.type === "replay_complete");
  ws.send(JSON.stringify({ type: "replay", sessionId: "test", afterSeq: 1000 }));
  await completed;
  assert.deepEqual(frames.filter((frame) => frame.seq).map((frame) => frame.seq), [1001,1002]);
  assert.equal(frames.find((frame) => frame.seq === 1002)!.type, "permission_request");
  const resync = waitFrame((frame) => frame.type === "resync_required");
  ws.send(JSON.stringify({ type: "replay", sessionId: "test", afterSeq: 0 }));
  await resync;
  assert.equal([...frames].reverse().find((frame) => frame.type === "resync_required")!.currentSeq, 1002); // 其后还有 ack，不能取最后一帧
  const launcher = readFileSync("bin/workbench", "utf8");
  assert.match(launcher, /exec setsid env WORKBENCH_PORT="\$PORT" node --import tsx "\$REPO\/server\/index\.ts" >>"\$LOG" 2>&1 < \/dev\/null/);
  assert.match(launcher, /\[\[ "\$cmd" == \*"\$REPO\/server\/index\.ts"\* \]\]/);
} finally {
  ws?.terminate(); child.kill("SIGTERM"); await exited; clearTimeout(timeout);
}
assert.equal(child.exitCode, 0, "直接 Node 进程 SIGTERM 正常完成 shutdown");
console.log("✅ performance routes: gzip/fallback/cache, list summaries, WS replay/ring fallback, direct Node SIGTERM");
