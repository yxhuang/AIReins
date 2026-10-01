import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocket } from "ws";

const serverDir = fileURLToPath(new URL(".", import.meta.url));
const forbiddenPorts = new Set([8790, 8793]);
async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return forbiddenPorts.has(address.port) ? freePort() : address.port;
}

async function within<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function run(stall: boolean): Promise<void> {
  const localPort = await freePort();
  let remotePort = await freePort();
  while (remotePort === localPort) remotePort = await freePort();
  const home = await mkdtemp(join(tmpdir(), "workbench-shutdown-test-"));
  const origin = "https://desk.tail1234.ts.net";
  await writeFile(join(home, "remote.json"), JSON.stringify({
    port: remotePort, origin, allowedLogins: ["me@github"], terminal: true,
  }));
  // 只替换子进程内的 shutdown 等待：不启动真实 agent，也不向生产代码添加测试开关。
  const preload = join(home, "shutdown-preload.mjs");
  await writeFile(preload, `
import { SessionManager } from ${JSON.stringify(pathToFileURL(join(serverDir, "session-manager.ts")).href)};
const original = SessionManager.prototype.shutdown;
SessionManager.prototype.shutdown = async function () {
  console.log("TEST_SHUTDOWN_WAITING");
  ${stall ? "await new Promise(() => {});" : "await new Promise(resolve => setTimeout(resolve, 1500));"}
  await original.call(this);
  console.log("TEST_WORKERS_STOPPED");
};
`);
  const child = spawn(process.execPath, ["--import", "tsx", "--import", preload, join(serverDir, "index.ts")], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: { ...process.env, WORKBENCH_HOME: home, WORKBENCH_PORT: String(localPort) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { output += chunk; });
  child.stderr.on("data", (chunk: string) => { output += chunk; });
  async function waitForOutput(marker: string): Promise<void> {
    if (output.includes(marker)) return;
    let onData: () => void = () => undefined;
    const found = new Promise<void>((resolve) => {
      onData = () => { if (output.includes(marker)) resolve(); };
      child.stdout.on("data", onData);
    });
    try {
      await within(Promise.race([
        found,
        exited.then(({ code, signal }) => { throw new Error(`server 提前退出 ${code}/${signal}: ${output}`); }),
      ]), 15_000, `等待 ${marker} 超时: ${output}`);
    } finally {
      child.stdout.off("data", onData);
    }
  }
  const websockets: WebSocket[] = [];
  const rawSockets: Socket[] = [];
  const entries = [
    { port: localPort, headers: { origin: `http://127.0.0.1:${localPort}` } },
    { port: remotePort, headers: { host: "desk.tail1234.ts.net", origin, "tailscale-user-login": "me@github" } },
  ];
  try {
    await waitForOutput('"message":"workbench server started"');
    await waitForOutput('"message":"remote listener started"');
    for (const { port, headers } of entries) {
      for (const path of ["/ws", "/ws/terminal"]) {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
        websockets.push(socket);
        socket.on("error", () => undefined);
        await within(once(socket, "open"), 3000, `初始 ${port}${path} WS 未打开`);
        // 模拟不回复 close frame 的客户端，不能靠优雅关闭的握手让进程退出。
        socket.pause();
      }
      const socket = createConnection({ host: "127.0.0.1", port });
      rawSockets.push(socket);
      socket.on("error", () => undefined);
      await within(once(socket, "connect"), 3000, "残留 HTTP 连接未打开");
      socket.write("GET /api/sessions HTTP/1.1\r\nHost: localhost\r\n"); // 未完成的 HTTP 请求
    }
    const started = Date.now();
    assert(child.kill("SIGTERM"));
    await waitForOutput("TEST_SHUTDOWN_WAITING");
    const checks: Promise<void>[] = [];
    for (const { port, headers } of entries) {
      for (const path of ["/ws", "/ws/terminal"]) {
        checks.push(within(new Promise<void>((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
          websockets.push(socket);
          socket.on("open", () => reject(new Error(`shutdown 期间 ${port}${path} WS 仍升级成功`)));
          socket.on("unexpected-response", (req, response) => {
            try {
              assert.equal(response.statusCode, 503);
              assert.equal(response.headers.connection, "close");
              response.resume();
              req.destroy();
              resolve();
            } catch (error) { reject(error); }
          });
          socket.on("error", (error: NodeJS.ErrnoException) => {
            // 直接销毁升级 socket 也符合接口契约；ECONNREFUSED 意味监听过早关闭，必须失败。
            if (error.code === "ECONNRESET") resolve();
            else reject(error);
          });
        }), 1000, `shutdown 期间 ${port}${path} WS 未被拒绝`));
      }
      checks.push(within(new Promise<void>((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port, path: "/api/sessions", headers }, (response) => {
          response.resume();
          response.once("end", () => {
            try {
              assert.equal(response.statusCode, 503, `shutdown 期间 ${port} HTTP 必须拒绝`);
              assert.equal(response.headers.connection, "close");
              assert(!output.includes("TEST_WORKERS_STOPPED"), "worker 停完前监听仍应存在");
              resolve();
            } catch (error) { reject(error); }
          });
        });
        req.on("error", reject);
        req.setTimeout(1000, () => req.destroy(new Error("shutdown HTTP 请求超时")));
        req.end();
      }), 1200, `shutdown 期间 ${port} HTTP 未返回`));
    }
    // 等所有检查结束再抛出，失败路径也不会留下尚未处理的异步断言。
    const results = await Promise.allSettled(checks);
    const failures = results.filter((result) => result.status === "rejected");
    assert.equal(failures.length, 0, failures.map((result) => String(result.reason)).join("\n"));
    const result = await within(exited, stall ? 11_000 : 4500, `shutdown 进程未退出: ${output}`);
    assert.deepEqual(result, { code: stall ? 1 : 0, signal: null });
    if (stall) {
      assert.match(output, /workbench server shutdown timed out/);
      assert(Date.now() - started < 12_000, "硬超时应在 12 秒内退出");
    } else {
      assert(output.includes("TEST_WORKERS_STOPPED"), "退出前 worker shutdown 必须完成");
      assert(Date.now() - started < 6000, "正常 shutdown 应在 6 秒内退出");
    }
    // 真正重新 bind 两个端口，比只检查 ECONNREFUSED 更直接地证明已释放监听。
    for (const { port } of entries) {
      const listener = createServer();
      await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(port, "127.0.0.1", resolve);
      });
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  } finally {
    for (const socket of websockets) socket.terminate();
    for (const socket of rawSockets) socket.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await within(exited, 3000, "测试子进程清理超时");
  }
}

await run(false);
console.log("✅ shutdown：两个监听拒绝 HTTP/WS，残留普通/终端 WS 与 HTTP 连接不阻塞退出，端口已释放");
await run(true);
console.log("✅ shutdown：worker 等待卡住时，10 秒硬超时记录日志并退出 1，两个端口已释放");
