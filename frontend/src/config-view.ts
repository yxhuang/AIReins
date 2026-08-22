import type { DriverConfigOption } from "./types";

// 配置控件展示的纯逻辑（无 DOM 依赖，可单测）：mutableVia:"restart" 的代价标注。

/**
 * mutableVia:"restart" 选项旁的一行小字（事实说明，不是警告）：
 * claude 的 model/effort 切换 = 停 worker → --resume 同一原生会话 → 带新参数重启。
 */
export const RESTART_NOTE = "切换会重启底层进程并续接当前会话";

/** 该选项是否需要「重启切换」代价标注（schema 的 mutableVia:"restart"）。 */
export function needsRestartNote(option: Pick<DriverConfigOption, "mutableVia">): boolean {
  return option.mutableVia === "restart";
}
