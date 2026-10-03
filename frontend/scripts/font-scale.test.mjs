import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { FONT_SCALES, fontScale, fontScaleChoice, readFontScaleChoice } from "../src/font-scale.ts";

assert.deepEqual(FONT_SCALES, { small: 0.9, default: 1, large: 1.15, xlarge: 1.25 });
for (const [choice, scale] of Object.entries(FONT_SCALES)) {
  assert.equal(fontScaleChoice(choice), choice);
  assert.equal(fontScale(choice), scale);
}
assert.equal(fontScaleChoice(null), "default");
assert.equal(fontScaleChoice("unknown"), "default");
assert.equal(fontScale("unknown"), 1);

assert.equal(fontScale("__proto__"), 1);
assert.equal(fontScale("constructor"), 1);
assert.equal(readFontScaleChoice(), "default"); // localStorage absent in Node
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
try {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "large" } });
  assert.equal(readFontScaleChoice(), "large");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  assert.equal(readFontScaleChoice(), "default");
} finally {
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
  else delete globalThis.localStorage;
}
// Keep the pre-paint inline bootstrap in sync with the typed choice mapping.
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
for (const choice of [...Object.keys(FONT_SCALES), null, "unknown", "__proto__"]) {
  let applied = 1;
  runInNewContext(script, {
    localStorage: { getItem: (key) => key === "workbench-font-scale" ? choice : null },
    document: { documentElement: { style: { setProperty: (key, value) => {
      assert.equal(key, "--font-scale");
      applied = Number(value);
    } } } },
  });
  assert.equal(applied, fontScale(choice));
}
assert.doesNotThrow(() => runInNewContext(script, {
  localStorage: { getItem() { throw new Error("blocked"); } },
}));

// 工单 C 的界面契约沿用现有前端验收入口。
await import("./ui-interface.test.mjs");
