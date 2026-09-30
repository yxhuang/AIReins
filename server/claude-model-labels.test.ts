import assert from "node:assert/strict";
import {
  CLAUDE_CONFIG_SCHEMA,
  deriveClaudeModelLabels,
  updateClaudeModelLabels,
} from "./drivers/claude.js";

const models = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus", description: "Opus 5.5 · Best for everyday, complex tasks" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1 · Most capable" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 · Efficient" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5 · Fastest" },
];
const values = CLAUDE_CONFIG_SCHEMA.options.find((option) => option.id === "model")!.values;
const labels = () => values.map(({ value, label }) => ({ value, label }));

assert.deepEqual(deriveClaudeModelLabels(models), {
  opus: "Opus 5.5", fable: "Fable 5.1", sonnet: "Sonnet 5", haiku: "Haiku 4.5",
});
updateClaudeModelLabels(models);
assert.deepEqual(labels(), [
  { value: null, label: "跟随 Claude 配置" },
  { value: "fable", label: "Fable 5.1" },
  { value: "opus", label: "Opus 5.5" },
  { value: "sonnet", label: "Sonnet 5" },
  { value: "haiku", label: "Haiku 4.5" },
]);

// Partial or malformed response only affects its own alias; never relabel default.
updateClaudeModelLabels([
  { value: "default", description: "Opus 99 · unrelated" },
  { value: "opus", description: "unexpected text" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", description: "Fable 5.2 · updated" },
]);
assert.deepEqual(labels(), [
  { value: null, label: "跟随 Claude 配置" },
  { value: "fable", label: "Fable 5.2" },
  { value: "opus", label: "Opus（最新）" },
  { value: "sonnet", label: "Sonnet（最新）" },
  { value: "haiku", label: "Haiku（最新）" },
]);
updateClaudeModelLabels(undefined);
assert.deepEqual(labels().slice(1).map((entry) => entry.label), [
  "Fable（最新）", "Opus（最新）", "Sonnet（最新）", "Haiku（最新）",
]);

// September 2026 initialize: displayName carries the version; prose no longer does.
const currentModels = [
  { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", description: "For complex work and everyday tasks" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", description: "Most efficient for simpler tasks" },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", description: "For your toughest challenges" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5", description: "Fastest for quick answers" },
  { value: "claude-fable-5", resolvedModel: "claude-fable-5", displayName: "Fable 5", description: "Previous model" },
];
const expected = { opus: "Opus 5.5", sonnet: "Sonnet 5.5", fable: "Fable 5.1", haiku: "Haiku 4.5" };
assert.deepEqual(deriveClaudeModelLabels(currentModels), expected);
assert.deepEqual(deriveClaudeModelLabels([...currentModels].reverse()), expected);
updateClaudeModelLabels(currentModels);
assert.deepEqual(labels(), [
  { value: null, label: "跟随 Claude 配置" },
  { value: "fable", label: "Fable 5.1" },
  { value: "opus", label: "Opus 5.5" },
  { value: "sonnet", label: "Sonnet 5.5" },
  { value: "haiku", label: "Haiku 4.5" },
]);
assert.deepEqual(deriveClaudeModelLabels([
  null, 123, {},
  { value: "opus", displayName: "Opus 5.5", description: "Opus 4.6 · stale description" },
  { value: "sonnet", displayName: "Sonnet 5.5 extra", description: "Sonnet 5 · legacy fallback" },
  { value: "claude-opus-99", displayName: "Opus 99" },
  { value: "default", resolvedModel: "claude-fable-99", description: "Fable 99 · default must not relabel aliases" },
  ...["5.9", "5.10.1", "5.10", "5"].map((version) => ({ value: "claude-fable-" + version, displayName: "Fable " + version })),
]), { opus: "Opus 5.5", sonnet: "Sonnet 5", fable: "Fable 5.10.1" });
assert.deepEqual(deriveClaudeModelLabels(undefined), {});
assert.deepEqual(deriveClaudeModelLabels({ models: currentModels }), {});
updateClaudeModelLabels(undefined);
