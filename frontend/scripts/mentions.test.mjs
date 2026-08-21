#!/usr/bin/env node
// mentions.ts 的纯函数单测。这三个函数是 @ 引用的解析核心，边界多、坏了不报错只会静默漏引用。
import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";

// 用 tsx 把 TS 模块加载进来
const { extractMentionTokens, mentionQueryAt, mentionTokenEnd } =
  await import("../src/mentions.ts");

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { console.error(`❌ ${name}\n   ${e.message}`); process.exitCode = 1; } };

// --- extractMentionTokens ---
t("行首引用", () => assert.deepEqual(extractMentionTokens("@a.ts 看看"), ["a.ts"]));
t("句中引用", () => assert.deepEqual(extractMentionTokens("看看 @server/index.ts 这个"), ["server/index.ts"]));
t("多个引用保持顺序", () => assert.deepEqual(extractMentionTokens("@b.ts 和 @a.ts"), ["b.ts", "a.ts"]));
t("重复引用去重", () => assert.deepEqual(extractMentionTokens("@a.ts @a.ts"), ["a.ts"]));
t("邮箱不误判", () => assert.deepEqual(extractMentionTokens("联系 foo@bar.com"), []));
t("纯 @ 不算", () => assert.deepEqual(extractMentionTokens("@ 空"), []));
t("无引用", () => assert.deepEqual(extractMentionTokens("普通文本"), []));
t("换行后引用", () => assert.deepEqual(extractMentionTokens("第一行\n@a.ts"), ["a.ts"]));
t("中文标点会并入(已知取舍)", () => assert.deepEqual(extractMentionTokens("看 @a.ts，然后"), ["a.ts，然后"]));

// --- mentionQueryAt ---
const at = (text, expectQuery) => {
  const start = text.lastIndexOf("@");
  assert.deepEqual(mentionQueryAt(text, text.length), { start, query: expectQuery });
};
t("token 末尾触发", () => at("@ser", "ser"));
t("句中 token 触发", () => at("看 @ser", "ser"));
t("刚打出 @ 即触发(空 query)", () => at("看 @", ""));
t("token 中间光标也触发", () => assert.deepEqual(mentionQueryAt("@server/x", 4), { start: 0, query: "ser" }));
t("非 @ token 不触发", () => assert.equal(mentionQueryAt("server", "server".length), null));
t("邮箱不触发", () => assert.equal(mentionQueryAt("foo@bar", "foo@bar".length), null));
t("光标在空白后不触发", () => assert.equal(mentionQueryAt("@a.ts ", "@a.ts ".length), null));

// --- mentionTokenEnd ---
t("扫到下一个空白", () => assert.equal(mentionTokenEnd("@a.ts 后面", 2), 5));
t("扫到文本末尾", () => assert.equal(mentionTokenEnd("@a.ts", 2), 5));
t("光标已在空白处", () => assert.equal(mentionTokenEnd("@a.ts 后", 5), 5));

if (!process.exitCode) console.log(`✅ mentions 解析单测全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
