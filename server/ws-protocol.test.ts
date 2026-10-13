import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

// K1：主 WS 收到 null/数组/数字/字符串帧时回协议错误 40001，进程不得崩溃；之后正常帧仍能处理。
// 修前行为：JSON.parse("null") 成功后在 try 外读 message.type 抛 TypeError，void 丢弃的 Promise
// 变成未处理拒绝，Node 22 默认行为直接退出整个 AIReins 进程。
const serverDir = fileURLToPath(new URL(".", import.meta.url));
const forbiddenPorts = new Set([8790, 8793]);
async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
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

const home = await mkdtemp(join(tmpdir(), "workbench-ws-protocol-"));
const port = await freePort();
const child = spawn(process.execPath, ["--import", "tsx", join(serverDir, "index.ts")], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, WORKBENCH_HOME: home, WORKBENCH_PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
let output = "";
let ready!: () => void;
const started = new Promise<void>((resolve) => { ready = resolve; });
function capture(chunk: string): void {
  output += chunk;
  // listen 回调才输出此日志；按累计内容判断，允许日志被拆成多块。
  if (output.includes('"message":"workbench server started"')) ready();
}
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", capture);
child.stderr.on("data", capture);

let socket!: WebSocket;
const frames: Record<string, any>[] = [];
const waiters: Array<{ predicate: (frame: Record<string, any>) => boolean; resolve: (frame: Record<string, any>) => void }> = [];
function connectSocket(): void {
  // 必须在 server 开始监听后再连：提前连接会被 ECONNREFUSED，ws 不会自动重试
  socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
  socket.on("error", () => undefined);
  socket.on("message", (data) => {
    const frame = JSON.parse(String(data)) as Record<string, any>;
    frames.push(frame);
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (waiters[index]!.predicate(frame)) waiters.splice(index, 1)[0]!.resolve(frame);
    }
  });
}
function nextFrame(predicate: (frame: Record<string, any>) => boolean, label: string): Promise<Record<string, any>> {
  const queued = frames.find(predicate);
  if (queued) return Promise.resolve(queued);
  return within(new Promise((resolve) => waiters.push({ predicate, resolve })), 3000, `${label}；已收到 ${JSON.stringify(frames)}`);
}

let bodyError: unknown;
try {
  await within(Promise.race([
    started,
    exited.then(({ code, signal }) => { throw new Error(`server 提前退出 ${code}/${signal}: ${output}`); }),
  ]), 15_000, `等待启动超时: ${output}`);
  connectSocket();
  await within(once(socket, "open"), 3000, "WS 未打开");
  await nextFrame((frame) => frame.type === "ready", "缺 ready 帧");

  // null / 数组 / 数字 / 字符串 / 非 JSON：全部回 40001，连接保持可用
  for (const raw of ["null", "[]", "[1,2]", "1", "\"x\"", "false", "not-json{"]) {
    const before = frames.length;
    socket.send(raw);
    const frame = await nextFrame(
      (candidate) => frames.indexOf(candidate) >= before && candidate.type === "error" && candidate.code === 40001,
      `「${raw}」未回 40001`,
    );
    assert.equal(frame.code, 40001, `「${raw}」应回协议错误 40001`);
  }

  // 之后正常帧仍能处理（不存在的会话走已有的 40003 协议错误路径）
  socket.send(JSON.stringify({ type: "interrupt", sessionId: "missing-session" }));
  const reply = await nextFrame((frame) => frame.type === "error" && frame.code === 40003, "正常帧未得到处理");
  assert.match(reply.msg, /会话不存在/);
  assert.equal(child.exitCode, null, "处理异常帧后进程必须存活");
  assert.equal(child.signalCode, null);
} catch (error) {
  bodyError = error;
} finally {
  socket?.terminate();
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  try {
    await within(exited, 5000, "子进程退出超时");
  } catch {
    child.kill("SIGKILL");
    await within(exited, 3000, "SIGKILL 后仍未退出").catch(() => undefined);
  }
  await rm(home, { recursive: true, force: true });
}
if (bodyError) throw bodyError;
console.log("✅ ws-protocol：null/数组/数字/字符串/非 JSON 帧回 40001，进程存活，正常帧照处理");
