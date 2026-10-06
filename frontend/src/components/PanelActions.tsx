import type { ReactNode } from "react";
import { store, type Store } from "../store";
import { shallowEqual, useStore } from "../useStore";
import { TerminalIcon } from "./TerminalIcon";
import type { DispatchRun } from "../dispatch-flow";

const selectPanelState = (value: Store) => [
  value.filesOpen, value.termOpen, value.dispatchesOpen,
  value.meta?.capabilities.terminal === true,
] as const;

const folderIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z" /></svg>;
export const dispatchIcon = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h7v6H4zM13 13h7v6h-7zM15 5h5M18 3l2 2-2 2M4 17h5M7 15l2 2-2 2" /></svg>;

/** 派单图标的执行端身份色：单家实色，多家按扇区分色；手机徽章与桌面按钮共用。 */
export function dispatchBadge(runs: readonly DispatchRun[], backgroundCount = 0) {
  const tools = [...new Set(runs.map((run) => run.tool))];
  const color = (tool: string) => `var(--agent-${tool}, var(--busy))`;
  const fill = tools.length === 1 ? color(tools[0]!)
    : `conic-gradient(${tools.map((tool, i) => `${color(tool)} ${i / tools.length * 360}deg ${(i + 1) / tools.length * 360}deg`).join(", ")})`;
  const label = `派单：${tools.join("、")}，共 ${runs.length} 个${backgroundCount ? `；后台 ${backgroundCount} 个任务` : ""}`;
  return { fill, label };
}

/** 会话、欢迎页、历史预览及手机列表页共用的右侧面板开关；会话页传入派单时派单按钮填身份色。 */
export function PanelActions({ dispatchRuns = [] }: { dispatchRuns?: readonly DispatchRun[] }) {
  const badge = dispatchRuns.length ? dispatchBadge(dispatchRuns) : null;
  const [filesOpen, termOpen, dispatchesOpen, terminalCapable] = useStore(selectPanelState, shallowEqual);
  return <div className="panel-actions" role="group" aria-label="右侧面板">
    <button type="button" className="btn chrome-icon-btn" aria-label="文件" aria-pressed={filesOpen} title="浏览文件" onClick={() => store.setFilesOpen(!store.filesOpen)}>
      {folderIcon}
    </button>
    {terminalCapable && <button type="button" className="btn chrome-icon-btn" aria-label="终端" aria-pressed={termOpen} title="终端（Ctrl+`）：工作区级内置终端，切会话不影响" onClick={() => store.setTerminalOpen(!store.termOpen)}>
      <TerminalIcon />
    </button>}
    <button type="button" className={`btn chrome-icon-btn${badge ? " has-dispatch-runs" : ""}`} style={badge ? { background: badge.fill } : undefined}
      aria-label="派单" aria-pressed={dispatchesOpen} title={badge ? `${badge.label}；点击查看流程图，再次点击收起` : "派单：查看派单流程图；再次点击收起"} onClick={() => store.toggleDispatches()}>
      {dispatchIcon}
    </button>
  </div>;
}

/** 手机会话顶栏只留「⋯」：同样三个开关以菜单项形式放进更多菜单（桌面由 CSS 隐藏）。 */
export function PanelMenuItems({ onDone }: { onDone: () => void }) {
  const [filesOpen, termOpen, dispatchesOpen, terminalCapable] = useStore(selectPanelState, shallowEqual);
  const item = (label: string, pressed: boolean, icon: ReactNode, toggle: () => void) =>
    <button type="button" className="btn session-more-item session-more-mobile" role="menuitemcheckbox" aria-checked={pressed} onClick={() => { onDone(); toggle(); }}>
      {icon} {label}
    </button>;
  return <>
    {item("文件", filesOpen, folderIcon, () => store.setFilesOpen(!store.filesOpen))}
    {terminalCapable && item("终端", termOpen, <TerminalIcon />, () => store.setTerminalOpen(!store.termOpen))}
    {item("派单", dispatchesOpen, dispatchIcon, () => store.toggleDispatches())}
  </>;
}
