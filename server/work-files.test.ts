import assert from "node:assert/strict";
import promises, { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getWorkFile, saveWorkFile, getWorkContent, normalizeWorkPath, WorkFileError, TEXT_LIMIT, MEDIA_LIMIT } from "./work-files.js";

const root = await mkdtemp(join(tmpdir(), "workbench-work-files-"));
const options = { sessionCwd: root };
const input = (name: string) => ({ path: join(root, name), root });
const fails = (status: number) => (error: unknown) => error instanceof WorkFileError && error.status === status;

for (const [name, kind, contents] of [
  ["a.txt", "text", "你好"], ["a.md", "markdown", "# title"], ["a.csv", "csv", '"a,b",c\n'],
  ["a.tsv", "tsv", "a\tb"], ["a.html", "html", "<script>alert(1)</script>"],
  ["a.png", "image", Buffer.from([137, 80, 78, 71])], ["a.pdf", "pdf", "%PDF-1.7"],
] as const) {
  await writeFile(input(name).path, contents);
  const file = await getWorkFile(input(name), options);
  assert.equal(file.kind, kind);
  assert.equal(file.editable, !["image", "pdf"].includes(kind));
  if (file.editable) assert.equal(file.text, contents);
}
await assert.rejects(getWorkFile(input("a.txt")), fails(403), "客户端 root 不是授权");
await assert.rejects(getWorkFile({ path: `${root}/../etc/passwd`, root }, options), fails(400));
await assert.rejects(getWorkFile({ path: "/etc/passwd", root }, options), fails(403));
await assert.rejects(getWorkFile({ path: root, root }, options), fails(400));
assert.equal(spawnSync("mkfifo", [input("pipe").path]).status, 0);
await assert.rejects(getWorkFile(input("pipe"), options), fails(400), "FIFO打开不阻塞且不能预览");
assert.equal(normalizeWorkPath("C:\\Users\\中文 文件.txt"), "/mnt/c/Users/中文 文件.txt");
for (const bad of ["relative", "/tmp/a\0b", "C:\\a\\..\\b", "/tmp/a/../b"]) {
  assert.throws(() => normalizeWorkPath(bad), fails(400));
}
await symlink("/etc/passwd", input("escape.txt").path);
await assert.rejects(getWorkFile(input("escape.txt"), options), fails(403));
await symlink(root, join(root, "inside-root"));
assert.equal((await getWorkFile({ path: join(root, "inside-root", "a.txt"), root: join(root, "inside-root") }, options)).text, "你好");
await symlink("/etc", join(root, "escaped-root"));
await assert.rejects(getWorkFile({ path: join(root, "escaped-root", "passwd"), root: join(root, "escaped-root") }, options), fails(403));
for (const [name, bytes, reason] of [
  ["binary.txt", Buffer.from([0, 1, 2]), /二进制/],
  ["latin.txt", Buffer.from([0xff, 0xfe]), /UTF-8/],
  ["office.docx", Buffer.from("valid text"), /Office/],
  ["big.txt", Buffer.alloc(TEXT_LIMIT + 1, 97), /1 MiB/],
  ["big.pdf", Buffer.alloc(MEDIA_LIMIT + 1), /32 MiB/],
] as const) {
  await writeFile(input(name).path, bytes);
  const file = await getWorkFile(input(name), options);
  assert.equal(file.kind, "unsupported");
  assert.equal(file.text, undefined);
  assert.match(file.reason!, reason);
}
await assert.rejects(getWorkContent(input("big.pdf"), options), fails(413));
await writeFile(input("no-extension").path, "plain");
assert.equal((await getWorkFile(input("no-extension"), options)).kind, "text");
await writeFile(input("bom.txt").path, Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from("初版")]));
const bom = await getWorkFile(input("bom.txt"), options);
assert.equal(bom.text, "\ufeff初版");
const saved = await saveWorkFile({ ...input("bom.txt"), version: bom.version!, text: "\ufeff新版" }, options);
assert.deepEqual(await readFile(input("bom.txt").path), Buffer.from("\ufeff新版"));
assert.notEqual(saved.version, bom.version);
await assert.rejects(saveWorkFile({ ...input("bom.txt"), version: bom.version!, text: "stale" }, options), fails(409));
await writeFile(input("bom.txt").path, "agent update");
await assert.rejects(saveWorkFile({ ...input("bom.txt"), version: saved.version!, text: "overwrite" }, options), fails(409));
await chmod(input("a.txt").path, 0o640);
await symlink(input("a.txt").path, input("link.txt").path);
const link = await getWorkFile(input("link.txt"), options);
await saveWorkFile({ ...input("link.txt"), version: link.version!, text: "through link" }, options);
assert.equal((await lstat(input("link.txt").path)).isSymbolicLink(), true);
assert.equal((await lstat(input("a.txt").path)).mode & 0o777, 0o640);
assert.equal(await readFile(input("a.txt").path, "utf8"), "through link");
const concurrent = await getWorkFile(input("a.txt"), options);
const results = await Promise.allSettled(["first", "second"].map(text => saveWorkFile({ ...input("a.txt"), version: concurrent.version!, text }, options)));
assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
assert.equal(results.filter(result => result.status === "rejected" && fails(409)(result.reason)).length, 1);
const current = await getWorkFile(input("a.txt"), options);
for (const text of ["bad\0text", "x".repeat(TEXT_LIMIT + 1), "\ud800"]) {
  await assert.rejects(saveWorkFile({ ...input("a.txt"), version: current.version!, text }, options));
  assert.equal(await readFile(input("a.txt").path, "utf8"), current.text, "保存失败保持原件");
}
await mkdir(join(root, "locked"));
await writeFile(join(root, "locked", "a.txt"), "original");
const lockedInput = { path: join(root, "locked", "a.txt"), root };
const locked = await getWorkFile(lockedInput, options);
await chmod(join(root, "locked"), 0o500);
try {
  await assert.rejects(saveWorkFile({ ...lockedInput, version: locked.version!, text: "failure" }, options));
  assert.equal(await readFile(lockedInput.path, "utf8"), "original");
} finally { await chmod(join(root, "locked"), 0o700); }
assert.ok(!(await readdir(root)).some(name => name.startsWith(".workbench-save-")));
const rename = promises.rename;
promises.rename = async () => { throw Object.assign(new Error("injected rename failure"), { code: "EIO" }); };
syncBuiltinESMExports();
try {
  await assert.rejects(saveWorkFile({ ...input("a.txt"), version: current.version!, text: "rename failure" }, options), /injected rename failure/);
} finally { promises.rename = rename; syncBuiltinESMExports(); }
assert.equal(await readFile(input("a.txt").path, "utf8"), current.text);
assert.ok(!(await readdir(root)).some(name => name.startsWith(".workbench-save-")), "rename失败清理本次临时文件");
const probe = await open(input("a.txt").path, "r");
const prototype = Object.getPrototypeOf(probe);
const sync = prototype.sync;
prototype.sync = async () => { throw new Error("injected fsync failure"); };
try {
  await assert.rejects(saveWorkFile({ ...input("a.txt"), version: current.version!, text: "fsync failure" }, options), /injected fsync failure/);
} finally { prototype.sync = sync; await probe.close(); }
assert.equal(await readFile(input("a.txt").path, "utf8"), current.text);
assert.ok(!(await readdir(root)).some(name => name.startsWith(".workbench-save-")), "fsync失败清理本次临时文件");
console.log("work-files: formats, authorization, symlinks, UTF-8, limits, atomic writes and conflicts passed");
