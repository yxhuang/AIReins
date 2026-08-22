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
 * 扩展页面视图（type:"iframe"）：
 * - 进入页面先查一次健康；reachable:false → 降级面板（description + reason + 重试），不渲染空白 iframe；
 * - reachable:true → iframe 撑满内容区，顶部常驻工具条带「在新标签页打开」出口——
 *   reachable 不代表允许被嵌入（如目标带 x-frame-options:DENY，浏览器端无法可靠探测）；
 * - 已渲染的 iframe 不定时不轮询健康检查，只在进入页面和点「重试」时查。
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

  const reachable = state.phase === "done" && pageRenderMode(state.health) === "iframe";

  if (!reachable) {
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

  return (
    <div className="page-view">
      <div className="page-toolbar">
        <span className="page-toolbar-title">
          <PageIcon icon={page.icon} />
          {page.name}
        </span>
        <span className="page-toolbar-hint">
          若下方空白，说明目标站点拒绝被嵌入，请用新标签页打开
        </span>
        <a className="page-open-blank" href={page.url} target="_blank" rel="noreferrer">
          在新标签页打开
        </a>
      </div>
      <iframe className="page-frame" src={page.url} title={page.name} />
    </div>
  );
}
