import { proxyEnvironment } from "./proxy-env.js";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { getDriverMetadata } from "./drivers/index.js";

export const SERVER_VERSION = "0.1.0";

export function getServerHostName(remoteOrigin?: string): string {
  try {
    const host = remoteOrigin ? new URL(remoteOrigin).hostname : "";
    if (host.endsWith(".ts.net")) return host.split(".")[0] || hostname();
  } catch { /* 配置不可用时使用实际系统名字。 */ }
  return hostname();
}

let cached: Promise<Record<string, unknown>> | undefined;

function probeVersion(command: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      env: proxyEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => { output += chunk.toString("utf8"); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => resolve(`unavailable: ${error.message}`));
    child.on("close", () => resolve(output.trim().split("\n")[0] || "unknown"));
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      resolve("unavailable: version probe timeout");
    }, 3_000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  });
}

// 三家模型列表探测要拉起各自 CLI，冷启动约 7 秒，期间 /api/meta 不返回，托盘和前端都卡在它上面
// （tray.log / server.log 10-06 00:40）。启动时先用上次落盘的结果，后台探测完再更新缓存，下次启动生效。
function cachePath(): string {
  return join(process.env.WORKBENCH_HOME || join(homedir(), ".workbench"), "meta-cache.json");
}

function readCache(): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath(), "utf8"));
    if (parsed && typeof parsed === "object" && "drivers" in parsed && "cliVersions" in parsed) {
      const { cliVersions, drivers } = parsed as Record<string, unknown>;
      return { cliVersions, drivers };
    }
  } catch { /* 没有缓存或已损坏就现场探测。 */ }
  return undefined;
}

function writeCache(probed: Record<string, unknown>): void {
  try {
    const path = cachePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, `${JSON.stringify(probed)}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  } catch { /* 缓存写不进去只影响下次启动速度。 */ }
}

export function getMeta(): Promise<Record<string, unknown>> {
  if (cached) return cached;
  const withLive = (probed: Record<string, unknown>) => ({
    serverVersion: SERVER_VERSION,
    // 新建会话表单的 cwd 默认值：没有它前端只能留空，而空 cwd 会让「创建」按钮永久禁用，
    // 用户在全新环境下会被锁在应用外面（2026-08-22 实测踩到）。
    defaultCwd: process.cwd(),
    // 历史会话目录筛选展开 `~` 用。
    homeDir: homedir(),
    ...probed,
  });
  const fresh = Promise.all([
    probeVersion("claude"),
    probeVersion("codex"),
    probeVersion("kimi"),
    getDriverMetadata(process.cwd()),
  ]).then(([claude, codex, kimi, drivers]) => {
    const probed = { cliVersions: { claude, codex, kimi }, drivers };
    writeCache(probed);
    cached = Promise.resolve(withLive(probed));
    return cached;
  });
  const disk = readCache();
  if (!disk) return (cached = fresh);
  fresh.catch(() => { /* 后台刷新失败时继续用缓存。 */ });
  return (cached = Promise.resolve(withLive(disk)));
}
