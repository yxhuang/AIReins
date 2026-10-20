import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
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
  await symlink(join(fixture, "wt", "sub"), join(fixture, "alias"));
  assert.deepEqual(worktreeOf(join(fixture, "alias")), { root: main, branch: "fix/sidebar" }, "软链 cwd 按真实路径上溯");

  const fifo = join(fixture, "fifo");
  await mkdir(fifo);
  execFileSync("mkfifo", [join(fifo, ".git")]);
  assert.equal(worktreeOf(fifo), undefined, "特殊文件 .git 不读取，避免阻塞");
  const loop = join(fixture, "loop");
  await mkdir(loop);
  await symlink(join(loop, ".git"), join(loop, ".git"));
  assert.equal(worktreeOf(loop), undefined, "循环链接不抛异常");

  const separate = join(fixture, "separate");
  execFileSync("git", ["init", "-q", "--separate-git-dir", join(fixture, "meta"), separate]);
  git(separate, "commit", "-q", "--allow-empty", "-m", "init");
  git(separate, "worktree", "add", "-q", join(fixture, "separate-wt"));
  assert.equal(worktreeOf(join(fixture, "separate-wt")), undefined, "独立元数据目录推不出主工作区");
  console.log("worktree tests passed");
} finally {
  await rm(fixture, { recursive: true, force: true });
}
