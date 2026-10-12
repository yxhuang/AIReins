import { t } from "../i18n";
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

  // 侧栏里的同源页面（AI 用量等）只比一屏略高时整页微缩放下，不为十几 px 出滚动条（用户 10-02，手机桌面一致）。
  // 每次先复位再量自然高度；最多缩到 0.85，再高就照常滚动。跨源页取不到 document，跳过。
  useEffect(() => {
    const frame = frameRef.current;
    if (!sidebar || !frame) return;
    let inner: ResizeObserver | null = null;
    let fitted: HTMLElement | null = null; // 只复位自己设过的 zoom，不动页面原有行内样式
    const unfit = () => { if (fitted) fitted.style.zoom = ""; fitted = null; };
    const fit = () => {
      unfit();
      let root: HTMLElement | undefined;
      try { root = frame.contentDocument?.documentElement; } catch { return; }
      const view = frame.contentWindow;
      if (!root || !view || root.style.zoom) return;
      const ratio = view.innerHeight / root.scrollHeight;
      if (ratio < 1 && ratio >= 0.85) { root.style.zoom = String(Math.floor(ratio * 1000) / 1000); fitted = root; }
    };
    // 页面数据异步渲染，高度在 load 之后才定：观察页内 body（用页内的 ResizeObserver）
    const attach = () => {
      inner?.disconnect();
      inner = null;
      fit();
      try {
        const view = frame.contentWindow as (Window & typeof globalThis) | null;
        const body = frame.contentDocument?.body;
        if (view && body && "ResizeObserver" in view) { inner = new view.ResizeObserver(fit); inner.observe(body); }
      } catch { /* 跨源 */ }
    };
    const outer = new ResizeObserver(fit);
    frame.addEventListener("load", attach);
    outer.observe(frame);
    attach();
    return () => { frame.removeEventListener("load", attach); outer.disconnect(); inner?.disconnect(); unfit(); };
  }, [sidebar, state, src]);

  // 手机经 Tailscale 打开时，127.0.0.1 指的是手机自己：这类页面只能在电脑上用。
  if (!page.proxy && !isLoopbackUrl(window.location.href) && isLoopbackUrl(page.url)) {
    return (
      <div className={viewClass}>
        <div className="page-fallback">
          <h2 className="page-fallback-title">
            <PageIcon icon={page.icon} />
            {page.name}
          </h2>
          <p className="page-fallback-info">{t("ui.PageView.this_page_points_to_a_local_computer_sentence", { p0: (page.url) })}</p>
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
            <p className="page-fallback-info">{t("ui.PageView.the_target_service_is_working_took_ms_sentence", { p0: (health.reason), p1: (health.durationMs) })}</p>
            {health.embedReason && (
              <p className="page-fallback-info">{t("ui.PageView.reason_sentence", { p0: (health.embedReason) })}</p>
            )}
            <p className="page-fallback-info">{t("ui.PageView.the_target_site_s_security_policy_prevents")}</p>
            <div className="page-fallback-actions">
              <a className="btn btn-primary" href={src} target="_blank" rel="noopener noreferrer">{t("ui.common.open_in_a_new_tab")}</a>
              <button
                type="button"
                className="btn"
                disabled={checking}
                onClick={() => void check()}
              >{t("ui.PageView.check_again")}</button>
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
              <span className="page-toolbar-hint">{t("ui.PageView.if_the_area_below_is_blank_the")}</span>
            )}
            <a className="page-open-blank" href={src} target="_blank" rel="noreferrer">{t("ui.common.open_in_a_new_tab")}</a>
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
          <p className="page-fallback-reason">{t("ui.PageView.checking_the_target_service")}</p>
        )}
        {state.phase === "done" && (
          <p className="page-fallback-reason" role="alert">{t("ui.PageView.the_target_service_is_currently_unreachable_took_sentence", { p0: (state.health.reason), p1: (state.health.durationMs) })}</p>
        )}
        {state.phase === "error" && (
          <p className="page-fallback-reason" role="alert">{t("ui.PageView.health_check_failed_sentence", { p0: (state.message) })}</p>
        )}
        <div className="page-fallback-actions">
          <button
            type="button"
            className="btn"
            disabled={state.phase === "checking"}
            onClick={() => void check()}
          >
            {state.phase === "checking" ? t("ui.PageView.checking") : t("ui.common.retry")}
          </button>
          <a className="page-open-blank" href={src} target="_blank" rel="noreferrer">{t("ui.common.open_in_a_new_tab")}</a>
        </div>
      </div>
    </div>
  );
}
