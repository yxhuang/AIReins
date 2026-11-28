export function dispatchExternalUrl(value: unknown): string | null {
  if (typeof value !== "string" || !/^https?:\/\/[^/?#]/iu.test(value) || /[\s\p{Cc}\\]/u.test(value)) return null;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}
