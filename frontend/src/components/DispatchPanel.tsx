import { lazy, Suspense } from "react";
import { PanelBackButton, PanelRightIcon, SidePanelResize, useSidePanelWidth } from "./SidePanelResize";

const DispatchView = lazy(() => import("./DispatchView").then((module) => ({ default: module.DispatchView })));

export function DispatchPanel({ onClose }: { onClose: () => void }) {
  const [width, setWidth] = useSidePanelWidth();
  return <>
    <SidePanelResize label="派单" width={width} setWidth={setWidth} />
    <div className="term-panel dispatch-side-panel" role="region" aria-label="派单面板" style={{ width: `${width}px` }}>
      <div className="term-titlebar">
        <PanelBackButton onClick={onClose} />
        <strong className="dispatch-side-title">派单</strong>
        <button type="button" className="btn chrome-icon-btn panel-icon-button panel-collapse" aria-label="关闭派单面板" title="收起面板" onClick={onClose}><PanelRightIcon /></button>
      </div>
      <Suspense fallback={<div className="empty-state" aria-label="派单加载中">正在加载派单…</div>}>
        <DispatchView />
      </Suspense>
    </div>
  </>;
}
