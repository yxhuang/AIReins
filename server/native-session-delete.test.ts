import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Driver, SessionRecord } from "./types.js";

const fixture = await mkdtemp(join(tmpdir(), "workbench-permanent-delete-"));
process.env.HOME = fixture;
process.env.CODEX_HOME = join(fixture, ".codex");
process.env.KIMI_CODE_HOME = join(fixture, ".kimi-code");
process.env.WORKBENCH_HOME = join(fixture, "wb");
process.env.WORKBENCH_CODEX_HISTORY_DIR = join(fixture, ".codex", "sessions");
process.env.WORKBENCH_KIMI_HISTORY_DIR = join(fixture, ".kimi-code", "sessions");
const bin = join(fixture, "bin");
await mkdir(bin, { recursive: true });
process.env.PATH = `${bin}:${process.env.PATH}`;
// Fake native CLIs perform real, isolated filesystem changes. No model/network calls.
await writeFile(join(bin, "codex"), `#!/usr/bin/env node
const fs = require('node:fs'), p = require('node:path');
const [cmd, force, id] = process.argv.slice(2);
if (cmd !== 'delete' || force !== '--force' || !/^[a-f0-9-]{36}$/.test(id)) process.exit(2);
if (fs.existsSync(p.join(process.env.HOME, 'require-stop')) && !fs.existsSync(p.join(process.env.HOME, 'stopped'))) process.exit(3);
if (id.startsWith('44444444')) { console.error('native delete rejected'); process.exit(4); }
fs.unlinkSync(p.join(process.env.CODEX_HOME, 'sessions', 'rollout-' + id + '.jsonl'));
fs.appendFileSync(p.join(process.env.HOME, 'deleted-ids'), id + '\\n');
`, { mode: 0o700 });
await writeFile(join(bin, "kimi"), `#!/usr/bin/env node
const fs = require('node:fs'), p = require('node:path');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line);
 if (m.method === 'initialize') console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{agentCapabilities:{sessionCapabilities:process.env.TEST_KIMI_UNSUPPORTED ? {} : {delete:{}}}}}));
 if (m.method === 'session/delete') {
  if (process.env.TEST_KIMI_FAIL) { console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'native delete rejected'}})); return; }
  const directory = p.join(process.env.KIMI_CODE_HOME || p.join(process.env.HOME,'.kimi-code'), 'sessions/wd_test', m.params.sessionId);
  if (process.env.TEST_KIMI_KEEP_DIR) { fs.unlinkSync(p.join(directory,'agents/main/wire.jsonl')); console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}})); return; }
  fs.rmSync(directory, {recursive:true});
  fs.appendFileSync(p.join(process.env.HOME,'kimi-deleted-ids'),m.params.sessionId+'\\n');
  console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{}}));
 }
});
`, { mode: 0o700 });

const now = new Date().toISOString();
function record(n: number, agent: "codex" | "kimi" | "claude" = "codex"): SessionRecord {
  const uuid = `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
  const nativeSessionId = agent === "kimi" ? `session_${uuid}` : uuid;
  return { id: `wb-${n}`, agent, agentId: "main", cwd: fixture, nativeSessionId,
    status: "dead", createdAt: now, lastActivityAt: now, seq: 0, config: {}, riskyMode: false,
    transcriptPath: join(process.env.WORKBENCH_HOME!, "transcripts", `wb-${n}.ndjson`),
    nativeTranscriptPath: agent === "kimi"
      ? join(process.env.WORKBENCH_KIMI_HISTORY_DIR!, "wd_test", nativeSessionId, "agents/main/wire.jsonl")
      : join(process.env.WORKBENCH_CODEX_HISTORY_DIR!, `rollout-${nativeSessionId}.jsonl`) };
}
const records = [record(1), record(2), record(3, "kimi"), record(4), record(5, "claude"), record(6), record(7), record(8)];
for (const r of records) {
  await mkdir(join(process.env.WORKBENCH_HOME!, "transcripts"), { recursive: true });
  await writeFile(r.transcriptPath, "");
  await mkdir(join(r.nativeTranscriptPath!, ".."), { recursive: true });
  if (r.agent === "kimi") {
    await writeFile(join(process.env.WORKBENCH_KIMI_HISTORY_DIR!, "wd_test", r.nativeSessionId!, "state.json"), JSON.stringify({id:r.nativeSessionId,cwd:fixture}));
    await writeFile(r.nativeTranscriptPath!, "");
  } else await writeFile(r.nativeTranscriptPath!, JSON.stringify({type:"session_meta",payload:{id:r.nativeSessionId,cwd:fixture}})+"\n");
}
await writeFile(join(process.env.WORKBENCH_HOME!, "sessions.json"), JSON.stringify(records));
const { deleteNativeSession, validateNativeDelete } = await import("./native-session-delete.js");
const { SessionManager } = await import("./session-manager.js");
const manager = new SessionManager();

// Existing remove preserves native history.
await manager.remove(records[0]!.id);
assert.ok(existsSync(records[0]!.nativeTranscriptPath!));
assert.ok(!existsSync(records[0]!.transcriptPath));

// Permanent deletion waits for stop and locks all mutation paths during that await.
const live = records[1]!;
Reflect.get(manager, "sessions").get(live.id).status = "idle";
await writeFile(join(fixture, "require-stop"), "");
let unblock!: () => void;
const gate = new Promise<void>(resolve => { unblock = resolve; });
Reflect.get(manager, "workers").set(live.id, { stop: async () => { await gate; await writeFile(join(fixture,"stopped"), ""); } } as Driver);
const deleting = manager.remove(live.id, true);
await assert.rejects(manager.remove(live.id), /彻底删除/);
await assert.rejects(manager.create({agent:"codex",cwd:fixture,resumeSessionId:live.nativeSessionId,snapshot:"skip"}), /彻底删除/);
assert.throws(() => manager.updateOrganization(live.id, {customTitle:"race"}), /彻底删除/);
assert.ok(existsSync(live.nativeTranscriptPath!), "native history remains until worker stopped");
unblock();
await deleting;
assert.equal(manager.get(live.id), undefined);
assert.ok(!existsSync(live.nativeTranscriptPath!));
assert.ok(!existsSync(live.transcriptPath));
assert.ok(existsSync(records[0]!.nativeTranscriptPath!), "another session remains intact");

process.env.TEST_KIMI_UNSUPPORTED = "1";
await assert.rejects(manager.remove(records[2]!.id, true), /不支持.*session\/delete/);
assert.ok(manager.get(records[2]!.id));
assert.ok(existsSync(records[2]!.nativeTranscriptPath!));
delete process.env.TEST_KIMI_UNSUPPORTED;
process.env.TEST_KIMI_FAIL = "1";
await assert.rejects(manager.remove(records[2]!.id, true), /Kimi.*失败.*native delete rejected/);
assert.ok(manager.get(records[2]!.id));
assert.ok(existsSync(records[2]!.transcriptPath));
assert.ok(existsSync(records[2]!.nativeTranscriptPath!));
delete process.env.TEST_KIMI_FAIL;
process.env.TEST_KIMI_KEEP_DIR = "1";
await assert.rejects(manager.remove(records[2]!.id, true), /历史文件仍存在/);
assert.ok(manager.get(records[2]!.id), "a partial native deletion keeps the WB record");
await writeFile(records[2]!.nativeTranscriptPath!, "");
delete process.env.TEST_KIMI_KEEP_DIR;
await manager.remove(records[2]!.id, true);
assert.equal(manager.get(records[2]!.id), undefined);
assert.ok(!existsSync(records[2]!.nativeTranscriptPath!));
assert.ok(!existsSync(records[2]!.transcriptPath));
assert.equal((await readFile(join(fixture,"kimi-deleted-ids"),"utf8")).trim(),records[2]!.nativeSessionId);
process.env.WORKBENCH_KIMI_HISTORY_DIR = join(fixture, "different-history");
assert.throws(() => validateNativeDelete(records[2]!), /历史目录/);
delete process.env.WORKBENCH_KIMI_HISTORY_DIR;
process.env.KIMI_CODE_HOME = join(fixture, "relocated-kimi");
process.env.WORKBENCH_KIMI_HISTORY_DIR = join(process.env.KIMI_CODE_HOME, "sessions");
const relocated = record(9, "kimi");
delete process.env.WORKBENCH_KIMI_HISTORY_DIR;
relocated.nativeTranscriptPath = join(process.env.KIMI_CODE_HOME, "sessions/wd_test", relocated.nativeSessionId!, "agents/main/wire.jsonl");
await mkdir(join(relocated.nativeTranscriptPath, ".."), {recursive:true});
await writeFile(join(process.env.KIMI_CODE_HOME,"sessions/wd_test",relocated.nativeSessionId!,"state.json"),JSON.stringify({id:relocated.nativeSessionId,cwd:fixture}));
await writeFile(relocated.nativeTranscriptPath, "");
await deleteNativeSession(relocated);
assert.ok(!existsSync(relocated.nativeTranscriptPath), "KIMI_CODE_HOME moves native reading and deleting together");
delete process.env.KIMI_CODE_HOME;
process.env.WORKBENCH_KIMI_HISTORY_DIR = join(fixture, ".kimi-code", "sessions");

await assert.rejects(manager.remove(records[3]!.id, true), /Codex.*失败/);
assert.ok(manager.get(records[3]!.id), "failed native deletion keeps WB record");
assert.ok(existsSync(records[3]!.transcriptPath));
assert.ok(existsSync(records[3]!.nativeTranscriptPath!));
await assert.rejects(manager.remove(records[4]!.id, true), /Claude/);
assert.ok(manager.get(records[4]!.id));

const stopFailure = records[7]!;
Reflect.get(manager,"sessions").get(stopFailure.id).status = "idle";
let stopCalls = 0;
const failedWorker = {stop:async()=>{ if (++stopCalls === 1) throw new Error("stop failed"); }} as Driver;
Reflect.get(manager,"workers").set(stopFailure.id,failedWorker);
await assert.rejects(manager.remove(stopFailure.id,true), /stop failed/);
assert.equal(Reflect.get(manager,"workers").get(stopFailure.id),failedWorker, "a failed stop does not orphan the managed worker");
assert.ok(existsSync(stopFailure.nativeTranscriptPath!));
Reflect.get(manager,"sessions").set("same-history-alias", {...records[6]!,id:"same-history-alias"});
await assert.rejects(manager.remove(records[6]!.id,true), /另一条/);
Reflect.get(manager,"sessions").delete("same-history-alias");

const running = Reflect.get(manager, "sessions").get(records[5]!.id);
running.status = "running";
await assert.rejects(manager.remove(running.id, true), /空闲|结束/);
running.status = "idle";
running.backgroundTasks = [{ id:"task", description:"test" }];
await assert.rejects(manager.remove(running.id, true), /后台/);
await assert.rejects(deleteNativeSession({...records[6]!, nativeSessionId:"--all"}), /原生会话/);
assert.throws(() => validateNativeDelete({...records[6]!, nativeSessionId:undefined}), /原生会话/);
await writeFile(records[6]!.nativeTranscriptPath!, JSON.stringify({type:"session_meta",payload:{id:records[0]!.nativeSessionId,cwd:fixture}})+"\n");
await assert.rejects(deleteNativeSession(records[6]!), /核验|身份/);
assert.ok(existsSync(records[6]!.nativeTranscriptPath!));
assert.equal((await readFile(join(fixture,"deleted-ids"),"utf8")).trim(), live.nativeSessionId);
await manager.shutdown();
console.log("Permanent deletion: Codex/Kimi, stop ordering, concurrent lock, RPC/partial failures, capabilities, relocated home, identity and ordinary remove passed");
