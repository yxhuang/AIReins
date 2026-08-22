import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

const DEFAULT_PAGES_ROOT = resolve(fileURLToPath(new URL("../pages", import.meta.url)));
const PAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
export const PAGE_HEALTH_TIMEOUT_MS = 2_000;

export interface IframePageManifest {
  id: string;
  name: string;
  icon: string;
  type: "iframe";
  url: string;
  healthCheck?: string;
  description?: string;
}

export type PageManifest = IframePageManifest;

export interface PageHealth {
  id: string;
  reachable: boolean;
  reason: string;
  status?: number;
  durationMs: number;
}

export function scanPages(root = DEFAULT_PAGES_ROOT): PageManifest[] {
  let directories;
  try {
    directories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    log("warn", "pages directory scan failed", { root, reason: errorMessage(error) });
    return [];
  }

  const pages: PageManifest[] = [];
  const ids = new Set<string>();
  for (const directory of directories) {
    const manifestPath = join(root, directory.name, "manifest.json");
    try {
      const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
      if (ids.has(manifest.id)) throw new Error(`id 重复：${manifest.id}`);
      ids.add(manifest.id);
      pages.push(manifest);
    } catch (error) {
      log("warn", "page manifest skipped", {
        directory: directory.name,
        manifestPath,
        reason: errorMessage(error),
      });
    }
  }
  return pages;
}

export async function checkPageHealth(
  page: PageManifest,
  timeoutMs = PAGE_HEALTH_TIMEOUT_MS,
): Promise<PageHealth> {
  const started = performance.now();
  try {
    const response = await fetch(page.healthCheck ?? page.url, {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel().catch(() => undefined);
    return {
      id: page.id,
      reachable: true,
      reason: `HTTP ${response.status}`,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
    };
  } catch (error) {
    return {
      id: page.id,
      reachable: false,
      reason: healthFailureReason(error, timeoutMs),
      durationMs: Math.round(performance.now() - started),
    };
  }
}

function parseManifest(value: unknown): PageManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("manifest 必须是 JSON 对象");
  }
  const input = value as Record<string, unknown>;
  const id = requiredString(input.id, "id");
  if (!PAGE_ID_PATTERN.test(id)) throw new Error("id 只能使用小写字母、数字和单个连字符分段");
  const name = requiredString(input.name, "name");
  const icon = requiredString(input.icon, "icon");
  if (!isSupportedIcon(icon)) throw new Error("icon 必须是 emoji 或内联 SVG 字符串");
  if (input.type !== "iframe") throw new Error('type 本轮只支持 "iframe"');
  const url = httpUrl(input.url, "url");
  const healthCheck = input.healthCheck === undefined
    ? undefined
    : httpUrl(input.healthCheck, "healthCheck");
  const description = input.description === undefined
    ? undefined
    : requiredString(input.description, "description");

  return {
    id,
    name,
    icon,
    type: "iframe",
    url,
    ...(healthCheck ? { healthCheck } : {}),
    ...(description ? { description } : {}),
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} 必须是非空字符串`);
  return value.trim();
}

function httpUrl(value: unknown, field: string): string {
  const raw = requiredString(value, field);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${field} 必须是有效 URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${field} 只支持 http 或 https`);
  }
  return raw;
}

function isSupportedIcon(value: string): boolean {
  const trimmed = value.trim();
  return EMOJI_PATTERN.test(trimmed) || (trimmed.startsWith("<svg") && trimmed.endsWith("</svg>"));
}

function healthFailureReason(error: unknown, timeoutMs: number): string {
  const name = error && typeof error === "object" && "name" in error
    ? String((error as { name: unknown }).name)
    : "";
  if (name === "TimeoutError" || name === "AbortError") return `超过 ${timeoutMs} ms 未响应`;

  const cause = error && typeof error === "object" && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  const code = cause && typeof cause === "object" && "code" in cause
    ? String((cause as { code: unknown }).code)
    : "";
  if (code === "ECONNREFUSED") return "连接被拒绝";
  if (code === "ENOTFOUND") return "地址无法解析";
  if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return "连接超时";
  return errorMessage(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
