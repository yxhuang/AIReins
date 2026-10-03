import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentKind, Driver, DriverCallbacks, DriverOptions, SessionConfig, SessionRecord, UnifiedEvent } from "./types.js";

const home = fs.mkdtempSync(join(tmpdir(), "wb-review-regressions-"));
process.env.WORKBENCH_HOME = home;
const { SessionManager } = await import("./session-manager.js");
const { appendTranscript, readTranscriptState } = await import("./persistence.js");
const { HistoryIndex } = await import("./history.js");
fs.mkdirSync(join(home, "transcripts"));
const event = (id: string, seq: number): UnifiedEvent => ({ type: "user_message", sessionId: id, agentId: "main", seq,
  timestamp: "2026-10-03T00:00:00.000Z", payload: { text: `问题 ${seq}` } });
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

await test("R1: 部分追加失败后重试不得重复旧尾段标记", async t => {
  for (const cut of ["repair", "none", "event-tail", "newline", "partial-marker"]) await t.test(cut, () => {
    const id = `partial-${cut}`;
    const path = join(home, "transcripts", `${id}.ndjson`);
    const original = `${JSON.stringify(event(id, 1))}\n{"type":`;
    fs.writeFileSync(path, original);
    readTranscriptState(path);
    const append = fs.appendFileSync;
    fs.appendFileSync = ((file, data, options) => {
      const text = String(data);
      const repairEnd = text.indexOf("\n", 1) + 1;
      const count = cut === "repair" ? repairEnd : cut === "none" ? 0
        : cut === "event-tail" ? repairEnd + 8 : cut === "newline" ? 1 : 8;
      if (count) append(file, text.slice(0, count), options);
      throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
    }) as typeof fs.appendFileSync;
    syncBuiltinESMExports();
    try { assert.throws(() => appendTranscript(path, event(id, 2)), /ENOSPC/); }
    finally { fs.appendFileSync = append; syncBuiltinESMExports(); }
    if (cut === "newline" || cut === "partial-marker") {
      const failedBytes = fs.readFileSync(path);
      assert.throws(() => appendTranscript(path, event(id, 2)), /transcript 损坏/);
      assert.deepEqual(fs.readFileSync(path), failedBytes, "缺少完整隔离标记时保守禁写，不追加失配标记");
    } else {
      appendTranscript(path, event(id, 2));
      const bytes = fs.readFileSync(path, "utf8");
      assert.ok(bytes.startsWith(original));
      const markers = bytes.split("\n").filter(line => line.startsWith('{"_wbSkippedTail":')).map(line => JSON.parse(line)._wbSkippedTail);
      const offset = Buffer.byteLength(original.slice(0, original.indexOf("\n") + 1));
      assert.equal(markers.filter(marker => marker.offset === offset).length, 1, "原尾段只隔离一次");
      const recovered = readTranscriptState(path);
      assert.equal(recovered.damaged, false);
      assert.deepEqual(recovered.events.map(item => item.seq), [1, 2]);
    }
  });
});

class FakeDriver implements Driver {
  stopEntered = gate();
  finishStop = gate();
  stopped = false;
  constructor(readonly kind: AgentKind, readonly options: DriverOptions) {}
  async start() { this.options.callbacks.status("idle"); }
  getConfigSchema() { return { source: "review", options: [] }; }
  async setConfig(config: SessionConfig) { return config; }
  async sendUserMessage() {}
  async resolvePermission() {}
  async interrupt() {}
  async stop() {
    this.stopEntered.resolve();
    await this.finishStop.promise;
    this.stopped = true;
    this.options.callbacks.exited({ code: 0, signal: null, expected: true });
  }
}

function damagedManager(id: string, agent: AgentKind = "claude") {
  const record: SessionRecord = { id, agent, agentId: "main", cwd: home, status: "idle", released: true,
    nativeSessionId: `native-${id}`, config: {}, riskyMode: false, seq: 2, createdAt: "2026-10-03T00:00:00.000Z",
    lastActivityAt: "2026-10-03T00:00:00.000Z", transcriptPath: join(home, "transcripts", `${id}.ndjson`) };
  fs.writeFileSync(record.transcriptPath, `${JSON.stringify(event(id, 1))}\nbad-middle\n${JSON.stringify(event(id, 2))}\n`);
  fs.writeFileSync(join(home, "sessions.json"), JSON.stringify([record]));
  let externalCalls = 0;
  const plugins = { async setEnabled() { externalCalls++; }, async list() { return []; } };
  const manager = new SessionManager(() => { externalCalls++; throw new Error("不应创建 worker"); },
    () => ({ model: null, effort: null }), undefined, undefined,
    plugins as unknown as ConstructorParameters<typeof SessionManager>[4]);
  return { manager, record, externalCalls: () => externalCalls };
}

await test("R2: 损坏会话所有写入口在状态及磁盘修改之前拒绝", async t => {
  const actions: Array<[string, (manager: InstanceType<typeof SessionManager>, id: string) => Promise<unknown>]> = [
    ["setThinking", (m, id) => m.setThinking(id, true)],
    ["sendUserMessage", (m, id) => m.sendUserMessage(id, { text: "拒绝" })],
    ["setConfig", (m, id) => m.setConfig(id, { model: "sonnet" })],
    ["setRemoteControl", (m, id) => m.setRemoteControl(id, true)],
    ["manageMcp", (m, id) => m.manageMcp(id, { action: "reconnect", serverName: "test" })],
    ["stopTask", (m, id) => m.stopTask(id, "test")],
    ["askSideQuestion", (m, id) => m.askSideQuestion(id, { question: "test" }, new AbortController().signal)],
    ["setPluginEnabled", (m, id) => m.setPluginEnabled(id, "test", true)],
    ["resolvePermission", (m, id) => m.resolvePermission(id, "test", "allow")],
    ["interrupt", (m, id) => m.interrupt(id)],
    ["remove", (m, id) => m.remove(id)],
    ["release", (m, id) => m.release(id, "manual")],
    ["executeCodexCommand", (m, id) => m.executeCodexCommand(id, { name: "new" })],
  ];
  for (const [name, action] of actions) await t.test(name, async () => {
    const id = `guard-${name}`;
    const { manager, record, externalCalls } = damagedManager(id, name === "executeCodexCommand" ? "codex" : "claude");
    const before = manager.get(id);
    const registry = fs.readFileSync(join(home, "sessions.json"));
    const transcript = fs.readFileSync(record.transcriptPath);
    await assert.rejects(action(manager, id), /transcript 损坏/);
    assert.deepEqual(manager.get(id), before, "内存 config/seq/状态不能先变");
    assert.deepEqual(fs.readFileSync(join(home, "sessions.json")), registry, "注册表不能先写");
    assert.deepEqual(fs.readFileSync(record.transcriptPath), transcript);
    assert.equal(externalCalls(), 0, "不能先调用 CLI 或插件写操作");
  });
  for (const [name, args] of [
    ["emit", ["config_updated", {}]], ["setStatus", ["idle"]],
    ["setBackgroundTasks", [[{ id: "test", description: "test" }]]],
    ["applyConfig", [{ thinkingLevel: "default_on" }]], ["applyEffectiveConfig", [{}]],
  ] as const) await t.test(`internal ${name}`, () => {
    const id = `guard-internal-${name}`;
    const { manager } = damagedManager(id);
    const before = manager.get(id);
    const session = Reflect.get(manager, "sessions").get(id);
    const target = name.startsWith("apply") ? session : id;
    assert.throws(() => Reflect.apply(Reflect.get(manager, name), manager, [target, ...args]), /transcript 损坏/);
    assert.deepEqual(manager.get(id), before);
  });
  await t.test("损坏会话的当前代 worker 回调也不能写", () => {
    const id = "guard-callbacks";
    const { manager } = damagedManager(id);
    const before = manager.get(id);
    const registry = fs.readFileSync(join(home, "sessions.json"));
    const worker = {} as Driver;
    Reflect.get(manager, "workers").set(id, worker);
    const callbacks = Reflect.apply(Reflect.get(manager, "driverCallbacks"), manager, [id, () => worker]) as DriverCallbacks;
    callbacks.metadata({ config: { thinkingLevel: "default_on" } });
    callbacks.commands([{ name: "test", description: "测试命令", source: "claude" }]);
    callbacks.status("idle");
    callbacks.emit("session_error", { message: "不应写入" });
    callbacks.exited({ code: 0, signal: null, expected: true });
    assert.deepEqual(manager.get(id), before);
    assert.deepEqual(manager.getCommands(id), []);
    assert.deepEqual(fs.readFileSync(join(home, "sessions.json")), registry);
  });
  await t.test("自动释放与 shutdown 保持损坏记录及 transcript 不变", async () => {
    const id = "guard-lifecycle";
    const { manager, record } = damagedManager(id);
    const before = manager.get(id);
    const registry = fs.readFileSync(join(home, "sessions.json"));
    const transcript = fs.readFileSync(record.transcriptPath);
    await manager.releaseIdleSessions(1, new Date(Date.now() + 120_000));
    await manager.shutdown();
    assert.deepEqual(manager.get(id), before);
    assert.deepEqual(fs.readFileSync(join(home, "sessions.json")), registry);
    assert.deepEqual(fs.readFileSync(record.transcriptPath), transcript);
  });
});

await test("R3: 自动释放 A 时 shutdown 必须等待仍在停止的 B", async () => {
  fs.writeFileSync(join(home, "sessions.json"), "[]");
  const drivers: FakeDriver[] = [];
  const manager = new SessionManager((agent, options) => {
    const driver = new FakeDriver(agent, options);
    drivers.push(driver);
    return driver;
  });
  const a = await manager.create({ agent: "codex", cwd: home, resumeSessionId: "native-A", snapshot: "skip" });
  const b = await manager.create({ agent: "codex", cwd: home, resumeSessionId: "native-B", snapshot: "skip" });
  const sweep = manager.releaseIdleSessions(1, new Date(Date.now() + 120_000));
  await drivers[0]!.stopEntered.promise;
  let done = false;
  const shutdown = manager.shutdown().then(() => { done = true; });
  await turn();
  drivers[0]!.finishStop.resolve();
  await drivers[1]!.stopEntered.promise;
  try {
    await turn();
    assert.equal(done, false, "B stop 未结束，shutdown 不得返回");
    assert.equal(drivers[1]!.stopped, false);
  } finally {
    drivers[1]!.finishStop.resolve();
    await Promise.all([sweep, shutdown]);
  }
  assert.equal(drivers.every(driver => driver.stopped), true);
  assert.equal(manager.get(a.id)?.released, true);
  assert.equal(manager.get(b.id)?.released, true);
  await assert.rejects(manager.release(b.id, "manual"), /正在退出/);
});

await test("R4: 每次发现耗尽预算时连续重试仍能推进并且不漏不重", async () => {
  const root = join(home, "history");
  fs.mkdirSync(root);
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  for (const id of ids) {
    const path = join(root, `${id}.jsonl`);
    fs.writeFileSync(path, `${JSON.stringify({ type: "user", cwd: "/repo", entrypoint: "cli", message: { role: "user", content: id } })}\n`);
    fs.utimesSync(path, 1000, 1000);
  }
  const index = new HistoryIndex({ roots: { claude: root, workbenchRegistry: join(home, "missing-registry") }, timeoutMs: 10 });
  const discover = Reflect.get(index, "discover");
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  Reflect.set(index, "discover", async (...args: unknown[]) => {
    const result = await Reflect.apply(discover, index, args);
    now += 10; // 每次都耗尽发现阶段预算；后续重试不移除这个桩。
    return result;
  });
  try {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let retry = 0; retry < 3; retry++) {
      const page = await index.list({ agent: "claude", limit: 1, cursor });
      seen.push(...page.sessions.map(session => session.nativeSessionId));
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, ids, "同一慢发现桩下三次扫描必须取得三个不同会话");
    assert.equal(cursor, undefined);
  } finally { Date.now = realNow; }
});
