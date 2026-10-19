import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeFileQuery, searchFiles } from "./file-search.js";

let rg: string;
try {
  rg = execFileSync("/bin/sh", ["-c", "command -v rg"], { encoding: "utf8" }).trim();
} catch (error) {
  if (![1, 127].includes((error as { status: number }).status)) throw error;
  console.log("SKIP file-search: rg (ripgrep) 未安装；请安装 ripgrep 后重跑。");
  process.exit(0);
}

const root = await mkdtemp(join(tmpdir(), "workbench-file-search-"));
const project = join(root, "project");
const bin = join(root, "bin");
const release = join(root, "release");
await Promise.all([mkdir(project), mkdir(bin), mkdir(join(release, "bin"), { recursive: true }), mkdir(join(release, "codex-path"), { recursive: true })]);
await writeFile(join(project, "README.md"), "readme");
await writeFile(join(project, "报告.txt"), "report");
await writeFile(join(project, ".gitignore"), "ignored.txt\n");
await writeFile(join(project, "ignored.txt"), "ignored");
await mkdir(join(project, "node_modules"));
await writeFile(join(project, "node_modules", "skip.txt"), "skip");
await symlink("/etc/passwd", join(project, "outside.txt"));
// Simulate AIReins's PATH: Git/Codex available, rg only bundled with Codex.
await symlink("/usr/bin/git", join(bin, "git"));
await writeFile(join(release, "bin", "codex"), "", { mode: 0o755 });
await symlink(join(release, "bin", "codex"), join(bin, "codex"));
await symlink(rg, join(release, "codex-path", "rg"));
const originalPath = process.env.PATH;
try {
  process.env.PATH = bin;
  assert.deepEqual(await searchFiles(project, "", 20), [".gitignore", "README.md", "ignored.txt", "报告.txt"]);
  assert.deepEqual(await searchFiles(project, "readme", 20), ["README.md"]);
  assert.deepEqual(await searchFiles(project, "报告", 20), ["报告.txt"]);
  assert.equal((await searchFiles(project, "", 1)).length, 1);
  execFileSync("/usr/bin/git", ["init", "--quiet", project]);
  const now = Date.now;
  Date.now = () => now() + 3_000;
  try { assert.deepEqual(await searchFiles(project, "", 20), [".gitignore", "README.md", "报告.txt"]); }
  finally { Date.now = now; }
  process.env.PATH = root;
  await assert.rejects(searchFiles(project, "", 20), /Git 文件枚举失败/);
} finally {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
}
assert.equal(normalizeFileQuery(project, "./README.md"), "README.md");
assert.throws(() => normalizeFileQuery(project, "../outside"));
console.log("file-search: Codex bundled rg fallback, matching, limits, ignores and symlink boundaries passed");
