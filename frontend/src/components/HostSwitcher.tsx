import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  connectionLabel, hostShortName, connectionsWithRemote, getHostConnections, hostNavigationUrl,
  normalizeLocalOrigin, normalizeRemoteOrigin, resolveRemoteHostInput, saveHostConnections, subscribeHostConnections,
} from "../host-connections";
import { fetchTailscalePeers, openAppWindow } from "../api";
import type { TailscalePeer } from "../../../server/tailscale-peers";
import { store } from "../store";
import { useStore } from "../useStore";
import { useAnchoredMenu } from "./useAnchoredMenu";

function useConnections() {
  return useSyncExternalStore(subscribeHostConnections, getHostConnections, getHostConnections);
}

// App 的左键 popup 继承 app 名；普通浏览器及修饰键沿用链接默认行为。
export function openNewWindow(event: MouseEvent<HTMLAnchorElement>, standalone: boolean) {
  if (!standalone || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  window.open(event.currentTarget.href, "_blank", `popup,noopener,noreferrer,width=${window.outerWidth},height=${window.outerHeight}`);
}

export function hostSwitchHasUnsentInput(): boolean {
  const draft = store.currentId ? store.getDraft(store.currentId).trim() : "";
  const firstMessage = document.querySelector<HTMLTextAreaElement>(".new-form textarea")?.value.trim();
  return Boolean(draft || firstMessage || document.querySelector(".composer .attach-remove"));
}

export function HostConnectionSettings() {
  const connections = useConnections();
  const [address, setAddress] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);
  const inputId = useId();
  const currentOrigin = new URL(window.location.href).origin;
  const write = (remotes: string[]) => {
    const saved = saveHostConnections({ ...connections, remotes });
    setNotice(saved ? "已保存。" : "浏览器无法保存设置，本页仍可使用这些地址。");
  };
  return <div className="host-connections-settings">
    <form className="host-address-form" onSubmit={async event => {
      event.preventDefault();
      if (adding) return;
      setAdding(true);
      setNotice("");
      try {
        const origin = resolveRemoteHostInput(address) ?? resolveRemoteHostInput(address, await fetchTailscalePeers());
        if (!origin) return;
        const saved = saveHostConnections(connectionsWithRemote(getHostConnections(), origin));
        const completed = address.trim() !== origin ? `已补全为 ${origin}。` : "";
        setNotice(completed + (saved ? "已保存。" : "浏览器无法保存设置，本页仍可使用这些地址。"));
        setAddress("");
      } catch (error) { setNotice((error as Error).message); }
      finally { setAdding(false); }
    }}>
      <label htmlFor={inputId}>Tailscale 地址</label>
      <div className="host-address-row">
        <input id={inputId} type="text" value={address} onChange={event => setAddress(event.target.value)}
          placeholder="机器名、Tailscale IP 或 https://…ts.net" autoComplete="off" spellCheck={false} required disabled={adding} />
        <button type="submit" className="btn" disabled={adding || !address.trim()}>{adding ? "添加中…" : "添加"}</button>
      </div>
    </form>
    <p className="settings-hint">可输入 Tailscale IP、机器名或 MagicDNS 地址。IP 与机器名从当前电脑的 Tailscale 设备中补全；地址保存在这个浏览器，切换时会带到目标 Workbench。</p>
    {connections.remotes.length > 0 && <ul className="host-saved-list">
      {connections.remotes.map(origin => <li key={origin}>
        <span className="host-saved-address"><strong>{connectionLabel(origin)}</strong><span>{origin}</span></span>
        <button type="button" className="host-remove" disabled={origin === currentOrigin}
          aria-label={`移除主机 ${connectionLabel(origin)}`} title={origin === currentOrigin ? "当前连接的主机" : "从连接列表移除"}
          onClick={() => write(connections.remotes.filter(value => value !== origin))}>移除</button>
      </li>)}
    </ul>}
    {notice && <p className="host-connection-notice" role="status">{notice}</p>}
  </div>;
}

export function HostSwitcher() {
  const connections = useConnections();
  const hostName = useStore(value => value.meta?.hostName);
  const appWindow = useStore(value => value.meta?.capabilities.appWindow);
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState("");
  const [openingApp, setOpeningApp] = useState(false);
  const [peers, setPeers] = useState<TailscalePeer[]>([]);
  const discoveryRef = useRef<AbortController | null>(null);
  const [position, setPosition] = useState({ top: 52, left: 8 });
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const currentOrigin = new URL(window.location.href).origin;
  const label = connectionLabel(window.location.href);
  const currentRemote = normalizeRemoteOrigin(currentOrigin);
  const currentUnsaved = currentRemote !== null && !connections.remotes.includes(currentRemote);
  const isLocal = normalizeLocalOrigin(currentOrigin) !== null;
  const localName = isLocal ? hostName ?? connections.localName : connections.localName;
  useEffect(() => {
    if (isLocal && hostName && hostName !== connections.localName) saveHostConnections({ ...connections, localName: hostName });
  }, [isLocal, hostName, connections]);
  const close = (returnFocus: boolean) => {
    discoveryRef.current?.abort();
    setOpen(false);
    setManaging(false);
    setError("");
    if (returnFocus) buttonRef.current?.focus();
  };
  useEffect(() => () => discoveryRef.current?.abort(), []);
  const openMenu = () => {
    setPeers([]);
    setOpen(true);
    const controller = new AbortController();
    discoveryRef.current = controller;
    void fetchTailscalePeers(AbortSignal.any([controller.signal, AbortSignal.timeout(7_000)]))
      .then(result => {
        if (!controller.signal.aborted) setPeers(result.peers.filter(peer => normalizeRemoteOrigin(peer.origin) === peer.origin));
      }).catch(() => { /* 发现失败静默，手动添加始终可用。 */ });
  };
  useAnchoredMenu({ open, rootRef, buttonRef, panelRef, close,
    initialFocus: managing ? "input" : '[aria-checked="true"], [role="menuitemradio"]', trapFocus: true });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (rect) setPosition({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 308)) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);

  const remember = (origin: string) => {
    try {
      const next = connectionsWithRemote(getHostConnections(), origin);
      if (!saveHostConnections(next)) setError("浏览器无法保存设置，本页仍可使用这些地址。");
      return next;
    } catch (error) { setError((error as Error).message); return null; }
  };
  const openNewTab = (event: MouseEvent<HTMLAnchorElement>, origin: string) => {
    const next = remember(origin);
    if (!next) event.preventDefault();
    else event.currentTarget.href = hostNavigationUrl(origin, next);
  };
  // Chrome/Edge 的 --app 与安装的 PWA 都报 standalone。
  const standalone = typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // 手机主屏 App 只在添加时的源内全屏，跳到别的电脑会被系统套上浏览器栏：改为提示用那台电脑自己的主屏图标。
  const homeScreenHint = (origin: string) => {
    if (!standalone || !mobile || origin === currentOrigin) return false;
    setError(`主屏 App 内切换会出现浏览器栏。请从 ${connectionLabel(origin)} 的主屏图标进入；还没有的话，在 Safari 打开 ${origin}，分享 → 添加到主屏幕。`);
    return true;
  };
  const choose = (origin: string, discovered = false) => {
    if (origin === currentOrigin) { close(true); return; }
    if (homeScreenHint(origin)) return;
    if (store.filePreview?.saving) { setError("文件正在保存，完成后再切换主机。"); return; }
    if (hostSwitchHasUnsentInput() && !window.confirm("当前有未发送的输入或附件，仍要切换主机？")) return;
    // 未保存文件继续由 store 的 beforeunload 保护；这里不清空文件、草稿，也不停止 worker。
    const next = discovered ? remember(origin) : connections;
    if (next) window.location.assign(hostNavigationUrl(origin, next));
  };
  const destinations = [
    ...(connections.localOrigin ? [{ origin: connections.localOrigin, name: localName ? `${localName}（本机）` : "本机" }] : []),
    ...(currentUnsaved ? [currentRemote, ...connections.remotes] : connections.remotes)
      .map(origin => ({ origin, name: connectionLabel(origin) }))
      // 本机自己的 Tailscale 地址与「本机」是同一台，不重复列出
      .filter(({ origin, name }) => !(connections.localOrigin && name === localName && origin !== currentOrigin)),
  ];
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands ?? [];
  const browserLabel = brands.some(b => b.brand === "Google Chrome") ? "在 Chrome 中打开" : "在浏览器中打开";
  const canOpenApp = !standalone && !mobile && isLocal && appWindow === true;
  const openInApp = async () => {
    if (openingApp) return;
    if (store.filePreview?.saving) { setError("文件正在保存，完成后再打开 WB 窗口。"); return; }
    if (hostSwitchHasUnsentInput() && !window.confirm("当前有未发送的输入或附件，仍要打开 WB 窗口并关闭这个标签页？")) return;
    const target = window.location.href;
    setOpeningApp(true);
    setError("");
    try {
      await openAppWindow(target);
      close(false);
      try { window.close(); } catch { /* 浏览器不允许关闭时保留标签页。 */ }
    } catch (error) { setError((error as Error).message); }
    finally { setOpeningApp(false); }
  };
  const knownOrigins = new Set([currentOrigin, ...connections.remotes]);
  const discovered = peers.filter(peer => {
    if (knownOrigins.has(peer.origin)) return false;
    knownOrigins.add(peer.origin);
    return true;
  });
  return <div className="host-switcher" ref={rootRef}>
    <button type="button" className="brand host-switch-button" ref={buttonRef}
      aria-label={`选择主机，当前：${label}`} title={`当前：${normalizeLocalOrigin(currentOrigin) ? "本机" : `远程 ${label}`}，点击切换主机`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => open ? close(false) : openMenu()}>
      <span className="brand-mark" aria-hidden="true">wb</span>
      <span className="brand-line" aria-hidden="true" />
      <span className="brand-name" aria-hidden="true">{label}</span>
      <span className="brand-short" aria-hidden="true">{hostShortName(isLocal ? localName ?? "" : label)}</span>
    </button>
    {open && createPortal(<div className={`host-switch-panel${managing ? " managing" : ""}`} ref={panelRef} id={panelId}
      role={managing ? "dialog" : "menu"} aria-label={managing ? "主机与连接" : "选择主机"}
      style={{ ...position, maxHeight: `calc(100dvh - ${position.top + 8}px)` }}
      onKeyDown={event => {
        if (managing || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]') ?? [])];
        if (!items.length) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 :
          (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}>
      <p className="host-switch-current">当前：{normalizeLocalOrigin(currentOrigin) ? "本机" : `远程 ${label}`}</p>
      {managing ? <>
        <HostConnectionSettings />
        <button type="button" className="host-menu-manage" onClick={() => setManaging(false)}>返回主机列表</button>
      </> : <>
        {destinations.map(({ origin, name }) => <div className="host-menu-row" role="none" key={origin}>
          <button type="button" role="menuitemradio" aria-checked={origin === currentOrigin}
            className="host-menu-target" title={origin} onClick={() => choose(origin)}>
            <span className="host-menu-check" aria-hidden="true">{origin === currentOrigin ? "✓" : ""}</span>
            <span className="host-menu-name">{name}</span>
          </button>
          <a role="menuitem" href={hostNavigationUrl(origin, connections)} target="_blank" rel="noopener noreferrer"
            className="host-menu-new-window" aria-label={`在新${standalone ? "窗口" : "标签页"}打开 ${name}`}
            title={standalone ? "在新窗口打开" : "在新标签页打开"} onClick={event => { if (homeScreenHint(origin)) event.preventDefault(); else openNewWindow(event, !!standalone); }}>↗</a>
        </div>)}
        {discovered.length > 0 && <>
          <p className="host-menu-section">Tailscale 上的其他电脑</p>
          {discovered.map(peer => <div className={`host-menu-row${peer.online ? "" : " host-menu-offline"}`} role="none" key={peer.origin}>
            <button type="button" role="menuitem" className="host-menu-target" title={peer.origin} onClick={() => choose(peer.origin, true)}>
              <span className="host-menu-check" aria-hidden="true" />
              <span className="host-menu-name">{peer.name}{!peer.online && <span className="host-menu-status">离线</span>}</span>
            </button>
            <a role="menuitem" href={hostNavigationUrl(peer.origin, { ...connections, remotes: [...connections.remotes, peer.origin] })}
              target="_blank" rel="noopener noreferrer" className="host-menu-new-window"
              aria-label={`在新${standalone ? "窗口" : "标签页"}打开 ${peer.name}`} title={standalone ? "在新窗口打开" : "在新标签页打开"}
              onClick={event => { if (homeScreenHint(peer.origin)) { event.preventDefault(); return; } openNewTab(event, peer.origin); openNewWindow(event, !!standalone); }}
              onAuxClick={event => { if (event.button === 1) openNewTab(event, peer.origin); }}>↗</a>
          </div>)}
        </>}
        <button type="button" role="menuitem" className="host-menu-manage host-menu-list-action" onClick={() => setManaging(true)}>管理主机…</button>
        {connections.remotes.length === 0 && <p className="settings-hint">添加另一台电脑的 Tailscale 地址后即可切换。</p>}
        {!connections.localOrigin && <p className="settings-hint">从电脑的本机 Workbench 进入远程后，可在这里返回本机。</p>}
        {currentUnsaved && <p className="settings-hint" role="status">列表已满，当前主机暂未保存。原有地址已保留，可在主机与连接中管理。</p>}
        {standalone && <a role="menuitem" className="host-menu-manage host-menu-browser" href={window.location.href}
          target="_blank" rel="noopener noreferrer" onClick={() => close(false)}>{browserLabel}</a>}
        {canOpenApp && <button type="button" role="menuitem" className="host-menu-manage host-menu-browser"
          title="用独立 WB 窗口打开当前页面，并关闭这个标签页" disabled={openingApp} onClick={() => void openInApp()}>
          {openingApp ? "正在打开…" : "在 WB 窗口中打开"}
        </button>}
      </>}
      {error && <p className="host-connection-notice" role="alert">{error}</p>}
    </div>, document.body)}
  </div>;
}
