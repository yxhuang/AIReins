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

/**
 * 健康检查结论 → 渲染模式。reachable 只表示服务在响应（收到任何 HTTP 响应即为 true），
 * 不代表目标允许被 iframe 嵌入——x-frame-options:DENY 浏览器端无法可靠探测，
 * 所以 iframe 模式下工具条常驻「在新标签页打开」出口。
 */
export function pageRenderMode(health: PageHealth): "iframe" | "fallback" {
  return health.reachable ? "iframe" : "fallback";
}
