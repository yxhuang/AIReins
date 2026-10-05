import { useLayoutEffect, useRef, useState } from "react";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** 固定保留开头 12 个可见字符，避免拆开 emoji 或组合字符。 */
export function shortSessionTitle(text: string, limit = 12): string {
  let result = "";
  let count = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (count++ === limit) return `${result}…`;
    result += segment;
  }
  return result;
}

/** 只测量能放进一行的前缀；长标题不创建完整的隐藏测量节点。 */
export function fitSessionTitle(text: string, width: number, measure: (text: string) => number): string {
  if (width <= 0) return "";
  let prefix = "";
  let clipped = measure("…") <= width ? "…" : "";
  for (const { segment, index } of graphemes.segment(text)) {
    const next = prefix + segment;
    if (measure(next) > width) return clipped;
    prefix = next;
    if (index + segment.length === text.length) return prefix;
    if (measure(`${prefix}…`) <= width) clipped = `${prefix}…`;
  }
  return prefix;
}

let measureContext: CanvasRenderingContext2D | null = null;

export function SidebarSessionTitle({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(() => shortSessionTitle(text, 24));

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    measureContext ??= document.createElement("canvas").getContext("2d");
    const context = measureContext;
    if (!context) { setDisplay(shortSessionTitle(text, 24)); return; }
    const update = () => {
      const style = getComputedStyle(element);
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      // 使用 CSS 内容宽度，避免 clientWidth 的整数舍入及 zoom 后的坐标差异。
      setDisplay(fitSessionTitle(text, Number.parseFloat(style.width), (value) => context.measureText(value).width));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return <span ref={ref} className="row-title" title={display}>{display}</span>;
}
