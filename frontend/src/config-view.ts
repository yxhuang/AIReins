import { t } from "./i18n";
import type { AgentKind, ConfigOptionId, DriverConfigOption, EffectiveSource, SessionRecord } from "./types";
export { configOptionsForModel, modelConfigPatch } from "../../shared/model-config";

/** 新建表单显式提交用户指定的默认模式，兼容尚未重启的服务端。 */
export function newSessionConfig(agent: AgentKind): Partial<Record<ConfigOptionId, string>> {
  if (agent === "codex") return { permissionMode: "auto-review" };
  if (agent === "kimi") return { permissionMode: "auto" };
  return {};
}

// 配置控件展示的纯逻辑（无 DOM 依赖，可单测）：mutableVia:"restart" 的代价标注、
// claude 实际生效值（effectiveModel/effectiveEffort）的读取与来源标注。

/**
 * mutableVia:"restart" 选项旁的一行小字（事实说明，不是警告）：
 * claude 的 model/effort 切换 = 停 worker → --resume 同一原生会话 → 带新参数重启。
 */
export const RESTART_NOTE = t("core.015");

/** 该选项是否需要「重启切换」代价标注（schema 的 mutableVia:"restart"）。 */
export function needsRestartNote(option: Pick<DriverConfigOption, "mutableVia">): boolean {
  return option.mutableVia === "restart";
}

/** effective* 来源的极小字标注：session=会话覆盖、settings=Claude 设置、init=运行时回报。 */
export const EFFECTIVE_SOURCE_LABELS: Record<Exclude<EffectiveSource, null>, string> = {
  session: t("core.016"),
  settings: t("core.017"),
  init: t("core.018"),
};

/** settings 来源的有效模型是别名（claude CLI 无枚举接口），不是精确 id。 */
export const ALIAS_NOTE = t("core.019");

interface EffectiveValue {
  value: string;
  source: Exclude<EffectiveSource, null>;
}

/**
 * 某配置项当前能确认的实际生效值（仅 claude 的 model/effort 有；codex/kimi 恒 null，属正常）。
 * 覆盖存在时（config 有值）不需要它——调用方只在「跟随配置」时使用。
 */
export function effectiveFor(
  session: Pick<
    SessionRecord,
    "effectiveModel" | "effectiveEffort" | "effectiveModelSource" | "effectiveEffortSource"
  >,
  optionId: ConfigOptionId,
): EffectiveValue | null {
  const value = optionId === "model" ? session.effectiveModel
    : optionId === "effort" ? session.effectiveEffort
    : null;
  const source = optionId === "model" ? session.effectiveModelSource
    : optionId === "effort" ? session.effectiveEffortSource
    : null;
  if (typeof value !== "string" || !value || !source) return null;
  return { value, source };
}

/** 胶囊上显示的值：有覆盖用覆盖，否则用实际生效值 / 后端给的 default，都没有才写「默认」。 */
export function pillText(
  option: { values: { value: string | null; label: string }[]; default: string | null },
  current: string | undefined,
  effective?: string | null,
): string {
  const labelOf = (value: string) =>
    option.values.find((v) => v.value === value)?.label ??
    // claude init 回报的是精确 id（claude-opus-5-5），按别名子串认回菜单里的标签
    option.values.find((v) => v.value !== null && value.includes(v.value))?.label ??
    value;
  const value = current || effective || option.default;
  return value ? labelOf(value) : t("core.020");
}

/** 会话头的模型短名：去掉 claude- 前缀与日期后缀，版本号连字符改点（claude-opus-5-5 → opus-5.5）。 */
export function modelShortName(model: string): string {
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-(\d+)-(\d+)(?=$|\[)/, "-$1.$2");
}
