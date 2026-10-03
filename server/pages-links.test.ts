import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLinks, scanPages } from "./pages.js";

const root = await mkdtemp(join(tmpdir(), "wb-links-"));
await mkdir(join(root, "ok"));
await writeFile(join(root, "ok", "manifest.json"), JSON.stringify({ id: "ok", name: "OK", icon: "📊", type: "iframe", url: "https://example.com" }));
assert.deepEqual(readLinks(root), [], "配置缺失时为空");
await writeFile(join(root, "links.json"), "{bad JSON");
assert.deepEqual(readLinks(root), [], "坏 JSON 不抛错");
await writeFile(join(root, "links.json"), JSON.stringify({ links: [
  { name: "网页", url: "https://x.com/thsottiaux?lang=en", icon: "𝕏", group: "关注" },
  { name: "编辑器", url: "vscode://file/home/project" },
  { name: "笔记", url: "obsidian://open?vault=work" },
  null, [], { name: "", url: "https://example.com" },
  { name: "bad", url: "javascript:alert(1)" }, { name: "bad", url: "DATA:text/html,test" },
  { name: "bad", url: "java\nscript:alert(1)" }, { name: "bad", url: "/relative" },
  { name: "bad", url: "https://example.com", icon: 1 }, { name: "bad", url: "https://example.com", group: [] },
] }));
assert.deepEqual(readLinks(root).map((link) => link.name), ["网页", "编辑器", "笔记"], "保留合法条目及 scheme，跳过坏字段");
assert.deepEqual(scanPages(root).map((p) => p.id), ["ok"], "根目录 links.json 不参与页面扫描");
await writeFile(join(root, "links.json"), JSON.stringify({ links: [{ name: "更新", url: "https://example.com" }] }));
assert.equal(readLinks(root)[0]?.name, "更新", "再次读取立即看到改动");
for (const input of [null, [], {}, { links: {} }]) {
  await writeFile(join(root, "links.json"), JSON.stringify(input));
  assert.deepEqual(readLinks(root), [], "非法顶层返回空列表");
}

console.log("✅ links 配置容错、scheme 校验和实时读取全过");
