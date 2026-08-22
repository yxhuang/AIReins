import { useCallback, useEffect, useState } from "react";
import type { PageHealth, PageManifest } from "../types";
import { fetchPageHealth } from "../api";
import { pageRenderMode } from "../pages";
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
export function PageView({ page }: { page: PageManifest }) {
  const [state, setState] = useState<CheckState>({ phase: "checking" });

  const check = useCallback(async () => {
    setState({ phase: "checking" });
    try {
      const health = await fetchPageHealth(page.id);
      setState({ phase: "done", health });
    } catch (error) {
      // 健康接口本身失败（server 不可达等）：同样降级面板 + 重试，不崩。
      setState({
        phase: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [page.id]);

  useEffect(() => {
    void check();
  }, [check]);

  if (state.phase === "done") {
    const { health } = state;
    const mode = pageRenderMode(health);

    if (mode === "blocked") {
      return (
        <div className="page-view">
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
              <a className="btn btn-primary" href={page.url} target="_blank" rel="noopener noreferrer">
                在新标签页打开
              </a>
              <button type="button" className="btn" onClick={() => void check()}>
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
        <div className="page-view" style={page.maxWidth ? { maxWidth: page.maxWidth } : undefined}>
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
            <a className="page-open-blank" href={page.url} target="_blank" rel="noreferrer">
              在新标签页打开
            </a>
          </div>
          <iframe className="page-frame" src={page.url} title={page.name} />
        </div>
      );
    }
    // mode === "fallback"（reachable:false）：落到下方降级面板
  }

  // 降级面板：检查中 / 健康接口失败 / reachable:false
  return (
    <div className="page-view">
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
          <a className="page-open-blank" href={page.url} target="_blank" rel="noreferrer">
            在新标签页打开
          </a>
        </div>
      </div>
    </div>
  );
}
