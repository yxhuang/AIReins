import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter, once } from "node:events";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveStatic } from "./static.js";
import { BaseDriver, captureProcessGroup, stopChildProcess } from "./drivers/base.js";
import { KimiDriver } from "./drivers/kimi.js";
import { TerminalRegistry } from "./terminals.js";
import { getWorkContent } from "./work-files.js";
import { HistoryIndex } from "./history.js";
import { searchFiles } from "./file-search.js";
import type { DriverCallbacks, SessionRecord } from "./types.js";

const home = fs.mkdtempSync(join(tmpdir(), "wb-backend-review-"));
process.env.WORKBENCH_HOME = home;
process.env.WORKBENCH_CLAUDE_HISTORY_DIR = join(home, "claude");
process.env.WORKBENCH_CODEX_HISTORY_DIR = join(home, "codex");
process.env.WORKBENCH_KIMI_HISTORY_DIR = join(home, "kimi");
const { SessionManager } = await import("./session-manager.js");
const { uploadDirReferences } = await import("./persistence.js");
const callbacks: DriverCallbacks = { emit() {}, status() {}, metadata() {}, commands() {}, exited() {} };
const kimi = () => new KimiDriver({ sessionId: "test", cwd: home, config: {}, callbacks });

function timers() {
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
  const pending: Array<{ ms: number; fire(): void; unref(): void; cleared: boolean }> = [];
  globalThis.setTimeout = ((fire: () => void, ms: number) => {
    const timer = { ms, fire, unref() {}, cleared: false };
    pending.push(timer);
    return timer;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((timer: typeof pending[number]) => { if (timer) timer.cleared = true; }) as unknown as typeof clearTimeout;
  return { pending, restore() { globalThis.setTimeout = set; globalThis.clearTimeout = clear; } };
}

await test("1: static 文件检查后、打开前消失时终止响应，server 继续服务", async () => {
  const root = fs.mkdtempSync(join(home, "static-"));
  const path = join(root, "index.html");
  fs.writeFileSync(path, "hello");
  const read = fs.createReadStream;
  fs.createReadStream = ((file, options) => {
    if (String(file) === path) fs.unlinkSync(path);
    return read(file, options);
  }) as typeof fs.createReadStream;
  syncBuiltinESMExports();
  const server = createServer((req, res) => {
    if (req.url === "/health") res.end("alive");
    else assert.equal(serveStatic(root, "/", res), true);
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  try {
    await new Promise<void>((done, fail) => {
      const req = get(`http://127.0.0.1:${port}/`, res => {
        res.resume();
        res.once("error", () => done());
        res.once("end", () => fail(new Error("缺失文件不应完整结束响应")));
      });
      req.once("error", () => done());
      req.setTimeout(3_000, () => req.destroy(new Error("timeout")));
    });
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/health`)).text(), "alive");
  } finally {
    fs.createReadStream = read; syncBuiltinESMExports();
    await new Promise<void>(done => server.close(() => done()));
  }
});

await test("2: 后台保存失败保留 dirty、有界退避并恢复；同步保存仍抛错", () => {
  const manager = new SessionManager();
  const internal = manager as any;
  const clock = timers();
  const write = fs.writeFileSync;
  let fail = true;
  fs.writeFileSync = ((file, ...args: unknown[]) => {
    if (String(file) === join(home, "sessions.json.tmp") && fail) throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    return (write as Function)(file, ...args);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try {
    internal.markRegistryDirty();
    assert.doesNotThrow(() => clock.pending[0]!.fire());
    assert.equal(internal.registryDirty, true);
    assert.equal(clock.pending[1]!.ms, 2_000);
    for (let i = 1; i < 8; i++) assert.doesNotThrow(() => clock.pending[i]!.fire());
    assert.equal(clock.pending.at(-1)!.ms, 30_000);
    assert.throws(() => internal.persistRegistry(), /ENOSPC/);
    // metadata 来自无人捕获的 driver IO 回调，保存失败也不能抛出进程。
    const driver = {};
    internal.workers.set("callback", driver);
    internal.sessions.set("callback", { id: "callback", config: {} });
    assert.doesNotThrow(() => internal.driverCallbacks("callback", () => driver).metadata({ nativeSessionId: "native" }));
    assert.equal(internal.registryDirty, true);
    fail = false;
    clock.pending.at(-1)!.fire();
    assert.equal(internal.registryDirty, false);
    assert.equal(internal.registryRetryMs, 1_000);
    internal.sessions.clear(); internal.workers.clear();
    internal.persistRegistry();
  } finally { fs.writeFileSync = write; syncBuiltinESMExports(); clock.restore(); }
});

await test("3: Kimi 异常退出与 stop 共用终端回收，SIGKILL 兜底并清空记录", async () => {
  for (const mode of ["exit", "stop"]) {
    const driver = kimi() as any;
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null,
      kill(signal: string) { signals.push(signal); return true; } });
    const exited = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null, kill() { assert.fail("已退出进程不应再杀"); } });
    const signals: string[] = [];
    driver.terminals.set("active", { process: child });
    driver.terminals.set("exited", { process: exited });
    const clock = timers();
    try {
      const stopped = mode === "exit" ? (driver.handleProcessExit(), Promise.resolve()) : driver.stop();
      let finished = false;
      void stopped.then(() => { finished = true; });
      await new Promise<void>(done => setImmediate(done));
      if (mode === "stop") assert.equal(finished, false, "stop 等待终端清理兜底");
      assert.equal(driver.terminals.size, 0);
      assert.deepEqual(signals, ["SIGTERM"]);
      clock.pending.find(timer => !timer.cleared)!.fire();
      assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      await stopped;
      child.emit("close");
    } finally { clock.restore(); }
  }
});

await test("4: POSIX worker stop 结束独立进程组内忽略 SIGTERM 的孙进程", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  let ready!: (pid: number) => void;
  const started = new Promise<number>(done => { ready = done; });
  class FakeWorker extends BaseDriver {
    readonly kind = "codex" as const;
    async start() {
      const grand = `process.on('SIGTERM',()=>{});console.log('grand '+process.pid);setInterval(()=>{},1000)`;
      this.spawnProcess(process.execPath, ["-e", `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grand)}],{stdio:['ignore',process.stdout,process.stderr]});process.on('SIGTERM',()=>{});process.stdin.resume();setInterval(()=>{},1000)`]);
    }
    getConfigSchema() { return { source: "test", options: [] }; }
    async setConfig() { return {}; }
    async sendUserMessage() {}
    async resolvePermission() {}
    protected handleStdoutLine(line: string) { if (line.startsWith("grand ")) ready(Number(line.slice(6))); }
  }
  const worker = new FakeWorker({ sessionId: "fake", cwd: home, config: {}, callbacks });
  await worker.start();
  const child = worker.child!;
  const closed = once(child, "close");
  try {
    const pid = await started;
    assert.notEqual(child.pid, process.pid);
    await worker.stop();
    await closed;
    let alive = false;
    try {
      process.kill(pid, 0);
      // Linux 的孤儿僵尸已退出，等待 init 回收不属于 worker 存活。
      const state = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0];
      alive = state !== "Z";
    } catch (error) { if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code!)) throw error; }
    assert.equal(alive, false);
  } finally {
    try { process.kill(-child.pid!, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
});

await test("5: Kimi 异步文件请求保持顺序，范围结果与旧 split/slice 完全一致", async () => {
  const driver = kimi() as any;
  const replies: any[] = [];
  driver.send = (value: unknown) => replies.push(value);
  const path = join(home, "kimi-text.txt");
  const text = "第1行\r\n第2行\n\n第4行\n";
  driver.handleServerRequest({ id: 1, method: "fs/write_text_file", params: { path, content: text } });
  driver.handleServerRequest({ id: 2, method: "fs/read_text_file", params: { path, line: 2, limit: 3 } });
  await driver.fileRequests;
  assert.deepEqual(replies.map(reply => reply.id), [1, 2]);
  assert.equal(replies[1].result.content, text.split("\n").slice(1, 4).join("\n"));
  for (const params of [{}, { line: 1, limit: 2 }, { line: 4, limit: 9 }, { line: 99 }, { line: 2, limit: 0 }, { line: 2, limit: -2 }, { line: 1.5, limit: 2.2 }]) {
    const input = params as { line?: number; limit?: number };
    const startLine = Math.max(1, Number(input.line) || 1), limit = Number(input.limit);
    const expected = startLine > 1 || Number.isFinite(limit) ? text.split("\n").slice(startLine - 1, Number.isFinite(limit) ? startLine - 1 + limit : undefined).join("\n") : text;
    await driver.handleReadTextFile(3, { path, ...params });
    assert.equal(replies.at(-1).result.content, expected, JSON.stringify(params));
  }
  // 小范围读取不得遍历大文件后部。
  fs.writeFileSync(path, "first\n" + "tail\n".repeat(100_000));
  const create = fs.createReadStream;
  let bytes = 0, stream: fs.ReadStream | undefined;
  fs.createReadStream = ((...args: Parameters<typeof fs.createReadStream>) => {
    stream = create(...args); stream.on("data", chunk => { bytes += Buffer.byteLength(chunk); }); return stream;
  }) as typeof fs.createReadStream;
  syncBuiltinESMExports();
  try {
    await driver.handleReadTextFile(4, { path, line: 1, limit: 1 });
    assert.equal(replies.at(-1).result.content, "first");
    assert.ok(bytes < fs.statSync(path).size);
    assert.equal(stream?.destroyed, true);
    await driver.handleReadTextFile(5, { path: join(home, "missing") });
    assert.equal(replies.at(-1).error.code, -32000);
  } finally { fs.createReadStream = create; syncBuiltinESMExports(); }
});

await test("6: 自动快照等待期间移除会话或 shutdown，不创建 worker", async () => {
  for (const mode of ["remove", "shutdown"]) {
    let finish!: (path: string | null) => void;
    let entered!: () => void;
    const snapshot = new Promise<string | null>(done => { finish = done; });
    const waiting = new Promise<void>(done => { entered = done; });
    let created = 0;
    const manager = new SessionManager(() => { created++; throw new Error("不可启动 worker"); }, undefined, () => { entered(); return snapshot; });
    const pending = manager.create({ agent: "codex", cwd: home, snapshot: "auto" });
    const rejection = assert.rejects(pending, mode === "remove" ? /会话不存在/ : /AIReins 正在退出/);
    await waiting;
    const id = manager.list().at(-1)!.id;
    if (mode === "remove") await manager.remove(id); else await manager.shutdown();
    finish(join(home, "snapshot"));
    await rejection;
    assert.equal(created, 0);
    assert.equal((manager as any).workers.size, 0);
    if (mode === "shutdown") await manager.remove(id);
  }
});

await test("7: 只淘汰按退出顺序最早的无人附着终端，活动与附着记录可回放", () => {
  class Pty {
    data?: (value: string) => void;
    exit?: (value: { exitCode: number }) => void;
    onData(callback: typeof this.data) { this.data = callback; }
    onExit(callback: typeof this.exit) { this.exit = callback; }
    write() {} resize() {} kill() { this.exit?.({ exitCode: 0 }); }
  }
  const ptys: Pty[] = [];
  const registry = new TerminalRegistry(home, (() => { const pty = new Pty(); ptys.push(pty); return pty; }) as any, () => ({ kind: "bash", file: "/bin/sh", args: [] }));
  const ids = Array.from({ length: 12 }, () => registry.create({ cols: 80, rows: 24 }).id);
  const attached = registry.attach(ids[0]!, () => {});
  const exitOrder = [0, 3, 2, 1, 4, 5, 6, 7, 8, 9, 10];
  for (const index of exitOrder) { ptys[index]!.data?.(`output ${index}`); ptys[index]!.exit?.({ exitCode: index }); }
  assert.ok(registry.get(ids[0]!), "有人附着的最早退出记录保留");
  assert.equal(registry.get(ids[3]!), undefined, "按退出顺序淘汰，不按创建顺序");
  assert.equal(registry.get(ids[2]!), undefined);
  assert.equal(registry.get(ids[11]!)?.exited, false);
  const replay = registry.attach(ids[10]!, () => {});
  assert.equal(replay.data, "output 10");
  replay.detach();
  attached.detach();
  assert.equal(registry.get(ids[0]!), undefined, "detach 后重新执行上限");
  registry.shutdown();
});

await test("8: PDF Range 只读取所需区间，保留后缀/非法范围与完整下载行为", async () => {
  const path = join(home, "range.pdf");
  const content = Buffer.from("%PDF-1.7\n0123456789".repeat(10_000));
  fs.writeFileSync(path, content);
  const open = fsp.open;
  let bytes = 0;
  fsp.open = (async (...args: Parameters<typeof fsp.open>) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    handle.read = (async (...readArgs: any[]) => {
      const result = await (read as Function)(...readArgs); bytes += result.bytesRead; return result;
    }) as typeof handle.read;
    return handle;
  }) as typeof fsp.open;
  syncBuiltinESMExports();
  try {
    const result = await getWorkContent({ path, root: home }, { sessionCwd: home }, "bytes=4-9");
    assert.deepEqual(result.bytes, content.subarray(4, 10));
    assert.deepEqual(result.range, { start: 4, end: 9 });
    assert.equal(result.file.size, content.length);
    assert.equal(bytes, 6, "不先读取完整 PDF");
    bytes = 0;
    assert.deepEqual((await getWorkContent({ path, root: home }, { sessionCwd: home }, "bytes=-5")).bytes, content.subarray(-5));
    assert.equal(bytes, 5);
    for (const range of ["bytes=999999-", "bytes=-0", "bytes=2-1", "bytes=1-2,4-5", "bytes=9007199254740992-"]) {
      bytes = 0;
      assert.equal((await getWorkContent({ path, root: home }, { sessionCwd: home }, range)).range, null);
      assert.equal(bytes, 0);
    }
    assert.deepEqual((await getWorkContent({ path, root: home }, { sessionCwd: home })).bytes, content);
  } finally { fsp.open = open; syncBuiltinESMExports(); }
});

await test("9: 没有上传目录不读 transcript；签名及上传 id 变化使引用缓存失效", () => {
  const path = join(home, "reference.ndjson");
  const records = [{ id: "reference", transcriptPath: path }] as SessionRecord[];
  fs.writeFileSync(path, join(home, "uploads", "one"));
  const read = fs.readFileSync;
  let count = 0;
  fs.readFileSync = ((file, ...args: unknown[]) => {
    if (String(file) === path) count++;
    return (read as Function)(file, ...args);
  }) as typeof fs.readFileSync;
  syncBuiltinESMExports();
  try {
    assert.equal(uploadDirReferences(records).size, 0);
    assert.equal(count, 0);
    fs.mkdirSync(join(home, "uploads", "one"), { recursive: true });
    assert.deepEqual([...uploadDirReferences(records).get("reference")!], ["one"]);
    uploadDirReferences(records);
    assert.equal(count, 1);
    fs.appendFileSync(path, " " + join(home, "uploads", "two"));
    uploadDirReferences(records);
    assert.equal(count, 2);
    fs.mkdirSync(join(home, "uploads", "two"));
    assert.deepEqual([...uploadDirReferences(records).get("reference")!], ["one", "two"]);
    assert.equal(count, 3);
  } finally { fs.readFileSync = read; syncBuiltinESMExports(); }
});

await test("10: 历史缓存命中不受发现预算影响，文件失效时重新发现", async () => {
  const root = join(home, "history"); fs.mkdirSync(root);
  const id = "11111111-1111-4111-8111-111111111111";
  const path = join(root, `${id}.jsonl`);
  fs.writeFileSync(path, [1, 2, 3].map(n => JSON.stringify({ type: "user", cwd: home, message: { role: "user", content: `message ${n}` } })).join("\n") + "\n");
  const index = new HistoryIndex({ roots: { claude: root, workbenchRegistry: join(home, "empty-registry") } });
  await index.list({ agent: "claude", limit: 10 });
  const internal = index as any;
  const discover = internal.discover.bind(index);
  let scans = 0;
  internal.discover = (...args: unknown[]) => { scans++; return discover(...args); };
  internal.maxDiscovered = 0;
  const page = await index.messages("claude", id, { limit: 1 });
  assert.equal(page?.messages[0]?.role, "user");
  assert.equal(scans, 0);
  assert.ok(page?.nextCursor);
  await index.messages("claude", id, { limit: 1, cursor: page.nextCursor });
  assert.equal(scans, 0);
  const outside = join(home, "outside.jsonl"); fs.renameSync(path, outside); fs.symlinkSync(outside, path);
  assert.equal(await index.messages("claude", id, { limit: 1 }), undefined, "缓存不能跟随逃出根目录的软链");
  assert.equal(scans, 1);
});

await test("11: 同 cwd 并发枚举合并且短时复用，中止请求不做后续排序", async () => {
  const cwd = fs.mkdtempSync(join(home, "search-"));
  fs.writeFileSync(join(cwd, "a.txt"), "a");
  const exec = childProcess.execFile;
  let scans = 0, finish!: () => void;
  childProcess.execFile = ((_command: unknown, _args: unknown, _options: unknown, callback: Function) => {
    scans++;
    finish = () => callback(null, "a.txt\0", "");
    return {};
  }) as typeof childProcess.execFile;
  syncBuiltinESMExports();
  try {
    const controller = new AbortController();
    const first = searchFiles(cwd, "a", 10, controller.signal);
    const second = searchFiles(cwd, "a", 10);
    // realpath 是异步的，等到两次请求都加入同一个枚举。
    await new Promise<void>(done => setTimeout(done, 30));
    assert.equal(scans, 1);
    controller.abort(); finish();
    assert.deepEqual(await first, []);
    assert.deepEqual(await second, ["a.txt"]);
    assert.deepEqual(await searchFiles(cwd, "a", 10), ["a.txt"]);
    assert.equal(scans, 1);
    assert.deepEqual(await searchFiles(cwd, "a", 10, AbortSignal.abort()), []);
    const now = Date.now; Date.now = () => now() + 3_000;
    try {
      const fresh = searchFiles(cwd, "a", 10);
      await new Promise<void>(done => setTimeout(done, 30));
      assert.equal(scans, 2); finish(); await fresh;
    } finally { Date.now = now; }
  } finally { childProcess.execFile = exec; syncBuiltinESMExports(); }
});

class ReviewWorker extends BaseDriver {
  readonly kind = "codex" as const;
  script = "";
  async start() { this.spawnProcess(process.execPath, ["-e", this.script]); }
  getConfigSchema() { return { source: "fixture", options: [] }; }
  async setConfig() { return {}; }
  async sendUserMessage() {}
  async resolvePermission() {}
  protected handleStdoutLine() {}
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0] !== "Z";
    return true;
  } catch (error) {
    if (["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code!)) return false;
    throw error;
  }
}
// SIGKILL 已发出后进程退出仍需调度时间，负载下立即断言会偶发失败。
async function exitedSoon(pid: number, ms = 2_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) if (!processAlive(pid)) return true;
  return !processAlive(pid);
}
function killFixtureGroup(pid: number): void {
  assert.notEqual(pid, process.pid);
  try { process.kill(-pid, "SIGKILL"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
const lingerScript = `const grand=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});grand.stdout.once('data',data=>process.stdout.write(data));process.stdin.on('end',()=>process.exit(0));process.stdin.resume();setInterval(()=>{},1000)`;
const orphanScript = `const grand=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log(process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','pipe','ignore']});grand.stdout.once('data',data=>{process.stdout.write(data,()=>process.exit(0));});setInterval(()=>{},1000)`;

await test("12: 组长在 stop 内退出时回收组内后代；stop 前已退出则不发组信号", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  // 宽限期内组长因 stdin 结束自行退出：进入 stop 时已核实身份，SIGTERM/SIGKILL 仍发往原组。
  const live = new ReviewWorker({ sessionId: "linger", cwd: home, config: {}, callbacks });
  live.script = lingerScript;
  await live.start();
  const leader = live.child!;
  let grandPid = 0;
  try {
    const [data] = await once(leader.stdout, "data"); grandPid = Number(String(data).trim());
    await live.stop();
    assert.equal(await exitedSoon(grandPid), true, "stop 内退出的组长不能让后代逃过清理");
  } finally { if (grandPid && processAlive(grandPid)) process.kill(grandPid, "SIGKILL"); killFixtureGroup(leader.pid!); }

  // stop 前组长已退出：无法证明组号未被复用，保守不发组信号。
  const worker = new ReviewWorker({ sessionId: "orphan", cwd: home, config: {}, callbacks });
  worker.script = orphanScript;
  await worker.start();
  const child = worker.child!;
  const closed = once(child, "close");
  const processKill = process.kill;
  const groupSignals: unknown[] = [];
  try {
    const [data] = await once(child.stdout, "data");
    grandPid = Number(String(data).trim());
    await closed;
    process.kill = ((pid, signal) => { if (pid < 0) groupSignals.push([pid, signal]); return processKill(pid, signal); }) as typeof process.kill;
    await worker.stop();
    assert.deepEqual(groupSignals, [], "stop 前组长已退出时不发组信号");
    assert.equal(processAlive(grandPid), true);
  } finally { process.kill = processKill; killFixtureGroup(child.pid!); }
});

await test("13: 身份二次读取失败或不匹配时退回 child 信号并等待兜底", { skip: process.platform !== "linux", timeout: 10_000 }, async () => {
  for (const mode of ["unreadable", "mismatch", "close"]) {
    const worker = new ReviewWorker({ sessionId: mode, cwd: home, config: {}, callbacks });
    worker.script = (mode === "close" ? "" : "process.on('SIGTERM',()=>{});") + "console.log('ready');process.stdin.resume();setInterval(()=>{},1000)";
    await worker.start();
    const child = worker.child!;
    const closed = once(child, "close");
    await once(child.stdout, "data");
    const read = fs.readFileSync, kill = child.kill.bind(child), processKill = process.kill;
    const signals: string[] = [];
    child.kill = ((signal: NodeJS.Signals) => { signals.push(signal); return kill(signal); }) as typeof child.kill;
    const clock = timers();
    const stopped = worker.stop(); // 进入 stdin 等待后，再模拟身份读取失效。
    let finished = false;
    void stopped.then(() => { finished = true; });
    fs.readFileSync = ((file, ...args: unknown[]) => {
      if (String(file) === `/proc/${child.pid}/stat`) {
        if (mode !== "mismatch") throw Object.assign(new Error("fixture EACCES"), { code: "EACCES" });
        const text = String((read as Function)(file, ...args));
        const index = text.lastIndexOf(") ") + 2;
        const fields = text.slice(index).trim().split(/\s+/);
        fields[19] = String(BigInt(fields[19]!) + 1n);
        return text.slice(0, index) + fields.join(" ");
      }
      return (read as Function)(file, ...args);
    }) as typeof fs.readFileSync;
    process.kill = ((pid, signal) => {
      if (signal === "SIGTERM" || signal === "SIGKILL") assert.ok(pid > 0, "身份失效不发送组信号");
      return processKill(pid, signal);
    }) as typeof process.kill;
    syncBuiltinESMExports();
    try {
      clock.pending[0]!.fire();
      assert.deepEqual(signals, ["SIGTERM"]);
      await Promise.resolve();
      assert.equal(finished, false, "child 仍活着时 stop 不能提前成功");
      if (mode === "close") {
        await closed; await stopped;
        assert.deepEqual(signals, ["SIGTERM"]);
        assert.equal(clock.pending[1]!.cleared, true, "close 后不再发送 SIGKILL");
      } else {
        clock.pending[1]!.fire(); await stopped;
        assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
      }
    } finally {
      fs.readFileSync = read; process.kill = processKill; syncBuiltinESMExports(); clock.restore();
      kill("SIGKILL"); await closed;
    }
  }
});

await test("14: Kimi 自建命令运行中被 stop/异常退出/release 时回收整组（含忽略 SIGTERM 的后代）", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  for (const mode of ["stop", "exit", "release"]) {
    const driver = kimi() as any;
    driver.send = () => {};
    driver.handleCreateTerminal(1, { command: process.execPath, args: ["-e", lingerScript] });
    const terminal = [...driver.terminals.values()][0] as any;
    const child = terminal.process;
    let grandPid = 0;
    try {
      const [data] = await once(child.stdout, "data"); grandPid = Number(String(data).trim());
      assert.equal(processAlive(grandPid), true);
      if (mode === "exit") driver.handleProcessExit();
      if (mode === "release") {
        driver.handleTerminalRelease(2, { terminalId: [...driver.terminals.keys()][0] });
        assert.equal(driver.terminals.size, 0, "release 已移除记录，回收只能靠 release 自身的组清理");
      }
      await driver.stop();
      assert.equal(driver.terminals.size, 0);
      assert.equal(await exitedSoon(grandPid), true, "Kimi 命令的独立组需整组回收");
    } finally {
      // 旧实现没有 detached：失败时只清理本测试确知的后代，绝不向测试自身组发信号。
      if (grandPid && processAlive(grandPid)) process.kill(grandPid, "SIGKILL");
      killFixtureGroup(child.pid);
    }
  }
});

await test("15: Kimi 关闭文件队列，取消未开始写入并等待在途操作", async () => {
  for (const mode of ["stop", "exit"]) {
    const driver = kimi() as any;
    const replies: any[] = [];
    driver.send = (reply: unknown) => replies.push(reply);
    const first = join(home, `active-${mode}.txt`), second = join(home, `queued-${mode}.txt`), third = join(home, `late-${mode}.txt`);
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>(done => { started = done; });
    const gate = new Promise<void>(done => { release = done; });
    const write = fsp.writeFile;
    fsp.writeFile = (async (path, ...args: unknown[]) => {
      if (String(path) === first) { started(); await gate; }
      return (write as Function)(path, ...args);
    }) as typeof fsp.writeFile;
    syncBuiltinESMExports();
    try {
      driver.handleServerRequest({ id: 1, method: "fs/write_text_file", params: { path: first, content: "active" } });
      driver.handleServerRequest({ id: 2, method: "fs/write_text_file", params: { path: second, content: "queued" } });
      await entered;
      if (mode === "exit") driver.handleProcessExit();
      const stopped = driver.stop();
      let finished = false; void stopped.then(() => { finished = true; });
      driver.handleServerRequest({ id: 3, method: "fs/write_text_file", params: { path: third, content: "late" } });
      await new Promise<void>(done => setImmediate(done));
      assert.equal(finished, false, "stop 必须等待已开始的文件操作");
      release(); await stopped; await driver.fileRequests;
      assert.equal(fs.readFileSync(first, "utf8"), "active");
      assert.equal(fs.existsSync(second), false);
      assert.equal(fs.existsSync(third), false);
      assert.deepEqual(replies.filter(reply => reply.id === 2 || reply.id === 3), []);
    } finally { release(); await driver.fileRequests; fsp.writeFile = write; syncBuiltinESMExports(); }
  }
  const driver = kimi() as any;
  driver.send = () => assert.fail("关闭后未开始的请求不能回复");
  const path = join(home, "never-started.txt");
  driver.handleServerRequest({ id: 4, method: "fs/write_text_file", params: { path, content: "cancel" } });
  await driver.stop(); await driver.fileRequests;
  assert.equal(fs.existsSync(path), false);
});

await test("16: Kimi 在途文件操作超时记日志后停止，不执行后续写入", async () => {
  const driver = kimi() as any;
  driver.send = () => {};
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>(done => { started = done; });
  const gate = new Promise<void>(done => { release = done; });
  const write = fsp.writeFile, output = console.log;
  const logs: string[] = [];
  const first = join(home, "timeout-active.txt"), second = join(home, "timeout-queued.txt");
  fsp.writeFile = (async (path, ...args: unknown[]) => {
    if (String(path) === first) { started(); await gate; }
    return (write as Function)(path, ...args);
  }) as typeof fsp.writeFile;
  syncBuiltinESMExports();
  let clock: ReturnType<typeof timers> | undefined;
  try {
    driver.handleServerRequest({ id: 1, method: "fs/write_text_file", params: { path: first, content: "active" } });
    driver.handleServerRequest({ id: 2, method: "fs/write_text_file", params: { path: second, content: "cancel" } });
    await entered;
    clock = timers(); console.log = (line: unknown) => { logs.push(String(line)); };
    const stopped = driver.stop();
    await Promise.resolve();
    assert.ok(clock.pending.length > 0, "在途文件操作必须设置停止超时");
    clock.pending[0]!.fire(); await stopped;
    assert.ok(logs.some(line => line.includes("file") && line.includes("timed out")), "超时应记日志");
    release(); await driver.fileRequests;
    assert.equal(fs.existsSync(second), false);
  } finally { release(); await driver.fileRequests; console.log = output; clock?.restore(); fsp.writeFile = write; syncBuiltinESMExports(); }
});

await test("17: 独立组清理排除自身组；组长已退出时直接完成", { skip: process.platform === "win32" }, async () => {
  const processKill = process.kill;
  const signals: string[] = [], groupSignals: Array<[number, unknown]> = [];
  const self = Object.assign(new EventEmitter(), { pid: process.pid, exitCode: null as number | null, signalCode: null,
    kill(signal: string) { signals.push(signal); self.exitCode = 0; self.emit("close"); return true; } });
  process.kill = ((pid, signal) => {
    assert.notEqual(pid, -process.pid, "不得向 AIReins 自身组发信号");
    groupSignals.push([pid, signal]);
    throw Object.assign(new Error("fixture ESRCH"), { code: "ESRCH" });
  }) as typeof process.kill;
  try {
    assert.equal(captureProcessGroup(self as any), undefined);
    await stopChildProcess(self as any, { bootId: "fixture", startTime: "1", processGroupId: process.pid });
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.deepEqual(groupSignals, []);
    const gone = Object.assign(new EventEmitter(), { pid: 9_999_999, exitCode: 0, signalCode: null });
    await stopChildProcess(gone as any, { bootId: "fixture", startTime: "1", processGroupId: gone.pid });
    // 上面的 deepEqual 把类型收窄成 never[]，这里还原声明类型。
    // stop 前组长已退出：不发组信号，直接完成。
    assert.deepEqual((groupSignals as Array<[number, unknown]>).filter(([, signal]) => signal !== 0), []);
  } finally { process.kill = processKill; }
});

await test("18: 组长退出后其 PID 被复用时不发组信号", { skip: process.platform !== "linux" }, async () => {
  const read = fs.readFileSync, processKill = process.kill;
  const reused = Object.assign(new EventEmitter(), { pid: 9_999_998, exitCode: 0, signalCode: null });
  const groupSignals: unknown[] = [];
  // 新进程占用同一 PID 并自成一组，但启动时间不同。
  fs.readFileSync = ((file, ...args: unknown[]) => String(file) === `/proc/${reused.pid}/stat`
    ? `${reused.pid} (other) S 1 ${reused.pid} ${reused.pid} ${Array.from({ length: 16 }, () => "0").join(" ")} 424242 0`
    : (read as Function)(file, ...args)) as typeof fs.readFileSync;
  process.kill = ((pid, signal) => { if (pid < 0) groupSignals.push([pid, signal]); return true; }) as typeof process.kill;
  syncBuiltinESMExports();
  try {
    await stopChildProcess(reused as any, { bootId: "", startTime: "1", processGroupId: reused.pid });
    assert.deepEqual(groupSignals, [], "PID 复用后不得向旧组号发信号");
  } finally { fs.readFileSync = read; process.kill = processKill; syncBuiltinESMExports(); }
});
