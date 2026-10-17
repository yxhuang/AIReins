import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeDefaultSettings, readClaudeEffectiveSettings, readClaudeStartupSettings, writeClaudeStartupSettings } from "./claude-settings.js";

const root = await mkdtemp(join(tmpdir(), "workbench-claude-settings-test-"));
const userHome = join(root, "home");
const layeredCwd = join(root, "layered");
const brokenCwd = join(root, "broken");
const unreadableCwd = join(root, "unreadable");
const missingCwd = join(root, "missing");
const unreadablePath = join(unreadableCwd, ".claude", "settings.local.json");

try {
  await Promise.all([
    mkdir(join(userHome, ".claude"), { recursive: true }),
    mkdir(join(layeredCwd, ".claude"), { recursive: true }),
    mkdir(join(brokenCwd, ".claude"), { recursive: true }),
    mkdir(join(unreadableCwd, ".claude"), { recursive: true }),
    mkdir(missingCwd, { recursive: true }),
  ]);
  await writeFile(
    join(userHome, ".claude", "settings.json"),
    JSON.stringify({ model: "opus", effortLevel: "high", remoteControlAtStartup: true }),
  );
  await writeFile(
    join(layeredCwd, ".claude", "settings.json"),
    JSON.stringify({ model: "sonnet" }),
  );
  await writeFile(
    join(layeredCwd, ".claude", "settings.local.json"),
    JSON.stringify({ effortLevel: "xhigh" }),
  );
  assert.deepEqual(readClaudeDefaultSettings(userHome), { model: "opus", effort: "high" }, "新建默认值仅取用户层，不受项目层覆盖");
  assert.deepEqual(readClaudeEffectiveSettings(layeredCwd, userHome), {
    model: "sonnet",
    effort: "xhigh",
    remoteControlAtStartup: true,
  });
  await writeFile(join(layeredCwd, ".claude", "settings.local.json"),
    JSON.stringify({ effortLevel: "xhigh", remoteControlAtStartup: false }));
  assert.equal(readClaudeEffectiveSettings(layeredCwd, userHome).remoteControlAtStartup, false);

  await writeFile(join(brokenCwd, ".claude", "settings.json"), "{ broken json");
  assert.deepEqual(readClaudeEffectiveSettings(brokenCwd, userHome), {
    model: "opus",
    effort: "high",
    remoteControlAtStartup: true,
  });

  await writeFile(
    unreadablePath,
    JSON.stringify({ model: "haiku", effortLevel: "low" }),
  );
  await chmod(unreadablePath, 0o000);
  assert.deepEqual(readClaudeEffectiveSettings(unreadableCwd, userHome), {
    model: "opus",
    effort: "high",
    remoteControlAtStartup: true,
  });
  await chmod(unreadablePath, 0o600);

  assert.deepEqual(readClaudeEffectiveSettings(missingCwd, join(root, "empty-home")), {
    model: null,
    effort: null,
    remoteControlAtStartup: false,
  });
  assert.deepEqual(readClaudeDefaultSettings(join(root, "empty-home")), { model: null, effort: null });

  const linkedHome = join(root, "linked-home");
  await mkdir(join(linkedHome, ".claude"), { recursive: true });
  const target = join(root, "managed-settings.json");
  const link = join(linkedHome, ".claude", "settings.json");
  const before = { model: "opus", remoteControlAtStartup: true, env: { KEEP: "yes" }, effortLevel: "high" };
  await writeFile(target, `${JSON.stringify(before, null, 2)}\n`);
  await symlink(target, link);
  const inode = (await lstat(link)).ino;
  assert.deepEqual(readClaudeDefaultSettings(linkedHome), { model: "opus", effort: "high" });
  assert.equal((await lstat(link)).ino, inode, "读取默认值保留设置软链接");
  assert.deepEqual(JSON.parse(await readFile(target, "utf8")), before, "读取默认值不写配置");
  assert.deepEqual(writeClaudeStartupSettings(false, linkedHome), { remoteControlAtStartup: false });
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal((await lstat(link)).ino, inode);
  assert.equal(await readlink(link), target);
  const saved = await readFile(target, "utf8");
  assert.equal(saved, `${JSON.stringify({ ...before, remoteControlAtStartup: false }, null, 2)}\n`);
  assert.deepEqual(Object.keys(JSON.parse(saved)), Object.keys(before));
  assert.deepEqual(writeClaudeStartupSettings(true, linkedHome), { remoteControlAtStartup: true });
  assert.deepEqual(readClaudeStartupSettings(linkedHome), { remoteControlAtStartup: true });
  await writeFile(target, "{ invalid");
  assert.deepEqual(readClaudeDefaultSettings(linkedHome), { model: null, effort: null }, "无效 JSON 不阻塞 meta");
  assert.throws(() => writeClaudeStartupSettings(false, linkedHome));
  assert.equal(await readFile(target, "utf8"), "{ invalid");
  for (const invalid of [[], null, "settings"]) {
    await writeFile(target, JSON.stringify(invalid));
    assert.deepEqual(readClaudeDefaultSettings(linkedHome), { model: null, effort: null });
  }
  await writeFile(target, JSON.stringify({ model: "  sonnet  ", effortLevel: " high ", env: { SECRET: "never exposed" } }));
  assert.deepEqual(readClaudeDefaultSettings(linkedHome), { model: "sonnet", effort: "high" });
  await writeFile(target, JSON.stringify({ model: 123, effortLevel: "   " }));
  assert.deepEqual(readClaudeDefaultSettings(linkedHome), { model: null, effort: null });
} finally {
  await chmod(unreadablePath, 0o600).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
}

console.log(JSON.stringify({
  layered: { model: "sonnet", effort: "xhigh" },
  brokenFallback: { model: "opus", effort: "high" },
  missing: { model: null, effort: null },
  cleaned: true,
}));
