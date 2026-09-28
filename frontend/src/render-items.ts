import type { AgentKind, AskQuestion, HistoryMessage, PermissionDecision, UnifiedEvent } from "./types";
import { asRecord, stringifyBlock } from "./format";
import { normalizeQuestions } from "./ask";

// 把统一事件折叠成渲染条目：同一 turn 内的文本增量、思考增量合并成块；
// 工具调用按 toolCallId 聚合三阶段；闸门按 requestId 聚合请求与结果。

export interface TextBlock {
  kind: "text";
  key: string;
  seq: number;
  text: string;
  turn: number;
}

export interface ThoughtBlock {
  kind: "thought";
  key: string;
  seq: number;
  text: string;
  turn: number;
}

export interface UserBlock {
  kind: "user";
  key: string;
  seq: number;
  text: string;
}

export interface ToolView {
  kind: "tool";
  key: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  input: string;
  status: "running" | "ok" | "error";
  result: string;
  turn: number;
}

export interface EditChunk {
  /** 「改动 #n」 */
  title: string;
  removed: string;
  added: string;
}

export interface GateView {
  kind: "gate";
  key: string;
  seq: number;
  requestId: string;
  gate: string;
  toolName: string;
  agent: AgentKind;
  finalGate: boolean;
  label: string;
  command: string;
  path: string;
  content: string;
  /** 编辑型入参（claude Edit/MultiEdit）的删除/新增文本；纯写入时为空 */
  removed: string;
  added: string;
  /** MultiEdit 按 edit 分组的 diff 块（每块一对 removed/added，标题「改动 #n」）；
      removed/added 仍保留拼接结果，供不消费本字段的渲染兜底。非 MultiEdit 时缺省 */
  editChunks?: EditChunk[];
  detail: string;
  suggestions: unknown[];
  decision?: PermissionDecision;
  /** interactionType:"ask_user_question" 时归一后的结构化提问（渲染成选择卡片而非审批卡片） */
  questions?: AskQuestion[];
  /** 提问的回答回执：permission_resolved 广播原样带回的 questionAnswers（key 逐字 = 问题原文） */
  questionAnswers?: Record<string, string>;
}

export interface SystemBlock {
  kind: "system";
  key: string;
  seq: number;
  text: string;
  tone: "muted" | "error";
}

export interface RawBlock {
  kind: "raw";
  key: string;
  seq: number;
  text: string;
}

export interface ExternalHistoryBlock {
  kind: "external-history";
  key: string;
  seq: number;
  messages: HistoryMessage[];
  truncated: boolean;
}

export type RenderItem =
  | TextBlock
  | ThoughtBlock
  | UserBlock
  | ToolView
  | GateView
  | SystemBlock
  | ExternalHistoryBlock
  | RawBlock;

// 从 permission_request payload 提取闸门视图；三家 payload 形状不同，宽容处理。
export function gateFromEvent(event: UnifiedEvent, agent: AgentKind): GateView {
  const p = event.payload;
  const input = asRecord(p.input);
  const toolCall = asRecord(p.toolCall);
  const toolName = String(p.toolName ?? toolCall.title ?? "tool");

  // 命令：kimi terminal/create 的 input.command(+args)、claude Bash 的 input.command、
  // codex commandExecution 的 params.command（可能是字符串数组）。
  let command = "";
  const rawCommand = input.command;
  if (typeof rawCommand === "string") {
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    command = [rawCommand, ...args].join(" ");
  } else if (Array.isArray(rawCommand)) {
    command = rawCommand.map(String).join(" ");
  }

  const path =
    (typeof input.path === "string" && input.path) ||
    (typeof input.file_path === "string" && input.file_path) ||
    "";
  const content = typeof input.content === "string" ? input.content : "";

  // 编辑型入参：claude Edit 的 old_string/new_string；MultiEdit 的 edits[] 全部拼接，
  // 并额外按 edit 分组产出 editChunks（标题「改动 #n」），供 diff 分组渲染。
  let removed = "";
  let added = "";
  let editChunks: EditChunk[] | undefined;
  if (typeof input.old_string === "string" || typeof input.new_string === "string") {
    removed = typeof input.old_string === "string" ? input.old_string : "";
    added = typeof input.new_string === "string" ? input.new_string : "";
  } else if (Array.isArray(input.edits)) {
    const edits = input.edits.map(asRecord);
    editChunks = edits.map((e, i) => ({
      title: `改动 #${i + 1}`,
      removed: typeof e.old_string === "string" ? e.old_string : "",
      added: typeof e.new_string === "string" ? e.new_string : "",
    }));
    removed = editChunks.map((c) => c.removed).join("\n");
    added = editChunks.map((c) => c.added).join("\n");
  }

  const label =
    (typeof p.displayName === "string" && p.displayName) ||
    (typeof p.description === "string" && p.description) ||
    (typeof toolCall.title === "string" && toolCall.title) ||
    toolName;

  const suggestions = Array.isArray(p.permissionSuggestions) ? p.permissionSuggestions : [];

  // Claude AskUserQuestion：interactionType 标记 + 结构化 questions[]；归一后为空则回退普通审批卡片。
  const questions =
    p.interactionType === "ask_user_question" ? normalizeQuestions(p.questions, p.otherSupported) : [];

  // 兜底详情：优先展示 input，其次 toolCall，再次整个 payload。
  const detailSource =
    Object.keys(input).length > 0 ? input : Object.keys(toolCall).length > 0 ? toolCall : p;

  return {
    kind: "gate",
    key: `gate:${String(p.requestId ?? event.seq)}`,
    seq: event.seq,
    requestId: String(p.requestId ?? ""),
    gate: String(p.gate ?? ""),
    toolName,
    agent,
    finalGate: Boolean(p.finalGate),
    label,
    command,
    path,
    content,
    removed,
    added,
    detail: stringifyBlock(detailSource),
    suggestions,
    ...(editChunks && editChunks.length > 0 ? { editChunks } : {}),
    ...(questions.length > 0 ? { questions } : {}),
  };
}

// 按 seq 顺序把事件流折叠为渲染条目。
function abnormalTurnReason(payload: Record<string, unknown>, agent: AgentKind): string | null {
  if (agent === "claude") {
    if (typeof payload.subtype === "string" && payload.subtype !== "success") return payload.subtype;
    return payload.isError === true ? "Claude 报告错误" : null;
  }
  if (agent === "codex") {
    const error = asRecord(payload.error);
    const message = typeof error.message === "string" ? error.message :
      typeof payload.error === "string" ? payload.error : "";
    if (message) return message;
    if (payload.error != null) return "Codex 报告错误";
    return typeof payload.status === "string" && payload.status !== "completed" ? payload.status : null;
  }
  return typeof payload.stopReason === "string" && payload.stopReason !== "end_turn" ? payload.stopReason : null;
}

export function buildRenderItems(events: UnifiedEvent[], agent: AgentKind): RenderItem[] {
  const items: RenderItem[] = [];
  const tools = new Map<string, ToolView>();
  const gates = new Map<string, GateView>();
  let lastText: TextBlock | undefined;
  let lastThought: ThoughtBlock | undefined;
  let turn = 0;

  const breakRun = () => {
    lastText = undefined;
    lastThought = undefined;
  };

  for (const event of [...events].sort((a, b) => a.seq - b.seq)) {
    const p = event.payload;
    switch (event.type) {
      case "agent_text_delta": {
        const text = String(p.text ?? "");
        if (lastText) {
          lastText.text += text;
        } else {
          lastText = { kind: "text", key: `text:${event.seq}`, seq: event.seq, text, turn };
          items.push(lastText);
        }
        lastThought = undefined;
        break;
      }
      case "thought_delta": {
        const text = String(p.text ?? "");
        if (lastThought) {
          lastThought.text += text;
        } else {
          lastThought = { kind: "thought", key: `thought:${event.seq}`, seq: event.seq, text, turn };
          items.push(lastThought);
        }
        lastText = undefined;
        break;
      }
      case "user_message":
        breakRun();
        turn++;
        items.push({
          kind: "user",
          key: `user:${event.seq}`,
          seq: event.seq,
          text: String(p.text ?? ""),
        });
        break;
      case "external_messages_added": {
        breakRun();
        const messages: HistoryMessage[] = Array.isArray(p.messages)
          ? p.messages.flatMap((raw) => {
              if (!raw || typeof raw !== "object") return [];
              const item = raw as Record<string, unknown>;
              if ((item.role !== "user" && item.role !== "assistant") || typeof item.text !== "string") return [];
              return [{ role: item.role, text: item.text, timestamp: typeof item.timestamp === "string" ? item.timestamp : null }];
            })
          : [];
        items.push({ kind: "external-history", key: `external:${event.seq}`, seq: event.seq, messages, truncated: p.truncated === true });
        break;
      }
      case "tool_call_started": {
        breakRun();
        const id = String(p.toolCallId ?? event.seq);
        const view: ToolView = {
          kind: "tool",
          key: `tool:${id}`,
          seq: event.seq,
          toolCallId: id,
          toolName: String(p.toolName ?? "tool"),
          input: toolInputText(p),
          status: "running",
          result: "",
          turn,
        };
        tools.set(id, view);
        items.push(view);
        break;
      }
      case "tool_call_updated": {
        const view = tools.get(String(p.toolCallId ?? ""));
        if (view) {
          const updated = toolInputText(p);
          if (updated) view.input = updated;
          if (typeof p.toolName === "string") view.toolName = p.toolName;
        }
        break;
      }
      case "tool_call_completed": {
        const view = tools.get(String(p.toolCallId ?? ""));
        if (view) {
          view.status = p.isError ? "error" : "ok";
          // claude 给 result，kimi 给 content，宽容取其一。
          view.result = toolResultText(p.result ?? p.content);
          if (typeof p.toolName === "string") view.toolName = p.toolName;
          const updated = toolInputText(p);
          if (updated) view.input = updated;
        }
        break;
      }
      case "permission_request": {
        breakRun();
        const view = gateFromEvent(event, agent);
        gates.set(view.requestId, view);
        items.push(view);
        break;
      }
      case "permission_resolved": {
        const view = gates.get(String(p.requestId ?? ""));
        if (view) {
          view.decision = p.decision as PermissionDecision;
          // 提问卡片的回答回执：广播原样带回 questionAnswers，供「已选择：…」降级态展示
          if (p.questionAnswers && typeof p.questionAnswers === "object" && !Array.isArray(p.questionAnswers)) {
            view.questionAnswers = p.questionAnswers as Record<string, string>;
          }
        }
        break;
      }
      case "session_created":
        breakRun();
        items.push({
          kind: "system",
          key: `sys:${event.seq}`,
          seq: event.seq,
          text: `会话已创建（${String(p.agent ?? agent)} · ${String(p.cwd ?? "")}）`,
          tone: "muted",
        });
        break;
      case "turn_completed": {
        breakRun();
        turn++;
        const reason = abnormalTurnReason(p, agent);
        if (reason) items.push({
          kind: "system", key: `sys:${event.seq}`, seq: event.seq,
          text: `本轮异常结束：${reason}`, tone: "error",
        });
        break;
      }
      case "session_error":
        breakRun();
        items.push({
          kind: "system",
          key: `sys:${event.seq}`,
          seq: event.seq,
          text: `出错：${String(p.message ?? "未知错误")}`,
          tone: "error",
        });
        break;
      case "process_exited":
        breakRun();
        items.push({
          kind: "system",
          key: `sys:${event.seq}`,
          seq: event.seq,
          text: `进程已退出（code=${String(p.code ?? "null")}）`,
          tone: "muted",
        });
        break;
      case "raw_event":
        breakRun();
        items.push({
          kind: "raw",
          key: `raw:${event.seq}`,
          seq: event.seq,
          text: stringifyBlock(p),
        });
        break;
      default:
        // usage_updated 等不在流内渲染（会话头单独展示）。
        break;
    }
  }
  return items;
}

// 工具入参的展示文本：claude 流式给 partialInput 字符串，kimi 给 content/rawInput，宽容处理。
function toolInputText(p: Record<string, unknown>): string {
  if (typeof p.partialInput === "string") return p.partialInput;
  if (p.input !== undefined) return stringifyBlock(p.input);
  if (p.content !== undefined) return stringifyBlock(p.content);
  return "";
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  // claude 的 tool_result content 是块数组；提取其中的 text 块，其余走 JSON。
  if (Array.isArray(result)) {
    const texts = result
      .map((block) => asRecord(block))
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => String(block.text));
    if (texts.length > 0 && texts.length === result.length) return texts.join("\n");
  }
  return stringifyBlock(result);
}

/**
 * claude prompt 缓存的过期时刻（ms 时间戳）；判定不了返回 null。
 * 起点 = 最近一次 usage_updated（claude 在回合结束的 result 里发，≈ 最后一次 API 请求）；
 * TTL = 往回找最近一次真写过缓存的 cache_creation 分项：ephemeral_1h > 0 → 1 小时，ephemeral_5m > 0 → 5 分钟。
 * 只读缓存的回合也会续期，所以起点取最近一次 usage，TTL 可以来自更早的回合。
 * codex/kimi 报文里没有 TTL 信息，调用方只对 claude 用。
 */
export function promptCacheExpiry(events: UnifiedEvent[]): number | null {
  let at: number | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "usage_updated") continue;
    at ??= Date.parse(event.timestamp);
    if (Number.isNaN(at)) return null;
    const created = asRecord(asRecord(event.payload.usage).cache_creation);
    if (Number(created.ephemeral_1h_input_tokens) > 0) return at + 60 * 60_000;
    if (Number(created.ephemeral_5m_input_tokens) > 0) return at + 5 * 60_000;
  }
  return null;
}
