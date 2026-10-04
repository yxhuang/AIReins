import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

const fixture = await mkdtemp(join(tmpdir(), "workbench-uploads-test-"));
process.env.WORKBENCH_HOME = join(fixture, "workbench");

const {
  IMAGE_MENTION_MIME_TYPES,
  mimeTypeForName,
  resolveUploadFile,
  sanitizeUploadName,
  saveUpload,
  uploadTimestamp,
  uploadsRoot,
  UploadError,
} = await import("./uploads.js");

try {
  // sanitizeUploadName：basename、控制字符/分隔符、限长、空名回退
  assert.equal(sanitizeUploadName("photo.png"), "photo.png");
  assert.equal(sanitizeUploadName("/tmp/evil/photo.png"), "photo.png");
  assert.equal(sanitizeUploadName("..\\..\\etc\\passwd"), "passwd");
  assert.equal(sanitizeUploadName("a/b/c.txt"), "c.txt");
  assert.equal(sanitizeUploadName("weird\u0007name.png"), "weird_name.png");
  assert.equal(sanitizeUploadName("..."), "file");
  assert.equal(sanitizeUploadName(""), "file");
  assert.equal(sanitizeUploadName("  a.txt  "), "a.txt");
  const longName = `${"长".repeat(200)}.png`;
  const cleaned = sanitizeUploadName(longName);
  assert.ok(cleaned.length <= 120 && cleaned.endsWith(".png"), "超长文件名限长并保留扩展名");
  const inName = sanitizeUploadName("line\nbreak\tname.png");
  assert.ok(!/[\n\t]/.test(inName), "控制字符被替换");

  // mimeTypeForName
  assert.equal(mimeTypeForName("a.png"), "image/png");
  assert.equal(mimeTypeForName("a.JPG"), "image/jpeg");
  assert.equal(mimeTypeForName("a.jpeg"), "image/jpeg");
  assert.equal(mimeTypeForName("a.webp"), "image/webp");
  assert.equal(mimeTypeForName("a.heic"), "image/heic");
  assert.equal(mimeTypeForName("a.bin"), "application/octet-stream");
  assert.equal(mimeTypeForName("noext"), "application/octet-stream");
  assert.ok(IMAGE_MENTION_MIME_TYPES.has("image/png") && IMAGE_MENTION_MIME_TYPES.has("image/webp"));
  assert.ok(!IMAGE_MENTION_MIME_TYPES.has("image/heic"), "HEIC 不在可直发的 image mention 集合内");

  // uploadTimestamp 形状
  assert.match(uploadTimestamp(new Date(2026, 8, 30, 9, 5, 3)), /^20260930-090503$/);

  // saveUpload 正常路径
  const payload = Buffer.from("hello upload 世界");
  const saved = await saveUpload("sess-1", "../../etc/photo.PNG", Readable.from([payload]));
  assert.equal(saved.name, "photo.PNG");
  assert.equal(saved.size, payload.length);
  assert.equal(saved.mimeType, "image/png");
  assert.ok(saved.path.startsWith(join(uploadsRoot(), "sess-1")), "落盘在会话目录下");
  assert.match(saved.path, /\/\d{8}-\d{6}-photo\.PNG$/);

  // 同秒同名冲突追加序号
  const again = await saveUpload("sess-1", "photo.PNG", Readable.from([payload]));
  assert.notEqual(again.path, saved.path);
  assert.match(again.path, /-\d+-photo\.PNG$/);

  // Concurrent same-name requests must reserve distinct paths before asynchronous writes.
  const contents = Array.from({ length: 8 }, (_, n) => Buffer.alloc(1024, 65 + n));
  const concurrent = await Promise.all(contents.map(content => saveUpload("sess-concurrent", "same.txt", Readable.from([content]))));
  assert.equal(new Set(concurrent.map(item => item.path)).size, contents.length);
  for (const [n, item] of concurrent.entries()) assert.deepEqual(await readFile(item.path), contents[n]);

  // A failed request must remove only its own reserved file, never its concurrent sibling.
  const aborted = new Readable({ read() { this.push(Buffer.from("partial")); this.destroy(new Error("input aborted")); } });
  const [bad, good] = await Promise.allSettled([
    saveUpload("sess-aborted", "same.txt", aborted),
    saveUpload("sess-aborted", "same.txt", Readable.from([payload])),
  ]);
  assert.equal(bad.status, "rejected");
  assert.equal(good.status, "fulfilled");
  if (good.status === "fulfilled") {
    assert.deepEqual(await readFile(good.value.path), payload);
    const { readdir } = await import("node:fs/promises");
    assert.equal((await readdir(join(uploadsRoot(), "sess-aborted"))).length, 1);
  }

  // 超限 413 且不留半截文件
  const dir = join(uploadsRoot(), "sess-big");
  const big = Buffer.alloc(1024 * 1024, 0x61);
  const chunks = Array.from({ length: 26 }, () => big);
  await assert.rejects(
    saveUpload("sess-big", "big.bin", Readable.from(chunks)),
    (error: unknown) => error instanceof UploadError && error.status === 413,
  );
  const { readdir } = await import("node:fs/promises");
  const leftover = existsSync(dir) ? await readdir(dir) : [];
  assert.deepEqual(leftover, [], "413 后不留半截文件");

  // resolveUploadFile：正常、越界、..、符号链接逃逸
  const ok = await resolveUploadFile(saved.path);
  assert.equal(ok?.path, saved.path);
  assert.equal(ok?.mimeType, "image/png");
  assert.equal(await resolveUploadFile(join(uploadsRoot(), "..", "sessions.json")), null, ".. 逃逸被拒绝");
  assert.equal(await resolveUploadFile("/etc/passwd"), null, "uploads 之外的路径被拒绝");
  assert.equal(await resolveUploadFile(join(uploadsRoot(), "sess-1", "missing.png")), null, "不存在返回 null");
  await mkdir(join(uploadsRoot(), "sess-2"), { recursive: true });
  const outside = join(fixture, "outside.png");
  await writeFile(outside, payload);
  await symlink(outside, join(uploadsRoot(), "sess-2", "escape.png"));
  assert.equal(await resolveUploadFile(join(uploadsRoot(), "sess-2", "escape.png")), null, "符号链接逃逸被拒绝");
  await symlink(join(uploadsRoot(), "sess-1"), join(uploadsRoot(), "sess-3"));
  const viaInnerSymlink = await resolveUploadFile(join(uploadsRoot(), "sess-3", saved.path.split("/").pop()!));
  assert.ok(viaInnerSymlink?.path === saved.path, "指向 uploads 内部的符号链接允许");

  console.log("✅ uploads 单元测试全过");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
