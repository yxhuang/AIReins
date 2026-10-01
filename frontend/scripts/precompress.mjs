import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const assets = new URL("../dist/assets/", import.meta.url);
let count = 0;
for (const name of readdirSync(assets)) {
  if (!/\.(js|css)$/.test(name)) continue;
  const source = new URL(name, assets);
  writeFileSync(`${fileURLToPath(source)}.gz`, gzipSync(readFileSync(source)));
  count++;
}
console.log(`Precompressed ${count} JS/CSS assets`);
