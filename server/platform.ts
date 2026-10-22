import { accessSync, constants, existsSync, statSync } from "node:fs";
import { release } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

export type Platform = WorkbenchPlatform;
export type WorkbenchPlatform = "wsl" | "linux" | "darwin" | "unsupported";

/** 不依赖 WSL 环境变量；测试注入内核/interop，不新增用户配置。 */
export function detectPlatform({ os = process.platform, kernel = release(), interop = existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") }:
  { os?: string; kernel?: string; interop?: boolean } = {}): WorkbenchPlatform {
  if (os === "darwin") return "darwin";
  if (os !== "linux") return "unsupported";
  return /microsoft/i.test(kernel) || interop ? "wsl" : "linux";
}
export const platform = detectPlatform();
export const powershellCandidates = [
  "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
  "/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe",
];
export function executableExists(path: string): boolean {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
}
export function commandAvailable(command: string): boolean {
  return isAbsolute(command) ? executableExists(command)
    : (process.env.PATH ?? "").split(delimiter).some(path => executableExists(join(path, command)));
}
export function tailscaleExecutables(host = platform): string[] {
  return ["tailscale", ...(host === "wsl" ? ["/mnt/c/Program Files/Tailscale/tailscale.exe"]
    : host === "darwin" ? ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"] : [])];
}
/** pwsh 7 先找 MSI 安装位置，再找 PATH 里的 Windows 目录（Microsoft Store/winget 版只在 WindowsApps 留启动别名）。 */
export function findPwsh7(host = platform, exists: (path: string) => boolean = existsSync, path = process.env.PATH ?? ""): string | undefined {
  if (host !== "wsl") return undefined;
  return [powershellCandidates[0]!, ...path.split(delimiter).filter(dir => dir.startsWith("/mnt/")).map(dir => join(dir, "pwsh.exe"))].find(exists);
}
export function findPowerShell(host = platform, exists: (path: string) => boolean = existsSync, path = process.env.PATH): string | undefined {
  return findPwsh7(host, exists, path) ?? (host === "wsl" ? powershellCandidates.slice(1).find(exists) : undefined);
}
/** 有 pwsh 7 用新式文件夹窗口，只有 Windows PowerShell 5.1 时退到旧式树形窗口。 */
export function windowsPickerAvailable(local: boolean, host = platform, exists: (path: string) => boolean = existsSync, path = process.env.PATH): boolean {
  return local && Boolean(findPowerShell(host, exists, path));
}
export function getPlatformCapabilities({ host = platform, local, remoteTerminal = false, chrome = false,
  picker = windowsPickerAvailable(local, host), powershell = Boolean(findPowerShell(host)), shellOpen = false, powerOff = false,
  tailscale = tailscaleExecutables(host).some(commandAvailable), zip = commandAvailable("zip") }:
  { host?: WorkbenchPlatform; local: boolean; remoteTerminal?: boolean; chrome?: boolean; picker?: boolean;
    powershell?: boolean; shellOpen?: boolean; powerOff?: boolean; tailscale?: boolean; zip?: boolean }) {
  const supported = host !== "unsupported";
  return {
    terminal: supported && (local || remoteTerminal),
    windowsDirectoryPicker: host === "wsl" && local && picker,
    systemOpen: supported && local && shellOpen,
    appWindow: host === "wsl" && local && chrome,
    powerOff: supported && powerOff,
    windowsPaths: host === "wsl",
    powershell: host === "wsl" && powershell,
    fileEdit: supported && host !== "darwin",
    taildrop: supported && tailscale,
    folderTaildrop: supported && host !== "darwin" && tailscale && zip,
    windowsTray: host === "wsl" && local,
    remoteGateway: host === "wsl",
  };
}

/** 显式 distro 用于测试；生产调用仅 WSL 使用发行版。 */
export function vscodeFileUri(path: string, distro = platform === "wsl" ? process.env.WSL_DISTRO_NAME : undefined): string | null {
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) return null;
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return distro?.trim() ? `vscode://vscode-remote/wsl+${encodeURIComponent(distro.trim())}${encoded}` : `vscode://file${encoded}`;
}
