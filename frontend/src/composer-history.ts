import { useLayoutEffect, useRef, type KeyboardEvent } from "react";

const STORAGE_KEY = "workbench-composer-history";
const MAX_ENTRIES = 100;
const MAX_STORAGE_CHARS = 256 * 1024;
let storagePrefix = "";
let connected = false;
// 无痕或存储空间不足时，本页仍可使用输入历史。
let transient: string[] | undefined;

export function connectComposerHistory(instanceId: string): void {
  const prefix = `${instanceId}\n`;
  connected = true;
  if (storagePrefix === prefix) return;
  storagePrefix = prefix;
  transient = undefined;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw !== null && !raw.startsWith(prefix)) localStorage.removeItem(STORAGE_KEY);
  } catch { /* 存储不可用时仅用内存 */ }
}

export function disconnectComposerHistory(serverStopped = false): void {
  connected = false;
  if (!serverStopped || !storagePrefix) return;
  try {
    if (localStorage.getItem(STORAGE_KEY)?.startsWith(storagePrefix)) localStorage.removeItem(STORAGE_KEY);
  } catch { /* 下次连接会校验进程标识 */ }
  storagePrefix = "";
  transient = undefined;
}

export function readComposerHistory(): string[] {
  if (!connected) return [];
  if (transient) return transient;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw?.startsWith(storagePrefix) || raw.length > MAX_STORAGE_CHARS + storagePrefix.length) return [];
    const entries: unknown = JSON.parse(raw.slice(storagePrefix.length));
    return Array.isArray(entries)
      ? entries.filter((item): item is string => typeof item === "string" && !!item.trim()).slice(0, MAX_ENTRIES)
      : [];
  } catch {
    return [];
  }
}

export function rememberComposerInput(input: string): void {
  if (!connected) return;
  const text = input.trim();
  if (!text || text.length > MAX_STORAGE_CHARS) return;
  const next: string[] = [];
  let size = 2;
  for (const entry of [text, ...readComposerHistory().filter(item => item !== text)].slice(0, MAX_ENTRIES)) {
    size += JSON.stringify(entry).length + 1;
    if (size > MAX_STORAGE_CHARS) break;
    next.push(entry);
  }
  if (!next.length) return;
  try {
    localStorage.setItem(STORAGE_KEY, storagePrefix + JSON.stringify(next));
    transient = undefined;
  } catch {
    transient = next;
  }
}

type InputPosition = { text: string; caret: number };
type Browse = { draft: InputPosition; entry: string };

export function moveComposerHistory(
  entries: readonly string[], current: InputPosition, browse: Browse | null, key: "ArrowUp" | "ArrowDown",
): (InputPosition & { browse: Browse | null }) | null {
  const active = browse?.entry === current.text ? browse : null;
  const index = active ? entries.indexOf(active.entry) : -1;
  const atEnd = current.caret === current.text.length;
  if (key === "ArrowDown") {
    if (!active || !atEnd) return null;
    if (index <= 0) return { ...active.draft, browse: null };
  } else {
    const onFirstLine = !current.text.slice(0, current.caret).includes("\n");
    if (!entries.length || (!onFirstLine && !(active && atEnd))) return null;
  }
  const nextIndex = key === "ArrowUp" ? Math.min(index + 1, entries.length - 1) : index - 1;
  const text = entries[nextIndex]!;
  return { text, caret: text.length, browse: { draft: active?.draft ?? current, entry: text } };
}

export function useComposerHistory(value: string, setValue: (value: string) => void) {
  const browse = useRef<Browse | null>(null);
  const selection = useRef<{ field: HTMLTextAreaElement; caret: number } | null>(null);
  useLayoutEffect(() => {
    const next = selection.current;
    if (!next) return;
    selection.current = null;
    next.field.setSelectionRange(next.caret, next.caret);
  }, [value]);

  return {
    reset() { browse.current = null; },
    onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): number | null {
      const { key, currentTarget: field } = event;
      if ((key !== "ArrowUp" && key !== "ArrowDown") || event.defaultPrevented ||
        event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || field.selectionStart !== field.selectionEnd ||
        (key === "ArrowDown" && !browse.current)) return null;
      const next = moveComposerHistory(readComposerHistory(), { text: field.value, caret: field.selectionStart }, browse.current, key);
      if (!next) return null;
      event.preventDefault();
      browse.current = next.browse;
      if (field.value === next.text) field.setSelectionRange(next.caret, next.caret);
      else {
        selection.current = { field, caret: next.caret };
        setValue(next.text);
      }
      return next.caret;
    },
  };
}
