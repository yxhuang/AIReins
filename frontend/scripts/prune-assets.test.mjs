import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "vite";
import { pruneAssets } from "./prune-assets.mjs";

// 测试产物只在独立临时目录，不删除仓库 dist，也不在测试结束时清理目录。
const root = mkdtempSync(join(tmpdir(), "aireins-prune-"));
const dist = join(root, "dist");
mkdirSync(join(dist, "assets/nested"), { recursive: true });
mkdirSync(join(dist, ".vite"));
const now = Math.floor(Date.now() / 1000) * 1000, day = 86400_000;
const file = (name, age = 8 * day) => {
  const path = join(dist, name);
  writeFileSync(path, name);
  utimesSync(path, (now - age) / 1000, (now - age) / 1000);
};
writeFileSync(join(dist, "index.html"), '<script src="/assets/current.js"></script><link href="./assets/direct.svg?v=1">');
const manifest = {
  "index.html": { file: "assets/current.js", imports: ["shared"], dynamicImports: ["lazy"], css: ["assets/current.css"] },
  shared: { file: "assets/shared.js", imports: ["lazy"] },
  lazy: { file: "assets/lazy.js", imports: ["shared"], css: ["assets/nested/lazy.css"], assets: ["assets/picture.svg"] },
};
const writeManifest = data => writeFileSync(join(dist, ".vite/manifest.json"), JSON.stringify(data));
writeManifest(manifest);
for (const name of ["current.js", "current.css", "shared.js", "lazy.js", "nested/lazy.css", "picture.svg", "direct.svg"]) {
  file(`assets/${name}`); file(`assets/${name}.gz`); file(`assets/${name}.map`);
}
file("assets/old.js"); file("assets/old.js.gz", 0); file("assets/old.js.map", 0); file("assets/old.js.map.gz", 0);
file("assets/nested/old.css"); file("assets/old.svg"); file("assets/orphan.js.gz");
file("assets/recent.js", day); file("assets/recent.js.gz"); file("assets/boundary.css", 7 * day);
file("keep-outside-assets.js");
assert.deepEqual(pruneAssets(dist, now).sort(), ["nested/old.css", "old.js", "old.js.gz", "old.js.map", "old.js.map.gz", "old.svg", "orphan.js.gz"].sort());
for (const name of ["current.js", "current.js.gz", "current.js.map", "lazy.js", "nested/lazy.css", "shared.js", "picture.svg", "direct.svg", "recent.js", "recent.js.gz", "boundary.css"]) {
  assert.equal(existsSync(join(dist, "assets", name)), true, name);
}
assert.equal(existsSync(join(dist, "keep-outside-assets.js")), true);
assert.deepEqual(pruneAssets(dist, now), [], "重复运行幂等");
file("assets/fail-safe.js");
writeManifest({ "index.html": { file: "assets/current.js", dynamicImports: ["missing"] } });
assert.throws(() => pruneAssets(dist, now), /Missing manifest chunk/);
assert.equal(existsSync(join(dist, "assets/fail-safe.js")), true, "解析引用链失败时不执行删除");
writeFileSync(join(dist, ".vite/manifest.json"), "broken");
assert.throws(() => pruneAssets(dist, now), SyntaxError);
assert.equal(existsSync(join(dist, "assets/fail-safe.js")), true);

// 真实 Vite 的文件名和引用关系：入口 → 静态 chunk / 动态 chunk → CSS → 图片。
const source = join(root, "source");
mkdirSync(source);
writeFileSync(join(source, "index.html"), '<script type="module" src="/main.js"></script>');
writeFileSync(join(source, "main.js"), 'import { shared } from "./shared.js"; document.body.textContent = shared; window.lazy = () => import("./lazy.js");');
writeFileSync(join(source, "shared.js"), 'export const shared = "shared";');
writeFileSync(join(source, "lazy.js"), 'import "./lazy.css"; import { shared } from "./shared.js"; export default shared;');
writeFileSync(join(source, "lazy.css"), 'body { background: url("./picture.svg"); }');
writeFileSync(join(source, "picture.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>');
const built = join(root, "built");
await build({ configFile: false, root: source, logLevel: "silent", build: {
  outDir: built, emptyOutDir: false, manifest: true, assetsInlineLimit: 0,
} });
const actual = JSON.parse(readFileSync(join(built, ".vite/manifest.json"), "utf8"));
assert.equal(actual["index.html"].dynamicImports.length, 1);
const currentFiles = new Set(Object.values(actual).flatMap(chunk => [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]));
for (const name of currentFiles) {
  const path = join(built, name);
  utimesSync(path, (now - 8 * day) / 1000, (now - 8 * day) / 1000);
}
writeFileSync(join(built, "assets/obsolete.js"), "obsolete");
utimesSync(join(built, "assets/obsolete.js"), (now - 8 * day) / 1000, (now - 8 * day) / 1000);
assert.deepEqual(pruneAssets(built, now), ["obsolete.js"]);
for (const name of currentFiles) assert.equal(existsSync(join(built, name)), true, `Vite current resource ${name}`);
console.log("✅ asset retention: old/unreferenced only, companions, 7-day boundary, nested/cyclic chain, fail-safe, actual Vite manifest");
