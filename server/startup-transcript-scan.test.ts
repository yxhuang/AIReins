import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { SessionRecord, UnifiedEvent } from "./types.js";
const home = fs.mkdtempSync(join(tmpdir(), "aireins-startup-scan-"));
process.env.WORKBENCH_HOME = home;
const p = await import("./persistence.js");
const { SessionManager } = await import("./session-manager.js");
p.loadRegistry();
const id = "fixture", path = p.transcriptPathFor(id);
const event = (seq: number, partial = false): UnifiedEvent => ({ type: partial ? "tool_call_updated" : "agent_text_delta", sessionId: id,
  agentId: "main", seq, timestamp: "2026-01-01T00:00:00Z", payload: partial ? { partialInput: "old", toolCallId: "fixture" } : { text: "modern" } });
const record: SessionRecord = { id, agent: "claude", agentId: "main", cwd: home, status: "dead", config: {}, riskyMode: false,
  seq: 3, createdAt: event(1).timestamp, lastActivityAt: event(1).timestamp, transcriptPath: path };
p.saveRegistry([record]);
const open = fs.openSync;
let opens = 0;
fs.openSync = ((...args: Parameters<typeof fs.openSync>) => { if (args[0] === path && args[1] === "r") opens++; return open(...args); }) as typeof fs.openSync;
syncBuiltinESMExports();
try {
  fs.writeFileSync(path, [event(1), event(2), event(3)].map(e => JSON.stringify(e) + "\n").join(""));
  const manager = new SessionManager();
  assert.equal(opens, 1, "modern transcripts must be scanned only once during startup recovery");
  await manager.shutdown();
  fs.writeFileSync(path, [event(1), event(2, true), event(3)].map(e => JSON.stringify(e) + "\n").join(""));
  const migrated = new SessionManager();
  assert.deepEqual(migrated.getSnapshot(id)!.events.map(e => e.seq), [1, 3], "newly found legacy updates still migrate");
  assert.equal(migrated.get(id)!.seq, 3);
  await migrated.shutdown();
} finally { fs.openSync = open; syncBuiltinESMExports(); }
console.log("PASS: one recovery scan for modern archives, legacy migration and seq preservation");
