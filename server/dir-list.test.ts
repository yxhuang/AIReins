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
  assert.equal((await listDirectories()).path, fixture);
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
}

console.log("dir-list: 过滤、排序、符号链接、parent、缺省及错误路径通过");
