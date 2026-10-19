import { readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** 当前 manifest 描述本次构建的静态/动态引用链；缺失或不完整时停止，不猜测可删文件。 */
export function pruneAssets(dist, now = Date.now()) {
  const manifest = JSON.parse(readFileSync(join(dist, ".vite/manifest.json"), "utf8"));
  const html = readFileSync(join(dist, "index.html"), "utf8");
  const assets = resolve(dist, "assets");
  const referenced = new Set();
  const visited = new Set();
  const add = (file) => {
    const name = relative(assets, resolve(dist, file));
    if (name && name !== ".." && !name.startsWith(`..${sep}`) && !name.startsWith(sep)) referenced.add(name);
  };
  const visit = (key) => {
    if (visited.has(key)) return;
    const chunk = manifest[key];
    if (!chunk || typeof chunk.file !== "string") throw new Error(`Missing manifest chunk: ${key}`);
    visited.add(key);
    add(chunk.file);
    for (const file of [...(chunk.css ?? []), ...(chunk.assets ?? [])]) add(file);
    for (const dependency of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) visit(dependency);
  };
  visit("index.html");
  // index.html 可直接引用资源（包括不进入 chunk 的链接）；同时保护伴生文件。
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)) {
    const url = new URL(match[1], "https://build.invalid/");
    if (url.origin === "https://build.invalid") add(decodeURIComponent(url.pathname).replace(/^\//, ""));
  }
  const files = new Map();
  const collect = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.isFile()) files.set(relative(assets, path), statSync(path));
    }
  };
  collect(assets);
  const baseName = (name) => name.replace(/(?:\.(?:gz|map))+$/, "");
  const deleted = [];
  for (const [name, info] of files) {
    const base = baseName(name);
    // 预压缩会刷新旧 .gz 的 mtime，伴生文件使用原资源的年龄。
    if (referenced.has(base) || referenced.has(name) || (files.get(base) ?? info).mtimeMs >= now - RETENTION_MS) continue;
    unlinkSync(join(assets, name));
    deleted.push(name);
  }
  return deleted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const deleted = pruneAssets(fileURLToPath(new URL("../dist/", import.meta.url)));
  console.log(`Pruned ${deleted.length} unreferenced assets older than 7 days`);
}
