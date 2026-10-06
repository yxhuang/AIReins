import type { TailscalePeersResult } from "../../server/tailscale-peers.js";

export interface HostConnections {
  /** 发起切换的浏览器本机入口；手机直接打开远程页时为空。 */
  localOrigin: string | null;
  localName?: string;
  remotes: string[];
}

export const HOST_CONNECTIONS_KEY = "workbench-host-connections";
export const MAX_REMOTE_HOSTS = 16;
const TRANSFER_PREFIX = "#wb-connect=";
const MAGIC_DNS = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ts\.net$/;

function address(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const url = new URL(value.trim());
    return !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash ? url : null;
  } catch { return null; }
}

export function normalizeRemoteOrigin(value: unknown): string | null {
  const url = address(value);
  return url?.protocol === "https:" && !url.port && MAGIC_DNS.test(url.hostname) ? url.origin : null;
}

function lookupKey(value: string): string {
  const key = value.trim().toLowerCase();
  // 浏览器 URL 解析统一 IPv6 的大小写、零压缩及可选方括号。
  if (key.includes(":")) {
    try { return new URL(`http://${key.startsWith("[") ? key : `[${key}]`}`).hostname; }
    catch { /* 非 IPv6 时仍作为机器名匹配。 */ }
  }
  return key;
}

/** null 表示需要发现结果；提供结果后无匹配或有歧义则抛出可读错误。 */
export function resolveRemoteHostInput(input: string, discovery?: TailscalePeersResult): string | null {
  const value = input.trim();
  if (!value || value.length > 512) throw new Error("请输入 Tailscale IP、机器名或完整地址（最多 512 个字符）。");
  const complete = normalizeRemoteOrigin(value);
  if (complete) return complete;
  const dns = value.toLowerCase().replace(/[/.]$/, "");
  if (MAGIC_DNS.test(dns)) return `https://${dns}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw new Error("请输入完整的 HTTPS Tailscale 地址，不带路径、账号密码或自定义端口。");
  if (!discovery) return null;
  const key = lookupKey(value);
  const origins = new Set<string>();
  for (const peer of discovery.peers) {
    const origin = normalizeRemoteOrigin(peer.origin);
    if (origin && (lookupKey(peer.name) === key || connectionLabel(origin).toLowerCase() === key || peer.ips.some(ip => lookupKey(ip) === key))) {
      origins.add(origin);
    }
  }
  if (origins.size > 1) throw new Error(`在 Tailscale 中找到多个匹配 ${value} 的电脑，请使用 Tailscale IP 或完整地址。`);
  if (origins.size === 0) throw new Error(`在 Tailscale 中找不到 ${value} 对应的电脑。${discovery.reason ? ` ${discovery.reason}` : ""}`);
  return [...origins][0]!;
}

export function normalizeLocalOrigin(value: unknown): string | null {
  const url = address(value);
  return url?.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost") ? url.origin : null;
}

export function normalizeConnections(value: unknown): HostConnections {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const remotes = Array.isArray(record.remotes) ? record.remotes.slice(0, 64).flatMap(value => {
    const origin = normalizeRemoteOrigin(value);
    return origin ? [origin] : [];
  }) : [];
  const localName = typeof record.localName === "string" && record.localName.trim().length > 0 &&
    record.localName.length <= 253 && !/[\u0000-\u001f\u007f]/.test(record.localName) ? record.localName.trim() : undefined;
  return { localOrigin: normalizeLocalOrigin(record.localOrigin), remotes: [...new Set(remotes)].slice(0, MAX_REMOTE_HOSTS),
    ...(localName ? { localName } : {}) };
}

export function connectionsWithRemote(connections: HostConnections, address: string): HostConnections {
  const origin = normalizeRemoteOrigin(address);
  if (!origin) throw new Error("请输入完整的 https://机器名.tail…ts.net Tailscale 地址，不带路径或账号密码。");
  if (connections.remotes.includes(origin)) return connections;
  if (connections.remotes.length >= MAX_REMOTE_HOSTS) throw new Error(`最多保存 ${MAX_REMOTE_HOSTS} 台远程主机。`);
  return { ...connections, remotes: [...connections.remotes, origin] };
}

export function connectionsForPage(href: string, saved: unknown, transfer?: unknown): HostConnections {
  const previous = normalizeConnections(saved), incoming = normalizeConnections(transfer);
  const origin = new URL(href).origin;
  const state = normalizeConnections({
    localOrigin: normalizeLocalOrigin(origin) ?? incoming.localOrigin ?? previous.localOrigin,
    remotes: [...previous.remotes, ...incoming.remotes],
    localName: incoming.localName ?? previous.localName,
  });
  const remote = normalizeRemoteOrigin(origin);
  if (remote && !state.remotes.includes(remote) && state.remotes.length < MAX_REMOTE_HOSTS) {
    state.remotes.push(remote);
  }
  return state;
}

export function connectionLabel(href: string): string {
  const url = new URL(href);
  if (normalizeLocalOrigin(url.origin)) return "本机";
  return normalizeRemoteOrigin(url.origin) ? (url.hostname.split(".")[0] ?? url.hostname) : url.hostname;
}

export function workbenchWindowTitle(href: string, pending: number): string {
  const prefix = pending > 0 ? `(${pending}) 个闸门待处理 · ` : "";
  const label = connectionLabel(href);
  return `${prefix}Workbench · ${normalizeLocalOrigin(new URL(href).origin) ? label : `远程 ${label}`}`;
}

export function parseHostTransfer(href: string): HostConnections | null {
  const hash = new URL(href).hash;
  if (!hash.startsWith(TRANSFER_PREFIX) || hash.length > 8_192) return null;
  try { return normalizeConnections(JSON.parse(decodeURIComponent(hash.slice(TRANSFER_PREFIX.length)))); }
  catch { return null; }
}

export function hostNavigationUrl(target: string, value: HostConnections): string {
  const state = normalizeConnections(value);
  const remote = normalizeRemoteOrigin(target), local = normalizeLocalOrigin(target);
  if (!remote && (!local || local !== state.localOrigin)) throw new Error("目标不是已记录的本机入口或有效 Tailscale 地址。");
  return `${remote ?? local}/${TRANSFER_PREFIX}${encodeURIComponent(JSON.stringify(state))}`;
}

/** 只在本机页面消费启动 fragment，目标限制为此 WB 的本机入口。 */
export function parseAppWindowRequest(href: string): string | null {
  const page = new URL(href);
  if (!normalizeLocalOrigin(page.origin) || page.hash.length > 32_768) return null;
  const prefix = "#wb-goto=";
  if (!page.hash.startsWith(prefix)) return null;
  try {
    const target = decodeURIComponent(page.hash.slice(prefix.length));
    if (target.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(target)) return null;
    const url = new URL(target);
    const local = normalizeLocalOrigin(url.origin) && (url.port === page.port || url.port === "5173");
    if (url.username || url.password || !local) return null;
    return url.href;
  } catch { return null; }
}

let snapshot: HostConnections | null = null;
const listeners = new Set<() => void>();
function pageHref(): string {
  return typeof window !== "undefined" ? window.location.href : "http://127.0.0.1:8790/";
}
function savedConnections(): unknown {
  try { return JSON.parse(localStorage.getItem(HOST_CONNECTIONS_KEY) ?? "null"); }
  catch { return null; }
}
function persist(state: HostConnections): boolean {
  try { localStorage.setItem(HOST_CONNECTIONS_KEY, JSON.stringify(state)); return true; }
  catch { return false; }
}

/** 在 store.init() 读取会话路由前消费 fragment，避免把连接上下文当作会话。 */
export function initializeHostConnections(): void {
  const href = pageHref();
  const transfer = parseHostTransfer(href);
  snapshot = connectionsForPage(href, savedConnections(), transfer);
  persist(snapshot);
  const url = new URL(href);
  if (normalizeLocalOrigin(url.origin) && url.hash.startsWith("#wb-goto=")) {
    const target = parseAppWindowRequest(href);
    url.hash = "";
    if (target) {
      const route = new URL(target);
      url.pathname = route.pathname;
      url.search = route.search;
      url.hash = route.hash;
    }
    window.history.replaceState(window.history.state, "", url.href);
  }
  if (url.hash.startsWith(TRANSFER_PREFIX)) {
    url.hash = "";
    window.history.replaceState(window.history.state, "", url.href);
  }
  if (transfer?.remotes.some(origin => !snapshot!.remotes.includes(origin))) {
    window.alert("主机列表已满，部分传入地址没有保存。原有地址已保留；可在主机与连接中移除不需要的地址后重新添加。");
  }
}

export function getHostConnections(): HostConnections {
  snapshot ??= connectionsForPage(pageHref(), savedConnections());
  return snapshot;
}

/** 返回是否落盘；失败仍保留本页状态，跨源导航直接传递这份状态。 */
export function saveHostConnections(value: HostConnections): boolean {
  snapshot = connectionsForPage(pageHref(), value);
  const saved = persist(snapshot);
  for (const listener of listeners) listener();
  return saved;
}

function onStorage(event: StorageEvent): void {
  if (event.key !== HOST_CONNECTIONS_KEY && event.key !== null) return;
  snapshot = connectionsForPage(pageHref(), savedConnections());
  for (const notify of listeners) notify();
}

export function subscribeHostConnections(listener: () => void): () => void {
  listeners.add(listener);
  // 单个存储监听：多个 UI 订阅共用同一份快照。
  if (listeners.size === 1) window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("storage", onStorage);
  };
}
