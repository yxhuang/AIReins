import coreZh from "./i18n/core.zh-CN.js";
import coreEn from "./i18n/core.en.js";
import uiZh from "./i18n/ui.zh-CN.js";
import uiEn from "./i18n/ui.en.js";
import serverZh from "./i18n/server.zh-CN.js";
import serverEn from "./i18n/server.en.js";

export type Locale = "zh-CN" | "en";
export type LanguagePreference = "system" | Locale;
export const LANGUAGE_STORAGE_KEY = "workbench-language";
import { PRODUCT_NAME } from "../../shared/product-name.js";
export { PRODUCT_NAME };
export const dictionaries: Record<Locale, Record<string, string>> = {
  "zh-CN": { ...coreZh, ...uiZh, ...serverZh },
  en: { ...coreEn, ...uiEn, ...serverEn },
};
export function languagePreference(value: unknown): LanguagePreference {
  return value === "zh-CN" || value === "en" ? value : "system";
}
export function readLanguagePreference(): LanguagePreference {
  try { return languagePreference(localStorage.getItem(LANGUAGE_STORAGE_KEY)); }
  catch { return "system"; }
}
export function resolveLocale(preference: LanguagePreference, systemLanguage: string): Locale {
  return preference === "system" ? (/^zh/i.test(systemLanguage) ? "zh-CN" : "en") : preference;
}
const currentLocale = resolveLocale(readLanguagePreference(), typeof navigator === "undefined" ? "en" : navigator.language);
export function getLocale(): Locale { return currentLocale; }
/** The selected preference applies on page reload, including module-level labels. */
export function setLanguagePreference(value: LanguagePreference): boolean {
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, languagePreference(value)); return true; }
  catch { return false; }
}
// 最简 ICU 复数：{name, plural, one {…#…} other {…#…}}，# 替换为按语言格式化的数量。
// 只有数量参数为有限数字（或纯数字字符串）时才展开，否则保留原文。
const pluralBlock = /\{(\w+),\s*plural,\s*one\s*\{([^{}]*)\}\s*other\s*\{([^{}]*)\}\}/g;
export function interpolate(template: string, params: Record<string, string | number> = {}): string {
  const rules = new Intl.PluralRules(getLocale());
  const resolved = template.replace(pluralBlock, (block, name: string, one: string, other: string) => {
    const value = params[name];
    const count = typeof value === "number" ? value
      : typeof value === "string" && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : NaN;
    if (!Number.isFinite(count)) return block;
    return (rules.select(count) === "one" ? one : other).replaceAll("#", formatNumber(count));
  });
  return resolved.replace(/\{(\w+)\}/g, (match, name: string) => name === "product" ? PRODUCT_NAME
    : Object.hasOwn(params, name) ? (typeof params[name] === "number" ? formatNumber(params[name] as number) : String(params[name])) : match);
}
export function t(key: string, params?: Record<string, string | number>): string {
  return interpolate(dictionaries[getLocale()][key] ?? dictionaries.en[key] ?? dictionaries["zh-CN"][key] ?? key, params);
}
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(getLocale(), options).format(value);
}
export function formatDate(value: string | number | Date, options?: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat(getLocale(), options).format(new Date(value));
}
export function formatRelativeTime(value: number, unit: Intl.RelativeTimeFormatUnit): string {
  return new Intl.RelativeTimeFormat(getLocale(), { numeric: "always" }).format(value, unit);
}
export interface MessageDescriptor {
  key: string;
  params?: Record<string, string>;
  localizedParams?: Record<string, MessageDescriptor>;
}
function descriptorText(descriptor: MessageDescriptor, fallback: string): string {
  if (!dictionaries[getLocale()][descriptor.key]) return fallback;
  const params = { ...descriptor.params };
  for (const [key, value] of Object.entries(descriptor.localizedParams ?? {})) params[key] = descriptorText(value, params[key] ?? "");
  return t(descriptor.key, params);
}
/** Only explicit server metadata is translated; user and model content stays verbatim. */
export function localizeServerData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(localizeServerData) as T;
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  const result = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, key === "i18n" ? item : localizeServerData(item)]));
  if (record.i18n && typeof record.i18n === "object") {
    for (const [field, descriptor] of Object.entries(record.i18n)) {
      if (Array.isArray(result[field]) && Array.isArray(descriptor)) {
        result[field] = (result[field] as unknown[]).map((item, index) => typeof item === "string" && descriptor[index] ? descriptorText(descriptor[index], item) : item);
      } else if (typeof result[field] === "string" && descriptor && typeof descriptor === "object" && typeof descriptor.key === "string") {
        result[field] = descriptorText(descriptor as MessageDescriptor, result[field] as string);
      }
    }
  }
  return result as T;
}
