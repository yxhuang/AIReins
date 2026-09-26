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
