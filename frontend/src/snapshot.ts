import type { SnapshotPreflight } from "./types";

// 建会话前快照的决策与流程编排（无 DOM 依赖，可单测）。
// 组件（Sidebar 的新建表单）只负责把 confirm/create 接进来；分支规则全部在这里。

/** 快照流程出口："proceed" = 直接建会话；"confirm" = 先弹确认框让用户拍板。 */
export type SnapshotFlow = "proceed" | "confirm";

/** 确认框三个出口；"auto"/"skip" 原样成为 POST /api/sessions 的 snapshot 字段。 */
export type SnapshotChoice = "auto" | "skip" | "cancel";

/**
 * 分支规则（与后端契约一一对应）：
 * - needed 为 false（git 仓库，自身有回滚能力）→ 直接建会话，不传 snapshot；
 * - needed 为 true 且未超阈值且空间足够 → 直接建会话（后端静默快照）；
 * - needed 为 true 且（超阈值或空间不足）→ 弹确认框。
 */
export function snapshotFlowDecision(preflight: SnapshotPreflight): SnapshotFlow {
  if (!preflight.needed) return "proceed";
  if (!preflight.exceeds && preflight.freeSpaceOk) return "proceed";
  return "confirm";
}

/** 确认框里「为什么弹这个框」的原因列表（超阈值 / 空间不足可同时成立）。 */
export function snapshotConfirmReasons(preflight: SnapshotPreflight): string[] {
  const reasons: string[] = [];
  if (preflight.exceeds) {
    reasons.push("该目录超过自动快照阈值（500MB 或 20000 个文件），完整复制可能需要较长时间。");
  }
  if (!preflight.freeSpaceOk) {
    reasons.push("快照目标盘的可用空间不足，直接快照会失败。");
  }
  return reasons;
}

export interface CreateWithSnapshotDeps {
  /** POST /api/snapshot/preflight */
  preflight: (cwd: string) => Promise<SnapshotPreflight>;
  /** 实际建会话；snapshot 缺省 = 不传该字段（后端默认 "auto"） */
  create: (snapshot?: "auto" | "skip") => Promise<void>;
  /** 弹确认框等用户选择；只在需要确认时被调用 */
  confirm: (preflight: SnapshotPreflight) => Promise<SnapshotChoice>;
  /** preflight 失败时的记录渠道（不打扰用户） */
  log?: (message: string) => void;
}

/**
 * 建会话流程编排：先 preflight，再按分支建会话。
 * 返回 true = 会话已建（create 完成）；false = 用户在确认框取消，未建会话。
 * create 自身的失败原样抛给调用方展示；只有 preflight 失败被吞——
 * 快照是保护措施，绝不能因为它坏了就阻断用户建会话（失败时不传 snapshot 照常建）。
 */
export async function createWithSnapshotPreflight(
  cwd: string,
  deps: CreateWithSnapshotDeps,
): Promise<boolean> {
  let preflight: SnapshotPreflight;
  try {
    preflight = await deps.preflight(cwd);
  } catch (error) {
    deps.log?.(
      `快照预检失败（${error instanceof Error ? error.message : String(error)}），跳过快照检查直接建会话`,
    );
    await deps.create(undefined);
    return true;
  }
  if (snapshotFlowDecision(preflight) === "proceed") {
    await deps.create(undefined);
    return true;
  }
  const choice = await deps.confirm(preflight);
  if (choice === "cancel") return false;
  await deps.create(choice);
  return true;
}
