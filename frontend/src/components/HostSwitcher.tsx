import { t } from "../i18n";
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
const BRAND_R = "M88 82 V14 H104 C128 14 128 52 104 52 H90";
const BRAND_R_LEG = "M100 52 C106 62 110 70 117 76 C122 81 130 82 134 76";

/** 品牌标志 AR：R 是一根带缝线的皮缰绳摆成，尾端绕成缰绳圈；单色随文字色，尺寸随外层字号。 */
export function BrandMark() {
  const maskId = `brand-stitch-${useId().replace(/[^\w-]/g, "")}`;
  return <svg className="brand-glyph" viewBox="-1 5 146 86" width="1.7em" height="1em" aria-hidden="true">
    <defs>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="-10" y="-10" width="170" height="120">
        <rect x="-10" y="-10" width="170" height="120" fill="white" />
        <g fill="none" stroke="black" strokeWidth="2.6" strokeDasharray="5 4" strokeLinecap="round" strokeLinejoin="round">
          <path d={BRAND_R} /><path d={BRAND_R_LEG} />
        </g>
      </mask>
    </defs>
    <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" mask={`url(#${maskId})`}>
      <path d="M6 80 L36 14 L66 80 M19 58 H53" strokeWidth="13" />
      <path d={BRAND_R} strokeWidth="15" />
      <path d={BRAND_R_LEG} strokeWidth="15" />
      <path d="M134 76 C138 69 129 64 125 71 C122 77 129 84 137 85" strokeWidth="8" />
    </g>
  </svg>;
}

export function openNewWindow(event: MouseEvent<HTMLAnchorElement>, standalone: boolean) {
  if (!standalone || event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  window.open(event.currentTarget.href, "_blank", `popup,noopener,noreferrer,width=${window.outerWidth},height=${window.outerHeight}`);
}

export function browserNavigationUrl(url: string, iosStandalone: boolean): string {
  // iOS 主屏 App 会把普通 HTTPS 链接留在内置页面；Safari scheme 交给外部 Safari。
  return iosStandalone ? url.replace(/^https:/i, "x-safari-https:") : url;
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
    setNotice(saved ? t("ui.HostSwitcher.saved") : t("ui.HostSwitcher.this_browser_cannot_save_settings_these_addresses"));
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
        const completed = address.trim() !== origin ? t("ui.HostSwitcher.completed_as", { p0: (origin) }) : "";
        setNotice(completed + (saved ? t("ui.HostSwitcher.saved") : t("ui.HostSwitcher.this_browser_cannot_save_settings_these_addresses")));
        setAddress("");
      } catch (error) { setNotice((error as Error).message); }
      finally { setAdding(false); }
    }}>
      <label htmlFor={inputId}>{t("ui.HostSwitcher.tailscale_address")}</label>
      <div className="host-address-row">
        <input id={inputId} type="text" value={address} onChange={event => setAddress(event.target.value)}
          placeholder={t("ui.HostSwitcher.host_name_tailscale_ip_or_https_ts")} autoComplete="off" spellCheck={false} required disabled={adding} />
        <button type="submit" className="btn" disabled={adding || !address.trim()}>{adding ? t("ui.HostSwitcher.adding") : t("ui.HostSwitcher.add")}</button>
      </div>
    </form>
    <p className="settings-hint">{t("ui.HostSwitcher.enter_a_tailscale_ip_host_name_or")}</p>
    {connections.remotes.length > 0 && <ul className="host-saved-list">
      {connections.remotes.map(origin => <li key={origin}>
        <span className="host-saved-address"><strong>{connectionLabel(origin)}</strong><span>{origin}</span></span>
        <button type="button" className="host-remove" disabled={origin === currentOrigin}
          aria-label={t("ui.HostSwitcher.remove_host", { p0: (connectionLabel(origin)) })} title={origin === currentOrigin ? t("ui.HostSwitcher.connected_host") : t("ui.HostSwitcher.remove_from_connection_list")}
          onClick={() => write(connections.remotes.filter(value => value !== origin))}>{t("ui.common.remove")}</button>
      </li>)}
    </ul>}
    {notice && <p className="host-connection-notice" role="status">{notice}</p>}
  </div>;
}

/** 设置里的「主机与连接」派发此事件，直接打开顶部主机菜单。 */
export const OPEN_HOST_MENU_EVENT = "workbench-open-host-menu";

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
  useEffect(() => {
    const onOpen = () => openMenu();
    window.addEventListener(OPEN_HOST_MENU_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_HOST_MENU_EVENT, onOpen);
  }, []);
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
      if (!saveHostConnections(next)) setError(t("ui.HostSwitcher.this_browser_cannot_save_settings_these_addresses"));
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
  const ios = /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const mobile = ios || /Android/i.test(navigator.userAgent);
  // 手机主屏 App 只在添加时的源内全屏，跳到别的电脑会被系统套上浏览器栏：改为提示用那台电脑自己的主屏图标。
  const homeScreenHint = (origin: string) => {
    if (!standalone || !mobile || origin === currentOrigin) return false;
    setError(t("ui.HostSwitcher.switching_inside_a_home_screen_app_shows", { p0: (connectionLabel(origin)), p1: (origin) }));
    return true;
  };
  const choose = (origin: string, discovered = false) => {
    if (origin === currentOrigin) { close(true); return; }
    if (homeScreenHint(origin)) return;
    if (store.fileSaving) { setError(t("ui.HostSwitcher.a_file_is_being_saved_wait_before")); return; }
    if (hostSwitchHasUnsentInput() && !window.confirm(t("ui.HostSwitcher.you_have_unsent_input_or_attachments_switch"))) return;
    // 未保存文件继续由 store 的 beforeunload 保护；这里不清空文件、草稿，也不停止 worker。
    const next = discovered ? remember(origin) : connections;
    if (next) window.location.assign(hostNavigationUrl(origin, next));
  };
  const destinations = [
    ...(connections.localOrigin ? [{ origin: connections.localOrigin, name: localName ? t("ui.HostSwitcher.local", { p0: (localName) }) : t("ui.HostSwitcher.local_2") }] : []),
    ...(currentUnsaved ? [currentRemote, ...connections.remotes] : connections.remotes)
      .map(origin => ({ origin, name: connectionLabel(origin) }))
      // 本机自己的 Tailscale 地址与「本机」是同一台，不重复列出
      .filter(({ origin, name }) => !(connections.localOrigin && name === localName && origin !== currentOrigin)),
  ];
  const brands = (navigator as Navigator & { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands ?? [];
  const browserLabel = brands.some(b => b.brand === "Google Chrome") ? t("ui.HostSwitcher.open_in_chrome") : t("ui.HostSwitcher.open_in_browser");
  const canOpenApp = !standalone && !mobile && isLocal && appWindow === true;
  const openInApp = async () => {
    if (openingApp) return;
    if (store.fileSaving) { setError(t("ui.HostSwitcher.a_file_is_being_saved_wait_before_2")); return; }
    if (hostSwitchHasUnsentInput() && !window.confirm(t("ui.HostSwitcher.you_have_unsent_input_or_attachments_open"))) return;
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
      aria-label={t("ui.HostSwitcher.select_host_current", { p0: (label) })} title={t("ui.HostSwitcher.current_click_to_switch_hosts", { p0: (normalizeLocalOrigin(currentOrigin) ? t("ui.HostSwitcher.local_detail") : t("ui.HostSwitcher.remote_detail", { p0: (label) })) })}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? panelId : undefined}
      onClick={() => open ? close(false) : openMenu()}>
      <span className="brand-mark" aria-hidden="true"><BrandMark /></span>
      <span className="brand-line" aria-hidden="true" />
      <span className="brand-name" aria-hidden="true">{label}</span>
      <span className="brand-short" aria-hidden="true">{hostShortName(isLocal ? localName ?? "" : label)}</span>
    </button>
    {open && createPortal(<div className={`host-switch-panel${managing ? " managing" : ""}`} ref={panelRef} id={panelId}
      role={managing ? "dialog" : "menu"} aria-label={managing ? t("ui.HostSwitcher.hosts_and_connections") : t("ui.HostSwitcher.select_host")}
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
      <p className="host-switch-current">{t("ui.HostSwitcher.current_sentence", { p0: (normalizeLocalOrigin(currentOrigin) ? t("ui.HostSwitcher.local_2") : t("ui.HostSwitcher.remote", { p0: (label) })) })}</p>
      {managing ? <>
        <HostConnectionSettings />
        <button type="button" className="host-menu-manage" onClick={() => setManaging(false)}>{t("ui.HostSwitcher.back_to_host_list")}</button>
      </> : <>
        {destinations.map(({ origin, name }) => <div className="host-menu-row" role="none" key={origin}>
          <button type="button" role="menuitemradio" aria-checked={origin === currentOrigin}
            className="host-menu-target" title={origin} onClick={() => choose(origin)}>
            <span className="host-menu-check" aria-hidden="true">{origin === currentOrigin ? "✓" : ""}</span>
            <span className="host-menu-name">{name}</span>
          </button>
          <a role="menuitem" href={hostNavigationUrl(origin, connections)} target="_blank" rel="noopener noreferrer"
            className="host-menu-new-window" aria-label={t("ui.HostSwitcher.open_in_a_new", { p0: (standalone ? t("ui.HostSwitcher.window_detail") : t("ui.HostSwitcher.tab_detail")), p1: (name) })}
            title={standalone ? t("ui.HostSwitcher.open_in_a_new_window") : t("ui.common.open_in_a_new_tab")} onClick={event => { if (homeScreenHint(origin)) event.preventDefault(); else openNewWindow(event, !!standalone); }}>↗</a>
        </div>)}
        {discovered.length > 0 && <>
          <p className="host-menu-section">{t("ui.HostSwitcher.other_computers_on_tailscale")}</p>
          {discovered.map(peer => <div className={`host-menu-row${peer.online ? "" : " host-menu-offline"}`} role="none" key={peer.origin}>
            <button type="button" role="menuitem" className="host-menu-target" title={peer.origin} onClick={() => choose(peer.origin, true)}>
              <span className="host-menu-check" aria-hidden="true" />
              <span className="host-menu-name">{peer.name}{!peer.online && <span className="host-menu-status">{t("ui.common.offline")}</span>}</span>
            </button>
            <a role="menuitem" href={hostNavigationUrl(peer.origin, { ...connections, remotes: [...connections.remotes, peer.origin] })}
              target="_blank" rel="noopener noreferrer" className="host-menu-new-window"
              aria-label={t("ui.HostSwitcher.open_in_a_new", { p0: (standalone ? t("ui.HostSwitcher.window_detail") : t("ui.HostSwitcher.tab_detail")), p1: (peer.name) })} title={standalone ? t("ui.HostSwitcher.open_in_a_new_window") : t("ui.common.open_in_a_new_tab")}
              onClick={event => { if (homeScreenHint(peer.origin)) { event.preventDefault(); return; } openNewTab(event, peer.origin); openNewWindow(event, !!standalone); }}
              onAuxClick={event => { if (event.button === 1) openNewTab(event, peer.origin); }}>↗</a>
          </div>)}
        </>}
        <button type="button" role="menuitem" className="host-menu-manage host-menu-list-action" onClick={() => setManaging(true)}>{t("ui.HostSwitcher.manage_hosts")}</button>
        {connections.remotes.length === 0 && <p className="settings-hint">{t("ui.HostSwitcher.add_another_computer_s_tailscale_address_to")}</p>}
        {!connections.localOrigin && <p className="settings-hint">{t("ui.HostSwitcher.after_entering_a_remote_host_from_your")}</p>}
        {currentUnsaved && <p className="settings-hint" role="status">{t("ui.HostSwitcher.the_list_is_full_the_current_host")}</p>}
        {standalone && <a role="menuitem" className="host-menu-manage host-menu-browser" href={browserNavigationUrl(window.location.href, ios)}
          target="_blank" rel="noopener noreferrer" onClick={() => close(false)}>{browserLabel}</a>}
        {canOpenApp && <button type="button" role="menuitem" className="host-menu-manage host-menu-browser"
          title={t("ui.HostSwitcher.open_this_page_in_a_separate_window")} disabled={openingApp} onClick={() => void openInApp()}>
          {openingApp ? t("ui.HostSwitcher.opening") : t("ui.HostSwitcher.open_in_a_window")}
        </button>}
      </>}
      {error && <p className="host-connection-notice" role="alert">{error}</p>}
    </div>, document.body)}
  </div>;
}
