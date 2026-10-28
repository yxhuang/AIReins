import { Component, lazy, Suspense, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import { t } from "../i18n";

const views = new WeakMap<object, unknown>();
function lazyView<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, retry = false) {
  if (retry || !views.has(load)) views.set(load, lazy(load));
  return views.get(load) as LazyExoticComponent<ComponentType<P>>;
}

export class PanelErrorBoundary extends Component<{
  children: ReactNode;
  fallback: (error: unknown) => ReactNode;
}, { failed: boolean; error: unknown }> {
  state = { failed: false, error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { failed: true, error }; }
  render() { return this.state.failed ? this.props.fallback(this.state.error) : this.props.children; }
}

export function PanelLoadFailure({ label, error, onRetry, onClose }: {
  label: string; error: unknown; onRetry: () => void; onClose: () => void;
}) {
  return <div className="empty-state" role="alert">
    <p>{t("ui.RecoverableLazy.failed", { panel: label })}</p>
    <p className="new-error">{error instanceof Error ? error.message : String(error)}</p>
    <p className="new-hint">{t("ui.RecoverableLazy.refresh_hint")}</p>
    <div className="info-actions">
      <button type="button" className="btn" onClick={onRetry}>{t("ui.RecoverableLazy.retry")}</button>
      <button type="button" className="btn" onClick={onClose}>{t("ui.common.close")}</button>
      <button type="button" className="btn" onClick={() => {
        if (window.confirm(t("ui.RecoverableLazy.refresh_confirm"))) window.location.reload();
      }}>{t("ui.RecoverableLazy.refresh")}</button>
    </div>
  </div>;
}

/** Recreate React.lazy on retry: remounting the same lazy object would retain its rejected promise. */
export function RecoverableLazy<P extends object>({ load, componentProps, label, onClose, visible = true, failureClassName }: {
  load: () => Promise<{ default: ComponentType<P> }>;
  componentProps: P;
  label: string;
  onClose: () => void;
  visible?: boolean;
  failureClassName?: string;
}) {
  const [attempt, setAttempt] = useState(() => ({ View: lazyView(load), id: 0 }));
  const retry = () => {
    const View = lazyView(load, true);
    setAttempt(previous => ({ View, id: previous.id + 1 }));
  };
  return <PanelErrorBoundary key={attempt.id} fallback={error => <div className={failureClassName} style={visible ? undefined : { display: "none" }}>
    <PanelLoadFailure label={label} error={error} onRetry={retry} onClose={onClose} />
  </div>}>
    <Suspense fallback={visible ? <div className={failureClassName}><div className="empty-state" role="status">{t("ui.RecoverableLazy.loading", { panel: label })}</div></div> : null}>
      <attempt.View {...componentProps} />
    </Suspense>
  </PanelErrorBoundary>;
}
