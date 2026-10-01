import type { AgentKind, HistoryMessage } from "./types";
import { buildHistoryRenderItems, groupReadOnlyTools } from "./render-items";

type HistoryItems = ReturnType<typeof groupReadOnlyTools>;

/** 历史数组不可变：新增消息或替换工具结果必须提供新数组；弱引用不阻止历史回收。 */
export function createHistoryRenderCache(
  build = (messages: HistoryMessage[], agent: AgentKind, cwd: string): HistoryItems =>
    groupReadOnlyTools(buildHistoryRenderItems(messages), agent, cwd),
) {
  const cache = new WeakMap<HistoryMessage[], { agent: AgentKind; cwd: string; items: HistoryItems }>();
  return (messages: HistoryMessage[], agent: AgentKind, cwd: string): HistoryItems => {
    const cached = cache.get(messages);
    if (cached?.agent === agent && cached.cwd === cwd) return cached.items;
    const items = build(messages, agent, cwd);
    cache.set(messages, { agent, cwd, items });
    return items;
  };
}

export const historyRenderItems = createHistoryRenderCache();
