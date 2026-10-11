import { readdirSync, readFileSync } from "node:fs";
import { pipeline } from "node:stream";
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { log } from "./logger.js";
import { workbenchHome } from "./persistence.js";

const DEFAULT_PAGES_ROOT = join(workbenchHome, "pages");
const PAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EMOJI_PATTERN = /\p{Extended_Pictographic}/u;
const PAGE_HEALTH_TIMEOUT_MS = 2_000;

export interface LauncherLink {
  name: string;
  url: string;
  icon?: string;
  group?: string;
}

/** 根目录配置按请求现读；坏配置只影响本次链接列表，不影响扩展页面。 */
export function readLinks(root = DEFAULT_PAGES_ROOT): LauncherLink[] {
  const path = join(root, "links.json");
  let input: unknown;
  try {
    input = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log("warn", "links config read failed", { path, reason: errorMessage(error) });
    }
    return [];
  }
  if (!input || typeof input !== "object" || !Array.isArray((input as { links?: unknown }).links)) {
    log("warn", "links config must contain a links array", { path });
    return [];
  }
  const links: LauncherLink[] = [];
  for (const [index, item] of (input as { links: unknown[] }).links.entries()) {
    try {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("link must be an object");
      const fields = item as Record<string, unknown>;
      if (typeof fields.name !== "string" || !fields.name.trim()) throw new Error("name is required");
      if (typeof fields.url !== "string" || !fields.url.trim()) throw new Error("url is required");
      const url = fields.url.trim();
      // URL scheme 必须显式给出；拒绝可执行内容、内联资源和本地文件。
      if (!/^[a-z][a-z0-9+.-]*:/i.test(url) || /[\u0000-\u0020\u007f]/u.test(url)) throw new Error("invalid URL");
      const parsed = new URL(url);
      if (["javascript:", "data:", "vbscript:", "file:", "blob:", "filesystem:", "about:"].includes(parsed.protocol)) {
        throw new Error("unsafe URL scheme");
      }
      if (["http:", "https:"].includes(parsed.protocol) && !parsed.hostname) throw new Error("URL host is required");
      const link: LauncherLink = { name: fields.name.trim(), url };
      for (const key of ["icon", "group"] as const) {
        if (fields[key] !== undefined) {
          if (typeof fields[key] !== "string" || !fields[key].trim()) throw new Error(`${key} must be a nonempty string`);
          link[key] = fields[key].trim();
        }
      }
      links.push(link);
    } catch (error) {
      log("warn", "invalid link skipped", { path, index, reason: errorMessage(error) });
    }
  }
  return links;
}

export interface IframePageManifest {
  id: string;
  name: string;
  icon: string;
  type: "iframe";
  url: string;
  healthCheck?: string;
  description?: string;
  /** 内容区最大宽度（任意合法 CSS 长度/百分比）。省略即撑满主窗口。
      动机：ai-usage 是窄面板，拉满整个宽屏主窗口反而难看。 */
  maxWidth?: string;
  /** true：经 workbench 自己的 /pages/<id>/ 反向代理访问 url（手机经 Tailscale 也能用）。
      目标前端必须全用相对路径。 */
  proxy?: boolean;
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
function detectEmbeddable(headers: Headers, selfOrigin: string, proxied: boolean): { embeddable: boolean | null; embedReason: string } {
  const xfo = headers.get("x-frame-options")?.trim().toLowerCase();
  if (xfo === "deny") return { embeddable: false, embedReason: "目标站点设置了 X-Frame-Options: DENY" };
  // 经反向代理时目标与 workbench 同源：SAMEORIGIN 和 'self' 都放行
  if (proxied && xfo === "sameorigin") return { embeddable: true, embedReason: "经 workbench 反向代理，与工作台同源" };
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
    if (proxied && tokens.includes("'self'")) {
      return { embeddable: true, embedReason: "经 workbench 反向代理，与工作台同源（目标站点 CSP 放行 'self'）" };
    }
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
    const embed = detectEmbeddable(response.headers, selfOrigin, page.proxy === true);
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

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

/**
 * /pages/<id>/<rest> → page.url 下的 <rest>。调用方必须先过 checkAccess。
 * 带 Origin 的请求此时已确认来自工作台自己的页面，改写成目标自己的源，目标的来源校验（如 ai-usage 的
 * require_local_ui）才认；Host 同理。Tailscale 身份头、Cookie、Referer 不往下传。
 * 2026-09-26 用户明确授权这一改写（手机上要能用 ai-usage 的刷新与开关）。
 */
export function proxyPage(page: PageManifest, path: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const target = new URL(page.url);
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP.has(name) || name.startsWith("tailscale-") || name.startsWith("x-forwarded-")) continue;
    if (name === "host" || name === "origin" || name === "cookie" || name === "referer") continue;
    headers[name] = value;
  }
  headers.host = target.host;
  if (request.headers.origin !== undefined) headers.origin = target.origin;
  return new Promise((resolvePromise, reject) => {
    const upstream = httpRequest({
      hostname: target.hostname,
      port: target.port || 80,
      method: request.method,
      path: target.pathname.replace(/\/$/u, "") + path,
      headers,
      signal: AbortSignal.timeout(30_000),
    }, (upstreamResponse) => {
      const outHeaders = { ...upstreamResponse.headers };
      for (const name of HOP_BY_HOP) delete outHeaders[name];
      response.writeHead(upstreamResponse.statusCode ?? 502, outHeaders);
      // pipeline：任一端出错或客户端断开都销毁两端，不会挂住响应
      pipeline(upstreamResponse, response, (error) => (error ? reject(error) : resolvePromise()));
    });
    upstream.on("error", reject);
    // 客户端上传途中断开：立即销毁上游并结束，不然这个请求要挂到 30 秒超时才释放
    request.on("error", (error) => {
      upstream.destroy();
      reject(error);
    });
    request.pipe(upstream);
  });
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
  const maxWidth = input.maxWidth === undefined
    ? undefined
    : cssLength(input.maxWidth, "maxWidth");
  if (input.proxy !== undefined && typeof input.proxy !== "boolean") throw new Error("proxy 必须是布尔值");
  if (input.proxy === true) {
    const target = new URL(url);
    if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
      throw new Error("proxy 只支持本机回环的 http 目标");
    }
  }

  return {
    id,
    name,
    icon,
    type: "iframe",
    url,
    ...(healthCheck ? { healthCheck } : {}),
    ...(description ? { description } : {}),
    ...(maxWidth ? { maxWidth } : {}),
    ...(input.proxy === true ? { proxy: true } : {}),
  };
}

/** 只放行简单的 CSS 长度/百分比，挡住把任意字符串塞进 style 的路径。 */
function cssLength(value: unknown, field: string): string {
  const raw = requiredString(value, field).trim();
  if (!/^\d+(?:\.\d+)?(?:px|rem|em|%|vw|ch)$/u.test(raw)) {
    throw new Error(`${field} 必须是简单的 CSS 长度，如 480px / 33% / 60ch`);
  }
  return raw;
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
