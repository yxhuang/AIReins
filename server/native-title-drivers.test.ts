import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeDriver } from "./drivers/claude.js";
import { KimiDriver } from "./drivers/kimi.js";
import type { DriverOptions } from "./types.js";

function harness<T extends ClaudeDriver | KimiDriver>(Driver: new (options: DriverOptions) => T, cwd = process.cwd(), onMetadata?: (value: Record<string, unknown>) => void) {
  const metadata: Record<string, unknown>[] = [];
  const sent: Record<string, any>[] = [];
  const driver = new Driver({
    sessionId: "test", cwd, config: {},
    callbacks: {
      emit: () => undefined, metadata: (value) => { metadata.push(value); onMetadata?.(value); },
      commands() {}, status() {}, exited() {},
    },
  });
  driver.child = { stdin: { writable: true, write(line: string) { sent.push(JSON.parse(line)); } } } as unknown as ChildProcessWithoutNullStreams;
  const receive = (message: unknown) => (driver as unknown as { handleStdoutLine(line: string): void })
    .handleStdoutLine(JSON.stringify(message));
  return { driver, metadata, sent, receive };
}

{
  const root = mkdtempSync(join(tmpdir(), "wb-native-title-"));
  const previousRoot = process.env.WORKBENCH_CLAUDE_HISTORY_DIR;
  process.env.WORKBENCH_CLAUDE_HISTORY_DIR = root;
  try {
    const project = join(root, "-tmp-native-title-fixture");
    mkdirSync(project);
    const id = "00000000-0000-4000-8000-000000000064";
    const path = join(project, `${id}.jsonl`);
    writeFileSync(path, JSON.stringify({ type: "user", message: { content: "x".repeat(300_000) } }) + "\n");
    appendFileSync(path, JSON.stringify({ type: "ai-title", aiTitle: "原生目录导航摘要", sessionId: id }) + "\n");
    appendFileSync(path, JSON.stringify({ type: "ai-title", aiTitle: "其他会话", sessionId: "different" }) + "\n");
    appendFileSync(path, '{"type":"ai-title","aiTitle":"partial');
    const h = harness(ClaudeDriver, "/tmp/native-title-fixture");
    h.receive({ type: "system", subtype: "init", session_id: id });
    assert.equal(h.metadata.find((value) => value.nativeTitle)?.nativeTitle, "原生目录导航摘要");
    appendFileSync(path, '"}\n' + JSON.stringify({ type: "ai-title", aiTitle: "首轮后的摘要", sessionId: id }) + "\n");
    h.receive({ type: "result", subtype: "success", session_id: id });
    assert.equal(h.metadata.filter((value) => value.nativeTitle).length, 1, "an existing AI title needs no repeated read or notification");
    assert.equal(h.sent.length, 0, "native summary reads do not send model requests");

    writeFileSync(path, "");
    let resolveTitle!: () => void;
    const titleArrived = new Promise<void>((resolve) => { resolveTitle = resolve; });
    const delayed = harness(ClaudeDriver, "/tmp/native-title-fixture", (value) => {
      if (value.nativeTitle === "稍后生成的摘要") resolveTitle();
    });
    delayed.receive({ type: "result", subtype: "success", session_id: id });
    appendFileSync(path, JSON.stringify({ type: "ai-title", aiTitle: "稍后生成的摘要", sessionId: id }) + "\n");
    const timeout = setTimeout(() => resolveTitle(), 2_000);
    await titleArrived;
    clearTimeout(timeout);
    assert.equal(delayed.metadata.filter((value) => value.nativeTitle).length, 1, "late CLI titles arrive once");
    assert.equal(delayed.metadata.at(-1)?.nativeTitle, "稍后生成的摘要");
    assert.equal((delayed.driver as unknown as { titleWatcher?: unknown }).titleWatcher, undefined);
    delayed.receive({ type: "result", subtype: "success", session_id: id });
    assert.equal(delayed.metadata.filter((value) => value.nativeTitle).length, 1);

    writeFileSync(path, "");
    const stopped = harness(ClaudeDriver, "/tmp/native-title-fixture");
    stopped.receive({ type: "result", subtype: "success", session_id: id });
    assert.ok((stopped.driver as unknown as { titleWatcher?: unknown }).titleWatcher);
    stopped.driver.child = undefined;
    await stopped.driver.stop();
    assert.equal((stopped.driver as unknown as { titleWatcher?: unknown }).titleWatcher, undefined);
  } finally {
    if (previousRoot === undefined) delete process.env.WORKBENCH_CLAUDE_HISTORY_DIR;
    else process.env.WORKBENCH_CLAUDE_HISTORY_DIR = previousRoot;
  }
}

{
  const h = harness(ClaudeDriver);
  h.receive({ type: "system", subtype: "session_title_changed", session_id: "native", title: "检验目录导航" });
  assert.equal(h.metadata.at(-1)?.nativeTitle, "检验目录导航");
  const count = h.metadata.length;
  h.receive({ type: "system", subtype: "session_title_changed", session_id: "other", title: "其他会话" });
  for (const title of [undefined, null, 42, "", "  "]) {
    h.receive({ type: "system", subtype: "session_title_changed", session_id: "native", title });
  }
  assert.equal(h.metadata.length, count, "malformed or empty titles do not erase the useful title");
}

{
  const h = harness(KimiDriver);
  (h.driver as unknown as { nativeSessionId: string }).nativeSessionId = "native";
  const update = (title: unknown) => h.receive({
    jsonrpc: "2.0", method: "session/update",
    params: { sessionId: "native", update: { sessionUpdate: "session_info_update", title } },
  });
  update("检验目录导航");
  assert.equal(h.metadata.at(-1)?.nativeTitle, "检验目录导航");
  const count = h.metadata.length;
  h.receive({ jsonrpc: "2.0", method: "session/update", params: {
    sessionId: "other", update: { sessionUpdate: "session_info_update", title: "其他会话" },
  } });
  for (const title of [undefined, null, 42, "", "  "]) update(title);
  assert.equal(h.metadata.length, count, "metadata-only updates do not erase the useful title");
}

console.log("Claude/Kimi 原生标题读取与通知通过");
