import type { HistoryMessage, HistoryMessagesPage } from "./types";

// 续接会话历史消息区（ResumedHistory）的纯逻辑（无 DOM 依赖，可单测）：
// 最新一页打底、nextCursor 向更早翻页 prepend。

/** 每页条数：与后端默认一致（50），默认只加载最近一页，不一次拉全。 */
export const HISTORY_PAGE_SIZE = 50;

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

/** cursor 类失败（已失效/不匹配/无效）的判定：服务端 400 的中文消息都含 "cursor"。 */
export function isStaleCursorError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("cursor");
}

/**
 * 首页加载：有 initialCursor（导入时刻的截止 cursor）先按它取，拿到的就是导入前的最新一页；
 * cursor 失效（原生文件被截断/改写等）时退回不带 cursor 的最新一页，不报错；
 * 其余错误原样抛出，由调用方显示。
 */
export async function fetchInitialHistoryPage(
  fetcher: (opts: { limit: number; cursor?: string }) => Promise<HistoryMessagesPage>,
  initialCursor: string | undefined,
  limit: number,
): Promise<HistoryMessagesPage> {
  if (!initialCursor) return fetcher({ limit });
  try {
    return await fetcher({ limit, cursor: initialCursor });
  } catch (error) {
    if (!isStaleCursorError(error)) throw error;
    return fetcher({ limit });
  }
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
