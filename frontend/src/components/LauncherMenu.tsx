import { useEffect, useId, useRef, useState } from "react";
import { fetchLinks, type LauncherLink } from "../api";
import { useAnchoredMenu } from "./useAnchoredMenu";

export function LauncherMenu({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<LauncherLink[]>([]);
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
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setLinks([]);
    fetchLinks().then((next) => {
      if (!cancelled) setLinks(next);
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);
  const groups = new Map<string, LauncherLink[]>();
  for (const link of links) {
    const group = link.group ?? "其他";
    groups.set(group, [...(groups.get(group) ?? []), link]);
  }
  return <div className="launcher" ref={rootRef}>
    <button type="button" className="launcher-button" ref={buttonRef} title="直达" aria-label="直达"
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen((value) => !value)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
        <path d="M14 10 20 4M15 4h5v5" />
      </svg>
      {!collapsed && <span>直达</span>}
    </button>
    {open && <div id={panelId} className="settings-panel launcher-panel" ref={panelRef} role="dialog" aria-label="直达链接" tabIndex={-1}>
      {loading ? <p className="settings-hint" role="status">读取中…</p> : error ? <p className="new-error" role="alert">{error}</p>
        : links.length === 0 ? <p className="settings-hint">在 pages/links.json 里添加链接</p>
        : [...groups].map(([group, items]) => <section className="settings-group" key={group}>
          <h3 className="settings-group-title">{group}</h3>
          {items.map((link, index) => <a className="launcher-link" key={index} href={link.url} target="_blank" rel="noopener noreferrer" onClick={() => close(true)}>
            {link.icon && <span className="launcher-link-icon" aria-hidden="true">{link.icon}</span>}
            <span className="launcher-link-name">{link.name}</span>
          </a>)}
        </section>)}
    </div>}
  </div>;
}
