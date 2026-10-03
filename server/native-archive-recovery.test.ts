import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NativeConversationReader } from "./native-conversation.js";
import type { AgentKind, SessionRecord } from "./types.js";

const fixture = await mkdtemp(join(tmpdir(), "workbench-native-archive-recovery-"));
const roots = { claude: join(fixture, "claude"), codex: join(fixture, "codex"), kimi: join(fixture, "kimi") };
const reader = new NativeConversationReader(roots);
const cwd = join(fixture, "project");
const ids = { claude: "archive-claude", codex: "archive-codex", kimi: "archive-kimi" };
const paths = {
  claude: join(roots.claude, "project", `${ids.claude}.jsonl`),
  codex: join(roots.codex, "2026", "10", "03", `rollout-fixture-${ids.codex}.jsonl`),
  kimi: join(roots.kimi, "workspace", ids.kimi, "agents", "main", "wire.jsonl"),
};
const session = (agent: AgentKind, overrides: Partial<SessionRecord> = {}) => ({
  agent, cwd, nativeSessionId: ids[agent], ...overrides,
}) as SessionRecord;
async function lines(path: string, records: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}
const claudeMessage = { type: "user", sessionId: ids.claude, message: { role: "user", content: "已落盘的问题" } };
const codexMetadata = { type: "session_meta", payload: { id: ids.codex, cwd } };
const kimiPrompt = { type: "turn.prompt", input: [{ type: "text", text: "已落盘的问题" }] };
await lines(paths.claude, [claudeMessage]);
await lines(paths.codex, [codexMetadata]);
await lines(paths.kimi, [kimiPrompt]);
const kimiState = join(roots.kimi, "workspace", ids.kimi, "state.json");
await writeFile(kimiState, JSON.stringify({ id: ids.kimi, cwd }));

// archive-claude-first-message-without-uuid: archive readiness does not require a conversation mark.
assert.equal(reader.hasArchive(session("claude")), true);
assert.equal(await reader.capture(session("claude")), undefined);
// archive-codex-before-first-message: metadata alone is a persisted resumable thread.
assert.equal(reader.hasArchive(session("codex")), true);
assert.equal(await reader.capture(session("codex")), undefined);
// archive-kimi-state-and-wire: resume needs the recorded workspace and readable wire.
assert.equal(reader.hasArchive(session("kimi")), true);
assert.equal(reader.hasArchive(session("kimi", { cwd: join(fixture, "different-project") })), false);
await writeFile(kimiState, JSON.stringify({ id: ids.kimi, workDir: cwd }));
assert.equal(reader.hasArchive(session("kimi")), true);
await writeFile(paths.kimi, "");
assert.equal(reader.hasArchive(session("kimi")), true, "valid state plus an empty wire can resume before its first prompt");
await writeFile(kimiState, "{broken}");
assert.equal(reader.hasArchive(session("kimi")), false);
await writeFile(kimiState, JSON.stringify({ id: "another-kimi", cwd }));
assert.equal(reader.hasArchive(session("kimi")), false);

// archive-missing-or-empty: Claude init's session_id is insufficient before its first archive write.
assert.equal(reader.hasArchive(session("claude", { nativeSessionId: "missing-archive" })), false);
await writeFile(paths.claude, "");
assert.equal(reader.hasArchive(session("claude")), false);
await lines(paths.claude, [{ type: "file-history-snapshot", sessionId: ids.claude }]);
assert.equal(reader.hasArchive(session("claude")), false);
// archive-corruption-and-partial-tail: unknown or damaged native records are conservative failures.
await writeFile(paths.claude, `${JSON.stringify(claudeMessage)}\n{broken}\n`);
assert.equal(reader.hasArchive(session("claude")), false);
await writeFile(paths.claude, `${JSON.stringify(claudeMessage)}\n{"type":`);
assert.equal(reader.hasArchive(session("claude")), false);
await writeFile(paths.claude, JSON.stringify(claudeMessage));
assert.equal(reader.hasArchive(session("claude")), true, "complete native final JSON need not have a newline");
// archive-identity-mismatch: neither hints nor metadata can select a different native session.
await lines(paths.codex, [{ type: "session_meta", payload: { id: "other-codex", cwd } }]);
assert.equal(reader.hasArchive(session("codex")), false);
await lines(paths.claude, [{ ...claudeMessage, sessionId: "other-claude" }]);
assert.equal(reader.hasArchive(session("claude")), false);
const wrongHint = join(roots.claude, "project", "another-claude.jsonl");
await lines(wrongHint, [claudeMessage]);
assert.equal(reader.hasArchive(session("claude", { nativeTranscriptPath: wrongHint })), false);
const outside = join(fixture, "outside.jsonl");
await lines(outside, [claudeMessage]);
const escaped = join(roots.claude, "project", "escape-claude.jsonl");
await symlink(outside, escaped);
assert.equal(reader.hasArchive(session("claude", { nativeSessionId: "escape-claude", nativeTranscriptPath: escaped })), false);
// archive-bounded-head: a large archive still resumes using readiness evidence in its bounded head.
await writeFile(paths.claude, `${JSON.stringify(claudeMessage)}\n${" ".repeat(4 * 1024 * 1024)}`);
assert.equal(reader.hasArchive(session("claude")), true);
console.log("✅ native archive recovery: Claude/Codex/Kimi readiness, identity, corruption, path safety and bounds");
