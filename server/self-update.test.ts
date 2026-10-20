import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUpdate, defaultCommitMessage, SelfUpdateError, updateStatus } from "./self-update.js";

// 夹具：裸远端 + 另一个推送用克隆 + 被更新的克隆（带 after-pull.sh，build 只落一个标记文件）。
const base = mkdtempSync(join(tmpdir(), "aireins-self-update-"));
writeFileSync(join(base, "gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.test\n");
Object.assign(process.env, { GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", LANG: "C", LC_ALL: "C" });
const remote = join(base, "remote.git"), other = join(base, "other"), repo = join(base, "repo");
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result.stdout.trim();
};
const commit = (cwd: string, path: string, message: string) => {
  mkdirSync(join(cwd, path, ".."), { recursive: true });
  writeFileSync(join(cwd, path), `${message}\n`);
  git(cwd, "add", "--", path);
  git(cwd, "commit", "-qm", message);
};
const rejects = async (promise: Promise<unknown>, status: number) => {
  await assert.rejects(promise, (error) => error instanceof SelfUpdateError && error.status === status);
};

git(base, "init", "-q", "--bare", "-b", "main", remote);
git(base, "clone", "-q", remote, other);
writeFileSync(join(other, "package.json"), JSON.stringify({ scripts: { build: "node -e \"require('fs').writeFileSync('built', '')\"" } }));
mkdirSync(join(other, "scripts/git-hooks"), { recursive: true });
copyFileSync(new URL("../scripts/git-hooks/after-pull.sh", import.meta.url), join(other, "scripts/git-hooks/after-pull.sh"));
writeFileSync(join(other, ".gitignore"), "built\npackage-lock.json\n");
git(other, "add", "-A");
git(other, "commit", "-qm", "baseline");
git(other, "push", "-q", "-u", "origin", "main");
git(base, "clone", "-q", remote, repo);
const built = join(repo, "built");

let status = await updateStatus(repo);
assert.equal(status.action, "none");
assert.equal(status.upstream, "origin/main");

// 远端有前端提交：拉取并构建，不需重启。
commit(other, "frontend/app.ts", "frontend change");
git(other, "push", "-q");
status = await updateStatus(repo);
assert.equal(status.action, "pull");
assert.equal(status.behind, 1);
assert.match(status.behindLog[0], /frontend change/);
await rejects(applyUpdate({ ...status, head: "0".repeat(40) }, repo), 409);
await rejects(applyUpdate({ ...status, branch: "other" }, repo), 409);
let result = await applyUpdate({ ...status, lang: "en" }, repo);
assert.equal(result.restart, false);
assert.match(result.output, /Frontend built/);
assert.ok(existsSync(built));
assert.equal(git(repo, "rev-parse", "HEAD"), status.upstreamHead);
rmSync(built);

// 后端提交：标记需要重启，不构建。
commit(other, "server/index.ts", "backend change");
git(other, "push", "-q");
status = await updateStatus(repo);
result = await applyUpdate(status, repo);
assert.equal(result.restart, true);
assert.ok(!existsSync(built));

// 构建失败：已快进，但不能报成功。
writeFileSync(join(other, "package.json"), JSON.stringify({ scripts: { build: "node -e \"process.exit(1)\"" } }));
git(other, "add", "--", "package.json");
commit(other, "frontend/app.ts", "broken build");
git(other, "push", "-q");
status = await updateStatus(repo);
await rejects(applyUpdate(status, repo), 500);
assert.equal(git(repo, "rev-parse", "HEAD"), status.upstreamHead);

// 本地未提交改动：要求提交说明，提交后推送；弹窗之后又出现的改动不能被顺带提交。
writeFileSync(join(repo, "notes.md"), "local\n");
status = await updateStatus(repo);
assert.equal(status.action, "push");
assert.deepEqual(status.changes, ["?? notes.md"]);
assert.equal(status.defaultMessage, "chore: update notes.md");
assert.equal(defaultCommitMessage([" M a/x", "?? b/y", "R  c -> d/z", ' M "e f/g"', "?? h/i"]), "chore: update a, b, d and 2 more");
writeFileSync(join(repo, "late.md"), "late\n");
await rejects(applyUpdate({ ...status, message: "" }, repo), 409);
rmSync(join(repo, "late.md"));
result = await applyUpdate({ ...status, message: "" }, repo);
assert.equal(result.action, "push");
assert.equal(git(remote, "log", "-1", "--format=%s", "main"), "chore: update notes.md");
assert.equal((await updateStatus(repo)).action, "none");

// 两边都有新提交：只报告分叉，不执行。
commit(other, "docs/a.md", "remote side");
git(other, "pull", "-q", "--rebase");
git(other, "push", "-q");
commit(repo, "docs/b.md", "local side");
status = await updateStatus(repo);
assert.equal(status.action, "diverged");
await rejects(applyUpdate({ ...status, action: "pull" }, repo), 409);

await rejects(applyUpdate({ action: "pull" }, repo), 400);
git(repo, "checkout", "-q", "--detach");
await rejects(updateStatus(repo), 409);

rmSync(base, { recursive: true, force: true });
console.log("✅ self-update");
