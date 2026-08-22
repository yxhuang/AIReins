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
  /** 目标站点是否允许被 iframe 嵌入。null = 无法确定（有 frame-ancestors 但不是 'none'）。 */
  embeddable?: boolean | null;
  /** embeddable 的判定依据，用于前端如实告知用户。 */
  embedReason?: string;
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

/**
 * 读响应头判断目标能否被 iframe 嵌入。
 * 动机：ai-usage(8788) 带 X-Frame-Options: DENY —— 健康检查报 reachable:true，
 * 但 iframe 里是 Chrome 的「拒绝了我们的连接请求」。渲染一个必然报错的 iframe
 * 比直接给降级面板更糟，所以这里把可嵌性也一并告诉前端。
 */
function detectEmbeddable(headers: Headers, selfOrigin: string): { embeddable: boolean | null; embedReason: string } {
  const xfo = headers.get("x-frame-options")?.trim().toLowerCase();
  if (xfo === "deny") return { embeddable: false, embedReason: "目标站点设置了 X-Frame-Options: DENY" };
  // workbench 与目标端口不同即为跨源，SAMEORIGIN 同样会被浏览器拦下
  if (xfo === "sameorigin") return { embeddable: false, embedReason: "目标站点设置了 X-Frame-Options: SAMEORIGIN（端口不同即跨源）" };

  const csp = headers.get("content-security-policy") ?? "";
  const directive = csp.split(";").map((d) => d.trim()).find((d) => d.toLowerCase().startsWith("frame-ancestors"));
  if (directive) {
    const value = directive.slice("frame-ancestors".length).trim().toLowerCase();
    if (value === "'none'") return { embeddable: false, embedReason: "目标站点 CSP 设置了 frame-ancestors 'none'" };
    // 白名单里如果明确列了 workbench 自己的源，就能判准，不必含糊成 null。
    // 注意 'self' 指的是目标站自己的源（8788），不是我们，所以不算数。
    const tokens = value.split(/\s+/u).filter(Boolean);
    if (tokens.includes(selfOrigin.toLowerCase())) {
      return { embeddable: true, embedReason: `目标站点 CSP 已显式放行 ${selfOrigin}` };
    }
    return { embeddable: null, embedReason: `目标站点 CSP 限制了 frame-ancestors（${directive}），未见放行 ${selfOrigin}` };
  }
  return { embeddable: true, embedReason: "未发现 X-Frame-Options 或 frame-ancestors 限制" };
}

export async function checkPageHealth(
  page: PageManifest,
  timeoutMs = PAGE_HEALTH_TIMEOUT_MS,
  selfOrigin = `http://127.0.0.1:${process.env.WORKBENCH_PORT ?? "8790"}`,
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
    const embed = detectEmbeddable(response.headers, selfOrigin);
    return {
      id: page.id,
      reachable: true,
      reason: `HTTP ${response.status}`,
      status: response.status,
      embeddable: embed.embeddable,
      embedReason: embed.embedReason,
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
