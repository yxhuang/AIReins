import { t } from "../i18n";
import { useEffect, useId, useRef, useState } from "react";
import { fetchLinks, type LauncherLink } from "../api";
import { useAnchoredMenu } from "./useAnchoredMenu";
import { isInlineSvg } from "../pages";
import { AgentIcon } from "./AgentIcon";

function LauncherLinkIcon({ link, fallback = false }: { link: LauncherLink; fallback?: boolean }) {
  const { icon, name } = link;
  if (!icon && !fallback) return null;
  const agent = /^agent:(claude|antigravity|codex|kimi|grok-bot)$/.exec(icon ?? "")?.[1] as
    Parameters<typeof AgentIcon>[0]["agent"] | undefined;
  // 与扩展页 manifest 同一信任边界：links.json 由用户维护，内联 SVG 按 HTML 渲染。
  if (icon && isInlineSvg(icon)) {
    return <span className="launcher-link-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon }} />;
  }
  return <span className="launcher-link-icon" aria-hidden="true">
    {agent ? <AgentIcon agent={agent} label={name} /> : icon ??
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13 5h6v6m0-6-9 9m9 0v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h4" />
      </svg>}
  </span>;
}

export function LauncherPinnedLinks({ links, onNavigate }: { links: LauncherLink[]; onNavigate: () => void }) {
  return links.filter((link) => link.pinned === true).slice(0, 2).map((link, index) =>
    <a className="launcher-pinned-button" key={index} href={link.url} target="_blank" rel="noopener noreferrer"
      title={link.name} aria-label={link.name} onClick={onNavigate}>
      <LauncherLinkIcon link={link} fallback />
    </a>);
}

export function LauncherMenu({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<LauncherLink[]>([]);
  const [refreshCount, setRefreshCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  };
  useAnchoredMenu({ open, rootRef, buttonRef, panelRef, close, initialFocus: "a[href]" });
  const toggle = () => {
    if (open) {
      close(false);
      return;
    }
    setLoading(true);
    setError("");
    setOpen(true);
    setRefreshCount((count) => count + 1);
  };
  useEffect(() => {
    let cancelled = false;
    // StrictMode 会立即取消第一次 effect，等这个检查后再发请求。
    Promise.resolve().then(() => cancelled ? undefined : fetchLinks()).then((next) => {
      if (!cancelled && next) setLinks(next);
    }).catch((cause: unknown) => {
      if (!cancelled && refreshCount > 0) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshCount]);
  const groups = new Map<string, LauncherLink[]>();
  for (const link of links) {
    const group = link.group ?? t("ui.LauncherMenu.other");
    groups.set(group, [...(groups.get(group) ?? []), link]);
  }
  return <div className="launcher" ref={rootRef}>
    <LauncherPinnedLinks links={links} onNavigate={() => close(false)} />
    <button type="button" className="launcher-button" ref={buttonRef} title={t("ui.LauncherMenu.quick_links")} aria-label={t("ui.LauncherMenu.quick_links")}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={toggle}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
        <path d="M14 10 20 4M15 4h5v5" />
      </svg>
      {!collapsed && <span>{t("ui.LauncherMenu.quick_links")}</span>}
    </button>
    {open && <div id={panelId} className="settings-panel launcher-panel" ref={panelRef} role="dialog" aria-label={t("ui.LauncherMenu.quick_links_2")} tabIndex={-1}>
      {loading ? <p className="settings-hint" role="status">{t("ui.common.reading_2")}</p> : error ? <p className="new-error" role="alert">{error}</p>
        : links.length === 0 ? <p className="settings-hint">{t("ui.LauncherMenu.add_links_in_pages_links_json")}</p>
        : [...groups].map(([group, items]) => <section className="settings-group" key={group}>
          <h3 className="settings-group-title">{group}</h3>
          {items.map((link, index) => <a className="launcher-link" key={index} href={link.url} target="_blank" rel="noopener noreferrer" onClick={() => close(true)}>
            <LauncherLinkIcon link={link} />
            <span className="launcher-link-name">{link.name}</span>
          </a>)}
        </section>)}
    </div>}
  </div>;
}
