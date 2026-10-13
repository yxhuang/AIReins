import { t } from "../i18n";
import { useEffect, useMemo, useRef } from "react";
import { directoryEntryDate, directoryEntrySize, sortedDirectoryEntries } from "../directory-path";
import type { DirectoryListing } from "../types";
import { CHROMIUM_DIRECTORY_HTML } from "../vendor/chromium-directory";

const TABLE_STYLE = `
html { color-scheme: light dark; }
body { margin: 0; background: var(--wb-bg); color: var(--wb-text); font: 14px/1.5 var(--wb-font, sans-serif); }
#header, #parentDirLinkBox { display: none !important; }
table { width: 100%; table-layout: fixed; }
th { position: sticky; top: 0; padding: 4px 6px; background: var(--wb-bg); color: var(--wb-text); font-size: 12px; }
th:nth-child(2) { width: 56px; } th:nth-child(3) { width: 128px; }
th[aria-sort="ascending"]::after { content: " ↑"; } th[aria-sort="descending"]::after { content: " ↓"; }
td { padding: 3px 6px; vertical-align: top; overflow-wrap: anywhere; }
td.detailsColumn { padding-inline-start: 6px; font-size: 12px; font-variant-numeric: tabular-nums; }
a.icon { display: block; min-height: 21px; padding-inline-start: 22px; background-position: 0 3px; color: var(--wb-link); }
a:focus-visible, th:focus-visible { outline: 2px solid var(--wb-link); outline-offset: -2px; border-radius: 3px; }
tbody tr:hover { background: var(--wb-hover); }
@media (max-width: 420px) {
  thead tr { display: grid; grid-template-columns: minmax(0,1fr) 56px 82px; }
  th:nth-child(n) { width: auto; } th { text-align: right; } th:first-child { text-align: left; }
  tbody tr { display: grid; grid-template-columns: 1fr auto; padding: 3px 0; }
  td:first-child { grid-column: 1 / -1; }
  td.detailsColumn { padding-top: 0; color: var(--wb-muted); } td:nth-child(2) { padding-left: 28px; text-align: left; }
}
@media (pointer: coarse) { a.icon { min-height: 26px; } tbody tr { min-height: 44px; } th { padding-top: 10px; padding-bottom: 10px; } }
`;

/** Trusted Chromium template; file names enter addRow as text, never HTML. */
function tableDocument(listing: DirectoryListing): string {
  const entries = sortedDirectoryEntries(listing, true, { key: "name", direction: "asc" });
  const rows = entries.map(entry => ({ ...entry, sizeText: entry.folder ? "" : directoryEntrySize(entry.size), dateText: directoryEntryDate(entry.modifiedAt) }));
  const data = JSON.stringify(rows).replaceAll("<", "\\u003c");
  const bridge = `<script>
const entries=${data};
const copy=${JSON.stringify({openFolder:t('ui.ChromeDirectoryTable.open_folder'),openFile:t('ui.ChromeDirectoryTable.open_file'),sort:t('ui.ChromeDirectoryTable.sort'),sortHint:t('ui.ChromeDirectoryTable.sort_hint')}).replaceAll('<', '\\u003c')};
for(const entry of entries) {
  addRow(entry.name, '', entry.folder, entry.size ?? -1, entry.sizeText, entry.modifiedAt ?? -1, entry.dateText);
  const row=document.getElementById('tbody').lastElementChild, link=row.querySelector('a');
  row.dataset.folder=String(entry.folder);
  row.cells[1].dataset.unknown=String(!entry.folder && entry.size == null);
  row.cells[2].dataset.unknown=String(entry.modifiedAt == null);
  link.href='#'; link.draggable=false; link.setAttribute('aria-label', entry.name);
  link.title=(entry.folder ? copy.openFolder : copy.openFile)+entry.path;
  link.addEventListener('click',event=>{event.preventDefault();parent.postMessage({type:'wb-directory-open',path:entry.path},'*')});
}
// Keep native ordering within each group; preserve AIReins folders-first/unknown-last behavior.
const nativeSort=sortTable;
sortTable=function(column) {
  nativeSort(column);
  const body=document.getElementById('tbody'),rows=Array.from(body.rows);
  rows.sort((a,b)=>Number(b.dataset.folder==='true')-Number(a.dataset.folder==='true') ||
    (column ? Number(a.cells[column].dataset.unknown==='true')-Number(b.cells[column].dataset.unknown==='true') : 0));
  for(const row of rows)body.appendChild(row);
  for(const [index,cell] of Array.from(document.getElementById('theader').cells).entries()) {
    cell.setAttribute('aria-pressed',String(index===column));
    cell.setAttribute('aria-sort',index===column ? cell.dataset.order==='1' ? 'ascending' : 'descending' : 'none');
  }
};
for(const [index,cell] of Array.from(document.getElementById('theader').cells).entries()) {
  cell.setAttribute('aria-label',copy.sort.replace('{name}',cell.textContent.trim()));
  cell.title=copy.sortHint.replace('{name}',cell.textContent.trim());
  cell.setAttribute('aria-sort',index===0?'ascending':'none');
}
window.addEventListener('message',event=>{
  if(event.source!==parent || event.data?.type!=='wb-directory-theme')return;
  for(const [key,value] of Object.entries(event.data.values))document.documentElement.style.setProperty(key,value);
  document.documentElement.style.colorScheme=event.data.scheme;
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){event.preventDefault();parent.postMessage({type:'wb-directory-escape'},'*')}
});
</script>`;
  return CHROMIUM_DIRECTORY_HTML
    .replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`)
    .replace("</head>", `<style>${TABLE_STYLE}</style></head>`)
    .replace("</body>", `${bridge}</body>`);
}

export function ChromeDirectoryTable({ listing, busy, onActivate }: {
  listing: DirectoryListing;
  busy: boolean;
  onActivate: (path: string, name: string, folder: boolean) => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const srcDoc = useMemo(() => tableDocument(listing), [listing]);
  const updateTheme = () => {
    const style = getComputedStyle(frame.current!);
    const values = Object.fromEntries([
      ["--wb-bg", "--bg"], ["--wb-text", "--text"], ["--wb-muted", "--text-muted"],
      ["--wb-link", "--busy"], ["--wb-hover", "--surface-sunk"], ["--wb-font", "--font-ui"],
    ].map(([key, token]) => [key, style.getPropertyValue(token!).trim()]));
    frame.current?.contentWindow?.postMessage({ type: "wb-directory-theme", values, scheme: style.colorScheme }, "*");
  };
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (busy || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "wb-directory-escape") {
        frame.current?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      } else if (event.data?.type === "wb-directory-open" && typeof event.data.path === "string") {
        const entry = listing.dirs.find(entry => entry.path === event.data.path) ?? listing.files?.find(entry => entry.path === event.data.path);
        if (entry) onActivate(entry.path, entry.name, listing.dirs.includes(entry));
      }
    };
    window.addEventListener("message", listener);
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => { window.removeEventListener("message", listener); observer.disconnect(); };
  }, [listing, busy, onActivate]);
  return <iframe ref={frame} className="dir-native-table" title={t("ui.common.directories_and_files")} sandbox="allow-scripts" srcDoc={srcDoc}
    aria-disabled={busy} tabIndex={busy ? -1 : undefined} onLoad={updateTheme} />;
}
