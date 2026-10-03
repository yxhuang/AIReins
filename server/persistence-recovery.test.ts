import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, DriverOptions, SessionRecord, UnifiedEvent, UserMessageInput } from "./types.js";

const home = mkdtempSync(join(tmpdir(), "wb-transcript-recovery-"));
process.env.WORKBENCH_HOME = home;
process.env.HOME = home;
process.env.WORKBENCH_CLAUDE_HISTORY_DIR = join(home, "claude", "projects");
process.env.WORKBENCH_CODEX_HISTORY_DIR = join(home, "codex", "sessions");
process.env.WORKBENCH_KIMI_HISTORY_DIR = join(home, "kimi", "sessions");
const { SessionManager } = await import("./session-manager.js");
const { appendTranscript, readTranscript, compactClaudeTranscripts } = await import("./persistence.js");
const { NativeConversationReader } = await import("./native-conversation.js");
mkdirSync(join(home, "transcripts"));
const requested = process.argv[2];
for (const mode of ["tail", "complete-tail", "middle"].filter(mode => !requested || requested === mode)) {
  const event = (id: string, seq: number): UnifiedEvent => ({ type: "user_message", sessionId: id, agentId: "main", seq,
    timestamp: "2026-10-03T00:00:00.000Z", payload: { text: `问题 ${seq}` } });
  const line = (id: string, seq: number) => `${JSON.stringify(event(id, seq))}\n`;
  const record = (id: string): SessionRecord => ({ id, agent: "claude", agentId: "main", cwd: home, config: {}, riskyMode: false,
    status: "idle", released: true, nativeSessionId: `native-${id}`, seq: 0, createdAt: "2026-10-03T00:00:00.000Z",
    lastActivityAt: "2026-10-03T00:00:00.000Z", transcriptPath: join(home, "transcripts", `${id}.ndjson`) });
  const good = record("good"), broken = record(mode);
  const partial = `${JSON.stringify({ ...event(mode, 2), type: "tool_call_updated", payload: { partialInput: "{" } })}\n`;
  const original = mode !== "middle" ? line(mode, 1) + partial + (mode === "tail" ? '{"type":' : JSON.stringify(event(mode, 99)))
    : line(mode, 1) + partial + 'bad-middle\n' + line(mode, 4);
  writeFileSync(good.transcriptPath, line(good.id, 1));
  writeFileSync(broken.transcriptPath, original);
  writeFileSync(join(home, "sessions.json"), JSON.stringify([broken, good]));
  const before = statSync(broken.transcriptPath);
  const manager = new SessionManager((_agent, options: DriverOptions) => ({ kind: "claude", async start() { options.callbacks.status("idle"); },
    getConfigSchema() { return { source: "test", options: [] }; }, async setConfig(config) { return config; },
    async sendUserMessage() {}, async resolvePermission() {}, async interrupt() {}, async stop() {} }));
  assert.equal(manager.get(good.id)?.status, "idle", "损坏会话不能阻断其他会话恢复");
  assert.equal(manager.get(broken.id)?.status, "error", "损坏会话应标为错误状态");
  assert.equal(readFileSync(broken.transcriptPath, "utf8"), original, "恢复与压缩均不改损坏文件");
  assert.equal(statSync(broken.transcriptPath).ino, before.ino);
  assert.equal(statSync(broken.transcriptPath).mtimeMs, before.mtimeMs);
  if (mode !== "middle") {
    assert.deepEqual(readTranscript(broken.transcriptPath).map(e => e.seq), [1, 2]);
    await manager.sendUserMessage(broken.id, { text: "续写" });
    const continued = readFileSync(broken.transcriptPath, "utf8");
    assert.ok(continued.startsWith(original + "\n"), "先补换行，原字节不动");
    for (const added of continued.slice(original.length + 1).trimEnd().split("\n")) JSON.parse(added);
    assert.ok(readTranscript(broken.transcriptPath).some(e => e.payload.text === "续写"));
    assert.ok(!readTranscript(broken.transcriptPath).some(e => e.seq === 99), "完整但未换行的尾段也保持跳过语义");
    await manager.shutdown();
    const reloaded = new SessionManager();
    assert.equal(reloaded.get(broken.id)?.status, "idle", "重启仍识别已隔离尾行，不能误判为中间损坏");
    await reloaded.shutdown();
  } else {
    assert.deepEqual(readTranscript(broken.transcriptPath).map(e => e.seq), [1, 2, 4], "中间损坏只读加载可解析部分");
    await assert.rejects(manager.sendUserMessage(broken.id, { text: "不得追加" }), /transcript|损坏/);
    assert.throws(() => appendTranscript(broken.transcriptPath, event(mode, 5)), /transcript|损坏/);
    compactClaudeTranscripts([broken]);
    assert.equal(readFileSync(broken.transcriptPath, "utf8"), original);
    await manager.shutdown();
  }
  console.log(`✅ transcript recovery: ${mode}`);
}

// 每个恢复用例只写隔离注册表与原生文件，绝不启动真实 CLI。
const timestamp = "2026-10-03T00:00:00.000Z";
const nativeId = "cccccccc-3333-4333-8333-333333333333";
const nativePath = join(process.env.WORKBENCH_CLAUDE_HISTORY_DIR!, "fixture", `${nativeId}.jsonl`);
mkdirSync(join(nativePath, ".."), { recursive: true });
writeFileSync(nativePath, `${JSON.stringify({ type: "user", uuid: "crash-user", message: { role: "user", content: "断电前问题" } })}\n`);

// Linux pid_max 远小于此值；先验证，不能把意外存在的 PID 当作 fixture。
const absentPid = 2_000_000_000;
assert.throws(() => process.kill(absentPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
const crashEvent = (id: string, type: UnifiedEvent["type"], seq: number, payload: Record<string, unknown>): UnifiedEvent => ({
  type, sessionId: id, agentId: "main", seq, timestamp, payload,
});
const crashRecord = (id: string): SessionRecord => ({
  id, agent: "claude", agentId: "main", cwd: home, config: {}, riskyMode: false,
  status: "running", nativeSessionId: nativeId, nativeTranscriptPath: nativePath, processId: absentPid,
  seq: 1, createdAt: timestamp, lastActivityAt: timestamp,
  transcriptPath: join(home, "transcripts", `${id}.ndjson`),
});

function loadCrash(record: SessionRecord, events = [crashEvent(record.id, "user_message", 1, { text: "断电前问题" })], suffix = "", bootTimeOverride?: number) {
  writeFileSync(record.transcriptPath, events.map(event => `${JSON.stringify(event)}\n`).join("") + suffix);
  writeFileSync(join(home, "sessions.json"), JSON.stringify([record]));
  const instances: Array<{ options: DriverOptions; sent: UserMessageInput[] }> = [];
  const reader = new NativeConversationReader();
  const factory = (agent: SessionRecord["agent"], options: DriverOptions): Driver => {
    const instance = { options, sent: [] as UserMessageInput[] };
    instances.push(instance);
    return {
      kind: agent,
      async start() {
        options.callbacks.metadata({ nativeSessionId: options.resumeSessionId });
        options.callbacks.status("idle");
      },
      getConfigSchema() { return { source: "test", options: [] }; },
      async setConfig(config) { return config; },
      async sendUserMessage(message) { instance.sent.push(message); options.callbacks.status("running"); },
      async resolvePermission() {}, async interrupt() {}, async stop() {},
    } satisfies Driver;
  };
  const manager = new SessionManager(factory, () => ({ model: null, effort: null }), async () => null, reader,
    undefined, () => bootTimeOverride);
  return { manager, instances, reader, factory };
}

const crashTests: Array<[string, () => Promise<void>]> = [
  ["crash-archive-and-gone-worker-resumes-in-place", async () => {
    const record = crashRecord("crash-resume");
    const reader = new NativeConversationReader();
    record.releasedMark = await reader.capture(record);
    assert.ok(record.releasedMark, "fixture 原生存档应可读");
    const { manager, instances } = loadCrash(record);
    assert.equal(manager.get(record.id)?.status, "idle", "非正常退出但旧 PID 不存在且有原生存档，应原地恢复为 idle");
    assert.equal(manager.get(record.id)?.released, true);
    assert.equal(manager.get(record.id)?.processId, undefined);
    assert.equal(manager.get(record.id)?.remoteControl?.status, "disconnected");
    assert.deepEqual((manager as unknown as { nativeMarks: Map<string, unknown> }).nativeMarks.get(record.id), record.releasedMark);
    assert.ok((manager as unknown as { promptedSessions: Set<string> }).promptedSessions.has(record.id));
    await manager.sendUserMessage(record.id, { text: "重启后原地继续" });
    assert.equal(instances.length, 1);
    assert.equal(instances[0]?.options.resumeSessionId, nativeId);
    assert.equal(instances[0]?.sent[0]?.text, "重启后原地继续");
    assert.equal(manager.get(record.id)?.released, undefined);
    await manager.shutdown();
  }],
  ["crash-live-worker-stays-dead", async () => {
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const record = { ...crashRecord("crash-live"), processId: process.pid,
      processIdentity: { bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        startTime: stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]! } };
    const { manager, instances } = loadCrash(record);
    assert.equal(manager.get(record.id)?.status, "dead", "存活的旧 worker 不能同时拉起第二个进程");
    assert.equal(manager.get(record.id)?.released, undefined);
    await assert.rejects(manager.sendUserMessage(record.id, { text: "不得并行续接" }));
    assert.equal(instances.length, 0);
    await manager.shutdown();
  }],
  ["crash-claude-missing-native-archive-stays-dead", async () => {
    const record = { ...crashRecord("crash-no-archive"), nativeSessionId: "dddddddd-4444-4444-8444-444444444444", nativeTranscriptPath: undefined };
    const { manager } = loadCrash(record);
    assert.equal(manager.get(record.id)?.status, "dead", "首条消息前只有 session_id、尚无原生存档不能续接");
    assert.equal(manager.get(record.id)?.released, undefined);
    await manager.shutdown();
  }],
  ["crash-transcript-damage-or-incomplete-tail-remains-error", async () => {
    for (const suffix of ['{"type":', 'bad-middle\n']) {
      const record = crashRecord(suffix.endsWith("\n") ? "crash-damaged" : "crash-tail");
      const { manager } = loadCrash(record, undefined, suffix);
      assert.equal(manager.get(record.id)?.status, "error", "error 判定优先于非正常退出恢复");
      assert.equal(manager.get(record.id)?.released, undefined, "非正常退出时损坏 transcript 不应授予原地恢复资格");
      await manager.shutdown();
    }
  }],
  ["crash-pending-approval-stays-dead-like-shutdown", async () => {
    const record = crashRecord("crash-approval");
    const { manager } = loadCrash(record, [
      crashEvent(record.id, "user_message", 1, { text: "审批前问题" }),
      crashEvent(record.id, "permission_request", 2, { requestId: "stale-request", gate: "fixture", toolName: "Bash" }),
    ]);
    assert.equal(manager.get(record.id)?.status, "dead", "审批闸门已失效，按 shutdown 的排除规则保持 dead");
    assert.equal(manager.get(record.id)?.released, undefined);
    await manager.shutdown();
  }],
  ["crash-unknown-worker-pid-stays-dead", async () => {
    const record = { ...crashRecord("crash-unknown-worker"), processId: undefined };
    const { manager } = loadCrash(record);
    assert.equal(manager.get(record.id)?.status, "dead", "旧注册表没有 worker PID 时不能证明旧进程已退出");
    await manager.shutdown();
  }],
  ["crash-recorded-cli-exit-stays-dead", async () => {
    const record = { ...crashRecord("crash-cli-exit"), status: "dead" as const };
    const { manager } = loadCrash(record, [
      crashEvent(record.id, "user_message", 1, { text: "CLI 崩溃前问题" }),
      crashEvent(record.id, "process_exited", 2, { code: 1, signal: null, expected: false }),
    ]);
    assert.equal(manager.get(record.id)?.status, "dead", "运行中 exited 已记为 dead，重启不能悄悄释放");
    assert.equal(manager.get(record.id)?.released, undefined);
    await manager.shutdown();
  }],
  ["crash-previous-boot-allows-recovery-even-if-pid-is-reused", async () => {
    const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const record = { ...crashRecord("crash-previous-boot"), processId: process.pid,
      processIdentity: { bootId: bootId[0] === "a" ? `b${bootId.slice(1)}` : `a${bootId.slice(1)}`, startTime: "1" } };
    const { manager } = loadCrash(record);
    assert.equal(manager.get(record.id)?.status, "idle", "机器重启后旧 boot 全部进程已消失，即使 PID 已复用也可续接");
    assert.equal(manager.get(record.id)?.released, true);
    await manager.shutdown();
  }],
  ["crash-same-boot-reused-pid-with-unknown-group-stays-dead", async () => {
    const record = { ...crashRecord("crash-reused-pid"), processId: process.pid,
      processIdentity: { bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), startTime: "0" } };
    const { manager } = loadCrash(record);
    assert.equal(manager.get(record.id)?.status, "dead", "同 boot PID 复用不能证明旧 launcher 子进程全退出");
    assert.equal(manager.get(record.id)?.released, undefined);
    await manager.shutdown();
  }],
  ["crash-native-mark-survives-two-reboots-without-send", async () => {
    const record = crashRecord("crash-two-reboots");
    record.releasedMark = await new NativeConversationReader().capture(record);
    assert.ok(record.releasedMark);
    const first = loadCrash(record);
    assert.equal(first.manager.get(record.id)?.released, true);
    // 第二次重启前不发消息、不 shutdown：构造器写回恢复资格时仍须保存私有指纹。
    const persisted = (JSON.parse(readFileSync(join(home, "sessions.json"), "utf8")) as SessionRecord[])
      .find(stored => stored.id === record.id)!;
    assert.equal(persisted.released, true);
    assert.deepEqual(persisted.releasedMark, record.releasedMark);
    const second = new SessionManager(first.factory, () => ({ model: null, effort: null }), async () => null, new NativeConversationReader());
    assert.equal(second.get(record.id)?.status, "idle");
    assert.equal(second.get(record.id)?.released, true);
    assert.deepEqual((second as unknown as { nativeMarks: Map<string, unknown> }).nativeMarks.get(record.id), record.releasedMark);
    assert.equal(second.get(record.id)?.releasedMark, undefined, "指纹不在公开 SessionRecord 中泄漏");
    await second.shutdown();
  }],
  ["crash-runtime-exited-callback-remains-dead-after-restart", async () => {
    const record = crashRecord("crash-runtime-exited");
    const first = loadCrash(record);
    await first.manager.sendUserMessage(record.id, { text: "进程退出前发送" });
    first.instances[0]!.options.callbacks.exited({ code: 1, signal: null, expected: false });
    assert.equal(first.manager.get(record.id)?.status, "dead");
    assert.equal(first.manager.get(record.id)?.released, undefined);
    const second = new SessionManager(first.factory, () => ({ model: null, effort: null }), async () => null, new NativeConversationReader());
    assert.equal(second.get(record.id)?.status, "dead", "运行中的 CLI 崩溃仍走 dead，重启不授予 released");
    assert.equal(second.get(record.id)?.released, undefined);
    await second.shutdown();
  }],
  ["crash-resumed-worker-persists-private-identity-and-shutdown-clears-it", async () => {
    const record = crashRecord("crash-persist-identity");
    record.releasedMark = await new NativeConversationReader().capture(record);
    assert.ok(record.releasedMark);
    const first = loadCrash(record);
    const manager = new SessionManager((agent, options) => ({
      ...first.factory(agent, options), child: { pid: process.pid } as Driver["child"],
    }), () => ({ model: null, effort: null }), async () => null, new NativeConversationReader());
    await manager.sendUserMessage(record.id, { text: "新 worker 身份落盘" });
    assert.equal(first.instances[0]!.options.resumeSessionId, nativeId);
    const stored = () => (JSON.parse(readFileSync(join(home, "sessions.json"), "utf8")) as SessionRecord[])
      .find(session => session.id === record.id)!;
    const running = stored();
    const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    assert.equal(running.processId, process.pid);
    assert.equal(running.processIdentity?.bootId, readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim());
    assert.equal(running.processIdentity?.startTime, stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]);
    assert.deepEqual(running.releasedMark, record.releasedMark, "活 worker 的恢复指纹也须持续落盘");
    assert.equal(manager.get(record.id)?.processIdentity, undefined, "worker 身份为私有持久化字段");
    assert.equal(manager.get(record.id)?.releasedMark, undefined);
    await manager.shutdown();
    assert.equal(stored().released, true);
    assert.equal(stored().processId, undefined);
    assert.equal(stored().processIdentity, undefined, "shutdown 停好 worker 后清除身份");
    assert.deepEqual(stored().releasedMark, record.releasedMark);
  }],
  ["crash-new-worker-unreadable-identity-stays-dead-after-restart", async () => {
    const record = crashRecord("crash-unreadable-new-identity");
    const first = loadCrash(record);
    const manager = new SessionManager((agent, options) => ({
      ...first.factory(agent, options), child: { pid: absentPid } as Driver["child"],
    }), () => ({ model: null, effort: null }), async () => null, new NativeConversationReader());
    await manager.sendUserMessage(record.id, { text: "身份读取失败的 mock worker" });
    const stored = (JSON.parse(readFileSync(join(home, "sessions.json"), "utf8")) as SessionRecord[])
      .find(session => session.id === record.id)!;
    assert.deepEqual(stored.processIdentity, { bootId: "", startTime: "" }, "新 worker 身份读取失败要落盘哨兵，不能伪装为 legacy 缺身份");
    const restarted = new SessionManager(first.factory, () => ({ model: null, effort: null }), async () => null, new NativeConversationReader());
    assert.equal(restarted.get(record.id)?.status, "dead", "旧 pid 消失也不能绕过新 worker 身份未知保护");
    assert.equal(restarted.get(record.id)?.released, undefined);
    await restarted.shutdown();
  }],
];
const bootAfterActivity = Date.parse(timestamp) + 60_000;
const legacyDead = (id: string): SessionRecord => ({ ...crashRecord(id), status: "dead", processId: undefined });
crashTests.push(
  ["legacy-dead-reboot-after-all-activity-resumes-in-place", async () => {
    const record = legacyDead("legacy-dead-reboot");
    const { manager, instances } = loadCrash(record, undefined, "", bootAfterActivity);
    assert.equal(manager.get(record.id)?.status, "idle", "当前 boot 晚于全部活动时间，旧 dead 无 PID 也能证明旧 worker 消失");
    assert.equal(manager.get(record.id)?.released, true);
    await manager.sendUserMessage(record.id, { text: "断电遗留 dead 原地继续" });
    assert.equal(instances[0]?.options.resumeSessionId, nativeId);
    assert.equal(instances[0]?.sent[0]?.text, "断电遗留 dead 原地继续");
    await manager.shutdown();
  }],
  ["legacy-dead-process-exited-survives-ordinary-lifecycle-events", async () => {
    for (const [type, payload] of [
      ["config_updated", { workerRestarted: false }], ["worker_released", { reason: "idle" }], ["turn_completed", {}],
    ] as const) {
      const record = legacyDead(`legacy-exited-${type}`);
      const { manager } = loadCrash(record, [
        crashEvent(record.id, "process_exited", 1, { code: 1, expected: false }),
        crashEvent(record.id, type, 2, payload),
      ], "", bootAfterActivity);
      assert.equal(manager.get(record.id)?.status, "dead", "普通生命周期事件不得擦除明确 CLI 退出证据");
      assert.equal(manager.get(record.id)?.released, undefined);
      await manager.shutdown();
    }
  }],
  ["legacy-dead-reboot-must-be-strictly-after-latest-activity", async () => {
    for (const source of ["registry", "transcript"] as const) {
      for (const delta of [0, -1]) {
        const record = legacyDead(`legacy-boot-${source}-${delta}`);
        const latest = bootAfterActivity + 1_000;
        const event = crashEvent(record.id, "user_message", 1, { text: "最新活动" });
        if (source === "registry") record.lastActivityAt = new Date(latest).toISOString();
        else event.timestamp = new Date(latest).toISOString();
        const { manager } = loadCrash(record, [event], "", latest + delta);
        assert.equal(manager.get(record.id)?.status, "dead", "boot 早于或等于任一最新活动都无法证明机器已重启");
        await manager.shutdown();
      }
    }
    const record = legacyDead("legacy-boot-out-of-order-time");
    const earlierLine = { ...crashEvent(record.id, "user_message", 1, { text: "更晚发生但较早写入" }),
      timestamp: new Date(bootAfterActivity + 1_000).toISOString() };
    const { manager } = loadCrash(record, [earlierLine, crashEvent(record.id, "turn_completed", 2, {})], "", bootAfterActivity);
    assert.equal(manager.get(record.id)?.status, "dead", "必须检查全部事件时间，不能只看 transcript 最后一行");
    await manager.shutdown();
  }],
  ["legacy-dead-reboot-pending-gate-remains-dead", async () => {
    const record = legacyDead("legacy-boot-gate");
    const { manager } = loadCrash(record, [crashEvent(record.id, "permission_request", 1, { requestId: "stale-approval" })], "", bootAfterActivity);
    assert.equal(manager.get(record.id)?.status, "dead");
    await manager.shutdown();
  }],
  ["legacy-dead-reboot-fatal-errors-remain-dead", async () => {
    for (const source of ["process", "startup", "config_restart", "external_resume"]) {
      const record = legacyDead(`legacy-fatal-${source}`);
      const { manager } = loadCrash(record, [crashEvent(record.id, "session_error", 1, { source, message: "明确失败" })], "", bootAfterActivity);
      assert.equal(manager.get(record.id)?.status, "dead", `fatal ${source} 阻断自动恢复`);
      await manager.shutdown();
    }
    const record = legacyDead("legacy-fatal-severity");
    const { manager } = loadCrash(record, [crashEvent(record.id, "session_error", 1, { severity: "fatal", message: "致命错误" })], "", bootAfterActivity);
    assert.equal(manager.get(record.id)?.status, "dead");
    await manager.shutdown();
  }],
  ["legacy-dead-warning-snapshot-does-not-block-reboot-recovery", async () => {
    const record = legacyDead("legacy-warning-snapshot");
    const { manager } = loadCrash(record, [crashEvent(record.id, "session_error", 1,
      { source: "snapshot", severity: "warning", nonBlocking: true, message: "快照失败" })], "", bootAfterActivity);
    assert.equal(manager.get(record.id)?.status, "idle", "snapshot warning 不是 worker 终止证据");
    assert.equal(manager.get(record.id)?.released, true);
    await manager.shutdown();
  }],
  ["legacy-dead-successful-new-worker-resets-terminal-evidence", async () => {
    for (const [type, payload] of [["session_created", {}], ["config_updated", { workerRestarted: true }]] as const) {
      const record = legacyDead(`legacy-new-worker-${type}`);
      const { manager } = loadCrash(record, [
        crashEvent(record.id, "process_exited", 1, { code: 1, expected: false }),
        crashEvent(record.id, type, 2, payload),
        crashEvent(record.id, "user_message", 3, { text: "新 worker 上的有效活动" }),
      ], "", bootAfterActivity);
      assert.equal(manager.get(record.id)?.status, "idle", "明确成功建立新 worker 后旧退出证据不再属于当前生命周期");
      await manager.shutdown();
    }
  }],
  ["legacy-dead-invalid-or-missing-activity-time-remains-dead", async () => {
    for (const source of ["registry", "transcript"] as const) {
      for (const value of ["not-a-date", undefined]) {
        const record = legacyDead(`legacy-time-${source}-${value ?? "missing"}`);
        const event = crashEvent(record.id, "user_message", 1, { text: "时间缺失" });
        if (source === "registry") record.lastActivityAt = value as unknown as string;
        else event.timestamp = value as unknown as string;
        const { manager } = loadCrash(record, [event], "", bootAfterActivity);
        assert.equal(manager.get(record.id)?.status, "dead", "时间缺失或损坏时无法比较完整活动边界");
        await manager.shutdown();
      }
    }
  }],
  ["legacy-dead-missing-boot-or-archive-and-damaged-transcript-stay-blocked", async () => {
    const noBoot = legacyDead("legacy-no-boot");
    const bootUnknown = loadCrash(noBoot);
    assert.equal(bootUnknown.manager.get(noBoot.id)?.status, "dead");
    await bootUnknown.manager.shutdown();
    const noArchive = { ...legacyDead("legacy-no-archive"), nativeSessionId: "eeeeeeee-5555-4555-8555-555555555555", nativeTranscriptPath: undefined };
    const missing = loadCrash(noArchive, undefined, "", bootAfterActivity);
    assert.equal(missing.manager.get(noArchive.id)?.status, "dead");
    await missing.manager.shutdown();
    for (const suffix of ['{"type":', "invalid-middle\n"]) {
      const record = legacyDead(`legacy-error-${suffix.endsWith("\n") ? "middle" : "tail"}`);
      const { manager } = loadCrash(record, undefined, suffix, bootAfterActivity);
      assert.equal(manager.get(record.id)?.status, "error", "transcript error 仍优先于 boot 恢复");
      assert.equal(manager.get(record.id)?.released, undefined);
      await manager.shutdown();
    }
  }],
  ["legacy-dead-empty-transcript-cannot-prove-reboot-recovery", async () => {
    const record = legacyDead("legacy-empty-transcript");
    const { manager, instances } = loadCrash(record, [], "", bootAfterActivity);
    assert.equal(manager.get(record.id)?.status, "dead", "只有 registry 时间而无任何 transcript 活动，不能证明旧生命周期完整");
    assert.equal(manager.get(record.id)?.released, undefined);
    assert.equal(instances.length, 0);
    await manager.shutdown();
  }],
);
const crashFailures: unknown[] = [];
for (const [name, run] of crashTests.filter(([name]) => !requested || requested === "crash" || requested === name)) {
  try {
    await run();
    console.log(`✅ persistence recovery: ${name}`);
  } catch (error) {
    console.error(`❌ persistence recovery: ${name}`, error);
    crashFailures.push(error);
  }
}
if (crashFailures.length) throw new AggregateError(crashFailures, `${crashFailures.length} persistence recovery tests failed`);
