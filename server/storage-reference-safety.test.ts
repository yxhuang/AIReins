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
const { removeUploadDirs, uploadDirReferences } = await import("./persistence.js");
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
      for (const record of records) assert.ok((counts.get(record.transcriptPath) ?? 0) <= 1, "每份 transcript 至多读一次，签名未变时复用缓存");
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

// 附件目录越多，不应按目录数反复扫描每份大 transcript。
const prefix = join(home, "uploads");
for (const id of ["ref", "reference", "special [1]", ...Array.from({ length: 75 }, (_, i) => `missing-${i}`)]) {
  fs.mkdirSync(join(prefix, id), { recursive: true });
}
const large = "x".repeat(2 * 1024 * 1024);
fs.writeFileSync(records[0]!.transcriptPath, `${large} ${join(prefix, "reference", "image.png")} ${join(prefix, "special [1]", "a.png")}`);
const includes = String.prototype.includes;
let scannedBytes = 0;
String.prototype.includes = function (search: string, position?: number): boolean {
  if (this.length >= large.length) scannedBytes += this.length;
  return includes.call(this, search, position);
};
try {
  const references = uploadDirReferences(records);
  assert.deepEqual([...references.get("live")!].sort(), ["ref", "reference", "special [1]"], "保留旧的保守前缀保护及特殊字符语义");
  assert.ok(scannedBytes <= large.length * 3, `大记录重复扫描了 ${scannedBytes} 字节，不能随附件目录数增长`);
} finally {
  String.prototype.includes = includes;
}
console.log("✅ reference scan: large transcripts are not rescanned for every upload directory");
