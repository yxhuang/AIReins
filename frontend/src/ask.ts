import type { AskQuestion, AskQuestionOption } from "./types";
import { asRecord } from "./format";

// AskUserQuestion 提问卡片的纯逻辑（无 DOM 依赖，可单测）：
// 事件 questions[] 归一、选项选择状态、回传 questionAnswers 的合成。
// 协议纪律（见 server/README）：key 逐字用 question 不用 header；多选合并为逗号分隔的一个字符串。

/**
 * 归一 permission_request 下行的 questions：只保留「question 为非空字符串且至少一个
 * label 非空的选项」的条目；全部无效时返回空数组（调用方回退到普通审批卡片）。
 */
export function normalizeQuestions(raw: unknown): AskQuestion[] {
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
    });
  }
  return questions;
}

/** 选中集合：key 逐字 = question，value = 已选 label 数组（保持选项顺序由合成时保证）。 */
export type AskSelection = Record<string, string[]>;

/** 点选一个选项：单选替换，多选 toggle。返回新对象（React state）。 */
export function toggleOption(
  selection: AskSelection,
  question: AskQuestion,
  label: string,
): AskSelection {
  const current = selection[question.question] ?? [];
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

/** 每题至少选中一项才可提交。 */
export function allAnswered(questions: AskQuestion[], selection: AskSelection): boolean {
  return questions.every((q) => (selection[q.question]?.length ?? 0) > 0);
}

/**
 * 合成 WS permission_resolved 的 questionAnswers：
 * key 逐字用 question 原文；多选按选项出现顺序合并为逗号分隔的一个字符串。
 */
export function buildQuestionAnswers(
  questions: AskQuestion[],
  selection: AskSelection,
): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const picked = new Set(selection[q.question] ?? []);
    const ordered = q.options.map((o) => o.label).filter((label) => picked.has(label));
    if (ordered.length > 0) answers[q.question] = ordered.join(",");
  }
  return answers;
}
