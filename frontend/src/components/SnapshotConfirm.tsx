import { t } from "../i18n";
import { useEffect, useRef } from "react";
import type { SnapshotPreflight } from "../types";
import { snapshotConfirmReasons, type SnapshotChoice } from "../snapshot";

interface SnapshotConfirmProps {
  preflight: SnapshotPreflight;
  /** 三个出口都经此回调；"auto"/"skip" 原样成为建会话的 snapshot 字段 */
  onResolve: (choice: SnapshotChoice) => void;
}

/**
 * 建会话前快照的风险确认弹窗（暖色闸门样式：它在等用户拍板）。
 * 只在 preflight 判定 needed && (exceeds || !freeSpaceOk) 时出现；
 * Esc 或点遮罩 = 取消（不建会话），Tab 在弹窗内循环（与设置浮层同一 focus trap 做法）。
 */
export function SnapshotConfirm({ preflight, onResolve }: SnapshotConfirmProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const reasons = snapshotConfirmReasons(preflight);
  // 空间不足时后端会拒绝复制：「仍然快照」禁用并写明原因，默认焦点改落「跳过快照」
  const canSnapshot = preflight.freeSpaceOk;

  // 打开时焦点进弹窗：首选「仍然快照」（快照是保护动作），被禁用时落「跳过快照」
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const preferred =
      dialog.querySelector<HTMLElement>("[data-autofocus]") ??
      dialog.querySelector<HTMLElement>("button:not(:disabled)");
    preferred?.focus();
  }, []);

  // Esc 取消；Tab/Shift+Tab 在弹窗内循环（focus trap），与 SettingsMenu 同一实现纪律
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onResolve("cancel");
        return;
      }
      if (e.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables.item(0);
      const last = focusables.item(focusables.length - 1);
      const active = document.activeElement;
      const outside = !dialog.contains(active);
      if (e.shiftKey && (outside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (outside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onResolve]);

  return (
    // 点遮罩本身（非弹窗内容）视为取消
    <div
      className="snapshot-overlay"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onResolve("cancel");
      }}
    >
      <div
        className="snapshot-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snapshot-confirm-title"
        aria-describedby="snapshot-confirm-desc"
        ref={dialogRef}
      >
        <h3 className="snapshot-title" id="snapshot-confirm-title">{t("ui.SnapshotConfirm.before_creating_the_session_confirm_working_directory")}</h3>
        <p className="snapshot-body" id="snapshot-confirm-desc">{t("ui.SnapshotConfirm.this_directory_is_outside_a_git_repository")}{reasons.map((reason) => (
            <span key={reason} className="snapshot-reason">
              {reason}
            </span>
          ))}
        </p>
        {preflight.snapshotPath && (
          <p className="snapshot-body">{t("ui.SnapshotConfirm.snapshot_destination")}<code className="mono snapshot-path">{preflight.snapshotPath}</code>
          </p>
        )}
        {preflight.existing && (
          <p className="snapshot-body">{t("ui.SnapshotConfirm.this_directory_already_has_a_snapshot_it")}</p>
        )}
        {!canSnapshot && (
          <p className="snapshot-warn">{t("ui.SnapshotConfirm.the_destination_disk_has_insufficient_space_take")}</p>
        )}
        <div className="snapshot-actions">
          <button
            type="button"
            className="btn btn-gate"
            disabled={!canSnapshot}
            {...(canSnapshot ? { "data-autofocus": true } : {})}
            title={canSnapshot ? t("ui.SnapshotConfirm.back_up_this_directory_before_creating_the") : t("ui.SnapshotConfirm.insufficient_disk_space_snapshot_will_fail")}
            onClick={() => onResolve("auto")}
          >{t("ui.SnapshotConfirm.take_snapshot_anyway")}</button>
          <button
            type="button"
            className="btn"
            {...(!canSnapshot ? { "data-autofocus": true } : {})}
            title={t("ui.SnapshotConfirm.create_the_session_without_a_backup")}
            onClick={() => onResolve("skip")}
          >{t("ui.SnapshotConfirm.skip_snapshot")}</button>
          <button
            type="button"
            className="btn"
            title={t("ui.SnapshotConfirm.cancel_esc_do_not_create_a_session")}
            onClick={() => onResolve("cancel")}
          >{t("ui.common.cancel")}</button>
        </div>
      </div>
    </div>
  );
}
