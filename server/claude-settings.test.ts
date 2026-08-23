import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeEffectiveSettings } from "./claude-settings.js";

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
    JSON.stringify({ model: "opus", effortLevel: "high" }),
  );
  await writeFile(
    join(layeredCwd, ".claude", "settings.json"),
    JSON.stringify({ model: "sonnet" }),
  );
  await writeFile(
    join(layeredCwd, ".claude", "settings.local.json"),
    JSON.stringify({ effortLevel: "xhigh" }),
  );
  assert.deepEqual(readClaudeEffectiveSettings(layeredCwd, userHome), {
    model: "sonnet",
    effort: "xhigh",
  });

  await writeFile(join(brokenCwd, ".claude", "settings.json"), "{ broken json");
  assert.deepEqual(readClaudeEffectiveSettings(brokenCwd, userHome), {
    model: "opus",
    effort: "high",
  });

  await writeFile(
    unreadablePath,
    JSON.stringify({ model: "haiku", effortLevel: "low" }),
  );
  await chmod(unreadablePath, 0o000);
  assert.deepEqual(readClaudeEffectiveSettings(unreadableCwd, userHome), {
    model: "opus",
    effort: "high",
  });
  await chmod(unreadablePath, 0o600);

  assert.deepEqual(readClaudeEffectiveSettings(missingCwd, join(root, "empty-home")), {
    model: null,
    effort: null,
  });
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
