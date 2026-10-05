import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  connectionLabel, getHostConnections, hostNavigationUrl, MAX_REMOTE_HOSTS,
  normalizeLocalOrigin, normalizeRemoteOrigin, saveHostConnections, subscribeHostConnections,
} from "../host-connections";
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
  const inputId = useId();
  const currentOrigin = new URL(window.location.href).origin;
  const write = (remotes: string[]) => {
    const saved = saveHostConnections({ ...connections, remotes });
    setNotice(saved ? "已保存。" : "浏览器无法保存设置，本页仍可使用这些地址。");
  };
  return <div className="host-connections-settings">
    <form className="host-address-form" onSubmit={event => {
      event.preventDefault();
      const origin = normalizeRemoteOrigin(address);
      if (!origin) { setNotice("请输入完整的 https://机器名.tail…ts.net 地址，不带路径或账号密码。"); return; }
      if (!connections.remotes.includes(origin) && connections.remotes.length >= MAX_REMOTE_HOSTS) {
        setNotice(`最多保存 ${MAX_REMOTE_HOSTS} 台远程主机。`); return;
      }
      write([...new Set([...connections.remotes, origin])]);
      setAddress("");
    }}>
      <label htmlFor={inputId}>Tailscale 地址</label>
      <div className="host-address-row">
        <input id={inputId} type="url" value={address} onChange={event => setAddress(event.target.value)}
          placeholder="https://机器名.tail…ts.net" autoComplete="off" spellCheck={false} required />
        <button type="submit" className="btn" disabled={!address.trim()}>添加</button>
      </div>
    </form>
    <p className="settings-hint">名称使用 Tailscale 的机器名。地址保存在这个浏览器，切换时会带到目标 Workbench。</p>
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
    setOpen(false);
    setManaging(false);
    setError("");
    if (returnFocus) buttonRef.current?.focus();
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

  const choose = (origin: string) => {
    if (origin === currentOrigin) { close(true); return; }
    if (store.filePreview?.saving) { setError("文件正在保存，完成后再切换主机。"); return; }
    if (hostSwitchHasUnsentInput() && !window.confirm("当前有未发送的输入或附件，仍要切换主机？")) return;
    // 未保存文件继续由 store 的 beforeunload 保护；这里不清空文件、草稿，也不停止 worker。
    window.location.assign(hostNavigationUrl(origin, connections));
  };
  const destinations = [
    ...(connections.localOrigin ? [{ origin: connections.localOrigin, name: localName ? `${localName}（本机）` : "本机" }] : []),
    ...(currentUnsaved ? [currentRemote, ...connections.remotes] : connections.remotes)
      .map(origin => ({ origin, name: connectionLabel(origin) })),
  ];
  return <div className="host-switcher" ref={rootRef}>
    <button type="button" className="brand host-switch-button" ref={buttonRef}
      aria-label={`选择主机，当前：${label}`} title={`当前：${normalizeLocalOrigin(currentOrigin) ? "本机" : `远程 ${label}`}，点击切换主机`}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => open ? close(false) : setOpen(true)}>
      <span className="brand-mark" aria-hidden="true">wb</span>
      <span className="brand-line" aria-hidden="true" />
      <span className="brand-name" aria-hidden="true">{label}</span>
    </button>
    {open && createPortal(<div className="host-switch-panel" ref={panelRef} id={panelId}
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
            className="host-menu-new-window" aria-label={`在新标签页打开 ${name}`} title="在新标签页打开">↗</a>
        </div>)}
        {connections.remotes.length === 0 && <p className="settings-hint">添加另一台电脑的 Tailscale 地址后即可切换。</p>}
        {!connections.localOrigin && <p className="settings-hint">从电脑的本机 Workbench 进入远程后，可在这里返回本机。</p>}
        {currentUnsaved && <p className="settings-hint" role="status">列表已满，当前主机暂未保存。原有地址已保留，可在主机与连接中管理。</p>}
        <button type="button" role="menuitem" className="host-menu-manage" onClick={() => setManaging(true)}>管理主机…</button>
      </>}
      {error && <p className="host-connection-notice" role="alert">{error}</p>}
    </div>, document.body)}
  </div>;
}
