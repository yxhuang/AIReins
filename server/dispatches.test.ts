import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DispatchQueryError, dispatchSessionMap, getDispatch, getDispatchLog, listDispatches, readClaudeTranscriptModel, readClaudeParentModel } from "./dispatches.js";

const root = await mkdtemp(join(tmpdir(), "wb-dispatches-"));
const outside = await mkdtemp(join(tmpdir(), "wb-dispatches-outside-"));
const previousRoot = process.env.WB_DELEGATE_DIR;
process.env.WB_DELEGATE_DIR = root;

async function fixture(id: string, files: Record<string, unknown> = {}): Promise<string> {
  const directory = join(root, id);
  await mkdir(directory);
  for (const [name, value] of Object.entries(files)) {
    await writeFile(join(directory, name), typeof value === "string" ? value : JSON.stringify(value));
  }
  return directory;
}

try {
  const projects = join(root, "claude-projects");
  const project = join(projects, "project");
  await mkdir(project, { recursive: true });
  const transcript = join(project, "parent-test.jsonl");
  await writeFile(transcript, `${JSON.stringify({ type: "user", message: { content: "x".repeat(1100000) } })}\n${[
    { type: "assistant", message: { model: "claude-sonnet-4-5" } },
    { type: "user", message: { model: "user-model" } },
    { type: "assistant", message: { model: "claude-opus-5-5" } },
    { type: "system", message: { model: "system-model" } },
  ].map((row) => JSON.stringify(row)).join("\n")}\n`);
  assert.equal(await readClaudeTranscriptModel(transcript), "claude-opus-5-5", "只取末尾最后一条 assistant.model");
  assert.equal(await readClaudeTranscriptModel(join(project, "missing.jsonl")), null);
  assert.equal(await readClaudeParentModel("parent-test", projects), "claude-opus-5-5");
  await appendFile(transcript, `${JSON.stringify({ type: "assistant", message: { model: "new-model" } })}\n`);
  assert.equal(await readClaudeParentModel("parent-test", projects), "claude-opus-5-5", "缓存 30 秒内复用");
  assert.equal(await readClaudeTranscriptModel(transcript), "new-model");
  await appendFile(transcript, `${JSON.stringify({ type: "assistant", message: {} })}\n`);
  assert.equal(await readClaudeTranscriptModel(transcript), null, "最后 assistant 无模型不回退旧模型");
  assert.equal(await readClaudeParentModel("../escape", projects), null);
  const doneId = "20261001-120000-codex-finished";
  const parent = { agent: "claude", sessionId: "parent-session", entrypoint: "cli", model: null };
  const done = await fixture(doneId, {
    "run.json": {
      schema: 1, runId: doneId, tool: "codex", name: "human readable name", cwd: "/project", model: "test-model", effort: "high",
      status: "OK", startedAt: "2026-10-01T12:00:00+08:00", endedAt: "2026-10-01T12:01:00+08:00",
      elapsed_s: 60, exit: 0, files: 2, session: "session", parent,
    },
    "prompt.txt": "\n  \n第一行\n第二行", "summary.txt": "完成摘要\n", "last.txt": "最终结果\n", "accept.log": "通过\n",
    "stdout.log": "开始\n完成\n", "stderr.log": "",
  });
  const detail = await getDispatch(doneId);
  assert.ok(detail);
  assert.deepEqual(detail, {
    runId: doneId, tool: "codex", name: "human readable name", cwd: "/project", model: "test-model", effort: "high",
    status: "OK", startedAt: "2026-10-01T12:00:00+08:00", endedAt: "2026-10-01T12:01:00+08:00",
    elapsedS: 60, exit: 0, files: 2, session: "session", parent, promptHead: "第一行",
    prompt: "\n  \n第一行\n第二行", promptTruncated: false, summary: "完成摘要\n", final: "最终结果\n", accept: "通过\n",
    acceptResult: null, resume: null, credits: null,
  });

  const runningId = "20261001-120001-codex-running";
  const session = "12345678-abcd-1234-5678-123456789abc";
  await fixture(runningId, {
    "run.json": { schema: 1, status: "running", pid: process.pid, session: null, parent: { agent: "codex", sessionId: "upstream", entrypoint: null } },
    "stderr.log": `Codex startup\nsession id: ${session}\n`, "prompt.txt": "中文".repeat(100),
  });
  const running = await getDispatch(runningId);
  assert.equal(running?.status, "running", "当前进程 PID 存活");
  assert.equal(running?.session, session, "codex 从 stderr 首 8KB 补齐 session");
  assert.equal(running?.promptHead, "中文".repeat(80), "首行截 160 字符");
  assert.equal(running?.startedAt, new Date("2026-10-01T12:00:01").toISOString(), "目录时间按服务端本地时区推导");

  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const deadPid = child.pid;
  assert.ok(deadPid);
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}`)));
  });
  const lostId = "20261001-120002-kimi-lost";
  await fixture(lostId, {
    "run.json": { schema: 1, status: "running", pid: deadPid, parent: { agent: "codex", runId: runningId, sessionId: null, entrypoint: null } },
  });
  assert.equal((await getDispatch(lostId))?.status, "lost", "已退出子进程标 lost");
  assert.deepEqual((await getDispatch(lostId))?.parent, { agent: "codex", runId: runningId, sessionId: null, entrypoint: null, model: null });

  const legacyId = "20260930-120003-copilot-legacy";
  await fixture(legacyId, {
    "meta.json": { tool: "copilot", status: "ACCEPT_FAIL", exit: 0, session: "?", model: "old", cwd: "/old", elapsed_s: 42 },
  });
  const legacy = await getDispatch(legacyId);
  assert.equal(legacy?.status, "ACCEPT_FAIL");
  assert.equal(legacy?.model, "old");
  assert.equal(legacy?.elapsedS, 42);
  assert.equal(legacy?.session, null);
  assert.equal(legacy?.parent, null);
  assert.equal(legacy?.endedAt, null);
  assert.equal(legacy?.prompt, null);

  const emptyId = "20261001-120004-kimi-empty";
  await fixture(emptyId);
  assert.equal((await getDispatch(emptyId))?.status, "unknown", "空目录保留为 unknown");
  const brokenId = "20261001-120005-codex-broken";
  await fixture(brokenId, { "run.json": "{bad", "meta.json": { status: "OK" }, "prompt.txt": "坏元数据仍可读首行" });
  assert.equal((await getDispatch(brokenId))?.status, "unknown", "损坏 run 不借旧 meta 掩盖");
  assert.equal((await getDispatch(brokenId))?.promptHead, "坏元数据仍可读首行");
  const unreadableId = "20261001-120006-kimi-unreadable";
  const unreadable = await fixture(unreadableId, { "run.json": { schema: 1, status: "OK" } });
  await chmod(join(unreadable, "run.json"), 0);
  try {
    if (process.getuid?.() !== 0) assert.equal((await getDispatch(unreadableId))?.status, "unknown", "无权限单条降级");
  } finally { await chmod(join(unreadable, "run.json"), 0o600); }

  const list = await listDispatches();
  assert.equal(list.length, 7);
  assert.deepEqual(list.map((item) => item.runId), list.map((item) => item.runId).sort().reverse());
  assert.equal(list.find((item) => item.runId === brokenId)?.status, "unknown");
  assert.equal(list.find((item) => item.runId === doneId)?.status, "OK", "坏目录不影响其他条目");
  assert.equal("prompt" in list[0]!, false, "列表不读出 prompt 全文");
  assert.equal((await listDispatches(2)).length, 2);

  await fixture("unrelated");
  await fixture("20261001-120100-claude-ignored");
  const escapeId = "20261001-120101-codex-escape";
  await symlink(outside, join(root, escapeId));
  for (const id of ["../x", `${doneId}/../x`, `${doneId}..`, escapeId, "20261001-120102-codex-missing"]) {
    assert.equal(await getDispatch(id), null, `详情拒绝 ${id}`);
    assert.equal(await getDispatchLog(id), null, `日志拒绝 ${id}`);
  }
  assert.equal((await listDispatches()).length, 7, "不匹配目录与外部符号链接均跳过");
  await writeFile(join(outside, "secret"), "outside secret");
  // 固定的日志文件也不能通过符号链接读取根外内容。
  const fileEscapeId = "20261001-120103-kimi-file-escape";
  const fileEscape = await fixture(fileEscapeId, { "run.json": { schema: 1, status: "OK" } });
  await symlink(join(outside, "secret"), join(fileEscape, "prompt.txt"));
  await symlink(join(outside, "secret"), join(fileEscape, "stdout.log"));
  assert.equal((await getDispatch(fileEscapeId))?.prompt, null);
  assert.equal((await getDispatch(fileEscapeId))?.status, "unknown");
  assert.equal(await getDispatchLog(fileEscapeId), null);

  // 第一个 64KB 块末尾只含「中」的首字节，整条未完成行必须留给下一次。
  const logPath = join(done, "stdout.log");
  await writeFile(logPath, "abc\n中文\n");
  assert.equal((await getDispatchLog(doneId, "stdout", 1))?.text, "bc\n中文\n", "显式 offset 从该字节起读");
  assert.equal((await getDispatchLog(doneId, "stdout", 5))?.text, "文\n", "手工 offset 落在中文字符内部时不输出残缺字符");
  const firstLine = "a".repeat(65_531) + "\n"; // 65,532 bytes
  const logText = firstLine + "前中文后\n下一行未完成";
  await writeFile(logPath, logText);
  const first = await getDispatchLog(doneId, "stdout", 0);
  assert.deepEqual(first, { text: firstLine, nextOffset: 65_532, size: Buffer.byteLength(logText), eof: false });
  const second = await getDispatchLog(doneId, "stdout", first!.nextOffset);
  assert.equal(second?.text, "前中文后\n");
  assert.equal(second?.nextOffset, 65_532 + Buffer.byteLength("前中文后\n"));
  assert.equal(second?.eof, false, "尾半行仍未消费");
  const half = await getDispatchLog(doneId, "stdout", second!.nextOffset);
  assert.equal(half?.text, "");
  assert.equal(half?.nextOffset, second?.nextOffset);
  await appendFile(logPath, "补全\n");
  const completed = await getDispatchLog(doneId, "stdout", half!.nextOffset);
  assert.equal(completed?.text, "下一行未完成补全\n");
  assert.equal(completed?.eof, true);
  assert.equal(completed?.text.includes("�"), false);

  await writeFile(logPath, "重建\n尾半行");
  const reset = await getDispatchLog(doneId, "stdout", 999_999);
  assert.deepEqual(reset, { text: "重建\n", nextOffset: Buffer.byteLength("重建\n"), size: Buffer.byteLength("重建\n尾半行"), eof: false, reset: true });
  const tailText = "首行\n" + "中文行\n".repeat(2_000) + "尾半行";
  await writeFile(logPath, tailText);
  const tail = await getDispatchLog(doneId);
  assert.ok(tail);
  assert.ok(Buffer.byteLength(tail.text) <= 16 * 1024);
  assert.ok(tail.text.startsWith("中文行\n"), "尾读从完整行首开始");
  assert.equal(tail.text.includes("�"), false);
  assert.equal(tail.nextOffset, Buffer.byteLength(tailText) - Buffer.byteLength("尾半行"));
  assert.equal(tail.eof, false);
  const logSize = Buffer.byteLength(tailText);
  assert.deepEqual(await getDispatchLog(doneId, "stdout", logSize), { text: "", nextOffset: logSize, size: logSize, eof: true });
  assert.equal((await getDispatchLog(runningId, "stderr", 0))?.text, `Codex startup\nsession id: ${session}\n`);
  assert.deepEqual(await getDispatchLog(emptyId), { text: "", nextOffset: 0, size: 0, eof: true });
  await assert.rejects(getDispatchLog(doneId, "../prompt"), DispatchQueryError);
  for (const offset of [-1, 0.5, "bad", "", Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(getDispatchLog(doneId, "stdout", offset), DispatchQueryError);
  }

  const longPrompt = "x".repeat(65_535) + "中文";
  await writeFile(join(done, "prompt.txt"), longPrompt);
  await writeFile(join(done, "last.txt"), "中".repeat(4_000));
  await writeFile(join(done, "accept.log"), "文".repeat(2_000));
  const capped = await getDispatch(doneId);
  assert.equal(capped?.promptTruncated, true);
  assert.equal(capped?.prompt, "x".repeat(65_535), "prompt 64KB 字节边界不产生残缺 UTF-8");
  assert.equal(capped?.final, "中".repeat(Math.floor(8 * 1024 / 3)));
  assert.equal(capped?.accept, "文".repeat(Math.floor(4 * 1024 / 3)));
  await writeFile(join(done, "prompt.txt"), "\n".repeat(70_000) + "😀".repeat(161));
  assert.equal((await getDispatch(doneId))?.promptHead, "😀".repeat(160), "跨块跳过空行并按 Unicode 字符截取");

  const limitRoot = await mkdtemp(join(tmpdir(), "wb-dispatches-limit-"));
  for (let index = 0; index < 205; index++) {
    await mkdir(join(limitRoot, `20261001-130000-kimi-${index.toString().padStart(3, "0")}`));
  }
  assert.equal((await listDispatches(null, limitRoot)).length, 50);
  assert.equal((await listDispatches("999999", limitRoot)).length, 200, "limit 上限 200");
  assert.equal((await listDispatches("invalid", limitRoot)).length, 50);
  assert.equal((await listDispatches(0, limitRoot)).length, 50);
  assert.equal((await listDispatches(1.8, limitRoot)).length, 1);
  assert.deepEqual(await listDispatches(null, join(root, "missing-root")), []);
  // 超过一整块的单行（codex stderr 实测有 1MB 单行）：offset 必须能推进，拼回与原文一致，不出残缺字符
  const longLine = "长".repeat(70_000) + "x\n";
  await writeFile(logPath, longLine);
  let cursor = 0, joined = "", reads = 0;
  for (;;) {
    const part = await getDispatchLog(doneId, "stdout", cursor);
    assert.ok(part && !part.text.includes("\ufffd"), "长行分块不得出现残缺字符");
    assert.ok(part!.nextOffset > cursor || part!.eof, "长行时 offset 必须推进");
    joined += part!.text; cursor = part!.nextOffset; reads++;
    if (part!.eof) break;
    assert.ok(reads < 20);
  }
  assert.equal(joined, longLine, "长行分块拼回与原文一致");
  assert.ok((await getDispatchLog(doneId, "stdout"))!.text.length > 0, "尾读长行时不返回空");

  const kimiSession = "session_dispatch_test";
  const kimiRun = "20261001-180001-kimi-mapped";
  await fixture(kimiRun, { "meta.json": { session: kimiSession, name: "旧格式 Kimi 工单" } });
  await writeFile(join(done, "run.json"), JSON.stringify({ schema: 1, session, name: "Codex 工单" }));
  const mapped = await dispatchSessionMap();
  assert.deepEqual(mapped.get(session), { runId: doneId, name: "Codex 工单" });
  assert.deepEqual(mapped.get(kimiSession), { runId: kimiRun, name: "旧格式 Kimi 工单" });
  assert.equal(mapped.has("?"), false);
  assert.ok(![...mapped.values()].some((value) => value.runId === brokenId), "坏目录不影响映射");
  assert.equal(await dispatchSessionMap(), mapped, "30 秒内复用同一映射");
  const manyRoot = await mkdtemp(join(tmpdir(), "wb-dispatch-map-many-"));
  for (let i = 0; i < 205; i++) {
    const runId = `20261001-190000-codex-${i}`;
    await mkdir(join(manyRoot, runId));
    await writeFile(join(manyRoot, runId, "run.json"), JSON.stringify({ schema: 1, session: `id-${i}` }));
  }
  assert.equal((await dispatchSessionMap(manyRoot)).size, 205, "遍历全部目录，不套用列表 200 条上限");
  console.log("✅ dispatches 只读接口及全量缓存会话映射测试全过");
} finally {
  if (previousRoot === undefined) delete process.env.WB_DELEGATE_DIR;
  else process.env.WB_DELEGATE_DIR = previousRoot;
}
