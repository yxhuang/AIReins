import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { once } from "node:events";
import { readFileSync, readdirSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { spawn } from "@lydell/node-pty";
import { WebSocket } from "ws";
import { localPolicy, remotePolicy } from "./access.js";
import { MAX_SCROLLBACK_BYTES, TerminalRegistry, isWindowsMount, resolveShell, stripReplayQueries, terminalEnabled, windowsHome } from "./terminals.js";

type Pty = ReturnType<typeof spawn>;
class FakePty {
  private dataListeners = new Set<(data: string) => void>();
  private exitListeners = new Set<(event: { exitCode: number }) => void>();
  writes: string[] = [];
  sizes: Array<[number, number]> = [];
  kills = 0;
  onData = (listener: (data: string) => void) => {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  };
  onExit = (listener: (event: { exitCode: number }) => void) => {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  };
  write(data: string): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.sizes.push([cols, rows]); }
  kill(): void { this.kills++; this.exit(0); }
  output(data: string): void { for (const listener of this.dataListeners) listener(data); }
  exit(exitCode: number): void { for (const listener of this.exitListeners) listener({ exitCode }); }
}

const ptys: FakePty[] = [];
let spawned: { file: string; args: string[] | string; options: Parameters<typeof spawn>[2] } | undefined;
const fakeSpawn = ((file: string, args: string[] | string, options: Parameters<typeof spawn>[2]) => {
  spawned = { file, args, options };
  const pty = new FakePty();
  ptys.push(pty);
  return pty as unknown as Pty;
}) as typeof spawn;
const registry = new TerminalRegistry(process.cwd(), fakeSpawn);
const created = registry.create({ cwd: "/path/that/does/not/exist", cols: 80, rows: 24 });
assert.match(created.id, /^term_[0-9A-HJKMNP-TV-Z]{26}$/);
assert.equal(created.cwd, process.cwd(), "不存在的 cwd 回退到 defaultCwd");
assert.equal(created.kind, "bash", "省略 shell 默认 bash");
assert.equal(spawned?.file, "bash", "选 bash 就跑 bash，不跟 $SHELL");
assert.deepEqual(spawned?.args, ["-l", "-i"]);
assert.equal(spawned?.options.cwd, process.cwd());
assert.equal(spawned?.options.env, process.env);
assert.deepEqual(registry.list(), [created]);

const pty = ptys[0];
pty.output("before");
const received: unknown[] = [];
const replay = registry.attach(created.id, (event) => received.push(event));
assert.deepEqual({ omitted: replay.omitted, data: replay.data }, { omitted: 0, data: "before" });
pty.output("after");
assert.deepEqual(received, [{ type: "data", terminalId: created.id, data: "after" }]);
replay.detach();
pty.output("detached");
assert.equal(received.length, 1, "断连只取消订阅，PTY 继续运行");
assert.equal(registry.attach(created.id, () => undefined).data, "beforeafterdetached");

pty.output("a".repeat(MAX_SCROLLBACK_BYTES + 17));
const truncated = registry.attach(created.id, () => undefined);
assert.equal(Buffer.byteLength(truncated.data), MAX_SCROLLBACK_BYTES);
assert.equal(truncated.omitted, Buffer.byteLength("beforeafterdetached") + 17);
assert.equal(truncated.data, "a".repeat(MAX_SCROLLBACK_BYTES));

registry.input(created.id, "pwd\r");
assert.deepEqual(pty.writes, ["pwd\r"]);
registry.resize(created.id, 120, 40);
assert.deepEqual(pty.sizes, [[120, 40]]);
assert.deepEqual([registry.get(created.id)?.cols, registry.get(created.id)?.rows], [120, 40]);
for (const [cols, rows] of [[0, 24], [501, 24], [80.5, 24], [80, 0], [80, 301], [80, NaN]]) {
  assert.throws(() => registry.resize(created.id, cols, rows), /cols|rows/);
}
assert.throws(() => registry.input(created.id, 1), /data/);
assert.throws(() => registry.attach("term_missing", () => undefined), /不存在/);

registry.kill(created.id);
assert.equal(pty.kills, 1);
assert.deepEqual({ exited: registry.get(created.id)?.exited, exitCode: registry.get(created.id)?.exitCode }, { exited: true, exitCode: 0 });
assert.throws(() => registry.input(created.id, "x"), /已退出/);
assert.throws(() => registry.resize(created.id, 80, 24), /已退出/);
registry.kill(created.id);
assert.equal(pty.kills, 1, "重复 kill 不重复发信号");
const second = registry.create({ cols: 80, rows: 24 });
assert.equal(second.cwd, process.cwd(), "省略 cwd 使用 defaultCwd");
ptys[1].output("x".repeat(MAX_SCROLLBACK_BYTES - 10));
ptys[1].output("y".repeat(20));
const wrapped = registry.attach(second.id, () => undefined);
assert.equal(wrapped.omitted, 10, "分块溢出累计丢弃字节数");
assert.equal(wrapped.data, "x".repeat(MAX_SCROLLBACK_BYTES - 20) + "y".repeat(20));
assert.equal(registry.create({ shell: "bash", cols: 80, rows: 24 }).kind, "bash");
for (const bad of ["pwsh", "/bin/sh", "/mnt/c/Program Files/PowerShell/7/pwsh.exe", 1, null]) {
  assert.throws(() => registry.create({ shell: bad, cols: 80, rows: 24 }), /shell 只能是/, `拒绝 ${String(bad)}`);
}
assert.deepEqual(resolveShell("powershell", (path) => path.endsWith("powershell.exe"), "wsl"), {
  kind: "powershell", file: "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe", args: ["-NoLogo"],
}, "没有 pwsh 7 时退到 Windows PowerShell");
assert.equal(resolveShell("powershell", () => true, "wsl").file, "/mnt/c/Program Files/PowerShell/7/pwsh.exe", "优先 pwsh 7");
assert.throws(() => resolveShell("powershell", () => false, "wsl"), /没有找到 PowerShell/);
assert.deepEqual(["/mnt/c", "/mnt/d/work", "/mnt/cdrom", "/home/me", "/mnt"].map(isWindowsMount), [true, true, false, false, false]);
assert.equal(windowsHome("/usr/bin:/mnt/c/Users/user/AppData/Local/Microsoft/WindowsApps:/mnt/c/WINDOWS", () => true), "/mnt/c/Users/user");
assert.equal(windowsHome("/usr/bin:/mnt/c/WINDOWS", () => true), "/mnt/c", "PATH 里没有用户目录退 /mnt/c");
assert.equal(windowsHome("/mnt/c/Users/Gone/bin", () => false), "/mnt/c", "目录不存在不用");
// 本机有 PowerShell 时走一遍真实 create（FakePty，不启动 Windows 程序）：WSL 目录进 Windows 用户目录，Windows 目录原样
if ((() => { try { resolveShell("powershell"); return true; } catch { return false; } })()) { // 无 PowerShell 的机器跳过
  const home = windowsHome();
  assert.equal(registry.create({ shell: "powershell", cwd: process.cwd(), cols: 80, rows: 24 }).cwd, home);
  assert.equal(registry.create({ shell: "powershell", cols: 80, rows: 24 }).cwd, home);
  assert.equal(registry.create({ shell: "powershell", cwd: "/mnt/c", cols: 80, rows: 24 }).cwd, "/mnt/c");
}
registry.shutdown();
assert.equal(registry.get(second.id)?.exited, true);
assert.equal(ptys[1].kills, 1);

// 回放剥查询序列：OSC 颜色查询与 CSI DA 询问无视觉效果，但回放时 xterm 会重新应答，
// 应答字节进 PTY 输入被 shell 回显成垃圾（10-03 切标签/重连复现）；设置命令不剥。
// （独立 registry，新 PTY 用 at(-1) 取，不占 ptys 数字下标）
const registryQueries = new TerminalRegistry(process.cwd(), fakeSpawn);
const queried = registryQueries.create({ cols: 80, rows: 24 });
ptys.at(-1)!.output("prompt$ \x1b]10;?\x1b\\\x1b]11;?\x07\x1b]4;0;?\x1b\\\x1b[>c\x1b[0c echo ok \x1b]11;rgb:fbfb/fafa/f7f7\x07 done");
const strippedReplay = registryQueries.attach(queried.id, () => undefined);
assert.equal(strippedReplay.data, "prompt$  echo ok \x1b]11;rgb:fbfb/fafa/f7f7\x07 done");
assert.equal(stripReplayQueries("\x1b]12;?\x07"), "");
assert.equal(stripReplayQueries("plain text"), "plain text");

assert.equal(stripReplayQueries("before\x1b[5n\x1b[6n\x1b[?6nafter"), "beforeafter");
assert.equal(stripReplayQueries("\x1b[1n\x1b[?5n\x1b[31mred\x1b[0m"), "\x1b[1n\x1b[?5n\x1b[31mred\x1b[0m", "只剥标准查询，不泛化所有 n 或视觉控制");

// 无人订阅时服务端代答 CPR：ConPTY 启动发 \x1b[6n 后阻塞，远程 attach 晚到且回放剥询问会让 PowerShell 永远空白
const registryCpr = new TerminalRegistry(process.cwd(), fakeSpawn);
const cprTerm = registryCpr.create({ cols: 80, rows: 24 });
const cprPty = ptys.at(-1)!;
cprPty.output("\x1b[6n");
assert.deepEqual(cprPty.writes, ["\x1b[1;1R"], "无人订阅时代答一次 CPR");
cprPty.output("\x1b[?6n\x1b[5n");
assert.deepEqual(cprPty.writes, ["\x1b[1;1R"], "只代答标准 CPR，不碰 DECXCPR/DSR 状态");
registryCpr.attach(cprTerm.id, () => undefined);
cprPty.output("\x1b[6n");
assert.deepEqual(cprPty.writes, ["\x1b[1;1R"], "有订阅时交给前端 xterm 应答");
registryCpr.shutdown();

const local = localPolicy(8790);
const remote = remotePolicy({ port: 8792, origin: "https://desk.tail1234.ts.net", allowedLogins: ["me@github"] });
assert.equal(terminalEnabled(local, null), true);
assert.equal(terminalEnabled(remote, null), false);
assert.equal(terminalEnabled(remote, { port: 8792, origin: "https://desk.tail1234.ts.net", allowedLogins: ["me@github"] }), false);
assert.equal(terminalEnabled(remote, { port: 8792, origin: "https://desk.tail1234.ts.net", allowedLogins: ["me@github"], terminal: true }), true);

const serverDir = fileURLToPath(new URL(".", import.meta.url));
const index = readFileSync(join(serverDir, "index.ts"), "utf8");
assert.match(index, /requireTerminalEnabled\(policy\);[\s\S]*?terminals\.list\(\)/, "REST 读取经过能力闸门");
assert.match(index, /requireTerminalEnabled\(policy\);[\s\S]*?terminals\.create\(/, "REST 创建经过能力闸门");
assert.match(index, /requireTerminalEnabled\(policy\);[\s\S]*?terminals\.kill\(/, "REST kill 经过能力闸门");
assert.match(index, /if \(!terminalEnabled\(policy, REMOTE_CONFIG\)\)[\s\S]*?HTTP\/1\.1 403 Forbidden/, "WS 能力关闭时拒绝升级");
assert.match(index, /new ApiError\(403, 40300, "终端未对该入口开放"\)/, "REST 能力关闭时返回 403");
const driversDir = join(serverDir, "drivers");
function assertDriversIsolated(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      assertDriversIsolated(path);
    } else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) {
      const source = readFileSync(path, "utf8");
      assert.doesNotMatch(source, /(?:import|require\()[^\n]*terminals(?:\.js)?["']/, `driver ${path} 不得引用用户终端模块`);
    }
  }
}
assertDriversIsolated(driversDir);

// 用独立 WORKBENCH_HOME 启动真实路由，验证远程能力关闭时 HTTP 与 WS 都拒绝。
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
const localPort = await freePort();
let remotePort = await freePort();
while (remotePort === localPort) remotePort = await freePort();
const testHome = await mkdtemp(join(tmpdir(), "workbench-terminal-test-"));
const remoteOrigin = "https://desk.tail1234.ts.net";
await writeFile(join(testHome, "remote.json"), JSON.stringify({
  port: remotePort, origin: remoteOrigin, allowedLogins: ["me@github"],
}));
const child = spawnChild(process.execPath, ["--import", "tsx", join(serverDir, "index.ts")], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: { ...process.env, WORKBENCH_HOME: testHome, WORKBENCH_PORT: String(localPort) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", () => undefined);
try {
  await new Promise<void>((done, fail) => {
    let output = "";
    const timer = setTimeout(() => fail(new Error("远程测试监听启动超时")), 15_000);
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`测试 server 提前退出：${code}`)));
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes('"message":"remote listener started"')) {
        clearTimeout(timer);
        done();
      }
    });
  });

  const headers = { host: "desk.tail1234.ts.net", origin: remoteOrigin, "tailscale-user-login": "me@github" };
  function httpCall(method: string, path: string): Promise<{ status: number; data: any }> {
    return new Promise((done, fail) => {
      const req = request({ hostname: "127.0.0.1", port: remotePort, method, path, headers }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
        res.on("end", () => done({ status: res.statusCode ?? 0, data: JSON.parse(body) }));
      });
      req.on("error", fail);
      req.end();
    });
  }
  const meta = await httpCall("GET", "/api/meta");
  assert.equal(meta.status, 200);
  assert.equal(meta.data.data.capabilities.terminal, false);
  for (const [method, path] of [["GET", "/api/terminals"], ["POST", "/api/terminals"], ["POST", "/api/terminals/term_missing/kill"]]) {
    const response = await httpCall(method, path);
    assert.equal(response.status, 403, `${method} ${path}`);
    assert.equal(response.data.code, 40300);
  }
  const wsStatus = await new Promise<number>((done, fail) => {
    const socket = new WebSocket(`ws://127.0.0.1:${remotePort}/ws/terminal`, { headers });
    socket.on("unexpected-response", (_req, response) => { done(response.statusCode ?? 0); response.resume(); });
    socket.on("open", () => { socket.close(); fail(new Error("远程终端 WS 意外升级成功")); });
    socket.on("error", () => undefined);
  });
  assert.equal(wsStatus, 403);

  // 本机入口：detach 后该连接不再收旧终端输出，PTY 照常运行，重新 attach 能回放。
  const localBase = `http://127.0.0.1:${localPort}`;
  const createdRes = await fetch(`${localBase}/api/terminals`, {
    method: "POST", headers: { "content-type": "application/json", origin: localBase }, body: JSON.stringify({ cols: 80, rows: 24 }),
  });
  const bashTerm = (await createdRes.json()).data;
  assert.equal(bashTerm.kind, "bash");
  const ws = new WebSocket(`ws://127.0.0.1:${localPort}/ws/terminal`, { headers: { origin: localBase } });
  await once(ws, "open");
  const frames: any[] = [];
  ws.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  const send = (frame: object) => ws.send(JSON.stringify(frame));
  const waitFor = async (check: () => boolean, label: string) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
    assert(check(), label);
  };
  send({ type: "attach", terminalId: bashTerm.id });
  await waitFor(() => frames.some((f) => f.type === "attached"), "attach 成功");
  send({ type: "detach", terminalId: bashTerm.id });
  await new Promise((r) => setTimeout(r, 200));
  const before = frames.length;
  send({ type: "input", terminalId: bashTerm.id, data: "echo DETACH_$((6*7))\r" });
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(frames.length, before, "detach 后不再推送该终端输出");
  send({ type: "attach", terminalId: bashTerm.id });
  await waitFor(() => frames.some((f) => f.type === "data" && String(f.data).includes("DETACH_42")), "重新 attach 回放 detach 期间的输出");
  ws.close();
} finally {
  child.kill("SIGTERM");
  if (child.exitCode === null) await once(child, "exit");
}

console.log("✅ 用户终端注册表、回放、能力闸门和隔离断言通过");
