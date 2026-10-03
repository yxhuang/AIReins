import assert from "node:assert/strict";
import { once } from "node:events";
import { ClaudeDriver } from "./drivers/claude.js";
import { CodexDriver } from "./drivers/codex.js";
import { KimiDriver } from "./drivers/kimi.js";

// Exercise actual worker process environments using a local shell, without invoking AI CLIs.
for (const Driver of [ClaudeDriver, CodexDriver, KimiDriver]) {
  const received: any[] = [];
  const driver = new Driver({
    sessionId: "wb-parent", cwd: process.cwd(), config: {},
    callbacks: { emit() { return undefined; }, metadata() {}, commands() {}, status() {}, exited() {} },
  });
  const internal = driver as any;
  internal.handleStdoutLine = (line: string) => { received.push(JSON.parse(line)); };
  internal.spawnProcess("/bin/sh", ["-c", 'printf \'{"agent":"%s","session":"%s","extra":"%s","delegate":"%s","upstream":"%s"}\\n\' "$WORKBENCH_PARENT_AGENT" "$WORKBENCH_PARENT_SESSION_ID" "$WB_EXTRA" "$DELEGATE_RUN_ID" "$CODEX_THREAD_ID"'], {
    env: { ...process.env, WB_EXTRA: "retained", WORKBENCH_PARENT_AGENT: "upstream", WORKBENCH_PARENT_SESSION_ID: "upstream-id",
      DELEGATE_RUN_ID: "upstream-run", DELEGATE_TOOL: "codex", CODEX_THREAD_ID: "upstream-thread" },
  });
  const [code] = await once(driver.child!, "close");
  assert.equal(code, 0);
  assert.deepEqual(received, [{ agent: driver.kind, session: "wb-parent", extra: "retained", delegate: "", upstream: "" }]);
}
console.log("✅ 三家实际 worker 环境：父会话标记正确，启动参数环境保留，上游标记不串入当前会话");
