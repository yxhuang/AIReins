import type { AskQuestion, AskQuestionOption } from "./types";
import { asRecord } from "./format";

// AskUserQuestion 提问卡片的纯逻辑（无 DOM 依赖，可单测）：
// 事件 questions[] 归一、选项选择状态、「其他…」自由文本、回传 questionAnswers 的合成。
// 协议纪律（见 server/README）：key 逐字用 question 不用 header；多选合并为逗号分隔的一个字符串；
// 「其他」选中时该题答案取输入文本（原样透传，后端不区分来源）。

/**
 * 归一 permission_request 下行的 questions：只保留「question 为非空字符串且至少一个
 * label 非空的选项」的条目；全部无效时返回空数组（调用方回退到普通审批卡片）。
 */
export function normalizeQuestions(raw: unknown, payloadOtherSupported?: unknown): AskQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: AskQuestion[] = [];
  for (const item of raw) {
    const q = asRecord(item);
    if (typeof q.question !== "string" || !q.question) continue;
    const options: AskQuestionOption[] = [];
    if (Array.isArray(q.options)) {
      for (const rawOption of q.options) {
        const o = asRecord(rawOption);
        if (typeof o.label !== "string" || !o.label) continue;
        options.push({
          label: o.label,
          ...(typeof o.description === "string" && o.description
            ? { description: o.description }
            : {}),
        });
      }
    }
    if (options.length === 0) continue;
    questions.push({
      question: q.question,
      ...(typeof q.header === "string" && q.header ? { header: q.header } : {}),
      options,
      multiSelect: q.multiSelect === true,
      // 每题的 otherSupported 优先，其次事件级；只有明确 false 才隐藏「其他…」
      ...(q.otherSupported === false || (q.otherSupported === undefined && payloadOtherSupported === false)
        ? { otherSupported: false }
        : {}),
    });
  }
  return questions;
}

/** 选中集合：key 逐字 = question，value = 已选 label 数组（保持选项顺序由合成时保证）。 */
export type AskSelection = Record<string, string[]>;

/** 「其他…」自由文本：key 逐字 = question；键存在即表示该题选中「其他」（与选项互斥），值为输入文本。 */
export type AskOther = Record<string, string>;

/** 问题原文可与 Object.prototype 的属性同名，只读取实际选择键。 */
export function selectedOptions(selection: AskSelection, question: AskQuestion): string[] {
  return Object.hasOwn(selection, question.question) ? selection[question.question]! : [];
}

/** 点选一个选项：单选替换，多选 toggle。返回新对象（React state）。 */
export function toggleOption(
  selection: AskSelection,
  question: AskQuestion,
  label: string,
): AskSelection {
  const current = selectedOptions(selection, question);
  let next: string[];
  if (question.multiSelect) {
    next = current.includes(label)
      ? current.filter((item) => item !== label)
      : [...current, label];
  } else {
    next = current.length === 1 && current[0] === label ? [] : [label];
  }
  return { ...selection, [question.question]: next };
}

/** 该题是否选中了「其他…」。不用 in（question 可能撞上原型链上的键如 "constructor"）。 */
export function hasOther(other: AskOther, question: AskQuestion): boolean {
  return Object.hasOwn(other, question.question);
}

/** 选中/取消「其他…」：选中即清空该题已选选项（互斥，单选语义）。返回新 selection 与新 other。 */
export function toggleOther(
  selection: AskSelection,
  other: AskOther,
  question: AskQuestion,
): { selection: AskSelection; other: AskOther } {
  if (hasOther(other, question)) {
    const nextOther = { ...other };
    delete nextOther[question.question];
    return { selection, other: nextOther };
  }
  return {
    selection: { ...selection, [question.question]: [] },
    other: { ...other, [question.question]: "" },
  };
}

/** 输入「其他」文本；仅在该题已选中「其他」时生效。 */
export function setOtherText(other: AskOther, question: AskQuestion, text: string): AskOther {
  if (!hasOther(other, question)) return other;
  return { ...other, [question.question]: text };
}

/** 与「其他」互斥：点选任何选项时清掉该题的「其他」。 */
export function clearOther(other: AskOther, question: AskQuestion): AskOther {
  if (!hasOther(other, question)) return other;
  const next = { ...other };
  delete next[question.question];
  return next;
}

/** 每题至少选中一项才可提交；选中「其他」时须填了非空文本才算已回答。 */
export function allAnswered(
  questions: AskQuestion[],
  selection: AskSelection,
  other: AskOther = {},
): boolean {
  return questions.every((q) =>
    hasOther(other, q)
      ? other[q.question]!.trim().length > 0
      : selectedOptions(selection, q).length > 0,
  );
}

/**
 * 合成 WS permission_resolved 的 questionAnswers：
 * key 逐字用 question 原文；多选按选项出现顺序合并为逗号分隔的一个字符串；
 * 选中「其他」的题答案取输入文本（去首尾空白），不与选项合并。
 */
export function buildQuestionAnswers(
  questions: AskQuestion[],
  selection: AskSelection,
  other: AskOther = {},
): Record<string, string> {
  const answers: [string, string][] = [];
  for (const q of questions) {
    if (hasOther(other, q)) {
      const text = other[q.question]!.trim();
      if (text) answers.push([q.question, text]);
      continue;
    }
    const picked = new Set(selectedOptions(selection, q));
    const ordered = q.options.map((o) => o.label).filter((label) => picked.has(label));
    if (ordered.length > 0) answers.push([q.question, ordered.join(",")]);
  }
  return Object.fromEntries(answers);
}
