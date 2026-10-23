import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = await mkdtemp(join(tmpdir(), "workbench-prefs-test-"));
process.env.WORKBENCH_HOME = fixture;

const { DEFAULT_PREFS, isValidIdleReleaseMinutes, loadPrefs, prefsPath, savePrefs } = await import("./prefs.js");

// 文件不存在按默认值
assert.deepEqual(loadPrefs(), DEFAULT_PREFS);
assert.equal(DEFAULT_PREFS.idleReleaseMinutes, 30);
assert.equal(DEFAULT_PREFS.retentionDays, 30);

// 持久化往返
savePrefs({ idleReleaseMinutes: 15, retentionDays: 7 });
assert.equal(existsSync(prefsPath()), true);
assert.deepEqual(loadPrefs(), { idleReleaseMinutes: 15, retentionDays: 7 });

// 新监控默认关闭；只接受 boolean，并在偏好往返中保留。
assert.equal(loadPrefs().codexResetWatch === true, false);
savePrefs({ idleReleaseMinutes: 15, retentionDays: 7, codexResetWatch: true });
assert.equal(loadPrefs().codexResetWatch, true);
await writeFile(prefsPath(), JSON.stringify({ idleReleaseMinutes: 15, retentionDays: 7, codexResetWatch: "true" }));
assert.equal(loadPrefs().codexResetWatch === true, false);
savePrefs({ idleReleaseMinutes: 15, retentionDays: 7, codexResetWatch: false });
assert.equal(loadPrefs().codexResetWatch, false);

// 0 是合法值（关闭），不能被当成缺省
const localPrefs = { idleReleaseMinutes: 15, retentionDays: 7, shutdownCommand: "/opt/bin/power-off",
  claudeCodeEntrypoint: "claude-vscode" as const, directoryBrowserHome: "/opt/projects", codexResetWatch: true,
  codexProxyUrl: "http://localhost:18080", proxyUrl: "http://localhost:18081" };
savePrefs(localPrefs);
assert.deepEqual(loadPrefs(), localPrefs, "本机可选字段持久化往返");
await writeFile(prefsPath(), JSON.stringify({ ...localPrefs, shutdownCommand: "relative", claudeCodeEntrypoint: "invalid", directoryBrowserHome: "/bad\u0000path", codexProxyUrl: "not a URL", proxyUrl: "not a URL" }));
assert.deepEqual(loadPrefs(), { idleReleaseMinutes: 15, retentionDays: 7, codexResetWatch: true }, "拒绝无效的本机字段");

for (const proxy of ["http://localhost:18080", "https://proxy.example:18443/", "http://[::1]:18080"]) {
  savePrefs({ ...DEFAULT_PREFS, codexProxyUrl: proxy, proxyUrl: proxy });
  assert.equal(loadPrefs().codexProxyUrl, proxy);
  assert.equal(loadPrefs().proxyUrl, proxy);
}
for (const proxy of [null, 42, "", "not a URL", "socks5://localhost:18080", "http://user:password@localhost",
  "http://localhost/path", "http://localhost?query", "http://localhost#hash", "http://localhost:99999",
  "http://localhost\n", "http://local\u0000host", "x".repeat(2049)]) {
  await writeFile(prefsPath(), JSON.stringify({ ...DEFAULT_PREFS, codexProxyUrl: proxy, proxyUrl: proxy }));
  assert.deepEqual(loadPrefs(), DEFAULT_PREFS, "Invalid proxy must not discard unrelated preferences");
}

await writeFile(prefsPath(), JSON.stringify({ ...DEFAULT_PREFS, selfUpdateProxyUrl: "http://unused.example:18080" }));
assert.deepEqual(loadPrefs(), DEFAULT_PREFS, "Unreleased update-only preference is ignored");

savePrefs({ idleReleaseMinutes: 0, retentionDays: 0 });
assert.deepEqual(loadPrefs(), { idleReleaseMinutes: 0, retentionDays: 0 });

// 单个字段无效只回落该字段
await writeFile(prefsPath(), JSON.stringify({ idleReleaseMinutes: 10, retentionDays: -1 }));
assert.deepEqual(loadPrefs(), { idleReleaseMinutes: 10, retentionDays: 30 });

// 坏 JSON、字段无效均回落默认值
await writeFile(prefsPath(), "not json");
assert.deepEqual(loadPrefs(), DEFAULT_PREFS);
await writeFile(prefsPath(), JSON.stringify({ idleReleaseMinutes: -5 }));
assert.deepEqual(loadPrefs(), DEFAULT_PREFS);
await writeFile(prefsPath(), JSON.stringify({ idleReleaseMinutes: "30" }));
assert.deepEqual(loadPrefs(), DEFAULT_PREFS);
await writeFile(prefsPath(), JSON.stringify({ idleReleaseMinutes: 1441 }));
assert.deepEqual(loadPrefs(), DEFAULT_PREFS);

// 校验边界
for (const ok of [0, 1, 30, 1440]) assert.equal(isValidIdleReleaseMinutes(ok), true, `${ok} 应合法`);
for (const bad of [-1, 1441, 1.5, Number.NaN, "0", null, undefined, true]) {
  assert.equal(isValidIdleReleaseMinutes(bad), false, `${String(bad)} 应拒绝`);
}

// 启动清理：过期会话出登记表，残留 transcript / uploads 删除，坏时间戳保留
const { pruneStorage, saveRegistry, loadRegistry, transcriptPathFor } = await import("./persistence.js");
const now = Date.parse("2026-10-01T00:00:00Z");
const record = (id: string, lastActivityAt: string) => ({ id, lastActivityAt, transcriptPath: transcriptPathFor(id) }) as never;
saveRegistry([record("fresh", "2026-09-20T00:00:00Z"), record("stale", "2026-08-01T00:00:00Z"), record("weird", "not a date")]);
await mkdir(join(fixture, "uploads", "stale"), { recursive: true });
await mkdir(join(fixture, "uploads", "fresh"), { recursive: true });
for (const id of ["fresh", "stale", "weird", "orphan"]) await writeFile(transcriptPathFor(id), "");
await writeFile(join(fixture, "transcripts", "keep.txt"), "");
assert.deepEqual(pruneStorage(30, now), { expired: 1, removedFiles: 3 });
assert.deepEqual(loadRegistry().map((session: { id: string }) => session.id), ["fresh", "weird"]);
assert.deepEqual((await readdir(join(fixture, "transcripts"))).sort(), ["fresh.ndjson", "keep.txt", "weird.ndjson"]);
assert.deepEqual(await readdir(join(fixture, "uploads")), ["fresh"]);
// 保留会话引用了别的会话的附件：该目录不删
await mkdir(join(fixture, "uploads", "gone"), { recursive: true });
await writeFile(transcriptPathFor("fresh"), JSON.stringify({ mentions: [{ path: join(fixture, "uploads", "gone", "a.png") }] }));
assert.deepEqual(pruneStorage(30, now), { expired: 0, removedFiles: 0 });
assert.deepEqual((await readdir(join(fixture, "uploads"))).sort(), ["fresh", "gone"]);
await writeFile(transcriptPathFor("fresh"), "");

// 0 = 不过期，但残留照清
saveRegistry([record("fresh", "2000-01-01T00:00:00Z")]);
assert.deepEqual(pruneStorage(0, now), { expired: 0, removedFiles: 2 });

await rm(fixture, { recursive: true, force: true });
console.log("prefs tests passed");
