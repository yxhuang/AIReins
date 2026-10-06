import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import {
  connectionLabel, connectionsWithRemote, getHostConnections, hostNavigationUrl,
  normalizeLocalOrigin, normalizeRemoteOrigin, resolveRemoteHostInput, saveHostConnections, subscribeHostConnections,
} from "../host-connections";
import { fetchTailscalePeers } from "../api";
import type { TailscalePeer } from "../../../server/tailscale-peers";
import { store } from "../store";
import { useStore } from "../useStore";
import { useAnchoredMenu } from "./useAnchoredMenu";

function useConnections() {
  return useSyncExternalStore(subscribeHostConnections, getHostConnections, getHostConnections);
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
  const [open, setOpen] = useState(false);
  const [managing, setManaging] = useState(false);
  const [error, setError] = useState("");
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
  // 左键开独立窗口：Chrome --app 窗口里的 popup 继承同一 app 名，任务栏与 WB 归为一组；中键仍按浏览器默认开标签页。
  const openNewWindow = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    window.open(event.currentTarget.href, "_blank", `popup,noopener,noreferrer,width=${window.outerWidth},height=${window.outerHeight}`);
  };
  const choose = (origin: string, discovered = false) => {
    if (origin === currentOrigin) { close(true); return; }
    if (store.filePreview?.saving) { setError("文件正在保存，完成后再切换主机。"); return; }
    if (hostSwitchHasUnsentInput() && !window.confirm("当前有未发送的输入或附件，仍要切换主机？")) return;
    // 未保存文件继续由 store 的 beforeunload 保护；这里不清空文件、草稿，也不停止 worker。
    const next = discovered ? remember(origin) : connections;
    if (next) window.location.assign(hostNavigationUrl(origin, next));
  };
  const destinations = [
    ...(connections.localOrigin ? [{ origin: connections.localOrigin, name: localName ? `${localName}（本机）` : "本机" }] : []),
    ...(currentUnsaved ? [currentRemote, ...connections.remotes] : connections.remotes)
      .map(origin => ({ origin, name: connectionLabel(origin) })),
  ];
  // Chrome/Edge 的 --app 与安装的 PWA 都报 standalone；普通标签页里不需要这个入口。
  const standalone = typeof window !== "undefined" && window.matchMedia?.("(display-mode: standalone)").matches;
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands ?? [];
  const browserLabel = brands.some(b => b.brand === "Google Chrome") ? "在 Chrome 中打开" : "在浏览器中打开";
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
            className="host-menu-new-window" aria-label={`在新窗口打开 ${name}`} title="在新窗口打开" onClick={openNewWindow}>↗</a>
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
              aria-label={`在新窗口打开 ${peer.name}`} title="在新窗口打开"
              onClick={event => { openNewTab(event, peer.origin); openNewWindow(event); }}
              onAuxClick={event => { if (event.button === 1) openNewTab(event, peer.origin); }}>↗</a>
          </div>)}
        </>}
        {connections.remotes.length === 0 && <p className="settings-hint">添加另一台电脑的 Tailscale 地址后即可切换。</p>}
        {!connections.localOrigin && <p className="settings-hint">从电脑的本机 Workbench 进入远程后，可在这里返回本机。</p>}
        {currentUnsaved && <p className="settings-hint" role="status">列表已满，当前主机暂未保存。原有地址已保留，可在主机与连接中管理。</p>}
        {standalone && <a role="menuitem" className="host-menu-manage host-menu-browser" href={window.location.href}
          target="_blank" rel="noopener noreferrer" onClick={() => close(false)}>{browserLabel}</a>}
        <button type="button" role="menuitem" className="host-menu-manage" onClick={() => setManaging(true)}>管理主机…</button>
      </>}
      {error && <p className="host-connection-notice" role="alert">{error}</p>}
    </div>, document.body)}
  </div>;
}
