import { execFile, spawn } from "node:child_process";
import { isIP } from "node:net";
import { release } from "node:os";
import type { Readable } from "node:stream";
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
function tailscaleExecutables(): string[] {
  const wsl = process.platform === "linux" && (Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME) || /microsoft/i.test(release()));
  return ["tailscale", ...(wsl ? ["/mnt/c/Program Files/Tailscale/tailscale.exe"] : [])];
}
/** 按顺序找可用的 tailscale CLI；都不存在返回 null。 */
async function runTailscale(args: string[]): Promise<{ executable: string; stdout: string } | null> {
  for (const executable of tailscaleExecutables()) {
    try {
      const { stdout } = await run(executable, args, { timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8" });
      return { executable, stdout };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return null;
}
export async function getTailscalePeers(): Promise<TailscalePeersResult> {
  try {
    const result = await runTailscale(["status", "--json"]);
    return result ? parseTailscalePeers(result.stdout) : { peers: [], reason: "未检测到 Tailscale" };
  } catch (error) {
    return { peers: [], reason: (error as { killed?: boolean }).killed ? "读取 Tailscale 状态超时" : "Tailscale 未运行或无法读取状态" };
  }
}

export interface TaildropTarget { name: string; ip: string; online: boolean; self: boolean }
export interface TaildropTargetsResult { targets: TaildropTarget[]; reason?: string }
export class TaildropError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

/** `tailscale file cp --targets` 每行：IP<TAB>主机名[<TAB>offline; …]。selfIp 来自 Serve 的 X-Forwarded-For。 */
export function parseTaildropTargets(text: string, selfIp?: string): TaildropTarget[] {
  const targets: TaildropTarget[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [ip, name, detail] = line.split("\t");
    if (!ip || !name?.trim() || isIP(ip) === 0) continue;
    targets.push({ name: name.trim(), ip, online: !detail?.startsWith("offline"), self: ip === selfIp });
  }
  return targets.sort((a, b) => Number(b.self) - Number(a.self) || Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

async function taildropTargets(selfIp?: string): Promise<TaildropTargetsResult & { executable?: string }> {
  try {
    const result = await runTailscale(["file", "cp", "--targets"]);
    return result ? { targets: parseTaildropTargets(result.stdout, selfIp), executable: result.executable } : { targets: [], reason: "未检测到 Tailscale" };
  } catch (error) {
    return { targets: [], reason: (error as { killed?: boolean }).killed ? "读取 Taildrop 目标超时" : "Tailscale 未运行，或本机未开启 Taildrop" };
  }
}
export async function getTaildropTargets(selfIp?: string): Promise<TaildropTargetsResult> {
  const { targets, reason } = await taildropTargets(selfIp);
  return reason ? { targets, reason } : { targets };
}

/** 只发往当前 `--targets` 列出的在线 IP，参数不经 shell；stdin 喂内容，--name 给文件名。 */
export async function sendTaildrop(ip: unknown, name: string, source: Readable): Promise<void> {
  let sourceError: Error | undefined;
  source.on("error", error => { sourceError = error; });
  const { targets, reason, executable } = await taildropTargets();
  const target = targets.find(value => value.ip === ip);
  if (!target || !executable) throw new TaildropError(400, reason ?? "目标设备不在 Taildrop 可发送列表中");
  if (!target.online) throw new TaildropError(409, `${target.name} 当前离线`);
  const child = spawn(executable, ["file", "cp", "--update-interval=0", `--name=${name}`, "-", `${target.ip}:`], { stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
  child.stdin.on("error", () => { /* 子进程提前退出时的 EPIPE 由 exit 码报告 */ });
  source.on("error", () => child.kill());
  if (sourceError) child.kill();
  else source.pipe(child.stdin);
  // shortcut: 固定 30 分钟上限，超大文件走慢速 DERP 可能被截断；真遇到再按大小放宽。
  const timer = setTimeout(() => child.kill(), 30 * 60_000);
  try {
    const code = await new Promise<number | null>(done => {
      child.on("error", error => { stderr ||= error.message; done(null); });
      child.on("close", done);
    });
    if (sourceError) throw new TaildropError(500, `读取待发送内容失败：${sourceError.message}`);
    if (code !== 0) throw new TaildropError(502, `发送到 ${target.name} 失败：${stderr.trim().split(/\r?\n/).pop() || `退出码 ${code}`}`);
  } finally { clearTimeout(timer); }
}
