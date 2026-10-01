import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupKimiProbeSession } from "./drivers/kimi.js";

const root = await mkdtemp(join(tmpdir(), "wb-kimi-probe-"));
const dirty = join(root, ".index-dirty");
await mkdir(dirty);
const exists = async (path: string) => access(path).then(() => true, () => false);
const allowed = ["metadata", "permission.set_mode", "profile.bind", "runtime.set_binding"];
async function fixture(id: string, stateId = id, types = allowed): Promise<string> {
  const directory = join(root, "wd_workbench_test", id);
  await mkdir(join(directory, "agents", "main"), { recursive: true });
  await writeFile(join(directory, "state.json"), JSON.stringify({ id: stateId }));
  await writeFile(join(directory, "agents", "main", "wire.jsonl"), types.map((type) => JSON.stringify({ type })).join("\n"));
  await writeFile(join(dirty, `${id}.marker`), "probe");
  return directory;
}

const match = await fixture("session_probe");
const mismatch = await fixture("session_mismatch", "session_other");
const conversation = await fixture("session_conversation", undefined, [...allowed, "turn.prompt"]);
const unknown = await fixture("session_unknown", undefined, [...allowed, "unexpected.record"]);
const malformed = await fixture("session_malformed");
await writeFile(join(malformed, "agents", "main", "wire.jsonl"), "{bad\n");
assert.equal(await cleanupKimiProbeSession("session_probe", root), true);
assert.equal(await exists(match), false);
assert.equal(await exists(join(dirty, "session_probe.marker")), false);
for (const [id, directory] of [["session_mismatch", mismatch], ["session_conversation", conversation], ["session_unknown", unknown], ["session_malformed", malformed]]) {
  const before = await readFile(join(directory!, "agents", "main", "wire.jsonl"), "utf8");
  assert.equal(await cleanupKimiProbeSession(id!, root), false);
  assert.equal(await readFile(join(directory!, "agents", "main", "wire.jsonl"), "utf8"), before);
  assert.equal(await exists(join(dirty, `${id}.marker`)), true);
}
await writeFile(join(dirty, "session_missing.marker"), "preserve");
assert.equal(await cleanupKimiProbeSession("session_missing", root), false);
assert.equal(await exists(join(dirty, "session_missing.marker")), true, "目录不存在时也不能删除标记");
assert.equal(await cleanupKimiProbeSession("../session_mismatch", root), false);

console.log("✅ Kimi probe cleanup：仅匹配且无对话目录可删；不匹配/有对话/不存在/未知或坏记录均保留");
