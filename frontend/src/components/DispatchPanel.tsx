import { t } from "../i18n";
import { lazy, Suspense } from "react";
import { store } from "../store";
import { useStore } from "../useStore";
import { PanelBackButton, PanelRightIcon, SidePanelResize, useSidePanelWidth } from "./SidePanelResize";

const DispatchView = lazy(() => import("./DispatchView").then((module) => ({ default: module.DispatchView })));

export function DispatchPanel({ onClose }: { onClose: () => void }) {
  const [width, setWidth] = useSidePanelWidth();
  const selected = useStore(() => window.location.hash).match(/^#\/dispatches\/([^?]+)/)?.[1];
  const selectedId = selected ? decodeURIComponent(selected) : null;
  return <>
    <SidePanelResize label={t("ui.common.dispatches")} width={width} setWidth={setWidth} />
    <div className="term-panel dispatch-side-panel" role="region" aria-label={t("ui.DispatchPanel.dispatch_panel")} style={{ width: `${width}px` }}>
      <div className="term-titlebar">
        <PanelBackButton onClick={() => selectedId ? store.backFromDispatchDetail(selectedId) : onClose()} />
        <strong className="dispatch-side-title">{t("ui.common.dispatches")}</strong>
        <button type="button" className="btn chrome-icon-btn panel-icon-button panel-collapse" aria-label={t("ui.DispatchPanel.close_dispatch_panel")} title={t("ui.common.collapse_panel")} onClick={onClose}><PanelRightIcon /></button>
      </div>
      <Suspense fallback={<div className="empty-state" aria-label={t("ui.DispatchPanel.loading_dispatches")}>{t("ui.common.loading_dispatch")}</div>}>
        <DispatchView />
      </Suspense>
    </div>
  </>;
}
