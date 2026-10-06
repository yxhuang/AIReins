import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { release } from "node:os";
import { promisify } from "node:util";

export interface TailscalePeer {
  name: string;
  origin: string;
  online: boolean;
  os: string;
  ips: string[];
}

export interface TailscalePeersResult {
  peers: TailscalePeer[];
  reason?: string;
}

// 与前端 normalizeRemoteOrigin 接受的 MagicDNS 主机格式一致。
const MAGIC_DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/;
function dnsName(value: unknown): string {
  return typeof value === "string" ? value.replace(/\.$/, "").toLowerCase() : "";
}

/** 仅解析输入，不访问系统或调用 CLI。 */
export function parseTailscalePeers(text: string): TailscalePeersResult {
  let status;
  try { status = JSON.parse(text); }
  catch { return { peers: [], reason: "Tailscale 状态不是有效 JSON" }; }
  if (!status || typeof status !== "object" || Array.isArray(status)) {
    return { peers: [], reason: "Tailscale 状态格式无效" };
  }
  if (status.BackendState !== undefined && status.BackendState !== "Running") {
    return { peers: [], reason: "Tailscale 未运行" };
  }
  const peers: TailscalePeer[] = [];
  const self = status.Self;
  if (status.Peer && typeof status.Peer === "object" && !Array.isArray(status.Peer)) {
    for (const [key, peer] of Object.entries(status.Peer) as [string, Record<string, unknown>][]) {
      if (!peer || typeof peer !== "object" || Array.isArray(peer)) continue;
      const dns = dnsName(peer.DNSName);
      if (!MAGIC_DNS.test(dns) || (self && (dns === dnsName(self.DNSName) ||
        (self.ID && (peer.ID === self.ID || key === self.ID)) || (self.PublicKey && key === self.PublicKey)))) continue;
      if (typeof peer.OS !== "string" || !/^(windows|linux|macos)$/i.test(peer.OS)) continue;
      peers.push({
        name: typeof peer.HostName === "string" && peer.HostName.trim() ? peer.HostName.trim() : dns.split(".")[0]!,
        origin: `https://${dns}`, online: peer.Online === true, os: peer.OS,
        ips: Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.filter((ip): ip is string => typeof ip === "string" && isIP(ip) !== 0) : [],
      });
    }
  }
  peers.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name) || a.origin.localeCompare(b.origin));
  return { peers };
}

const run = promisify(execFile);
export async function getTailscalePeers(): Promise<TailscalePeersResult> {
  const wsl = process.platform === "linux" && (Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) || /microsoft/i.test(release()));
  const executables = ["tailscale", ...(wsl ? ["/mnt/c/Program Files/Tailscale/tailscale.exe"] : [])];
  for (const executable of executables) {
    try {
      const { stdout } = await run(executable, ["status", "--json"], { timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
      return parseTailscalePeers(stdout);
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      if (failure.code === "ENOENT") continue;
      return { peers: [], reason: failure.killed ? "读取 Tailscale 状态超时" : "Tailscale 未运行或无法读取状态" };
    }
  }
  return { peers: [], reason: "未检测到 Tailscale" };
}
