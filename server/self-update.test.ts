import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyUpdate, defaultCommitMessage, runUpdateCommand, SelfUpdateError, updateStatus } from "./self-update.js";
import { DEFAULT_PREFS, savePrefs } from "./prefs.js";

// 夹具：裸远端 + 另一个推送用克隆 + 被更新的克隆（带 after-pull.sh，build 只落一个标记文件）。
const base = mkdtempSync(join(tmpdir(), "aireins-self-update-"));
writeFileSync(join(base, "gitconfig"), "[user]\n\tname = Fixture\n\temail = fixture@example.test\n");
Object.assign(process.env, { WORKBENCH_HOME: base, GIT_CONFIG_GLOBAL: join(base, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", LANG: "C", LC_ALL: "C" });
const remote = join(base, "remote.git"), other = join(base, "other"), repo = join(base, "repo");
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stdout + result.stderr + (result.error?.message ?? ""));
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
writeFileSync(join(other, "install.sh"), `#!/bin/bash
set -e
test "$1" = --update
printf '%s\\n' install >> install-runs
if test -f fail-install; then echo fixture-install-failed >&2; exit 7; fi
npm install --no-audit --no-fund > /dev/null
if test "\${AIREINS_FIXTURE_INSTALL_RECOVERY:-}" = 1; then echo fixture-recovery; else npm run build; fi
echo fixture-install-complete
`);
writeFileSync(join(other, ".gitignore"), "built\npackage-lock.json\ninstall-runs\nfail-install\n");
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
assert.equal(status.install, false, "普通前端更新只构建");
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

// 部署变化：预告并只运行安装器；失败后仓库已快进也能继续用按钮重试。
commit(other, "deploy/windows/launcher.cs", "tray deployment");
git(other, "push", "-q");
status = await updateStatus(repo);
assert.equal(status.install, true);
assert.equal(status.trayRestart, true);
writeFileSync(join(repo, "fail-install"), "fail\n");
await assert.rejects(applyUpdate(status, repo), error => error instanceof SelfUpdateError
  && /fixture-install-failed/.test(error.message));
assert.equal(git(repo, "rev-parse", "HEAD"), status.upstreamHead);
const beforeTrayUpdate = status.head;
const legacyKey = createHash("sha256").update(`${repo}\0main`).digest("hex");
const trayKey = createHash("sha256").update(`${repo}\0main\0${status.upstreamHead}`).digest("hex");
const trayStatePath = join(base, "updates", `${trayKey}.json`);
const legacyState = JSON.parse(readFileSync(trayStatePath, "utf8"));
delete legacyState.stage;
writeFileSync(join(base, "updates", `${legacyKey}.json`), JSON.stringify(legacyState));
rmSync(trayStatePath);
status = await updateStatus(repo);
assert.equal(status.action, "install", "旧版无 stage 的安装待办保持可重试");
assert.equal(status.install, true);
git(remote, "branch", "older", beforeTrayUpdate);
git(repo, "fetch", "-q");
git(repo, "switch", "-q", "-c", "older", "--track", "origin/older");
assert.equal((await updateStatus(repo)).action, "none", "其他分支不能消费 main 的待安装任务");
git(repo, "switch", "-q", "main");
status = await updateStatus(repo);
assert.equal(status.action, "install", "切回失败版本仍可重试安装");
rmSync(join(repo, "fail-install"));
result = await applyUpdate(status, repo);
assert.equal(result.installed, true);
assert.equal(result.trayRestart, true);
assert.match(result.output, /fixture-install-complete/);
assert.equal(readFileSync(join(repo, "install-runs"), "utf8").trim().split("\n").length, 2, "一次失败、一次重试，after-pull 不重复执行");
assert.equal((await updateStatus(repo)).action, "none");
rmSync(built);

// 普通 shared/frontend 构建失败：HEAD 已快进，待办按提交隔离，离线可直接重试构建。
const failingBuild = join(base, "fail-build");
writeFileSync(join(other, "package.json"), JSON.stringify({ scripts: { build: `node -e "if(require('fs').existsSync('${failingBuild}'))process.exit(1);require('fs').writeFileSync('built','')"` } }));
git(other, "commit", "-qam", "build failure fixture");
git(other, "push", "-q");
await applyUpdate(await updateStatus(repo), repo);
rmSync(built);
writeFileSync(failingBuild, "fail\n");
commit(other, "shared/value.ts", "shared build failure");
git(other, "push", "-q");
status = await updateStatus(repo);
assert.equal(status.install, false);
await rejects(applyUpdate(status, repo), 500);
assert.equal(git(repo, "rev-parse", "HEAD"), status.upstreamHead);
const failedHead = status.upstreamHead;
status = await updateStatus(repo);
assert.equal(status.action, "build", "普通构建失败不能显示为已最新");
assert.equal(status.install, false);
assert.equal(status.restart, true, "共享代码的重启要求在失败后保留");
const branchHeadKey = (head: string) => createHash("sha256").update(`${repo}\0main\0${head}`).digest("hex");
const pendingPath = join(base, "updates", `${branchHeadKey(failedHead)}.json`);
const pendingState = readFileSync(pendingPath, "utf8");
await rejects(applyUpdate(status, repo), 500);
assert.equal(readFileSync(pendingPath, "utf8"), pendingState, "重复失败保留同一待办");
git(repo, "switch", "-q", "older");
assert.equal((await updateStatus(repo)).action, "none", "其他分支不消费构建待办");
git(repo, "switch", "-q", "main");
commit(repo, "docs/later.md", "different target commit");
assert.equal((await updateStatus(repo)).action, "push", "相同分支的其他提交不消费旧待办");
assert.equal(readFileSync(pendingPath, "utf8"), pendingState);
commit(other, "docs/newer.md", "new remote during recovery");
git(other, "push", "-q");
assert.equal((await updateStatus(repo)).action, "diverged", "HEAD 不匹配时仍正常 fetch 发现新远端提交");
git(repo, "update-ref", "refs/heads/main", failedHead);
git(repo, "restore", "--source=HEAD", "--staged", "--worktree", ".");
git(repo, "remote", "set-url", "origin", join(base, "offline.git"));
status = await updateStatus(repo);
assert.equal(status.action, "build", "离线检查不 fetch");
git(repo, "update-ref", "ORIG_HEAD", failedHead);
rmSync(failingBuild);
result = await applyUpdate(status, repo);
assert.equal(result.action, "build");
assert.equal(result.restart, true);
assert.equal(result.installed, false);
assert.ok(existsSync(built), "重试直接构建，不依赖 ORIG_HEAD 的变化列表");
assert.equal(git(repo, "rev-parse", "HEAD"), failedHead, "重试不重复合并");
git(repo, "remote", "set-url", "origin", remote);
assert.equal((await updateStatus(repo)).action, "pull", "先完成当前待办，再处理新远端提交");
await applyUpdate(await updateStatus(repo), repo);
assert.equal((await updateStatus(repo)).action, "none");
rmSync(built);

// 仅前端失败也保留构建待办，成功后不要求重启后端。
writeFileSync(failingBuild, "fail\n");
commit(other, "frontend/app.ts", "frontend build failure");
git(other, "push", "-q");
await rejects(applyUpdate(await updateStatus(repo), repo), 500);
status = await updateStatus(repo);
assert.equal(status.action, "build");
assert.equal(status.restart, false);
rmSync(failingBuild);
result = await applyUpdate(status, repo);
assert.equal(result.restart, false);
assert.ok(existsSync(built));
assert.equal((await updateStatus(repo)).action, "none");
rmSync(built);

// 文档变动不安装、不构建。
commit(other, "docs/plain.md", "documentation only");
git(other, "push", "-q");
status = await updateStatus(repo);
assert.equal(status.install, false);
result = await applyUpdate(status, repo);
assert.equal(result.installed, false);
assert.equal(result.trayRestart, false);
assert.ok(!existsSync(built));

// 构建失败：已快进，但不能报成功。
writeFileSync(join(other, "package.json"), JSON.stringify({ scripts: { build: "node -e \"process.exit(1)\"" } }));
git(other, "add", "--", "package.json");
commit(other, "frontend/app.ts", "broken build");
git(other, "push", "-q");
status = await updateStatus(repo);
await rejects(applyUpdate(status, repo), 500);
assert.equal(git(repo, "rev-parse", "HEAD"), status.upstreamHead);
assert.equal((await updateStatus(repo)).action, "install", "依赖更新失败也可重试安装");
writeFileSync(join(other, "package.json"), JSON.stringify({ scripts: { build: "node -e \"require('fs').writeFileSync('built', '')\"" } }));
git(other, "commit", "-qam", "repair build");
git(other, "push", "-q");
// 先完成当前已拉代码的安装；修复夹具命令不改 Git 工作区，随后再正常拉取修复。
const retry = await updateStatus(repo);
assert.equal(retry.action, "install");
process.env.AIREINS_FIXTURE_INSTALL_RECOVERY = "1";
await applyUpdate(retry, repo);
delete process.env.AIREINS_FIXTURE_INSTALL_RECOVERY;
status = await updateStatus(repo);
assert.equal(status.action, "pull");
result = await applyUpdate(status, repo);
assert.equal(result.installed, true);
assert.equal(result.restart, true);

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

// Exercise the actual child environment; all network commands still use the local bare fixture.
const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
assert.ok(realGit);
const bin = join(base, "bin"), calls = join(base, "git-calls.jsonl");
mkdirSync(bin);
const proxyKeys = ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"];
const inherited = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
writeFileSync(join(bin, "git"), `#!/usr/bin/env node
const { appendFileSync, writeSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({args, env: Object.fromEntries(${JSON.stringify(proxyKeys)}.map(k => [k, process.env[k]]))}) + '\\n');
if (args[0] === 'push' && process.env.AIREINS_FIXTURE_PUSH_FAIL === '1') {
  writeSync(2, 'fixture push rejected'); process.exit(1);
}
const result = spawnSync(${JSON.stringify(realGit)}, args, {stdio: 'inherit'});
process.exit(result.status ?? 1);
`, { mode: 0o700 });
const originalPath = process.env.PATH;
process.env.PATH = `${bin}:${originalPath}`;
const recorded = () => readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line));
savePrefs(DEFAULT_PREFS);
await updateStatus(repo);
assert.deepEqual(recorded().find(call => call.args[0] === "fetch").env, JSON.parse(JSON.stringify(inherited)), "No preference preserves the inherited environment");
savePrefs({ ...DEFAULT_PREFS, codexProxyUrl: "http://localhost:18082", proxyUrl: "http://localhost:18083" });
await updateStatus(repo);
assert.ok(proxyKeys.every(key => recorded().filter(call => call.args[0] === "fetch").at(-1).env[key] === "http://localhost:18083"));
assert.deepEqual(recorded().filter(call => call.args[0] === "status").at(-1).env, JSON.parse(JSON.stringify(inherited)), "Local commands keep their original environment");
savePrefs({ ...DEFAULT_PREFS, proxyUrl: "http://localhost:18084" });
await updateStatus(repo);
assert.ok(proxyKeys.every(key => recorded().filter(call => call.args[0] === "fetch").at(-1).env[key] === "http://localhost:18084"), "Every check reads the current proxy preference");
assert.deepEqual(Object.fromEntries(proxyKeys.map(key => [key, process.env[key]])), inherited);

writeFileSync(join(repo, "retry.md"), "keep local commit\n");
status = await updateStatus(repo);
process.env.AIREINS_FIXTURE_PUSH_FAIL = "1";
await assert.rejects(applyUpdate(status, repo), error => error instanceof SelfUpdateError
  && /本地提交已保留/.test(error.message) && /fixture push rejected/.test(error.message));
const savedHead = git(repo, "rev-parse", "HEAD");
assert.notEqual(savedHead, status.head);
status = await updateStatus(repo);
assert.equal(status.ahead, 1);
assert.deepEqual(status.changes, []);
delete process.env.AIREINS_FIXTURE_PUSH_FAIL;
await applyUpdate(status, repo);
assert.equal(git(remote, "rev-parse", "main"), savedHead, "Retry pushes the saved commit without creating another one");
assert.ok(proxyKeys.every(key => recorded().filter(call => call.args[0] === "push").at(-1).env[key] === "http://localhost:18084"));
await assert.rejects(runUpdateCommand(repo, process.execPath, ["-e", "setTimeout(() => {}, 10000)"], 50),
  error => error instanceof SelfUpdateError && /执行超时（0.05 秒）/.test(error.message));
process.env.PATH = originalPath;

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
