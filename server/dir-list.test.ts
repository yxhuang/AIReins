import assert from "node:assert/strict";
import { mkdir, mkdtemp, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DirListError, gitStatus, listDirectories } from "./dir-list.js";

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

const modified = new Date("2026-10-04T12:00:00Z");
await utimes(join(fixture, "file.txt"), modified, modified);
await symlink(join(fixture, "file.txt"), join(fixture, "linked-file.txt"));
const details = await listDirectories(fixture, { files: true });
for (const file of details.files ?? []) {
  assert.equal(file.size, 4, "普通文件及内部链接的大小来自 stat");
  assert.equal(file.modifiedAt, modified.getTime(), "修改时间使用 Unix 毫秒");
}
assert.equal(details.files?.length, 2);
for (const dir of details.dirs) {
  assert.equal(dir.size, null, "不把目录 inode 大小当成目录内容大小");
  assert.equal(dir.modifiedAt, (await stat(dir.path)).mtimeMs);
}
assert.ok(!("modifiedAt" in (await listDirectories(fixture)).dirs[0]!), "目录选择模式不额外读取元数据");

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

const repo = await mkdtemp(join(tmpdir(), "workbench-dir-list-git-"));
const gitIn = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
gitIn("init", "-q");
await mkdir(join(repo, "子 目录", "deep"), { recursive: true });
await writeFile(join(repo, "clean.txt"), "c");
await writeFile(join(repo, "edit.txt"), "e");
await writeFile(join(repo, "子 目录", "a.txt"), "a");
await writeFile(join(repo, "子 目录", "deep", "old.txt"), "o");
gitIn("add", ".");
gitIn("commit", "-qm", "init");
await writeFile(join(repo, "edit.txt"), "changed");
await writeFile(join(repo, "子 目录", "new.txt"), "n");
await mkdir(join(repo, "子 目录", "fresh"));
await writeFile(join(repo, "子 目录", "fresh", "f.txt"), "f");
gitIn("mv", "子 目录/deep/old.txt", "子 目录/deep/renamed.txt");
assert.deepEqual(await gitStatus(repo), { "edit.txt": "M", "子 目录": "R" }, "根目录：文件取自身状态，文件夹取子项最高状态");
assert.deepEqual(await gitStatus(join(repo, "子 目录")), { "new.txt": "U", fresh: "U", deep: "R" }, "子目录按仓库前缀截成直接子项");
assert.deepEqual((await listDirectories(repo, { files: true })).git, { "edit.txt": "M", "子 目录": "R" });
assert.equal((await listDirectories(repo)).git, undefined, "目录选择模式不跑 git");
assert.equal(await gitStatus(fixture), undefined, "非 Git 目录不返回状态");
const parent = await mkdtemp(join(tmpdir(), "workbench-dir-list-repos-"));
await mkdir(join(parent, "plain"));
execFileSync("git", ["init", "-q", join(parent, "clean-repo")]);
execFileSync("cp", ["-r", repo, join(parent, "dirty-repo")]);
assert.deepEqual((await listDirectories(parent, { files: true })).git, { "dirty-repo": "M" }, "非仓库目录里，子仓库按整仓最高状态亮点，干净仓库与普通文件夹不标");
assert.equal((await listDirectories(fixture, { files: true })).git, undefined, "没有子仓库时不返回 git");

console.log("dir-list: 过滤、排序、符号链接、parent、缺省、错误路径及 Git 状态通过");
