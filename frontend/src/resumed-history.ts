import type { HistoryMessage, HistoryMessagesPage } from "./types";

// 续接会话历史消息区（ResumedHistory）的纯逻辑（无 DOM 依赖，可单测）：
// 最新一页打底、nextCursor 向更早翻页 prepend、DOM 量上限。

/** 每页条数：与后端默认一致（50），默认只加载最近一页，不一次拉全。 */
export const HISTORY_PAGE_SIZE = 50;

/**
 * 历史区 DOM 量上限：最多加载最近 500 条（10 页）。达到后不再继续翻页，
 * 如实提示「更早的内容在原生会话文件中」，不引虚拟滚动库。
 */
export const HISTORY_MAX_MESSAGES = 500;

export interface HistoryPageState {
  /** 已加载消息，整体按时间正序（新的在后） */
  messages: HistoryMessage[];
  /** 继续向更早翻页的不透明 cursor；undefined = 已到最早 */
  nextCursor?: string;
  hasMore: boolean;
  /** 已加载的任一页触发过读取窗口限制（中性说明，不是错误） */
  truncated: boolean;
}

/** 最新一页打底（进入会话时默认加载）。 */
export function initialHistoryPage(page: HistoryMessagesPage): HistoryPageState {
  return {
    messages: [...page.messages],
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    hasMore: page.hasMore,
    truncated: page.truncated,
  };
}

/**
 * 用 nextCursor 取到的更早一页 prepend：页内按时间正序，
 * 整页比已加载内容更早，直接拼在前面即可。
 * 空页不 prepend（空页会让 messages 条数不变、滚动补偿基线滞留）：
 * messages 原样保留，但 cursor/hasMore 照常推进，否则翻页按钮会卡死在同一个空页上。
 */
export function prependHistoryPage(
  prev: HistoryPageState,
  page: HistoryMessagesPage,
): HistoryPageState {
  if (page.messages.length === 0) {
    return {
      messages: prev.messages,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      hasMore: page.hasMore,
      truncated: prev.truncated || page.truncated,
    };
  }
  return {
    messages: [...page.messages, ...prev.messages],
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    hasMore: page.hasMore,
    truncated: prev.truncated || page.truncated,
  };
}

/** 是否已到 DOM 上限（达到后翻页按钮换成说明文字）。 */
export function historyCapReached(state: HistoryPageState): boolean {
  return state.messages.length >= HISTORY_MAX_MESSAGES;
}
