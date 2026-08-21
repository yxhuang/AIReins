import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionRecord, UnifiedEvent } from "./types.js";

export const workbenchHome = process.env.WORKBENCH_HOME || join(homedir(), ".workbench");
export const registryPath = join(workbenchHome, "sessions.json");
export const transcriptsDir = join(workbenchHome, "transcripts");

export function ensureStorage(): void {
  mkdirSync(transcriptsDir, { recursive: true });
}

export function loadRegistry(): SessionRecord[] {
  ensureStorage();
  if (!existsSync(registryPath)) return [];
  const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${registryPath} 必须是 JSON 数组`);
  return parsed as SessionRecord[];
}

export function saveRegistry(sessions: SessionRecord[]): void {
  ensureStorage();
  const temporary = `${registryPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(sessions, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, registryPath);
}

export function transcriptPathFor(sessionId: string): string {
  return join(transcriptsDir, `${sessionId}.ndjson`);
}

export function appendTranscript(path: string, event: UnifiedEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
}

export function readTranscript(path: string): UnifiedEvent[] {
  if (!existsSync(path)) return [];
  const events: UnifiedEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as UnifiedEvent);
    } catch (error) {
      throw new Error(`transcript 存在无效 NDJSON 行：${path}: ${String(error)}`);
    }
  }
  return events;
}
