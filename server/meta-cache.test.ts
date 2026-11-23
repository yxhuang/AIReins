import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 有缓存时立即返回缓存；后台探测（PATH 置空，CLI 全部探测失败）完成后覆盖缓存文件。
const home = mkdtempSync(join(tmpdir(), "wb-meta-"));
process.env.WORKBENCH_HOME = home;
process.env.PATH = "";
writeFileSync(join(home, "meta-cache.json"), JSON.stringify({ cliVersions: { claude: "9.9" }, drivers: { marker: 1 } }));
const { getMeta, whenMetaReady } = await import("./meta.js");
const started = Date.now();
const meta = await getMeta();
assert.ok(Date.now() - started < 200, "有缓存时不等探测");
assert.equal((meta.drivers as any).marker, 1);
assert.deepEqual((meta.drivers as any).antigravity.options, [], "旧缓存也立即提供 Antigravity 基础能力");
assert.equal(meta.defaultCwd, process.cwd());
await whenMetaReady();
const refreshed = JSON.parse(readFileSync(join(home, "meta-cache.json"), "utf8"));
assert.ok(refreshed.drivers.codex, "后台探测结果写回缓存");
assert.notDeepEqual((await getMeta()).drivers, { marker: 1 }, "探测完成后内存结果更新");
console.log("PASS: /api/meta 先返回落盘缓存，后台探测后更新缓存");

// 独立模块实例，模拟第一次安装；不调用已登录的 CLI。
process.env.WORKBENCH_HOME = mkdtempSync(join(tmpdir(), "wb-meta-cold-"));
const cold = await import(new URL("./meta.ts?cold-start", import.meta.url).href);
const initial = await cold.getMeta();
assert.equal(initial.metadataPending, true, "无缓存时先给基础信息，不等 CLI 探测");
assert.equal(initial.defaultCwd, process.cwd());
for (const agent of ["claude", "antigravity", "codex", "kimi"]) {
  assert.equal((initial.drivers as Record<string, { interrupt: boolean }>)[agent].interrupt, true);
  assert.deepEqual((initial.drivers as Record<string, { options: unknown[] }>)[agent].options, []);
}
await cold.whenMetaReady();
assert.equal((await cold.getMeta()).metadataPending, false, "探测失败也结束 pending 状态");
assert.ok((await cold.getMeta()).cliVersions);
console.log("PASS: 无缓存先显示基础界面，后台探测完成或失败后可取得最终结果");

const previousOptions = [
  { id: "model", name: "Model", default: "test-model", values: [{ value: "test-model", label: "Test Model" }], mutable: true },
  { id: "permissionMode", name: "Mode", default: "auto", values: [{ value: "auto", label: "Auto" }], mutable: true },
];
const lastGoodHome = mkdtempSync(join(tmpdir(), "wb-meta-last-good-"));
process.env.WORKBENCH_HOME = lastGoodHome;
const lastGoodCache = join(lastGoodHome, "meta-cache.json");
writeFileSync(lastGoodCache, JSON.stringify({ cliVersions: {}, drivers: { antigravity: { options: previousOptions } } }));
const lastGood = await import(new URL("./meta.ts?last-good", import.meta.url).href);
await lastGood.whenMetaReady();
const afterFailure = (await lastGood.getMeta()).drivers as Record<string, { error?: string; options: unknown[] }>;
assert.ok(afterFailure.antigravity.error, "保留本次探测错误供诊断");
assert.deepEqual(afterFailure.antigravity.options, previousOptions, "探测失败后，新建页继续得到上次成功的选项");
assert.deepEqual(JSON.parse(readFileSync(lastGoodCache, "utf8")).drivers.antigravity.options, previousOptions);
console.log("PASS: Antigravity 探测失败时，内存和磁盘均保留上次成功的选项");
