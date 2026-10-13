export const BODY_FONT_STORAGE_KEY = "workbench-body-font";
export const BODY_FONT_MIN = 13;
export const BODY_FONT_MAX = 20;
export const BODY_FONT_STEP = 0.5;
type BodyFontSize = number;

/** 13–20、0.5 一档；其他值（含旧版存的 22）一律回到默认 15。 */
export function bodyFontSize(value: string | null): BodyFontSize {
  const size = Number(value);
  return value !== null && Number.isFinite(size) && size >= BODY_FONT_MIN && size <= BODY_FONT_MAX && Number.isInteger(size / BODY_FONT_STEP) ? size : 15;
}

export function readBodyFontSize(): BodyFontSize {
  try {
    return bodyFontSize(localStorage.getItem(BODY_FONT_STORAGE_KEY));
  } catch {
    return 15;
  }
}

/** 终端字号（设置滑块，按设备存在本机）：未设置为 null = 按界面字号自动（宽屏 16、手机 13，乘字号档）。 */
export const TERM_FONT_STORAGE_KEY = "workbench-term-font";
export const TERM_FONT_MIN = 10;
export const TERM_FONT_MAX = 24;

export function termFontSize(value: string | null): number | null {
  const size = Number(value);
  return value !== null && Number.isInteger(size) && size >= TERM_FONT_MIN && size <= TERM_FONT_MAX ? size : null;
}

export function readTermFontSetting(): number | null {
  try {
    return termFontSize(localStorage.getItem(TERM_FONT_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** 终端实际字号：设置过就用设置值，否则按界面字号自动。 */
export function readTermFontSize(): number {
  const set = readTermFontSetting();
  if (set !== null) return set;
  if (typeof getComputedStyle !== "function") return 16; // 服务端渲染（测试）没有 DOM
  // Read the applied value, so storage failures do not prevent live updates.
  const scale = Number(getComputedStyle(document.documentElement).getPropertyValue("--font-scale"));
  // 宽屏对齐用户 VSCode 终端的 16px；手机窄屏 13px，不然一行放不下几个字
  const base = window.matchMedia("(max-width: 720px)").matches ? 13 : 16;
  return base * (Number.isFinite(scale) && scale > 0 ? scale : 1);
}

export function applyBodyFontSize(size: BodyFontSize): void {
  document.documentElement.style.setProperty("--body-font-size", `${size}px`);
}
