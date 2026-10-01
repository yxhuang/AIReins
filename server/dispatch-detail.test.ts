import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDispatch, getDispatchMessages, listDispatchHistory, listParentDispatches, DispatchQueryError } from "./dispatches.js";
import { NativeConversationReader } from "./native-conversation.js";

const root = await mkdtemp(join(tmpdir(), "wb-dispatch-detail-"));
const previous = process.env.WB_DELEGATE_DIR;
process.env.WB_DELEGATE_DIR = root;
const now = Date.parse("2026-10-01T12:00:00Z");
async function fixture(id: string, metadata: object, files: Record<string, string> = {}) {
  const directory = join(root, id);
  await mkdir(directory);
  await writeFile(join(directory, "run.json"), JSON.stringify({ schema: 1, ...metadata }));
  for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), value);
  return directory;
}
try {
  for (let i = 0; i < 24; i++) await fixture(`20260925-120000-codex-${i}`, {
    status: "OK", endedAt: new Date(now - i * 1000).toISOString(), elapsed_s: 10,
  });
  await fixture("20261001-120000-codex-old-end", { status: "OK", endedAt: new Date(now - 8 * 86400_000).toISOString() });
  await fixture("20261001-120001-kimi-no-end", { status: "lost" });
  await fixture("20260925-120001-kimi-inferred-end", { status: "TOOL_FAIL", startedAt: new Date(now - 60_000).toISOString(), elapsed_s: 10 });
  const running = "20260920-120000-codex-running";
  await fixture(running, { status: "running", pid: process.pid, parent: { agent: "claude", sessionId: "parent" } });
  await fixture("20260920-120001-codex-other", { status: "running", pid: process.pid, parent: { agent: "codex", sessionId: "parent" } });
  const first = await listDispatchHistory(null, root, now);
  const second = await listDispatchHistory("20", root, now);
  assert.equal(first.total, 25);
  assert.equal(first.dispatches.length, 20);
  assert.equal(first.nextOffset, 20);
  assert.equal(second.dispatches.length, 5);
  assert.equal(second.nextOffset, null);
  assert.equal(first.dispatches[0]?.runId, "20260925-120000-codex-0", "sort by end time, not directory/start date");
  assert.equal(new Set([...first.dispatches, ...second.dispatches].map((run) => run.runId)).size, 25);
  assert.deepEqual((await listParentDispatches("parent")).map((run) => run.runId), [running]);
  for (const value of ["-1", "", "bad", "1.5"]) await assert.rejects(listDispatchHistory(value), DispatchQueryError);
  await assert.rejects(listParentDispatches("../parent"), DispatchQueryError);

  const id = "20261001-120002-codex-native";
  const session = "22222222-2222-4222-8222-222222222222";
  const nativeRoot = join(root, "codex");
  const nativeDirectory = join(nativeRoot, "2026", "10", "01");
  await mkdir(nativeDirectory, { recursive: true });
  const path = join(nativeDirectory, `rollout-2026-10-01T00-00-00-${session}.jsonl`);
  const row = (payload: object) => JSON.stringify({ type: "response_item", payload }) + "\n";
  await writeFile(path, row({ type: "message", role: "user", content: [{ type: "input_text", text: "read file" }] })
    + row({ type: "function_call", call_id: "call1", name: "exec_command", arguments: JSON.stringify({ cmd: "cat file" }) }));
  const directory = await fixture(id, { status: "OK", session, endedAt: new Date(now).toISOString() }, {
    "summary.txt": "STATUS OK credits 1.25\nACCEPT exit 0 ← npm test\nRESUME codex resume abc\n", "usage.json": JSON.stringify({ totalNanoAiu: 2500000000 }),
  });
  const reader = new NativeConversationReader({ codex: nativeRoot });
  const initial = await getDispatchMessages(id, null, root, reader);
  assert.equal(initial?.source, "native");
  assert.equal(initial?.replaceFrom, 0);
  assert.ok(initial?.messages.some((message) => message.role === "tool"));
  const unchanged = await getDispatchMessages(id, initial!.cursor, root, reader);
  assert.deepEqual(unchanged?.messages, []);
  await appendFile(path, row({ type: "function_call_output", call_id: "call1", output: "file contents" }));
  const changed = await getDispatchMessages(id, initial!.cursor, root, reader);
  assert.equal(changed?.replaceFrom, 1, "tool result replaces its earlier call, without repeating user text");
  assert.ok(changed?.messages.some((message) => message.role === "tool" && message.tool.result === "file contents"));
  await appendFile(path, row({ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }));
  const appended = await getDispatchMessages(id, changed!.cursor, root, reader);
  assert.equal(appended?.replaceFrom, 2);
  assert.equal(appended?.messages.length, 1);
  const reset = await getDispatchMessages(id, "unknown-cursor", root, reader);
  assert.equal(reset?.replaceFrom, 0);
  assert.equal(reset?.messages.length, 3);
  const detail = await getDispatch(id);
  assert.equal(detail?.resume, "codex resume abc");
  assert.equal(detail?.acceptResult, "exit 0 ← npm test");
  assert.equal(detail?.credits, 2.5);

  const outside = await mkdtemp(join(tmpdir(), "wb-dispatch-detail-outside-"));
  const escape = "20261001-120003-codex-escape";
  await symlink(outside, join(root, escape));
  for (const value of ["../x", `${id}/../x`, escape, "20261001-120004-codex-missing"]) {
    assert.equal(await getDispatchMessages(value, null, root, reader), null);
  }
  await writeFile(join(directory, "run.json"), JSON.stringify({ schema: 1, session: "../../secret" }));
  assert.equal((await getDispatchMessages(id, null, root, reader))?.source, "stdout");
  // Native transcript symlinks must not grant arbitrary file reads.
  const escapedSession = "33333333-3333-4333-8333-333333333333";
  await writeFile(join(outside, "secret.jsonl"), row({ type: "message", role: "user", content: [{ type: "input_text", text: "SECRET" }] }));
  await symlink(join(outside, "secret.jsonl"), join(nativeDirectory, `rollout-x-${escapedSession}.jsonl`));
  await writeFile(join(directory, "run.json"), JSON.stringify({ schema: 1, session: escapedSession }));
  assert.equal((await getDispatchMessages(id, null, root, reader))?.source, "stdout");
  console.log("✅ dispatch detail: history pagination, parent matching, native deltas/tool updates and path escapes");
} finally {
  if (previous === undefined) delete process.env.WB_DELEGATE_DIR;
  else process.env.WB_DELEGATE_DIR = previous;
}
