import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandAvailable, findPowerShell, platform, type Platform } from "./platform.js";
import { resolveWorkOpenTarget, WorkFileError, type WorkFileInput, type WorkFileOptions } from "./work-files.js";

const execute = promisify(execFile);

// 只做 WSL（Windows 关联程序/资源管理器）与 macOS（open）；原生 Linux 的 xdg-open 可能等应用退出，未接入。
export function systemOpenEnabled(local: boolean, host: Platform = platform): boolean {
  return local && (host === "wsl" ? Boolean(findPowerShell(host)) : host === "darwin" && commandAvailable("/usr/bin/open"));
}

/** 只映射可由 Windows 无歧义表示的路径，避免反斜杠、ADS 或末尾点指向另一对象。 */
export function windowsOpenPath(path: string, distro = process.env.WSL_DISTRO_NAME): string {
  const parts = path.split("/").slice(1);
  if (!path.startsWith("/") || parts.some(part => !part || /[\\:*?"<>|\x00-\x1f\x7f]/.test(part) || /[. ]$/.test(part) || part === "." || part === "..")) {
    if (path !== "/") throw new WorkFileError(400, "此路径无法用 Windows 程序打开");
  }
  const mount = /^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(path);
  if (mount) return `${mount[1]!.toUpperCase()}:\\${(mount[2] ?? "").replaceAll("/", "\\")}`;
  if (!distro || !/^[\w.-]+$/.test(distro)) throw new WorkFileError(503, "无法确定 WSL 发行版，不能打开 Windows 路径");
  return `\\\\wsl.localhost\\${distro}${path.replaceAll("/", "\\")}`;
}

// 路径经环境变量传递，不拼入 PowerShell 源码或命令行；ShellExecute 按系统关联打开文件和目录。
export const WINDOWS_OPEN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $env:AIREINS_OPEN_PATH
$start.UseShellExecute = $true
$start.Verb = 'open'
$child = [System.Diagnostics.Process]::Start($start)
if ($null -ne $child) { $child.Dispose() }
`;

async function runWindowsOpen(path: string): Promise<void> {
  const powershell = findPowerShell();
  if (!powershell) throw new Error("PowerShell unavailable");
  await execute(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", Buffer.from(WINDOWS_OPEN_SCRIPT, "utf16le").toString("base64")], {
    cwd: "/mnt/c", timeout: 15_000, maxBuffer: 16 * 1024,
    env: { ...process.env, AIREINS_OPEN_PATH: path, WSLENV: `${process.env.WSLENV ? `${process.env.WSLENV}:` : ""}AIREINS_OPEN_PATH` },
  });
}

async function runSystemOpen(path: string, host: Platform): Promise<void> {
  if (host === "wsl") return runWindowsOpen(path);
  // 路径是 realpath，必以 / 开头，不会被 open 当成选项；不加 -W，不等应用退出。
  if (host === "darwin") await execute("/usr/bin/open", [path], { timeout: 15_000, maxBuffer: 16 * 1024 });
  else throw new Error("Unsupported platform");
}

export async function openSystemWorkPath(input: WorkFileInput, options: WorkFileOptions = {}, run = runSystemOpen): Promise<void> {
  const host = options.platform ?? platform;
  const real = await resolveWorkOpenTarget(input, options);
  const path = host === "wsl" ? windowsOpenPath(real) : real;
  try { await run(path, host); }
  catch { throw new WorkFileError(503, "无法用系统程序打开，请检查默认程序和桌面登录状态"); }
}
