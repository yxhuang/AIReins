export const BODY_FONT_STORAGE_KEY = "workbench-body-font";
export const BODY_FONT_MIN = 14;
export const BODY_FONT_MAX = 20;
export const BODY_FONT_STEP = 0.5;
type BodyFontSize = number;

/** 14–20、0.5 一档；其他值（含旧版存的 22）一律回到默认 16。 */
export function bodyFontSize(value: string | null): BodyFontSize {
  const size = Number(value);
  return value !== null && Number.isFinite(size) && size >= BODY_FONT_MIN && size <= BODY_FONT_MAX && Number.isInteger(size / BODY_FONT_STEP) ? size : 16;
}

export function readBodyFontSize(): BodyFontSize {
  try {
    return bodyFontSize(localStorage.getItem(BODY_FONT_STORAGE_KEY));
  } catch {
    return 16;
  }
}

export function applyBodyFontSize(size: BodyFontSize): void {
  document.documentElement.style.setProperty("--body-font-size", `${size}px`);
}
