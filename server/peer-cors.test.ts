import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// 端到端：手机主屏 App 留在台式机的源，API/WS 跨源打到笔记本。用 PATH 里的假 tailscale 提供设备列表。
const serverDir = fileURLToPath(new URL(".", import.meta.url));
async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return [8790, 8793].includes(address.port) ? freePort() : address.port;
}

const localPort = await freePort();
let remotePort = await freePort();
while (remotePort === localPort) remotePort = await freePort();
const home = await mkdtemp(join(tmpdir(), "workbench-peer-cors-test-"));
const own = "https://laptop.tail1234.ts.net", desk = "https://desk.tail1234.ts.net", stranger = "https://shared.tail1234.ts.net";
await writeFile(join(home, "remote.json"), JSON.stringify({ port: remotePort, origin: own, allowedLogins: ["me@github"] }));
const bin = join(home, "bin");
await mkdir(bin);
const status = {
  BackendState: "Running",
  Self: { DNSName: "laptop.tail1234.ts.net.", HostName: "laptop", OS: "linux", UserID: 7 },
  Peer: {
    desk: { DNSName: "desk.tail1234.ts.net.", HostName: "desk", OS: "windows", Online: true, UserID: 7, TailscaleIPs: [] },
    shared: { DNSName: "shared.tail1234.ts.net.", HostName: "shared", OS: "linux", Online: true, UserID: 8, TailscaleIPs: [] },
  },
};
await writeFile(join(bin, "tailscale"), `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(status)}\nEOF\n`);
await chmod(join(bin, "tailscale"), 0o755);

const child = spawn(process.execPath, ["--import", "tsx", join(serverDir, "index.ts")], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, WORKBENCH_HOME: home, WORKBENCH_PORT: String(localPort), WORKBENCH_NO_APP_WINDOW: "1", PATH: `${bin}:${process.env.PATH}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });

function send(method: string, origin: string | null, extra: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port: remotePort, method, path: "/api/prefs",
      headers: { host: "laptop.tail1234.ts.net", "tailscale-user-login": "me@github", ...(origin ? { origin } : {}), ...extra },
    }, (response) => { response.resume(); response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers })); });
    req.on("error", reject);
    req.end();
  });
}

function upgrade(origin: string): Promise<"open" | number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${remotePort}/ws`, { headers: { host: "laptop.tail1234.ts.net", origin, "tailscale-user-login": "me@github" } });
    socket.on("open", () => { socket.close(); resolve("open"); });
    socket.on("unexpected-response", (_req, response) => resolve(response.statusCode ?? 0));
    socket.on("error", () => undefined);
  });
}

try {
  const deadline = Date.now() + 15_000;
  while (!output.includes('"message":"remote listener started"')) {
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`server 未就绪：${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const preflight = await send("OPTIONS", desk, { "access-control-request-method": "PUT", "access-control-request-headers": "content-type" });
  assert.equal(preflight.status, 204, "本人电脑的预检通过");
  assert.equal(preflight.headers["access-control-allow-origin"], desk);
  assert.match(String(preflight.headers["access-control-allow-methods"]), /PUT/);
  assert.match(String(preflight.headers["access-control-allow-headers"]), /content-type/);
  const read = await send("GET", desk);
  assert.equal(read.status, 200);
  assert.equal(read.headers["access-control-allow-origin"], desk, "跨源 GET 可读");
  assert.equal((await send("GET", own)).headers["access-control-allow-origin"], undefined, "同源不加 CORS");
  const foreign = await send("OPTIONS", stranger, { "access-control-request-method": "PUT" });
  assert.equal(foreign.status, 403, "别人账号的电脑预检被拒");
  assert.equal(foreign.headers["access-control-allow-origin"], undefined);
  assert.equal((await send("GET", "https://evil.example")).headers["access-control-allow-origin"], undefined);
  assert.equal(await upgrade(desk), "open", "本人电脑可开 WS");
  assert.equal(await upgrade(stranger), 403, "别人账号的电脑 WS 被拒");
  console.log("PASS: 本人其他电脑跨源预检/读取/WS 放行，同源不加 CORS，他人电脑与外站被拒");
} finally {
  child.kill("SIGTERM");
  await once(child, "exit");
}
