import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { release } from "node:os";
import type { AccessPolicy } from "./access.js";

export class AppWindowError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function mountedPath(value: string): string {
  return value.replace(/^([a-z]):[\\/]/i, (_, drive: string) => `/mnt/${drive.toLowerCase()}/`).replaceAll("\\", "/");
}

/** 与托盘一致的两个系统安装目录和用户 LOCALAPPDATA 安装目录；只读文件，不运行 Windows 命令。 */
export function findWindowsChrome(wsl = process.platform === "linux" &&
  (Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) || /microsoft/i.test(release()))): string | null {
  if (!wsl) return null;
  const candidates = [
    `${mountedPath(process.env.ProgramFiles || "C:\\Program Files")}/Google/Chrome/Application/chrome.exe`,
    `${mountedPath(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)")}/Google/Chrome/Application/chrome.exe`,
  ];
  if (process.env.LOCALAPPDATA) candidates.push(`${mountedPath(process.env.LOCALAPPDATA)}/Google/Chrome/Application/chrome.exe`);
  else {
    // WSL 通常不继承 LOCALAPPDATA；只查看标准用户安装路径。
    try {
      for (const user of readdirSync("/mnt/c/Users")) candidates.push(`/mnt/c/Users/${user}/AppData/Local/Google/Chrome/Application/chrome.exe`);
    } catch { /* 未挂载 Windows 用户目录。 */ }
  }
  return candidates.find(path => existsSync(path)) ?? null;
}

export function appWindowEnabled(policy: AccessPolicy, chrome: string | null): boolean {
  return policy.kind === "local" && chrome !== null;
}

function launchChrome(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { cwd: "/mnt/c", windowsHide: false });
    child.once("error", reject);
    child.once("spawn", () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      resolve();
    });
  });
}

export async function openAppWindow(policy: AccessPolicy, port: number, input: unknown,
  chrome: string | null, launch = launchChrome): Promise<void> {
  if (policy.kind !== "local") throw new AppWindowError(403, "仅本机入口可打开 WB 窗口");
  const target = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).target : undefined;
  let url: URL;
  try {
    if (typeof target !== "string" || target.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(target)) throw Error();
    url = new URL(target);
    if (url.username || url.password || !policy.origins.has(url.origin)) throw Error();
  } catch { throw new AppWindowError(400, "target 必须是本机 WB 页面地址"); }
  if (!chrome) throw new AppWindowError(503, "此主机无法打开 Windows Chrome WB 窗口");
  try {
    await launch(chrome, [`--app=http://127.0.0.1:${port}/#wb-goto=${encodeURIComponent(url.href)}`]);
  } catch { throw new AppWindowError(503, "无法启动 Windows Chrome WB 窗口，请保留标签页并重试"); }
}
