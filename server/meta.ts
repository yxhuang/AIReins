import { proxyEnvironment } from "./proxy-env.js";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { DRIVER_CAPABILITIES, getDriverMetadata } from "./drivers/index.js";

export const SERVER_VERSION = "0.1.0";

export function getServerHostName(remoteOrigin?: string): string {
  try {
    const host = remoteOrigin ? new URL(remoteOrigin).hostname : "";
    if (host.endsWith(".ts.net")) return host.split(".")[0] || hostname();
  } catch { /* 配置不可用时使用实际系统名字。 */ }
  return hostname();
}

let cached: Promise<Record<string, unknown>> | undefined;
let probing: Promise<void> | undefined;

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

// 三家 CLI 探测仅后台执行；首次无缓存也先返回基础能力，完整配置就绪后通知页面补取。
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
  const initial = readCache() ?? {
    cliVersions: { claude: "unknown", codex: "unknown", kimi: "unknown" },
    drivers: Object.fromEntries(Object.entries(DRIVER_CAPABILITIES).map(([agent, capabilities]) =>
      [agent, { ...capabilities, options: [] }],
    )),
  };
  cached = Promise.resolve(withLive({ ...initial, metadataPending: true }));
  probing = Promise.all([
    probeVersion("claude"),
    probeVersion("codex"),
    probeVersion("kimi"),
    getDriverMetadata(process.cwd()),
  ]).then(([claude, codex, kimi, drivers]) => {
    const probed = { cliVersions: { claude, codex, kimi }, drivers };
    writeCache(probed);
    cached = Promise.resolve(withLive({ ...probed, metadataPending: false }));
  }).catch(() => {
    // 不让一次失败把页面永久留在探测中，保留最近可用信息。
    cached = Promise.resolve(withLive({ ...initial, metadataPending: false }));
  });
  return cached;
}

/** 用于启动后广播；getMeta 本身不等待此 Promise。 */
export function whenMetaReady(): Promise<void> {
  void getMeta();
  return probing!;
}
