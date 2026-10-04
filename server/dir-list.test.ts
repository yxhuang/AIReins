import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirListError, listDirectories } from "./dir-list.js";

const fixture = await mkdtemp(join(tmpdir(), "workbench-dir-list-test-"));
await mkdir(join(fixture, "zeta"));
await mkdir(join(fixture, "alpha"));
await mkdir(join(fixture, ".hidden"));
await writeFile(join(fixture, "file.txt"), "file");
await symlink(join(fixture, "alpha"), join(fixture, "link-to-alpha"));
await symlink(join(fixture, "missing"), join(fixture, "broken-link"));

const listing = await listDirectories(join(fixture, ".", "alpha", ".."));
assert.equal(listing.path, fixture);
assert.equal(listing.parent, tmpdir());
assert.deepEqual(listing.dirs, ["alpha", "link-to-alpha", "zeta"].map((name) => ({
  name,
  path: join(fixture, name),
})));
assert.equal(listing.truncated, false);
assert.equal((await listDirectories("/")).parent, null);
assert.equal((await listDirectories(join(fixture, "link-to-alpha"))).path, join(fixture, "link-to-alpha"));

for (const path of ["relative", "", join(fixture, "missing"), join(fixture, "file.txt")]) {
  await assert.rejects(listDirectories(path), DirListError);
}

const previousHome = process.env.HOME;
try {
  process.env.HOME = fixture;
  assert.equal((await listDirectories()).path, fixture, "没有 dev 时缺省 $HOME");
  await mkdir(join(fixture, "dev"));
  assert.equal((await listDirectories()).path, join(fixture, "dev"), "有 dev 时缺省 ~/dev");
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
}

// Exact limits must distinguish complete output from an omitted eligible entry.
const limited = join(fixture, "limited");
await mkdir(limited);
await Promise.all(Array.from({ length: 1000 }, (_, n) => mkdir(join(limited, `dir-${String(n).padStart(4, "0")}`))));
await writeFile(join(limited, "zzz-not-a-directory.txt"), "");
assert.equal((await listDirectories(limited)).truncated, false, "恰好1000个目录且尾部仅不合格文件，仍完整");
await mkdir(join(limited, "dir-overflow"));
const overflow = await listDirectories(limited);
assert.equal(overflow.dirs.length, 1000);
assert.equal(overflow.truncated, true, "第1001个合格目录必须标截断");
await Promise.all(Array.from({ length: 1000 }, (_, n) => writeFile(join(limited, `file-${String(n).padStart(4, "0")}`), "")));
const mixed = await listDirectories(limited, { files: true });
assert.equal(mixed.dirs.length, 1000);
assert.equal(mixed.files?.length, 1000, "目录超限仍需收齐文件");
assert.equal(mixed.truncated, true);
const fileLimited = join(fixture, "file-limited");
await mkdir(fileLimited);
await Promise.all(Array.from({ length: 1000 }, (_, n) => writeFile(join(fileLimited, `${n}.txt`), "")));
assert.equal((await listDirectories(fileLimited, { files: true })).truncated, false);
await writeFile(join(fileLimited, "overflow.txt"), "");
assert.equal((await listDirectories(fileLimited, { files: true })).truncated, true);

console.log("dir-list: 过滤、排序、符号链接、parent、缺省及错误路径通过");
