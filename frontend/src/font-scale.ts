export const FONT_SCALE_STORAGE_KEY = "workbench-font-scale";
export const FONT_SCALE_EVENT = "workbench-font-scale-changed";

export const FONT_SCALES = {
  small: 0.9,
  default: 1,
  large: 1.15,
  xlarge: 1.3,
} as const;

export type FontScaleChoice = keyof typeof FONT_SCALES;

export function fontScaleChoice(value: string | null): FontScaleChoice {
  return value !== null && Object.hasOwn(FONT_SCALES, value)
    ? value as FontScaleChoice
    : "default";
}

export function readFontScaleChoice(): FontScaleChoice {
  try {
    return fontScaleChoice(localStorage.getItem(FONT_SCALE_STORAGE_KEY));
  } catch {
    return "default";
  }
}

export function fontScale(value: string | null): number {
  return FONT_SCALES[fontScaleChoice(value)];
}
