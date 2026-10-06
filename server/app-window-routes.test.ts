import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 隔离后端与假 CLI；只发必定拒绝的启动请求，不运行任何 Windows 程序。
const home = await mkdtemp(join(tmpdir(), "workbench-app-window-"));
const bin = join(home, "bin");
await mkdir(bin);
for (const name of ["codex", "claude", "kimi"]) {
  await writeFile(join(bin, name), "#!/bin/sh\nprintf 'fixture 1.0\\n'\n", { mode: 0o700 });
}
async function freePort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return port;
}
const port = await freePort(), remotePort = await freePort();
const origin = "https://desk.tail1234.ts.net";
await writeFile(join(home, "remote.json"), JSON.stringify({ port: remotePort, origin, allowedLogins: ["me"] }));
const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./index.ts", import.meta.url))], {
  env: { ...process.env, WORKBENCH_NO_APP_WINDOW: "1", WORKBENCH_HOME: home, WORKBENCH_PORT: String(port), PATH: `${bin}:${process.env.PATH}` },
  stdio: ["ignore", "pipe", "pipe"],
});
const closed = once(child, "close");
let output = "";
const collect = (chunk: Buffer) => { output += chunk.toString(); };
child.stdout.on("data", collect);
child.stderr.on("data", collect);
const deadline = setTimeout(() => child.kill("SIGTERM"), 25_000);
try {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`启动超时：${output}`)), 15_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", () => { clearTimeout(timer); reject(Error(`启动失败：${output}`)); });
    const ready = () => {
      if (output.includes('"message":"remote listener started"')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on("data", ready);
    child.stderr.on("data", ready);
  });
  const post = (base: string, headers: Record<string, string>, target: string) => fetch(`${base}/api/open-app-window`, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ target }),
    signal: AbortSignal.timeout(5000),
  });
  const localBase = `http://127.0.0.1:${port}`, remoteBase = `http://127.0.0.1:${remotePort}`;
  const remoteHeaders = { host: "desk.tail1234.ts.net", origin, "tailscale-user-login": "me" };
  const remote = await post(remoteBase, remoteHeaders, `${localBase}/#/session/a`);
  assert.equal(remote.status, 403, "有合法 Tailscale 身份的远程入口仍禁止启动程序");
  assert.equal((await remote.json()).code, 40300);
  const meta = await fetch(`${remoteBase}/api/meta`, { headers: remoteHeaders, signal: AbortSignal.timeout(10_000) });
  assert.equal((await meta.json()).data.capabilities.appWindow, false, "远程能力位不共享本机结果");
  const bad = await post(localBase, { origin: localBase }, "https://evil.test/");
  assert.equal(bad.status, 400);
  const foreignOrigin = await post(localBase, { origin: "https://evil.test" }, `${localBase}/`);
  assert.equal(foreignOrigin.status, 403, "沿用既有 Origin 校验");
  // fetch 会丢弃自定义 Host 头，改用 http.request 才能真正发出伪造 Host。
  const foreignHost = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/open-app-window", method: "POST",
      headers: { host: "evil.test", origin: localBase, "content-type": "application/json" } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on("error", reject); req.end(JSON.stringify({ target: `${localBase}/` }));
  });
  assert.equal(foreignHost, 403, "沿用既有 Host 校验");
  const ok = await post(localBase, { origin: localBase }, `${localBase}/`);
  assert.equal(ok.status, 503, "测试环境禁用启动器，合法请求也不启动 Chrome");
  console.log("PASS: 真实 HTTP 路由远程403、非法target400、Host/Origin隔离与远程能力位");
} finally {
  clearTimeout(deadline);
  child.kill("SIGTERM");
  await closed;
}
