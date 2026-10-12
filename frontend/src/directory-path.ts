import { getLocale } from "./i18n";
/** 接受资源管理器的盘符路径（含“复制为路径”的双引号）；保留 Linux 路径中的反斜杠。 */
export function normalizeDirectoryPath(value: string, windowsPaths = true): string {
  let path = value.trim();
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  const drive = /^([a-z]):[\\/](.*)$/is.exec(path);
  return drive && windowsPaths ? `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replaceAll("\\", "/")}` : path;
}

export function recentDirectoryPaths(sessions: readonly { cwd: string; lastActivityAt: string }[], extra: readonly string[] = [], windowsPaths = true): string[] {
  const ordered = [...sessions].sort((a, b) => (Date.parse(b.lastActivityAt) || 0) - (Date.parse(a.lastActivityAt) || 0));
  return [...new Set([...extra, ...ordered.map(session => session.cwd)].map(path => normalizeDirectoryPath(path, windowsPaths)).filter(path => path.startsWith("/")))].slice(0, 8);
}

export function directoryBreadcrumbs(path: string, windowsPaths = true): { label: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const windows = windowsPaths && parts[0] === "mnt" && /^[a-z]$/i.test(parts[1] ?? "");
  let current = windows ? `/mnt/${parts[1]}` : "";
  const crumbs = [{ label: windows ? `${parts[1]?.toUpperCase()}:` : "/", path: current || "/" }];
  for (const part of parts.slice(windows ? 2 : 0)) {
    current += `/${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

export type DirectorySort = { key: "name" | "size" | "modifiedAt"; direction: "asc" | "desc" };
const names = new Intl.Collator(getLocale(), { numeric: true, sensitivity: "base" });

/** 文件夹始终在前；未知元数据始终在同类末尾，不把缺失值当成零。 */
export function sortedDirectoryEntries(listing: DirectoryListing | null, includeFiles: boolean, sort: DirectorySort) {
  const entries = [...(listing?.dirs ?? []).map(entry => ({ ...entry, folder: true })),
    ...(includeFiles ? listing?.files ?? [] : []).map(entry => ({ ...entry, folder: false }))];
  return entries.sort((a, b) => {
    if (a.folder !== b.folder) return a.folder ? -1 : 1;
    if (sort.key !== "name") {
      const left = a[sort.key], right = b[sort.key];
      const leftKnown = typeof left === "number" && Number.isFinite(left);
      const rightKnown = typeof right === "number" && Number.isFinite(right);
      if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
      if (leftKnown && rightKnown && left !== right) return (left - right) * (sort.direction === "asc" ? 1 : -1);
    }
    const order = names.compare(a.name, b.name);
    return sort.key === "name" && sort.direction === "desc" ? -order : order;
  });
}

export function directoryEntrySize(size: number | null | undefined): string {
  if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return "—";
  if (size < 1024) return `${size} B`;
  const unit = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
  return `${Number((size / 1024 ** unit).toFixed(1))} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}

const dates = new Intl.DateTimeFormat(getLocale(), { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
export function directoryEntryDate(time: number | null | undefined): string {
  return typeof time === "number" && Number.isFinite(time) && !Number.isNaN(new Date(time).getTime()) ? dates.format(time) : "—";
}
import type { DirectoryListing } from "./types";
