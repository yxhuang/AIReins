import { useCallback, useEffect, useRef, useState } from "react";
import type { PageHealth, PageManifest } from "../types";
import { fetchPageHealth } from "../api";
import { isLoopbackUrl, pageRenderMode, pageSrc } from "../pages";
import { PageIcon } from "./Sidebar";

type CheckState =
  | { phase: "checking" }
  | { phase: "done"; health: PageHealth }
  | { phase: "error"; message: string };

/**
 * 扩展页面视图（type:"iframe"）：进入页面先查一次健康，按 pageRenderMode 三态渲染——
 * - "fallback"（reachable:false 或健康接口本身失败）：降级面板（description + reason + 重试），不渲染 iframe；
 * - "blocked"（embeddable:false）：完全不渲染 iframe——面板说清「服务是好的，但目标站点拒绝被嵌入」
 *   （embedReason 原样展示），主按钮「在新标签页打开」；这是目标站点的安全策略，双方都正常；
 * - "uncertain"（embeddable:null/缺省）：仍渲染 iframe，工具条保留「若下方空白」提示 + 常驻新标签页出口；
 * - "iframe"（embeddable:true）：正常渲染 iframe，不再挂空白提示。
 * 已渲染的 iframe 不定时不轮询健康检查，只在进入页面和点「重试」时查。
 */
export function PageView({ page, sidebar = false, onCollapse }: {
  page: PageManifest;
  sidebar?: boolean;
  onCollapse?: () => void;
}) {
  const viewClass = `page-view${sidebar ? " page-view-sidebar" : ""}`;
  const [state, setState] = useState<CheckState>({ phase: "checking" });
  /** 健康检查序号：连点「重新检查」时晚到的旧响应丢弃（同 Composer @ 检索的 searchSeq 模式） */
  const checkSeq = useRef(0);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const check = useCallback(async () => {
    const seq = ++checkSeq.current;
    setState({ phase: "checking" });
    try {
      const health = await fetchPageHealth(page.id);
      if (checkSeq.current !== seq) return; // 晚到的旧响应丢弃
      setState({ phase: "done", health });
    } catch (error) {
      if (checkSeq.current !== seq) return; // 晚到的旧响应丢弃
      // 健康接口本身失败（server 不可达等）：同样降级面板 + 重试，不崩。
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [page.id]);

  useEffect(() => {
    void check();
    return () => { checkSeq.current++; };
  }, [check]);

  // 检查进行中禁用「重新检查」/「重试」（检查中视图切到下方降级面板，这里是兜底表达）
  const checking = state.phase === "checking";
  const src = pageSrc(page);

  // iframe 内的键盘事件不会冒泡到父窗口；同源页（含 pages 代理）单独接上 Esc。
  // 跨源目标受浏览器同源策略限制，仍可用面板头收起按钮。
  useEffect(() => {
    const frame = frameRef.current;
    if (!sidebar || !onCollapse || !frame) return;
    let frameDocument: Document | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onCollapse();
    };
    const detach = () => frameDocument?.removeEventListener("keydown", onKeyDown);
    const attach = () => {
      detach();
      try {
        frameDocument = frame.contentDocument;
        frameDocument?.addEventListener("keydown", onKeyDown);
      } catch {
        frameDocument = null;
      }
    };
    frame.addEventListener("load", attach);
    attach();
    return () => {
      frame.removeEventListener("load", attach);
      detach();
    };
  }, [sidebar, onCollapse, state, src]);

  // 手机经 Tailscale 打开时，127.0.0.1 指的是手机自己：这类页面只能在电脑上用。
  if (!page.proxy && !isLoopbackUrl(window.location.href) && isLoopbackUrl(page.url)) {
    return (
      <div className={viewClass}>
        <div className="page-fallback">
          <h2 className="page-fallback-title">
            <PageIcon icon={page.icon} />
            {page.name}
          </h2>
          <p className="page-fallback-info">这个页面指向电脑本机地址（{page.url}），只能在电脑上打开。</p>
        </div>
      </div>
    );
  }

  if (state.phase === "done") {
    const { health } = state;
    const mode = pageRenderMode(health);

    if (mode === "blocked") {
      return (
        <div className={viewClass}>
          <div className="page-fallback">
            <h2 className="page-fallback-title">
              <PageIcon icon={page.icon} />
              {page.name}
            </h2>
            {page.description && <p className="page-fallback-desc">{page.description}</p>}
            {/* 不是错误：服务正常（中性文字，不用 --danger），只是目标站点拒绝被嵌入 */}
            <p className="page-fallback-info">
              目标服务本身正常（{health.reason}，耗时 {health.durationMs} ms），但它不允许被嵌入到其他页面里。
            </p>
            {health.embedReason && (
              <p className="page-fallback-info">原因：{health.embedReason}</p>
            )}
            <p className="page-fallback-info">
              这是目标站点自己的安全策略——workbench 与目标服务都没有故障，请在新标签页中使用它。
            </p>
            <div className="page-fallback-actions">
              <a className="btn btn-primary" href={src} target="_blank" rel="noopener noreferrer">
                在新标签页打开
              </a>
              <button
                type="button"
                className="btn"
                disabled={checking}
                onClick={() => void check()}
              >
                重新检查
              </button>
            </div>
          </div>
        </div>
      );
    }

    // "iframe"（embeddable:true）：不再挂空白提示；"uncertain"（null/缺省）：保留提示与新标签页出口
    if (mode === "iframe" || mode === "uncertain") {
      return (
        // maxWidth 由后端按简单 CSS 长度校验过；窄面板拉满宽屏反而难看
        <div className={viewClass} style={!sidebar && page.maxWidth ? { maxWidth: page.maxWidth } : undefined}>
          <div className="page-toolbar">
            <span className="page-toolbar-title">
              <PageIcon icon={page.icon} />
              {page.name}
            </span>
            {mode === "uncertain" && (
              <span className="page-toolbar-hint">
                若下方空白，说明目标站点拒绝被嵌入，请用新标签页打开
              </span>
            )}
            <a className="page-open-blank" href={src} target="_blank" rel="noreferrer">
              在新标签页打开
            </a>
          </div>
          {/* 有意不加 sandbox：pages/ 里的页面（如 ai-usage）可能需要脚本/同源等完整能力，记录此决策 */}
          <iframe ref={frameRef} className="page-frame" src={src} title={page.name} loading="lazy" />
        </div>
      );
    }
    // mode === "fallback"（reachable:false）：落到下方降级面板
  }

  // 降级面板：检查中 / 健康接口失败 / reachable:false
  return (
    <div className={viewClass}>
      <div className="page-fallback">
        <h2 className="page-fallback-title">
          <PageIcon icon={page.icon} />
          {page.name}
        </h2>
        {page.description && <p className="page-fallback-desc">{page.description}</p>}
        {state.phase === "checking" && (
          <p className="page-fallback-reason">正在检查目标服务…</p>
        )}
        {state.phase === "done" && (
          <p className="page-fallback-reason" role="alert">
            目标服务当前不可达：{state.health.reason}（耗时 {state.health.durationMs} ms）
          </p>
        )}
        {state.phase === "error" && (
          <p className="page-fallback-reason" role="alert">
            健康检查请求失败：{state.message}
          </p>
        )}
        <div className="page-fallback-actions">
          <button
            type="button"
            className="btn"
            disabled={state.phase === "checking"}
            onClick={() => void check()}
          >
            {state.phase === "checking" ? "检查中…" : "重试"}
          </button>
          <a className="page-open-blank" href={src} target="_blank" rel="noreferrer">
            在新标签页打开
          </a>
        </div>
      </div>
    </div>
  );
}
