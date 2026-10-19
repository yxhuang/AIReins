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
export function findPowerShell(host = platform, exists: (path: string) => boolean = existsSync): string | undefined {
  return host === "wsl" ? powershellCandidates.find(exists) : undefined;
}
export function windowsPickerAvailable(local: boolean, host = platform, exists: (path: string) => boolean = existsSync): boolean {
  return local && host === "wsl" && exists(powershellCandidates[0]!);
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
