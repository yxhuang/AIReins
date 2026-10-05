import { strict as assert } from "node:assert";
import { shortSessionTitle, fitSessionTitle } from "../src/components/SessionTitle.tsx";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const visible = (text) => [...segmenter.segment(text)].map(({ segment }) => segment);
const measure = (text) => visible(text).reduce((width, ch) => width + (ch === "W" ? 3 : /[\u4e00-\u9fff]|👩/u.test(ch) ? 2 : 1), 0);

assert.equal(shortSessionTitle("一二三四五六七八九十甲乙丙丁"), "一二三四五六七八九十甲乙…");
assert.equal(shortSessionTitle("abcdefghijklmnop"), "abcdefghijkl…");
assert.equal(shortSessionTitle("abcdefghijkl"), "abcdefghijkl");
assert.equal(shortSessionTitle("短标题"), "短标题");
assert.equal(shortSessionTitle("👩‍💻e\u0301甲乙丙", 2), "👩‍💻e\u0301…");

assert.equal(fitSessionTitle("abc", 3, measure), "abc", "完整标题恰好放下时不省略");
assert.equal(fitSessionTitle("abcdef", 4, measure), "abc…");
assert.equal(fitSessionTitle("Wii中文后文", 8, measure), "Wii中…");
assert.equal(fitSessionTitle("👩‍💻甲乙丙丁", 5, measure), "👩‍💻甲…");
assert.equal(fitSessionTitle("title", 0, measure), "");
assert.equal(fitSessionTitle("", 10, measure), "");
let calls = 0;
assert.equal(fitSessionTitle("字".repeat(100000), 9, (text) => { calls++; return measure(text); }), "字字字字…");
assert.ok(calls < 15, "只测量能显示的前缀，避免处理整段长标题");
console.log("PASS: 12 字上限、中英文宽度、组合字符、边界与长标题测量检查");
