import { normalizeRemoteOrigin } from "./host-connections";

/**
 * 远程页面的后端目标。手机主屏 App 只在安装时的源内全屏，跨源导航会套上 Safari 顶栏/底栏，
 * 所以在 ts.net 页面上切换主机时页面留在原源，API/WS 跨源指向目标电脑（目标 WB 按
 * Tailscale 账号放行本人其他电脑的源）。本机 127.0.0.1 页面不用这条路，仍按原方式导航。
 */
export const BACKEND_ORIGIN_KEY = "workbench-backend-origin";
/** 切换经由这个查询参数随整页导航生效：离页确认被取消时存储和路由都不变。 */
const BACKEND_PARAM = "wb-backend";

function tailnetSuffix(origin: string): string {
  const host = new URL(origin).hostname;
  return host.slice(host.indexOf("."));
}

/** 同一 tailnet 的另一台电脑：服务端只放行这类源，其余目标仍需整页导航。 */
function samePeer(page: string, target: string): boolean {
  return target !== page && tailnetSuffix(target) === tailnetSuffix(page);
}

/** null = 与页面同源。只在远程页面上、目标是同 tailnet 另一台合法 ts.net 电脑时生效。 */
export function resolveBackendOrigin(pageHref: string, saved: unknown): string | null {
  const page = normalizeRemoteOrigin(new URL(pageHref).origin);
  if (!page) return null;
  const target = normalizeRemoteOrigin(saved);
  return target && samePeer(page, target) ? target : null;
}

let cached: string | null | undefined;

/**
 * 在 store.init() 前消费 ?wb-backend=：值为页面自己的源表示清除，同 tailnet 他机表示原地连接。
 * 直接导航到某台电脑（↗、在浏览器中打开）也带上它，避免沿用该源以前保存的他机选择。
 */
export function initializeBackend(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(BACKEND_PARAM)) return;
  const requested = url.searchParams.get(BACKEND_PARAM);
  url.searchParams.delete(BACKEND_PARAM);
  window.history.replaceState(window.history.state, "", url.href);
  const page = normalizeRemoteOrigin(url.origin);
  if (!page) return;
  try {
    if (requested === page) localStorage.removeItem(BACKEND_ORIGIN_KEY);
    else if (resolveBackendOrigin(url.href, requested)) localStorage.setItem(BACKEND_ORIGIN_KEY, requested!);
  } catch {
    window.alert("浏览器无法保存主机选择，本页继续连接原主机。");
  }
  cached = undefined;
}

/** 切换主机靠整页重载生效，所以一次页面生命周期内取一次即可。 */
export function backendOrigin(): string | null {
  if (cached !== undefined) return cached;
  if (typeof window === "undefined") return cached = null;
  let saved: string | null = null;
  try { saved = localStorage.getItem(BACKEND_ORIGIN_KEY); } catch { /* 读不到就用同源 */ }
  try { return cached = resolveBackendOrigin(window.location.href, saved); }
  catch { return cached = null; }
}

/** 当前实际连接的 WB 源：界面上的「当前主机」以它为准，而不是页面地址。 */
export function backendHref(): string {
  return backendOrigin() ?? new URL(window.location.href).origin;
}

export function apiUrl(path: string): string {
  const origin = backendOrigin();
  return origin ? `${origin}${path}` : path;
}

export function wsUrl(path: string): string {
  const origin = backendOrigin();
  if (origin) return `wss://${new URL(origin).host}${path}`;
  return `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${path}`;
}

/** 会话 id、目录、终端 id 这类只属于某台电脑的本地记忆，按后端分开存。 */
export function backendStorageKey(key: string): string {
  const origin = backendOrigin();
  return origin ? `${key}@${new URL(origin).host}` : key;
}

/** 远程页面上可原地切换到 target：页面自己的源，或同 tailnet 的另一台电脑。 */
export function canSwitchInPlace(target: string): boolean {
  if (typeof window === "undefined") return false;
  const page = normalizeRemoteOrigin(new URL(window.location.href).origin), remote = normalizeRemoteOrigin(target);
  return page !== null && remote !== null && (remote === page || samePeer(page, remote));
}

/**
 * 回到本源首页并整页导航：会话路由属于旧电脑，不能带过去；replace 不留指向旧电脑会话的后退项。
 * 选择由目标页 initializeBackend() 落盘，所以离页确认被取消时什么都不变。
 */
export function switchBackendInPlace(target: string): void {
  const url = new URL("/", window.location.href);
  url.searchParams.set(BACKEND_PARAM, target);
  window.location.replace(url.href);
}

/** 直接导航到远程电脑的地址补上「连接该电脑自己」，覆盖该源以前保存的原地切换选择。 */
export function withOwnBackend(href: string): string {
  const url = new URL(href);
  const remote = normalizeRemoteOrigin(url.origin);
  if (!remote) return href;
  url.searchParams.set(BACKEND_PARAM, remote);
  return url.href;
}
