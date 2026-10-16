import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "wb-links-"));
process.env.WORKBENCH_HOME = root;
const { readLauncherLinks, readLinks, scanPages } = await import("./pages.js");
await mkdir(join(root, "pages", "local"), { recursive: true });
await writeFile(join(root, "pages", "local", "manifest.json"), JSON.stringify({ id: "local", name: "Local", icon: "📊", type: "iframe", url: "https://example.com" }));
await writeFile(join(root, "pages", "links.json"), JSON.stringify({ links: [{ name: "Local", url: "https://example.com" }] }));
assert.deepEqual(scanPages().map(page => page.id), ["local"], "缺省从 WORKBENCH_HOME/pages 扫描");
assert.equal(readLinks()[0]?.name, "Local", "直达与扩展页共用用户目录");
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

const repo = await mkdtemp(join(tmpdir(), "wb-links-repo-"));
const local = await mkdtemp(join(tmpdir(), "wb-links-local-"));
assert.deepEqual(readLauncherLinks(repo, local), [], "两处都缺失时为空");
await writeFile(join(repo, "links.json"), JSON.stringify({ links: [
  { name: "共享A", url: "https://a.example" }, { name: "共享B", url: "https://b.example", group: "参考" },
] }));
assert.deepEqual(readLauncherLinks(repo, local).map((link) => link.name), ["共享A", "共享B"], "本机缺失时用仓库菜单");
await writeFile(join(local, "links.json"), JSON.stringify({ links: [
  { name: "本机B", url: "https://b.example", icon: "🔥" }, { name: "本机C", url: "https://c.example" },
] }));
assert.deepEqual(readLauncherLinks(repo, local).map((link) => link.name), ["共享A", "本机B", "本机C"], "同 URL 本机覆盖原位，其余追加");
await writeFile(join(repo, "links.json"), "{bad JSON");
assert.deepEqual(readLauncherLinks(repo, local).map((link) => link.name), ["本机B", "本机C"], "仓库菜单损坏不影响本机条目");

console.log("✅ links 配置容错、scheme 校验和实时读取全过");
