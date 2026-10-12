import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, DriverOptions } from "./types.js";

const home = mkdtempSync(join(tmpdir(), "wb-session-i18n-"));
process.env.WORKBENCH_HOME = home;
const { SessionManager } = await import("./session-manager.js");
const { flushTranscripts } = await import("./persistence.js");
const factory = (kind: Driver["kind"], options: DriverOptions): Driver => ({
  kind,
  async start() { options.callbacks.status("idle"); },
  getConfigSchema: () => ({ source: "test", options: [] }),
  async setConfig(config) { return config; },
  async sendUserMessage() {},
  async resolvePermission() {},
  async interrupt() {},
  async stop() {},
});
const manager = new SessionManager(factory);
try {
  const session = await manager.create({ agent: "codex", cwd: home, config: {} });
  const empty = manager.getSnapshot(session.id, true)!.session as any;
  assert.equal(empty.i18n.title.key, "server.message316");
  await manager.sendUserMessage(session.id, { text: "新会话" });
  flushTranscripts();
  // Simulate a stale title map: the transcript reducer is still authoritative.
  (manager as any).titles.delete(session.id);
  const derived = manager.getSnapshot(session.id, true)!.session as any;
  assert.equal(derived.title, "新会话");
  assert.equal(derived.i18n, undefined, "a real user title must not receive fallback metadata");
  manager.updateOrganization(session.id, { customTitle: "新会话" });
  assert.equal((manager.getSnapshot(session.id, true)!.session as any).i18n, undefined);
} finally { await manager.shutdown(); }
console.log("Session i18n OK: generated fallback, transcript-derived title, and user override");
