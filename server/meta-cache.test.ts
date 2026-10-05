import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 有缓存时立即返回缓存；后台探测（PATH 置空，CLI 全部探测失败）完成后覆盖缓存文件。
const home = mkdtempSync(join(tmpdir(), "wb-meta-"));
process.env.WORKBENCH_HOME = home;
process.env.PATH = "";
writeFileSync(join(home, "meta-cache.json"), JSON.stringify({ cliVersions: { claude: "9.9" }, drivers: { marker: 1 } }));
const { getMeta } = await import("./meta.js");
const started = Date.now();
const meta = await getMeta();
assert.ok(Date.now() - started < 200, "有缓存时不等探测");
assert.deepEqual(meta.drivers, { marker: 1 });
assert.equal(meta.defaultCwd, process.cwd());
for (let i = 0; i < 100 && readFileSync(join(home, "meta-cache.json"), "utf8").includes("marker"); i++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const refreshed = JSON.parse(readFileSync(join(home, "meta-cache.json"), "utf8"));
assert.ok(refreshed.drivers.codex, "后台探测结果写回缓存");
assert.notDeepEqual((await getMeta()).drivers, { marker: 1 }, "探测完成后内存结果更新");
console.log("PASS: /api/meta 先返回落盘缓存，后台探测后更新缓存");
