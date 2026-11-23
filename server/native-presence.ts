import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { kimiHistoryRoot } from "./history.js";
import type { AgentKind, SessionRecord } from "./types.js";

const MAX_ENTRIES = 50_000;

/** Absence is usable only after a complete scan of the same native store. */
export async function scanNativePresence(agent: AgentKind, sessions: readonly SessionRecord[]) {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const brain = process.env.WORKBENCH_ANTIGRAVITY_BRAIN_DIR || join(homedir(), ".gemini", "antigravity-cli", "brain");
  const roots: Record<AgentKind, string> = {
    claude: process.env.WORKBENCH_CLAUDE_HISTORY_DIR || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects"),
    codex: process.env.WORKBENCH_CODEX_HISTORY_DIR || join(codexHome, "sessions"),
    kimi: kimiHistoryRoot(),
    antigravity: join(dirname(brain), "conversations"),
  };
  const root = roots[agent];
  const ids = new Set<string>();
  const rollouts = new Set<string>();
  let remaining = MAX_ENTRIES;
  async function entries(path: string) {
    const before = await lstat(path);
    if (!before.isDirectory()) throw new Error("Unexpected native history directory");
    const result = await readdir(path, { withFileTypes: true });
    remaining -= result.length;
    if (remaining < 0) throw new Error("Native history scan limit exceeded");
    const after = await lstat(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error("Native history changed during scan");
    }
    return result;
  }
  async function codexRollouts(path: string) {
    for (const entry of await entries(path)) {
      if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) rollouts.add(entry.name);
    }
  }
  try {
    const directory = await realpath(root);
    const initial = await stat(directory);
    if (!initial.isDirectory()) return undefined;
    if (agent === "codex") {
      for (const year of await entries(directory)) {
        if (!/^\d{4}$/.test(year.name)) continue;
        if (!year.isDirectory()) return undefined;
        const yearPath = join(directory, year.name);
        for (const month of await entries(yearPath)) {
          if (!/^\d{2}$/.test(month.name)) continue;
          if (!month.isDirectory()) return undefined;
          const monthPath = join(yearPath, month.name);
          for (const day of await entries(monthPath)) {
            if (!/^\d{2}$/.test(day.name)) continue;
            if (!day.isDirectory()) return undefined;
            await codexRollouts(join(monthPath, day.name));
          }
        }
      }
      const archived = join(dirname(root), "archived_sessions");
      const archiveEntry = await lstat(archived).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (archiveEntry) await codexRollouts(archived);
      const names = [...rollouts];
      for (const session of sessions) {
        const id = session.nativeSessionId!;
        if (names.some(name => name.endsWith(`-${id}.jsonl`))
          || (session.nativeTranscriptPath && rollouts.has(basename(session.nativeTranscriptPath)))) ids.add(id);
      }
    } else if (agent === "antigravity") {
      for (const entry of await entries(directory)) {
        const match = /^([\w-]+)\.db(?:-wal|-shm)?$/.exec(entry.name);
        if (match) ids.add(match[1]!);
      }
    } else {
      const workspaces = await entries(directory);
      const localDirs = new Set(workspaces.filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name)));
      for (const workspace of workspaces) {
        if (workspace.isSymbolicLink() && !localDirs.has(await realpath(join(directory, workspace.name)))) return undefined;
        if (!workspace.isDirectory()) continue;
        for (const entry of await entries(join(directory, workspace.name))) {
          if (agent === "kimi" && (entry.isDirectory() || entry.isSymbolicLink())) ids.add(entry.name);
          if (agent === "claude" && entry.name.endsWith(".jsonl")) ids.add(entry.name.slice(0, -6));
        }
      }
    }
    const final = await stat(directory);
    if (initial.dev !== final.dev || initial.ino !== final.ino || await realpath(root) !== directory) return undefined;
    return { store: JSON.stringify([directory, initial.dev, initial.ino]), ids };
  } catch {
    return undefined;
  }
}
