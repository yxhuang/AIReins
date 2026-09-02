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
        <h3 className="snapshot-title" id="snapshot-confirm-title">
          创建会话前：确认工作目录快照
        </h3>
        <p className="snapshot-body" id="snapshot-confirm-desc">
          该目录不在 git 仓库内，创建会话前会把它完整备份一份，供改坏后回滚。
          {reasons.map((reason) => (
            <span key={reason} className="snapshot-reason">
              {reason}
            </span>
          ))}
        </p>
        {preflight.snapshotPath && (
          <p className="snapshot-body">
            快照将写入：
            <code className="mono snapshot-path">{preflight.snapshotPath}</code>
          </p>
        )}
        {preflight.existing && (
          <p className="snapshot-body">该目录已有一份旧快照，本次会覆盖刷新。</p>
        )}
        {!canSnapshot && (
          <p className="snapshot-warn">
            目标盘空间不足，「仍然快照」会失败——请跳过快照，或先清理磁盘后重试。
          </p>
        )}
        <div className="snapshot-actions">
          <button
            type="button"
            className="btn btn-gate"
            disabled={!canSnapshot}
            {...(canSnapshot ? { "data-autofocus": true } : {})}
            title={canSnapshot ? "备份该目录后创建会话" : "目标盘空间不足，快照会失败"}
            onClick={() => onResolve("auto")}
          >
            仍然快照
          </button>
          <button
            type="button"
            className="btn"
            {...(!canSnapshot ? { "data-autofocus": true } : {})}
            title="不备份，直接创建会话"
            onClick={() => onResolve("skip")}
          >
            跳过快照
          </button>
          <button
            type="button"
            className="btn"
            title="取消（Esc）：不创建会话"
            onClick={() => onResolve("cancel")}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
