import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { NativeConversationReader } from "./native-conversation.js";
import { StdioRpcProbe } from "./drivers/rpc-probe.js";
import type { SessionRecord } from "./types.js";

const runFile = promisify(execFile);
const UUID = "[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}";
export class NativeDeleteError extends Error {}

/** Validate before stopping a worker; never substitute a project purge or worktree removal. */
export function validateNativeDelete(record: SessionRecord): void {
  if (record.agent === "claude") throw new NativeDeleteError("Claude 当前没有已核实的单会话彻底删除接口；请使用「移除」。AIReins 不会清理整个项目或工作树。");
  const pattern = new RegExp(record.agent === "kimi" ? `^session_${UUID}$` : `^${UUID}$`);
  if (!record.nativeSessionId || !pattern.test(record.nativeSessionId)) {
    throw new NativeDeleteError("无法核验原生会话 ID，禁止彻底删除；请使用「移除」。");
  }
  const root = record.agent === "kimi"
    ? join(process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code"), "sessions")
    : join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
  const configured = record.agent === "kimi" ? process.env.WORKBENCH_KIMI_HISTORY_DIR : process.env.WORKBENCH_CODEX_HISTORY_DIR;
  if (configured && resolve(configured) !== resolve(root)) {
    throw new NativeDeleteError("AIReins 历史目录与原生 CLI 目录不同，禁止删除其他位置的会话。");
  }
}

/** Native tools own both history and indexes. No raw unlink of user archives here. */
export async function deleteNativeSession(record: SessionRecord): Promise<void> {
  validateNativeDelete(record);
  const reader = new NativeConversationReader({
    codex: join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions"),
  });
  const path = reader.transcriptPath(record);
  if (!path || !reader.hasArchive(record)) throw new NativeDeleteError("无法核验原生历史文件及会话身份，未执行彻底删除。");
  if (record.agent === "kimi") {
    const probe = new StdioRpcProbe("kimi", ["acp"], homedir());
    try {
      const result = await probe.request("initialize", {
        protocolVersion: 1, clientCapabilities: {},
        clientInfo: { name: "workbench-delete", version: "0.1.0" },
      }, 10_000);
      if (!result?.agentCapabilities?.sessionCapabilities?.delete) {
        throw new NativeDeleteError("当前 Kimi CLI 不支持 session/delete；未删除会话。");
      }
      await probe.request("session/delete", { sessionId: record.nativeSessionId }, 20_000);
    } catch (error) {
      if (error instanceof NativeDeleteError) throw error;
      throw new NativeDeleteError(`Kimi 彻底删除失败：${(error as Error).message}`);
    } finally { await probe.close(); }
  } else {
    try {
      await runFile("codex", ["delete", "--force", record.nativeSessionId!], {
        cwd: homedir(), timeout: 30_000, maxBuffer: 64 * 1024,
      });
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new NativeDeleteError(`Codex 彻底删除失败：${detail.stderr?.trim() || detail.message}`);
    }
  }
  const deletedPath = record.agent === "kimi" ? dirname(dirname(dirname(path))) : path;
  try { await lstat(deletedPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new NativeDeleteError("原生 CLI 返回成功，但历史文件仍存在；无法确认彻底删除，AIReins 记录已保留。");
}
