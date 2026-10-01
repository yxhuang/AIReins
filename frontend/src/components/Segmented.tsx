import { useLayoutEffect, useRef } from "react";

interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
  disabled?: boolean;
}

interface SegmentedProps<Value extends string> {
  options: readonly SegmentedOption<Value>[];
  value: Value | null;
  onChange: (value: Value) => void;
  role?: "group" | "radiogroup";
  ariaLabel?: string;
  ariaLabelledby?: string;
  disabled?: boolean;
  className?: string;
  buttonClassName?: string;
}

/** 单一滑块按实际按钮度量，兼容不同标签宽度、字号和隐藏后重新展开。 */
export function Segmented<Value extends string>({
  options, value, onChange, role = "group", ariaLabel, ariaLabelledby,
  disabled = false, className = "", buttonClassName = "",
}: SegmentedProps<Value>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const slider = sliderRef.current;
    if (!root || !slider) return;
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>("button"));
    const selected = buttons[options.findIndex((option) => option.value === value)];
    const measure = () => {
      slider.hidden = !selected || selected.offsetWidth === 0;
      if (slider.hidden || !selected) return;
      slider.style.width = `${selected.offsetWidth}px`;
      slider.style.height = `${selected.offsetHeight}px`;
      slider.style.transform = `translate(${selected.offsetLeft}px, ${selected.offsetTop}px)`;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    buttons.forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [options, value]);

  const firstEnabled = options.find((option) => !option.disabled)?.value;
  const tabValue = options.find((option) => option.value === value && !option.disabled)?.value ?? firstEnabled;

  return (
    <div ref={rootRef} className={`segmented ${className}`} role={role}
      aria-label={ariaLabel} aria-labelledby={ariaLabelledby}
      onKeyDown={(event) => {
        const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
          : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
        if (!direction || disabled) return;
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        if (index < 0) return;
        event.preventDefault();
        const next = buttons[(index + direction + buttons.length) % buttons.length];
        next?.focus();
        next?.click();
      }}>
      <span ref={sliderRef} className="segmented-slider" aria-hidden="true" hidden />
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button key={option.value} type="button"
            className={`segmented-option ${buttonClassName}${selected ? " active" : ""}`}
            role={role === "radiogroup" ? "radio" : undefined}
            aria-checked={role === "radiogroup" ? selected : undefined}
            aria-pressed={role === "group" ? selected : undefined}
            tabIndex={role === "radiogroup" && option.value !== tabValue ? -1 : 0}
            disabled={disabled || option.disabled}
            onClick={() => onChange(option.value)}>
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
