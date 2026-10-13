import { t } from "./i18n";
import type { AgentKind, AskQuestion, HistoryMessage, Mention, PermissionDecision, UnifiedEvent } from "./types";
import { asRecord, stringifyBlock } from "./format";
import { normalizeQuestions } from "./ask";
import { summarizeTool, type ToolLocation, type ToolTerminalOutput } from "./tool-summary";

/** 仅影响展示；条件项必须确认成功或已有对应内容，未知事件保留。 */
export const RAW_EVENT_NOISE = {
  codex: ["turn/diff/updated", "hook/started", "account/updated", "hook/completed", "item/commandExecution/outputDelta"],
  claude: ["tool_progress", "command_lifecycle", "user"],
} as const;

function hookHasError(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hookHasError);
  if (!value || typeof value !== "object") return false;
  const record = asRecord(value);
  return Boolean(record.error) || record.isError === true || record.is_error === true || record.success === false
    || [record.exitCode, record.exit_code].some((code) => typeof code === "number" && code !== 0)
    || [record.status, record.type, record.kind, record.level].some((status) =>
      typeof status === "string" && /^(failed|failure|error|errored|blocked|cancelled|canceled|timeout)$/i.test(status))
    || Object.values(record).some(hookHasError);
}

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
  steer?: boolean;
  queued?: boolean;
  /** 随消息下行的附件/引用（@ 文件引用、「+」附件）；旧事件缺省 */
  mentions?: Mention[];
}

export interface ToolView {
  kind: "tool";
  key: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  input: string;
  status: "running" | "ok" | "error" | "unknown";
  result: string;
  turn: number;
  /** tool_call_started 时的最初短名（kimi 后来会把 toolName 改成人话标题；摘要器靠它分类） */
  baseToolName: string;
  /** 原始入参对象（claude 的 input、codex 的整个 item、kimi 的 rawInput）；旧 transcript 缺省 */
  rawInput?: unknown;
  /** 原始结果（claude result / kimi content / codex item）；旧 transcript 缺省 */
  rawResult?: unknown;
  /** ACP kind（read/edit/execute/…），有就优先用它分类 */
  toolKind?: string;
  locations?: ToolLocation[];
  /** kimi 命令类工具的终端输出（后端阶段 2 契约的可选字段；没有时输出仍不可见） */
  terminalOutput?: ToolTerminalOutput;
}

interface EditChunk {
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

/** Focus view 隐藏的项：工具、思考、调试行与中性系统行；闸门/提问、出错行照常显示。 */
export function focusVisible(item: StreamRenderItem): boolean {
  // SendUserFile 是发给用户的交付物，专注视图也保留。
  if (item.kind === "tool" && item.baseToolName === "SendUserFile") return true;
  if (item.kind === "tool" || item.kind === "tool-group" || item.kind === "thought" || item.kind === "raw") return false;
  return item.kind !== "system" || item.tone === "error";
}

export interface SystemBlock {
  kind: "system";
  key: string;
  seq: number;
  text: string;
  tone: "muted" | "error";
  /** 异常原始码只放 title，正文显示中文原因。 */
  rawCode?: string;
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

type RenderItem =
  | TextBlock
  | ThoughtBlock
  | UserBlock
  | ToolView
  | GateView
  | SystemBlock
  | ExternalHistoryBlock
  | RawBlock;

export interface ToolGroupView {
  kind: "tool-group";
  key: string;
  seq: number;
  turn: number;
  tools: ToolView[];
  summary: string;
  summaryParts: { verb: string; count: string }[];
}

type StreamRenderItem = RenderItem | ToolGroupView;

/** 摘要器的分类是私有实现：复用公开展示结果，不另建名字/ACP kind 分类表。
 * read 有专属 body；glob 独占「列出」；grep 与 websearch 共用「搜索」，需排除后者。
 * 未知工具会把原名当 verb，不能把名叫「搜索/列出」的未知工具误折叠。
 */
function foldableTool(tool: ToolView, agent: AgentKind, cwd: string) {
  if (tool.status !== "ok") return null;
  const summary = summarizeTool(agent, tool, cwd);
  const name = tool.baseToolName || tool.toolName || "tool";
  if (summary.body.type === "read") return { cls: "read" as const, path: summary.body.path };
  if (summary.verb === t("core.053") && name !== summary.verb) return { cls: "glob" as const, path: "" };
  if (summary.verb === t("core.054") && (tool.toolKind === "search" ||
      (name.toLowerCase() !== "websearch" && name !== summary.verb))) {
    return { cls: "grep" as const, path: "" };
  }
  return null;
}

/** 在过滤之前分组，保留所有非工具项作为连续性边界；不改变输入或原 ToolView。 */
export function groupReadOnlyTools(items: readonly RenderItem[], agent: AgentKind, cwd: string): StreamRenderItem[] {
  const grouped: StreamRenderItem[] = [];
  let tools: ToolView[] = [];
  const paths = new Set<string>();
  let reads = 0;
  let unlocatedReads = 0;
  let greps = 0;
  let globs = 0;
  const flush = () => {
    if (tools.length < 3) grouped.push(...tools);
    else {
      const summaryParts: ToolGroupView["summaryParts"] = [];
      const files = paths.size + unlocatedReads;
      if (reads) summaryParts.push({ verb: t("core.055"), count: t("core.056", { p0: files, p1: files < reads ? t("core.readCount", { count: reads }) : "" }) });
      if (greps) summaryParts.push({ verb: t("core.054"), count: t("core.057", { p0: greps }) });
      if (globs) summaryParts.push({ verb: t("core.053"), count: t("core.057", { p0: globs }) });
      const first = tools[0]!;
      grouped.push({ kind: "tool-group", key: `tool-group:${first.key}`, seq: first.seq,
        turn: first.turn, tools, summaryParts,
        summary: summaryParts.map(({ verb, count }) => `${verb} ${count}`).join(" · ") });
    }
    tools = [];
    paths.clear();
    reads = unlocatedReads = greps = globs = 0;
  };
  for (const item of items) {
    const classified = item.kind === "tool" ? foldableTool(item, agent, cwd) : null;
    if (item.kind !== "tool" || !classified) {
      flush();
      grouped.push(item);
      continue;
    }
    if (tools.length && tools[0]!.turn !== item.turn) flush();
    tools.push(item);
    if (classified.cls === "read") {
      reads++;
      // 缺路径的旧记录各算一次，不能把所有空路径误当作同一个文件去重。
      if (classified.path) paths.add(classified.path);
      else unlocatedReads++;
    } else if (classified.cls === "grep") greps++;
    else globs++;
  }
  flush();
  return grouped;
}

/** 历史消息没有 turn id，以用户消息分回合；文字/思考仍作为工具组边界。 */
export function buildHistoryRenderItems(messages: readonly HistoryMessage[]): RenderItem[] {
  let turn = 0;
  return messages.map((message, index): RenderItem => {
    const key = message.role === "tool" ? `tool:${message.tool.id}` : `${message.role}:${message.timestamp}:${index}`;
    if (message.role === "user") {
      turn++;
      return { kind: "user", key, seq: index, text: message.text };
    }
    if (message.role === "tool") return {
      kind: "tool", key, seq: index, turn, toolCallId: message.tool.id,
      toolName: message.tool.name, baseToolName: message.tool.name,
      input: typeof message.tool.input === "string" ? message.tool.input : JSON.stringify(message.tool.input ?? null),
      rawInput: message.tool.input, result: message.tool.result ?? "",
      rawResult: message.tool.rawResult, status: message.tool.status,
    };
    return { kind: message.role === "thought" ? "thought" : "text", key, seq: index, turn, text: message.text };
  });
}

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
      title: t("core.058", { p0: i + 1 }),
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

const TURN_ERROR_LABELS: Record<string, string> = {
  error_during_execution: t("core.059"),
  error_max_turns: t("core.060"),
  error_max_budget_usd: t("core.061"),
  error_json_schema: t("core.062"),
  error_max_structured_output_retries: t("core.063"),
  failed: t("core.064"),
  cancelled: t("core.065"),
  canceled: t("core.065"),
  interrupted: t("core.066"),
  max_tokens: t("core.067"),
  refusal: t("core.068"),
};

// 按 seq 顺序把事件流折叠为渲染条目。
function abnormalTurnReason(payload: Record<string, unknown>, agent: AgentKind): string | null {
  if (agent === "claude") {
    if (typeof payload.subtype === "string" && payload.subtype !== "success") return payload.subtype;
    return payload.isError === true ? t("core.069") : null;
  }
  if (agent === "codex") {
    const error = asRecord(payload.error);
    const message = typeof error.message === "string" ? error.message :
      typeof payload.error === "string" ? payload.error : "";
    if (message) return message;
    if (payload.error != null) return t("core.070");
    return typeof payload.status === "string" && payload.status !== "completed" ? payload.status : null;
  }
  return typeof payload.stopReason === "string" && payload.stopReason !== "end_turn" ? payload.stopReason : null;
}

const externalHistoryMessages = new WeakMap<object, HistoryMessage[]>();

function renderItemsReducer(events: UnifiedEvent[], agent: AgentKind) {
  const items: RenderItem[] = [];
  const tools = new Map<string, ToolView>();
  const gates = new Map<string, GateView>();
  const commandOutputs = new Map<string, string>();
  const startedTools = new Set<string>();
  const userTexts = new Set<string>();
  if (agent === "codex") for (const event of events) {
    const p = event.payload;
    if (event.type === "tool_call_started") startedTools.add(String(p.toolCallId ?? event.seq));
    if (event.type === "tool_call_completed" && typeof asRecord(p.result).aggregatedOutput === "string") {
      commandOutputs.set(String(p.toolCallId), asRecord(p.result).aggregatedOutput as string);
    }
  }
  let lastText: TextBlock | undefined;
  let lastThought: ThoughtBlock | undefined;
  let turn = 0;

  const breakRun = () => {
    lastText = undefined;
    lastThought = undefined;
  };

  const positions = new WeakMap<RenderItem, number>();
  const replace = <T extends RenderItem>(item: T): T => {
    const index = positions.get(item) ?? items.indexOf(item);
    const next = { ...item };
    items[index] = next;
    positions.set(next, index);
    return next;
  };
  const append = (event: UnifiedEvent) => {
    const p = event.payload;
    switch (event.type) {
      case "agent_text_delta": {
        const text = String(p.text ?? "");
        if (lastText) {
          lastText = replace(lastText);
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
          lastThought = replace(lastThought);
          lastThought.text += text;
        } else {
          lastThought = { kind: "thought", key: `thought:${event.seq}`, seq: event.seq, text, turn };
          items.push(lastThought);
        }
        lastText = undefined;
        break;
      }
      case "user_message": {
        breakRun();
        if (p.steer !== true) userTexts.clear();
        if (typeof p.text === "string" && p.text) userTexts.add(p.text);
        if (p.steer !== true) turn++;
        const mentions = mentionsFromPayload(p.mentions);
        items.push({
          kind: "user",
          key: `user:${event.seq}`,
          seq: event.seq,
          text: String(p.text ?? ""),
          ...(p.steer === true ? { steer: true } : {}),
          ...(p.queued === true ? { queued: true } : {}),
          ...(mentions.length > 0 ? { mentions } : {}),
        });
        break;
      }
      case "external_messages_added": {
        breakRun();
        const cached = Array.isArray(p.messages) ? externalHistoryMessages.get(p.messages) : undefined;
        const messages: HistoryMessage[] = cached ?? (Array.isArray(p.messages)
          ? p.messages.flatMap<HistoryMessage>((raw) => {
              if (!raw || typeof raw !== "object") return [];
              const item = raw as Record<string, unknown>;
              if (item.role === "tool") {
                const tool = asRecord(item.tool);
                if (typeof tool.id !== "string" || typeof tool.name !== "string") return [];
                return [{ role: "tool", timestamp: typeof item.timestamp === "string" ? item.timestamp : null,
                  tool: { id: tool.id, name: tool.name, input: tool.input,
                    result: typeof tool.result === "string" ? tool.result : undefined, rawResult: tool.rawResult,
                    status: tool.status === "ok" || tool.status === "error" ? tool.status : "unknown" } }];
              }
              if ((item.role !== "user" && item.role !== "assistant" && item.role !== "thought") || typeof item.text !== "string") return [];
              return [{ role: item.role, text: item.text, timestamp: typeof item.timestamp === "string" ? item.timestamp : null }];
            })
          : []);
        if (Array.isArray(p.messages) && !cached) externalHistoryMessages.set(p.messages, messages);
        items.push({ kind: "external-history", key: `external:${event.seq}`, seq: event.seq, messages, truncated: p.truncated === true });
        break;
      }
      case "tool_call_started": {
        breakRun();
        const id = String(p.toolCallId ?? event.seq);
        const toolName = String(p.toolName ?? "tool");
        const view: ToolView = {
          kind: "tool",
          key: `tool:${id}`,
          seq: event.seq,
          toolCallId: id,
          toolName,
          input: toolInputText(p),
          status: "running",
          result: "",
          turn,
          baseToolName: toolName,
          ...(isPlainObject(p.input) ? { rawInput: p.input } : {}),
          ...(typeof p.kind === "string" ? { toolKind: p.kind } : {}),
          ...(Array.isArray(p.locations) ? { locations: normalizeLocations(p.locations) } : {}),
        };
        tools.set(id, view);
        items.push(view);
        break;
      }
      case "tool_call_updated": {
        let view = tools.get(String(p.toolCallId ?? ""));
        if (view) {
          view = replace(view);
          tools.set(view.toolCallId, view);
          // kimi 跑命令时的 content 是终端引用（{type:"terminal"}），不是入参，不能覆盖真实入参
          const updated = toolInputText(p);
          if (updated && !isTerminalRefContent(p.content)) view.input = updated;
          if (typeof p.toolName === "string") view.toolName = p.toolName;
          mergeToolExtras(view, p);
        }
        break;
      }
      case "tool_call_completed": {
        let view = tools.get(String(p.toolCallId ?? ""));
        if (view) {
          view = replace(view);
          tools.set(view.toolCallId, view);
          view.status = p.isError ? "error" : "ok";
          // claude 给 result，kimi 给 content，宽容取其一。
          view.result = toolResultText(p.result ?? p.content);
          if (p.result !== undefined || p.content !== undefined) view.rawResult = p.result ?? p.content;
          if (typeof p.toolName === "string") view.toolName = p.toolName;
          // 完成态只更新结果：入参保持最后一次真实入参，不被结果 content 覆盖
          mergeToolExtras(view, p);
          const term = asRecord(p.terminalOutput);
          if (typeof term.output === "string") {
            view.terminalOutput = {
              terminalId: String(term.terminalId ?? ""),
              output: term.output,
              truncated: term.truncated === true,
              exitCode: typeof term.exitCode === "number" ? term.exitCode : null,
              signal: typeof term.signal === "string" ? term.signal : null,
            };
          }
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
        let view = gates.get(String(p.requestId ?? ""));
        if (view) {
          view = replace(view);
          gates.set(view.requestId, view);
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
          text: t("core.071", { p0: String(p.agent ?? agent), p1: String(p.cwd ?? "") }),
          tone: "muted",
        });
        break;
      case "turn_completed": {
        breakRun();
        userTexts.clear();
        turn++;
        const reason = abnormalTurnReason(p, agent);
        // 用户按停止：三家分别报 interrupted 标记 / interrupted / cancelled，按中性提示而非出错
        if (p.interrupted === true || reason === "interrupted" || reason === "cancelled") {
          items.push({ kind: "system", key: `sys:${event.seq}`, seq: event.seq, text: t("core.072"), tone: "muted" });
        } else if (reason) {
          const label = Object.hasOwn(TURN_ERROR_LABELS, reason) ? TURN_ERROR_LABELS[reason]
            : /^[a-z][a-z_]+$/.test(reason) ? t("core.073") : reason;
          const raw = agent === "claude" ? p.subtype : agent === "codex" ? p.status : p.stopReason;
          items.push({
            kind: "system", key: `sys:${event.seq}`, seq: event.seq,
            text: t("core.074", { p0: String(label) }), tone: "error", rawCode: typeof raw === "string" ? raw : reason,
          });
        }
        break;
      }
      case "session_error":
        breakRun();
        items.push({
          kind: "system",
          key: `sys:${event.seq}`,
          seq: event.seq,
          text: t("core.075", { p0: String(p.message ?? t("core.094")) }),
          tone: "error",
        });
        break;
      case "process_exited":
        breakRun();
        items.push({
          kind: "system",
          key: `sys:${event.seq}`,
          seq: event.seq,
          text: t("core.076", { p0: String(p.code ?? "null") }),
          tone: "muted",
        });
        break;
      case "worker_released":
        breakRun();
        items.push({
          kind: "system",
          key: `sys:${event.seq}`,
          seq: event.seq,
          text: workerReleasedText(p),
          tone: "muted",
        });
        break;
      case "raw_event": {
        const source = p.source ?? agent;
        const raw = asRecord(p.raw);
        const method = source === "codex" ? p.method : raw.type;
        if (source === "codex" && RAW_EVENT_NOISE.codex.includes(method as typeof RAW_EVENT_NOISE.codex[number])) {
          const params = asRecord(p.params);
          if (method === "hook/completed") {
            if (asRecord(params.run).status === "completed" && !hookHasError(params)) break;
          } else if (method === "item/commandExecution/outputDelta") {
            const id = String(params.itemId ?? "");
            if (startedTools.has(id) && typeof params.delta === "string"
                && commandOutputs.get(id)?.includes(params.delta)) break;
          } else break;
        }
        if (source === "claude" && RAW_EVENT_NOISE.claude.includes(method as typeof RAW_EVENT_NOISE.claude[number])) {
          if (method !== "user") break;
          const content = asRecord(raw.message).content;
          const text = typeof content === "string" ? content : Array.isArray(content)
            && content.every((block) => asRecord(block).type === "text" && typeof asRecord(block).text === "string")
            ? content.map((block) => asRecord(block).text).join("\n") : null;
          if (text && userTexts.has(text)) break;
        }
        breakRun();
        items.push({
          kind: "raw",
          key: `raw:${event.seq}`,
          seq: event.seq,
          text: stringifyBlock(p),
        });
        break;
      }
      default:
        // usage_updated 等不在流内渲染（会话头单独展示）。
        break;
    }
    if (items.length) positions.set(items[items.length - 1]!, items.length - 1);
  };
  return { items, append };
}

// 工具入参的展示文本：claude 流式给 partialInput 字符串，kimi 给 content/rawInput，宽容处理。

export function buildRenderItems(events: UnifiedEvent[], agent: AgentKind): RenderItem[] {
  const reducer = renderItemsReducer(events, agent);
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) reducer.append(event);
  return reducer.items;
}

/** A replacement window is always atomic, even when its last seq is unchanged. */
export function createRenderItemsBuilder(agent: AgentKind) {
  let source: UnifiedEvent[] | undefined;
  let length = 0;
  let dropped: number | undefined;
  let last: UnifiedEvent | undefined;
  let maxSeq = -Infinity;
  let reducer = renderItemsReducer([], agent);
  let displayCache: { items: RenderItem[]; version: number; focus: boolean; cwd: string; length: number; shown: StreamRenderItem[] } | undefined;
  return {
    // Older item changes invalidate the cached display prefix; text deltas only change the tail.
    prefixVersion: 0,
    firstUser: undefined as UnifiedEvent | undefined,
    display(focus: boolean, cwd: string): StreamRenderItem[] {
      const items = reducer.items;
      const cached = displayCache;
      if (cached && cached.items === items && cached.version === this.prefixVersion && cached.focus === focus && cached.cwd === cwd) {
        for (let i = Math.max(0, cached.length - 1); i < items.length; i++) {
          const item = items[i]!;
          if (focus && !focusVisible(item)) continue;
          if (cached.shown.at(-1)?.key === item.key) cached.shown[cached.shown.length - 1] = item;
          else if (i >= cached.length) cached.shown.push(item);
        }
        cached.length = items.length;
        return cached.shown;
      }
      const grouped = groupReadOnlyTools(items, agent, cwd);
      const shown = focus ? grouped.filter(focusVisible) : grouped;
      displayCache = { items, version: this.prefixVersion, focus, cwd, length: items.length, shown };
      return shown;
    },
    update(events: UnifiedEvent[], nextDropped = 0): RenderItem[] {
      let safe = source === events && dropped === nextDropped && events.length >= length
        && (length === 0 || events[length - 1] === last);
      let seq = maxSeq;
      for (let i = length; safe && i < events.length; i++) {
        const event = events[i]!;
        // Codex command output suppression looks ahead across the complete window.
        safe = event.seq > seq && !(agent === "codex" && (event.type === "tool_call_started"
          || event.type === "tool_call_completed" && typeof asRecord(event.payload.result).aggregatedOutput === "string"));
        seq = event.seq;
      }
      if (!safe) {
        reducer = renderItemsReducer(events, agent);
        for (const event of [...events].sort((a, b) => a.seq - b.seq)) reducer.append(event);
        this.firstUser = events.find(event => event.type === "user_message");
        maxSeq = events.reduce((max, event) => Math.max(max, event.seq), -Infinity);
        this.prefixVersion++;
      } else {
        for (let i = length; i < events.length; i++) {
          const event = events[i]!;
          if (!this.firstUser && event.type === "user_message") this.firstUser = event;
          if (event.type !== "agent_text_delta" && event.type !== "thought_delta") this.prefixVersion++;
          reducer.append(event);
        }
        maxSeq = seq;
      }
      source = events;
      length = events.length;
      last = events.at(-1);
      dropped = nextDropped;
      return reducer.items;
    },
  };
}

function toolInputText(p: Record<string, unknown>): string {
  if (typeof p.partialInput === "string") return p.partialInput;
  if (p.input !== undefined) return stringifyBlock(p.input);
  if (p.content !== undefined) return stringifyBlock(p.content);
  return "";
}

// 摘要器要的原始字段：kind/locations/rawInput 在任何阶段事件上出现就记下（有就优先用）。
function mergeToolExtras(view: ToolView, p: Record<string, unknown>): void {
  if (isPlainObject(p.input)) view.rawInput = p.input;
  if (typeof p.kind === "string") view.toolKind = p.kind;
  if (Array.isArray(p.locations)) view.locations = normalizeLocations(p.locations);
}

function isPlainObject(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// kimi 命令阶段的 content 只有终端引用块（{type:"terminal",terminalId}），不是入参文本
function isTerminalRefContent(content: unknown): boolean {
  return Array.isArray(content) && content.length > 0
    && content.every((block) => asRecord(block).type === "terminal");
}

function normalizeLocations(value: unknown[]): ToolLocation[] {
  return value
    .map(asRecord)
    .filter((l) => typeof l.path === "string" && l.path)
    .map((l) => ({ path: String(l.path), ...(typeof l.line === "number" ? { line: l.line } : {}) }));
}

/** user_message 下行的 mentions：容错解析，非数组/缺字段的项跳过（旧事件与残缺项不影响其他项）。 */
function mentionsFromPayload(value: unknown): Mention[] {
  if (!Array.isArray(value)) return [];
  const mentions: Mention[] = [];
  for (const raw of value) {
    const item = asRecord(raw);
    const path = typeof item.path === "string" ? item.path : "";
    if (!path) continue;
    const name = typeof item.name === "string" ? item.name : undefined;
    if (item.type === "image" && typeof item.mimeType === "string") {
      mentions.push({ type: "image", path, mimeType: item.mimeType, ...(name ? { name } : {}) });
    } else if (item.type === "file") {
      mentions.push({ type: "file", path, ...(name ? { name } : {}) });
    }
  }
  return mentions;
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  // claude 的 tool_result content 是块数组；kimi 的是嵌套块（{type:"content",content:{type:"text"}}）。
  // 提取其中的 text 块，其余走 JSON。
  if (Array.isArray(result)) {
    const texts = result
      .map((block) => asRecord(block))
      .map((block) => {
        if (block.type === "text" && typeof block.text === "string") return block.text;
        if (block.type === "content") {
          const inner = asRecord(block.content);
          if (inner.type === "text" && typeof inner.text === "string") return inner.text;
        }
        return null;
      })
      .filter((text): text is string => text !== null);
    if (texts.length > 0 && texts.length === result.length) return texts.join("\n");
  }
  return stringifyBlock(result);
}

// worker_released 的弱化系统行文案：空闲自动释放带分钟数，手动释放不带来源细节。
function workerReleasedText(p: Record<string, unknown>): string {
  if (p.reason === "shutdown") return t("core.077");
  if (p.reason === "idle") {
    const minutes = Number(p.idleMinutes);
    const why = Number.isFinite(minutes) && minutes > 0 ? t("core.078", { p0: minutes }) : t("core.079");
    return t("core.080", { p0: why });
  }
  return t("core.081");
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
