import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = await mkdtemp(join(tmpdir(), "workbench-prefs-test-"));
process.env.WORKBENCH_HOME = fixture;

const { DEFAULT_PREFS, isValidIdleReleaseMinutes, loadPrefs, prefsPath, savePrefs } = await import("./prefs.js");

// 文件不存在按默认值
assert.deepEqual(loadPrefs(), DEFAULT_PREFS);
assert.equal(DEFAULT_PREFS.idleReleaseMinutes, 30);

// 持久化往返
savePrefs({ idleReleaseMinutes: 15 });
assert.equal(existsSync(prefsPath()), true);
assert.deepEqual(loadPrefs(), { idleReleaseMinutes: 15 });

// 0 是合法值（关闭），不能被当成缺省
savePrefs({ idleReleaseMinutes: 0 });
assert.equal(loadPrefs().idleReleaseMinutes, 0);

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

await rm(fixture, { recursive: true, force: true });
console.log("prefs tests passed");
