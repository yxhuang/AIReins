import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeOf } from "./worktree.js";

const fixture = await realpath(await mkdtemp(join(tmpdir(), "aireins-worktree-test-")));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, stdio: "ignore" });
try {
  const main = join(fixture, "main");
  await mkdir(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "commit", "-q", "--allow-empty", "-m", "init");
  git(main, "worktree", "add", "-q", "-b", "fix/sidebar", join(fixture, "wt"));
  git(main, "worktree", "add", "-q", "--detach", join(fixture, "detached"));
  await mkdir(join(fixture, "wt", "sub"));

  assert.equal(worktreeOf(main), undefined, "主仓库不算工作树");
  assert.equal(worktreeOf(fixture), undefined, "非仓库目录");
  assert.deepEqual(worktreeOf(join(fixture, "wt")), { root: main, branch: "fix/sidebar" });
  assert.deepEqual(worktreeOf(join(fixture, "wt", "sub")), { root: main, branch: "fix/sidebar" }, "子目录上溯");
  assert.deepEqual(worktreeOf(join(fixture, "detached")), { root: main }, "分离 HEAD 不带分支");
  console.log("worktree tests passed");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
