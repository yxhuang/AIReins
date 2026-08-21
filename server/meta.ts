import { spawn } from "node:child_process";
import { getDriverMetadata } from "./drivers/index.js";

export const SERVER_VERSION = "0.1.0";

let cached: Promise<Record<string, unknown>> | undefined;

function probeVersion(command: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      env: process.env,
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

export function getMeta(): Promise<Record<string, unknown>> {
  cached ??= Promise.all([
    probeVersion("claude"),
    probeVersion("codex"),
    probeVersion("kimi"),
    getDriverMetadata(process.cwd()),
  ]).then(([claude, codex, kimi, drivers]) => ({
    serverVersion: SERVER_VERSION,
    cliVersions: { claude, codex, kimi },
    capabilities: {
      websocket: true,
      snapshot: true,
      ringReplay: true,
      staticServing: true,
    },
    drivers,
    security: {
      bindHost: "127.0.0.1",
      authentication: false,
      remoteAccess: false,
    },
  }));
  return cached;
}
