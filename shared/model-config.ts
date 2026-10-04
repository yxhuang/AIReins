interface ModelConfigValue {
  value: string | null;
  label: string;
  description?: string;
}

interface ModelConfigOption {
  id: string;
  values: ModelConfigValue[];
  default: string | null;
  valuesByModel?: Record<string, ModelConfigValue[]>;
  defaultsByModel?: Record<string, string | null>;
}

/** 模型能力由后端提供；菜单与配置校验使用同一套选择规则。 */
export function configOptionsForModel<T extends ModelConfigOption>(options: T[], model?: string | null): T[] {
  const selected = model || options.find(option => option.id === "model")?.default;
  return options.map(option => {
    const values = selected ? option.valuesByModel?.[selected] : undefined;
    if (!values) return option;
    const defaultValue = values.some(value => value.value === option.default)
      ? option.default : option.defaultsByModel?.[selected!] ?? null;
    return { ...option, values, default: defaultValue };
  });
}

/** 切换到不支持当前显式档位的模型时撤销档位覆盖，交由模型选择默认值。 */
export function modelConfigPatch(options: ModelConfigOption[], current: { effort?: string | null }, model: string | null) {
  const effort = configOptionsForModel(options, model).find(option => option.id === "effort");
  return {
    model,
    ...(current.effort && effort && !effort.values.some(value => value.value === current.effort)
      ? { effort: null } : {}),
  };
}
