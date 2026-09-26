// pages/ 扩展页面的纯逻辑（无 DOM 依赖，可单测；打桩测试见 scripts/pages-flow.test.mjs）。
import type { PageHealth, PageManifest } from "./types";

/** icon 是 emoji 文本或内联 SVG 字符串；SVG 以 <svg 开头（server 已校验 manifest 形状）。 */
export function isInlineSvg(icon: string): boolean {
  return /^\s*<svg[\s>]/i.test(icon);
}

export interface SkippedPage {
  id: string;
  name: string;
  type: string;
}

/**
 * 本轮只支持 type:"iframe"。未知类型（或字段残缺）的条目跳过并记录，
 * 供侧边栏给一行小字提示——绝不因单条 manifest 崩掉整个页面列表。
 */
export function partitionPages(list: PageManifest[]): {
  supported: PageManifest[];
  skipped: SkippedPage[];
} {
  const supported: PageManifest[] = [];
  const skipped: SkippedPage[] = [];
  for (const page of list ?? []) {
    if (
      page &&
      page.type === "iframe" &&
      typeof page.id === "string" &&
      typeof page.url === "string"
    ) {
      supported.push(page);
    } else if (page) {
      skipped.push({
        id: String(page.id ?? "?"),
        name: String(page.name ?? page.id ?? "?"),
        type: String(page.type ?? "?"),
      });
    }
  }
  return { supported, skipped };
}

/** 健康检查结论 → 渲染模式（见 pageRenderMode）。 */
export type PageRenderMode = "iframe" | "fallback" | "blocked" | "uncertain";

/**
 * reachable 只表示服务在响应（收到任何 HTTP 响应即为 true），不代表允许被嵌入。
 * embeddable 三态：
 * - true  → "iframe"：正常渲染 iframe，工具条不再挂「若下方空白」提示；
 * - false → "blocked"：完全不渲染 iframe，降级面板说明「服务是好的，但拒绝被嵌入」
 *   （embedReason 原样展示），主按钮「在新标签页打开」；
 * - null/缺省 → "uncertain"：无法确定（或旧后端没这个字段），仍渲染 iframe，
 *   但保留空白提示与常驻新标签页出口。
 */
export function pageRenderMode(health: PageHealth): PageRenderMode {
  if (!health.reachable) return "fallback";
  if (health.embeddable === true) return "iframe";
  if (health.embeddable === false) return "blocked";
  return "uncertain";
}

/** 指向本机回环地址的 URL：手机经 Tailscale 打开 workbench 时，这类地址指的是手机自己。 */
export function isLoopbackUrl(url: string): boolean {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** iframe 与「新标签页打开」用的地址：开了代理就走 workbench 自己的 /pages/<id>/（相对当前源，手机上也可用）。 */
export function pageSrc(page: PageManifest): string {
  return page.proxy ? `/pages/${encodeURIComponent(page.id)}/` : page.url;
}
