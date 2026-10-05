import assert from "node:assert/strict";
import { contextPercent } from "../src/context-usage.ts";

// 累计花费不能当成当前上下文；Codex 必须取 last 而非 total。
assert.equal(contextPercent("codex", { usage: { total: { totalTokens: 900000 }, last: { totalTokens: 25000 }, modelContextWindow: 100000 } }), 25);
assert.equal(contextPercent("codex", { usage: { total: { totalTokens: 900000 }, modelContextWindow: 100000 } }), null);
assert.equal(contextPercent("kimi", { used: 25417, size: 1048576 }), 25417 / 1048576 * 100);
assert.equal(contextPercent("claude", { usage: { input_tokens: 500000 }, modelUsage: { model: { contextWindow: 200000 } } }), null);
assert.equal(contextPercent("claude", { totalTokens: 42000, maxTokens: 200000, percentage: 21 }), 21);
assert.equal(contextPercent("claude", { totalTokens: 42000, maxTokens: 200000 }), 21);
assert.equal(contextPercent("claude", { percentage: 0 }), 0);
assert.equal(contextPercent("kimi", { used: 120, size: 100 }), 100);
for (const payload of [undefined, null, {}, { used: 3, size: 0 }, { used: -1, size: 100 }, { used: "30", size: 100 }, { used: Infinity, size: 100 }, { used: 30, size: NaN }]) {
  assert.equal(contextPercent("kimi", payload), null);
}
console.log("PASS: 三家当前上下文口径、累计值隔离、零值、越界及缺失数据");
