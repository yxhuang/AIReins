import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "./session-manager.js";
import type { SessionRecord } from "./types.js";

const home = fs.mkdtempSync(join(tmpdir(), "wb-reference-safety-"));
process.env.WORKBENCH_HOME = home;
fs.mkdirSync(join(home, "uploads", "orphan"), { recursive: true });
fs.mkdirSync(join(home, "transcripts"));
const records = ["live", "ended"].map((id): SessionRecord => ({ id, agent: "codex", agentId: "main", cwd: home, status: "dead",
  config: {}, riskyMode: false, seq: 0, createdAt: "2026-10-03T00:00:00.000Z", lastActivityAt: "2026-10-03T00:00:00.000Z",
  transcriptPath: join(home, "transcripts", `${id}.ndjson`) }));
for (const record of records) fs.writeFileSync(record.transcriptPath, "{}\n");
const { removeUploadDirs } = await import("./persistence.js");
const { getStorageStats } = await import("./storage.js");
const read = fs.readFileSync, remove = fs.rmSync;
for (const mode of process.argv[2] ? [process.argv[2]] : ["deletion", "scan"]) {
  fs.mkdirSync(join(home, "uploads", "orphan"), { recursive: true });
  const counts = new Map<string, number>();
  let deleted = 0;
  fs.readFileSync = ((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    const name = String(path);
    if (records.some(record => record.transcriptPath === name)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (mode === "deletion") throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
    }
    return (read as Function)(path, ...args);
  }) as typeof fs.readFileSync;
  fs.rmSync = ((...args: Parameters<typeof fs.rmSync>) => { deleted++; return remove(...args); }) as typeof fs.rmSync;
  syncBuiltinESMExports();
  try {
    if (mode === "deletion") {
      assert.equal(removeUploadDirs(["orphan"], records), 0, "EACCES 时整次附件删除放弃");
      assert.equal(deleted, 0);
      assert.ok(fs.existsSync(join(home, "uploads", "orphan")));
    } else {
    const manager = { list: () => [...records, { ...records[0]!, id: "alias" }],
      isEndedSessionRemovable: (id: string) => id === "ended" } as unknown as SessionManager;
      getStorageStats(manager);
      for (const record of records) assert.equal(counts.get(record.transcriptPath), 1, "每份 transcript 只读一次");
    }
  } finally {
    fs.readFileSync = read;
    fs.rmSync = remove;
    syncBuiltinESMExports();
  }
  assert.equal(removeUploadDirs(["orphan"], records), 1, "正常孤儿仍能删除");
  assert.equal(fs.existsSync(join(home, "uploads", "orphan")), false);
  console.log(`✅ reference safety: ${mode}`);
}
