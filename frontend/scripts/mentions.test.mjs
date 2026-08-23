#!/usr/bin/env node
// mentions.ts 的纯函数单测。这三个函数是 @ 引用的解析核心，边界多、坏了不报错只会静默漏引用。
import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";

// 用 tsx 把 TS 模块加载进来
const { extractMentionTokens, mentionQueryAt, mentionTokenEnd, stripMentionCandidates } =
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
t("中文标点并入原 token（截断由剥离候选兜底，见 P2-3 用例）", () => assert.deepEqual(extractMentionTokens("看 @a.ts，然后"), ["a.ts，然后"]));
t("中文标点后紧跟的 @ 也算引用", () => assert.deepEqual(extractMentionTokens("看，@a.ts 然后"), ["a.ts"]));

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
t("句读标点后不再触发(面板关闭)", () => assert.equal(mentionQueryAt("@a.ts，然后", "@a.ts，然后".length), null));
t("光标在标点前的 token 内仍触发", () => assert.deepEqual(mentionQueryAt("@a.ts，然后", 5), { start: 0, query: "a.ts" }));
t("点不作边界(路径正常触发)", () => at("@a.t", "a.t"));
t("句读标点后紧跟的 @ 是新 token", () => assert.deepEqual(mentionQueryAt("看，@a", 4), { start: 2, query: "a" }));

// --- mentionTokenEnd ---
t("扫到下一个空白", () => assert.equal(mentionTokenEnd("@a.ts 后面", 2), 5));
t("扫到文本末尾", () => assert.equal(mentionTokenEnd("@a.ts", 2), 5));
t("光标已在空白处", () => assert.equal(mentionTokenEnd("@a.ts 后", 5), 5));
t("扫到下一个句读标点", () => assert.equal(mentionTokenEnd("@a.ts，然后", 2), 5));

// --- stripMentionCandidates ---
// 纯函数只产出候选；「整 token 命中则不剥」「剥后命中才采纳」的存在性判定在 store-flow 打桩测试里。
t("句末逗号能剥", () => assert.deepEqual(stripMentionCandidates("a.ts，"), ["a.ts"]));
t("连续标点逐级剥(长的在前)", () => assert.deepEqual(stripMentionCandidates("a.ts，。"), ["a.ts，", "a.ts"]));
t("尾部英文标点也剥", () => assert.deepEqual(stripMentionCandidates("a.ts!"), ["a.ts"]));
t("尾部闭括号/引号也剥", () => assert.deepEqual(stripMentionCandidates("a.ts》"), ["a.ts"]));
t("尾点参与剥离(剥后是否采纳由存在性判定)", () => assert.deepEqual(stripMentionCandidates("readme.md."), ["readme.md"]));
t("无尾部标点无候选", () => assert.deepEqual(stripMentionCandidates("a.ts"), []));
t("- 与 _ 不剥", () => assert.deepEqual(stripMentionCandidates("file-name_final"), []));
t("中间的点不剥(只剥尾部)", () => assert.deepEqual(stripMentionCandidates("v1.2，"), ["v1.2"]));
t("剥空不产生空候选", () => assert.deepEqual(stripMentionCandidates("，"), []));
t("纯标点串的中间候选保留(不会命中,查一次无害)", () => assert.deepEqual(stripMentionCandidates("，。"), ["，"]));
t("中段标点截断(尾部无可剥时)", () => assert.deepEqual(stripMentionCandidates("a.ts，然后"), ["a.ts"]));
t("中段截断时 . 不作边界", () => assert.deepEqual(stripMentionCandidates("v1.2，然后"), ["v1.2"]));
t("尾部剥离候选排在中段截断前", () => assert.deepEqual(stripMentionCandidates("ab，cd，。"), ["ab，cd，", "ab，cd", "ab"]));

// --- P2-3：@ 后紧跟中文标点无空格（端到端解析纪律） ---
// resolve 模拟 store.resolveMentionPath 的查询顺序：整 token 优先，剥离候选只作回退；
// 存在性判定在 store 层（resolveFile 精确 includes），这里用 knownFiles 打桩同一纪律。
const resolve = (token, knownFiles) => {
  if (knownFiles.includes(token)) return token;
  for (const candidate of stripMentionCandidates(token)) {
    if (knownFiles.includes(candidate)) return candidate;
  }
  return null;
};
t("@a.ts，然后 解析出 a.ts（而非未找到）", () => {
  const [token] = extractMentionTokens("看 @a.ts，然后");
  assert.equal(token, "a.ts，然后"); // 整 token 原样提取（真带标点的文件名不冤枉）
  assert.equal(resolve(token, ["a.ts"]), "a.ts");
});
t("文件名真带逗号仍整 token 命中（截断只是回退路径）", () => {
  const [token] = extractMentionTokens("看 @report，final.txt");
  assert.equal(token, "report，final.txt");
  // report 与 report，final.txt 同时存在：整 token 优先，不得被中段截断冤枉成 report
  assert.equal(resolve(token, ["report", "report，final.txt"]), "report，final.txt");
});

if (!process.exitCode) console.log(`✅ mentions 解析单测全过（${pass} 例）`);
else console.error(`部分用例失败（通过 ${pass} 例）`);
