import assert from "node:assert/strict";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryIndex } from "./history.js";

const fixture = await mkdtemp(join(tmpdir(), "workbench-history-resume-"));
const roots = {
  claude: join(fixture, "claude"),
  codex: join(fixture, "codex"),
  kimi: join(fixture, "kimi"),
  workbenchRegistry: join(fixture, "sessions.json"),
};
await Promise.all([roots.claude, roots.codex, roots.kimi].map((path) => mkdir(path)));
const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
for (const id of ids) {
  const path = join(roots.claude, `${id}.jsonl`);
  await writeFile(path, `${JSON.stringify({ type: "user", cwd: "/repo", entrypoint: "cli", message: { role: "user", content: id } })}\n`);
  // 同一 mtime 也须按既有的 agent/path 次序翻页，不遗漏或重复。
  await utimes(path, 1_000, 1_000);
}
const history = new HistoryIndex({ roots });
const first = await history.list({ agent: "claude", limit: 1 });
assert.equal(first.sessions[0].nativeSessionId, ids[0]);
assert.ok(first.nextCursor);

// 连发现阶段也没开始：必须有可重试的起始游标。
const zeroDiscovery = await new HistoryIndex({ roots, timeoutMs: 0 }).list({ agent: "claude", limit: 1 });
assert.equal(zeroDiscovery.truncated, true);
assert.equal(zeroDiscovery.discovered, 0);
assert.ok(zeroDiscovery.nextCursor, "零消费 deadline 仍须返回续扫游标");
const resumedFirst = await history.list({ agent: "claude", limit: 1, cursor: zeroDiscovery.nextCursor });
const resumedSecond = await history.list({ agent: "claude", limit: 1, cursor: resumedFirst.nextCursor });
assert.deepEqual([...resumedFirst.sessions, ...resumedSecond.sessions].map((session) => session.nativeSessionId), ids);
assert.equal(resumedSecond.nextCursor, undefined);

// 已翻过一页后零消费，保持排除已消费候选的旧游标语义。
const zeroContinuation = await new HistoryIndex({ roots, timeoutMs: 0 }).list({ agent: "claude", limit: 1, cursor: first.nextCursor });
assert.equal(zeroContinuation.nextCursor, first.nextCursor);
const continuation = await history.list({ agent: "claude", limit: 1, cursor: zeroContinuation.nextCursor });
assert.deepEqual(continuation.sessions.map((session) => session.nativeSessionId), [ids[1]]);

// 用时钟与阶段打桩触发 deadline，不依赖机器速度或 sleep。
const realNow = Date.now;
let now = realNow();
Date.now = () => now;
try {
  for (const stage of ["discover", "parseCandidate"]) {
    const interrupted = new HistoryIndex({ roots, timeoutMs: 10 });
    const method = Reflect.get(interrupted, stage);
    Reflect.set(interrupted, stage, async (...args: unknown[]) => {
      const value = await Reflect.apply(method, interrupted, args);
      now += 10;
      return value;
    });
    const page = await interrupted.list({ agent: "claude", limit: 1 });
    // 发现用完预算仍有独立消费预算；解析用完预算则保持零消费续扫。
    assert.equal(page.sessions.length, stage === "discover" ? 1 : 0);
    assert.equal(page.discovered, 2);
    assert.equal(page.truncated, stage !== "discover");
    assert.ok(page.nextCursor, `${stage} 后零消费应可重试`);
    Reflect.set(interrupted, stage, method);
    const resumed = await interrupted.list({ agent: "claude", limit: 2, cursor: page.nextCursor });
    assert.deepEqual([...page.sessions, ...resumed.sessions].map((session) => session.nativeSessionId), ids,
      `${stage} 重试不能跳过未消费候选或重复已消费候选`);
  }
} finally {
  Date.now = realNow;
}
console.log("✅ 历史零消费续扫回归通过（4 个边界场景）");
