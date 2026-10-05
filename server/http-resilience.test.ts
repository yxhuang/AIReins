import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// Real HTTP/upgrade handlers, isolated state and fake metadata CLIs; no live worker/model.
const root = fileURLToPath(new URL("..", import.meta.url));
const home = await mkdtemp(join(tmpdir(), "workbench-http-resilience-"));
const bin = join(home, "bin");
await mkdir(bin);
await mkdir(join(home, "transcripts"));
for (const name of ["claude", "codex", "kimi"]) {
  await writeFile(join(bin, name), "#!/bin/sh\nprintf 'fixture 1.0\\n'\n", { mode: 0o700 });
}
const nativePath = join(home, "native-history.jsonl");
await writeFile(nativePath, "native history must remain\n");
const sessions = Array.from({ length: 100 }, (_, n) => ({
  id: `resilience-${n}`, agent: "codex", agentId: "main", cwd: home, status: "dead",
  createdAt: new Date().toISOString(), lastActivityAt: new Date().toISOString(), seq: 0,
  transcriptPath: join(home, "transcripts", `${n}.ndjson`), nativeTranscriptPath: nativePath,
  title: "long-title-".repeat(50), config: {}, riskyMode: false,
}));
await writeFile(sessions[0]!.transcriptPath, "");
await writeFile(join(home, "sessions.json"), JSON.stringify(sessions));
const permanentId = "11111111-1111-4111-8111-111111111111";
const codexHome = join(home, "codex");
const permanentPath = join(codexHome, "sessions", `rollout-${permanentId}.jsonl`);
await mkdir(join(codexHome, "sessions"), { recursive: true });
await writeFile(permanentPath, JSON.stringify({ type: "session_meta", payload: { id: permanentId, cwd: home } }) + "\n");
await writeFile(sessions[1]!.transcriptPath, "");
await writeFile(join(home, "sessions.json"), JSON.stringify(sessions.map((session, index) => index === 1
  ? { ...session, nativeSessionId: permanentId, nativeTranscriptPath: permanentPath } : session)));
await writeFile(join(bin, "codex"), `#!/usr/bin/env node
const fs = require('node:fs'), p = require('node:path');
if (process.argv[2] === 'delete') {
 if (process.argv[3] !== '--force' || process.argv[4] !== '${permanentId}') process.exit(2);
 fs.unlinkSync(p.join(process.env.CODEX_HOME, 'sessions', 'rollout-${permanentId}.jsonl'));
} else fs.writeSync(1, 'fixture 1.0\\n');
`, { mode: 0o700 });
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = (listener.address() as { port: number }).port;
await new Promise<void>(resolve => listener.close(() => resolve()));
const child = spawn(process.execPath, ["--import", "tsx", join(root, "server/index.ts")], {
  cwd: root, env: { ...process.env, WORKBENCH_HOME: home, WORKBENCH_PORT: String(port), PATH: `${bin}:${process.env.PATH}`,
    CODEX_HOME: codexHome, WORKBENCH_CODEX_HISTORY_DIR: join(codexHome, "sessions") },
  stdio: ["ignore", "pipe", "pipe"],
});
const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
let output = "";
child.stderr.on("data", chunk => { output += chunk.toString(); });
const base = `http://127.0.0.1:${port}`;
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup timeout: ${output}`)), 15_000);
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    child.stdout.on("data", chunk => {
      output += chunk.toString();
      if (output.includes('"message":"workbench server started"')) { clearTimeout(timer); resolve(); }
    });
  });
  // 畸形路径必须在启动任何 Windows 程序前拒绝；跨站请求沿用现有访问控制。
  const invalidPicker = await fetch(`${base}/api/fs/pick-directory`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: 42 }) });
  assert.ok([400, 403].includes(invalidPicker.status), "不可用环境返回403，可用环境在启动前返回400");
  const foreignPicker = await fetch(`${base}/api/fs/pick-directory`, { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json" }, body: "{}" });
  assert.equal(foreignPicker.status, 403);
  for (const [encoding, expected] of [["gzip;q=0", null], ["gzip;q=0.0, br", null], ["GZIP;Q=0", null], ["br", null], ["gzip;q=0.5", "gzip"], ["GZIP", "gzip"]] as const) {
    const response = await fetch(`${base}/api/sessions`, { headers: { "accept-encoding": encoding } });
    assert.equal(response.headers.get("content-encoding"), expected, `API ${encoding}`);
    const body = await response.json();
    assert.equal(body.data.sessions.length, 100);
  }
  const asset = (await readdir(join(root, "frontend/dist/assets"))).find(name => name.endsWith(".css.gz"));
  assert.ok(asset, "Existing compressed CSS asset required");
  for (const [encoding, expected] of [["gzip;q=0", null], ["gzip", "gzip"]] as const) {
    const response: Response = await fetch(`${base}/assets/${asset.slice(0, -3)}`, { headers: { "accept-encoding": encoding } });
    assert.equal(response.headers.get("content-encoding"), expected, `static ${encoding}`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const socket = connect(port, "127.0.0.1");
  let rejection = "";
  socket.on("data", chunk => { rejection += chunk.toString(); });
  socket.on("error", () => undefined);
  await once(socket, "connect");
  const socketClosed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Malformed upgrade did not close")); }, 5_000);
    socket.once("close", () => { clearTimeout(timer); resolve(); });
  });
  socket.write(`GET http://[ HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${base}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await socketClosed;
  assert.match(rejection, /^HTTP\/1\.1 400 /);
  assert.equal(child.exitCode, null, "Malformed URL must not terminate server");
  assert.equal((await fetch(`${base}/api/sessions`)).status, 200, "Normal HTTP remains available");
  for (const pathname of ["/ws", "/ws/terminal"]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers: { origin: base } });
    await once(ws, "open");
    ws.close();
    await once(ws, "close");
  }
  const deleted = await fetch(`${base}/api/sessions/${sessions[0]!.id}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  const result = (await deleted.json()).data;
  assert.equal(result.transcriptsDeleted, true);
  assert.equal(result.workbenchTranscriptPreserved, false);
  assert.equal(result.nativeTranscriptPreserved, true);
  await assert.rejects(readFile(sessions[0]!.transcriptPath), { code: "ENOENT" });
  assert.equal(await readFile(nativePath, "utf8"), "native history must remain\n");
  const permanentUrl = `${base}/api/sessions/${sessions[1]!.id}/permanent`;
  for (const body of [{}, { confirmNativeSessionId: "wrong-id" }]) {
    const response = await fetch(permanentUrl, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 400, "permanent deletion requires matching explicit confirmation");
    assert.equal((await fetch(`${base}/api/sessions/${sessions[1]!.id}`)).status, 200);
    assert.ok(await readFile(permanentPath));
  }
  const legacyQuery = await fetch(`${base}/api/sessions/${sessions[1]!.id}?permanent=true`, { method: "DELETE" });
  assert.equal(legacyQuery.status, 400, "query parameter must never downgrade permanent deletion to ordinary remove");
  const permanentResponse = await fetch(permanentUrl, { method: "DELETE", headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirmNativeSessionId: permanentId }) });
  assert.equal(permanentResponse.status, 200);
  assert.equal((await permanentResponse.json()).data.nativeTranscriptPreserved, false);
  await assert.rejects(readFile(permanentPath), { code: "ENOENT" });
  await assert.rejects(readFile(sessions[1]!.transcriptPath), { code: "ENOENT" });
  assert.equal(await readFile(nativePath, "utf8"), "native history must remain\n");
  console.log("HTTP resilience: malformed upgrade, gzip negotiation, truthful delete contract passed");
} finally {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
  await closed;
  clearTimeout(timer);
}
