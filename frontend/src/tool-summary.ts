// 工具行人话化（消息显示改版阶段 2：动词 + 对象 + 附注 + 状态）。
// 纯函数：把三家形状不一的工具调用归一成「动词 + 对象 + 附注 + 展开体」，不依赖 React/DOM。
// 覆盖 §2 表里的阶段差异：claude 名字不变、codex 名字是 item 类型、
// kimi 的 toolName 会从短名变人话标题、完成事件可以不带名字。
// 认不出的工具一律回落「原始工具名 + raw body」，不丢信息。

import type { AgentKind } from "./types";
import { asRecord, stringifyBlock } from "./format";
import { lineDiff } from "./components/DiffView";

/** kimi tool_call_completed 上可选的终端输出（后端阶段 2 契约；旧事件没有此字段） */
export interface ToolTerminalOutput {
  terminalId: string;
  output: string;
  truncated: boolean;
  exitCode: number | null;
  signal: string | null;
}

export interface ToolLocation {
  path: string;
  line?: number;
}

/** 摘要器的输入：ToolView 的展示字段 + 原始数据。旧 transcript 只有前四个展示字段。 */
export interface ToolSummarySource {
  toolName: string;
  /** tool_call_started 时的最初短名（kimi 后来会把 toolName 改成人话标题） */
  baseToolName?: string;
  input: string;
  result: string;
  status: "running" | "ok" | "error" | "unknown";
  rawInput?: unknown;
  rawResult?: unknown;
  /** ACP kind（read/edit/execute/…）；注意不是 ToolView.kind（恒为 "tool"） */
  toolKind?: string;
  locations?: ToolLocation[];
  terminalOutput?: ToolTerminalOutput;
}

export interface DiffBodyChunk {
  /** 所属文件（codex fileChange 一次改多个文件时每块标出）；单文件不缺省 */
  title?: string;
  removed: string;
  added: string;
}

export type ToolBody =
  | { type: "exec"; calls: { verb: string; target: string; input: string }[]; input: string; result: string }
  | { type: "command"; command: string; output: string; exitCode: number | null; truncated: boolean; signal: string | null }
  | { type: "diff"; path: string; chunks: DiffBodyChunk[]; error?: string }
  | { type: "read"; path: string; lineCount: number | null; error?: string }
  | { type: "raw"; input: string; result: string };

export interface ToolSummary {
  verb: string;
  target: string;
  note: string;
  body: ToolBody;
}

type ToolClass =
  | "read" | "grep" | "glob" | "edit" | "write" | "command"
  | "fetch" | "websearch" | "todo" | "task" | "filechange" | "mcp"
  | "delete" | "move" | "unknown";

export function summarizeTool(agent: AgentKind, tool: ToolSummarySource, cwd: string): ToolSummary {
  const input = rawInputObject(tool);
  const resultItem = asRecord(tool.rawResult);
  const name = tool.baseToolName || tool.toolName || "tool";
  if (agent === "codex" && name.replace(/^functions\./, "") === "exec") {
    const source = typeof tool.rawInput === "string" ? tool.rawInput
      : typeof input.input === "string" ? input.input : tool.input;
    const calls = parseCodexExec(source);
    if (calls) {
      const summaries = calls.map((call) => {
        if (call.name === "apply_patch") {
          const paths = [...call.argument.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => relPath(m[1]!, cwd));
          return { verb: "编辑", target: paths.length === 1 ? paths[0]! : paths.length ? `${paths.length} 个文件` : "文件改动", input: call.argument };
        }
        const alias: Record<string, string> = { exec_command: "commandExecution", write_stdin: "commandExecution", web__run: "webSearch", view_image: "Read" };
        const name = Object.hasOwn(alias, call.name) ? alias[call.name]! : call.name;
        const args = { ...call.fields, ...(call.command !== undefined ? { command: call.command } : {}) };
        if (call.name === "write_stdin") args.command = `终端 ${call.fields.session_id ?? ""}`.trim();
        const summary = summarizeTool(agent, { ...tool, toolName: name, baseToolName: name,
          toolKind: undefined, rawInput: args, rawResult: undefined, input: call.argument, result: "", status: "unknown" }, cwd);
        return { verb: summary.verb, target: summary.target, input: call.command !== undefined ? stripShellWrapper(call.command) : call.argument };
      });
      const commands = calls.filter((call) => call.command !== undefined);
      const first = summaries[0]!;
      const allCommands = commands.length === calls.length;
      return { verb: first.verb, target: first.target,
        note: [calls.length > 1 ? `等 ${calls.length} ${allCommands ? "条命令" : "项调用"}` : "", tool.status === "error" ? firstLine(resultText(tool)) : ""].filter(Boolean).join(" · "),
        body: { type: "exec", calls: summaries, input: source, result: resultText(tool) } };
    }
  }
  const { cls, titleArg } = classify(name, tool.toolName, tool.toolKind ?? "");
  const text = resultText(tool);
  const loc0 = tool.locations?.[0]?.path ?? "";
  const pathOf = () =>
    relPath(str(input.file_path) || str(input.path) || loc0 || titleArg, cwd);

  let verb = name;
  let target = "";
  let note = "";
  let body: ToolBody = { type: "raw", input: tool.input, result: tool.result };

  switch (cls) {
    case "read": {
      verb = "读取";
      target = pathOf();
      const lineCount = tool.status !== "ok" ? null : countTextLines(text) || null; // 失败时结果是错误文本，不算文件行数
      note = lineCount ? `${lineCount} 行` : "";
      body = { type: "read", path: target, lineCount };
      break;
    }
    case "grep": {
      verb = "搜索";
      const pattern = str(input.pattern) || titleArg;
      target = pattern ? `"${pattern}"` : "";
      const hits = tool.status === "running" ? 0 : countTextLines(text);
      // 附注口径跟 output_mode 走：content 才是命中数「N 处」，files_with_matches 是「N 个文件」；
      // 模式判不定（没给 output_mode、结果也不像 content 行）就省略附注，不写误导数字。
      const mode = str(input.output_mode);
      if (hits > 0) {
        if (mode === "content") note = `${hits} 处`;
        else if (mode === "files_with_matches") note = `${hits} 个文件`;
        else if (!mode && grepResultLooksLikeContent(text)) note = `${hits} 处`;
      }
      break;
    }
    case "glob": {
      verb = "列出";
      target = str(input.pattern) || titleArg;
      const files = tool.status === "running" ? 0 : countTextLines(text);
      note = files ? `${files} 个文件` : "";
      break;
    }
    case "edit": {
      verb = "编辑";
      target = pathOf();
      const chunks = editChunksOf(input);
      note = diffNote(sumLines(chunks, "added"), sumLines(chunks, "removed"));
      body = { type: "diff", path: target, chunks };
      break;
    }
    case "write": {
      verb = "写入";
      target = pathOf();
      const chunks = [{ removed: "", added: str(input.content) }];
      note = diffNote(sumLines(chunks, "added"), 0);
      body = { type: "diff", path: target, chunks };
      break;
    }
    case "command": {
      verb = "运行";
      const command = commandOf(agent, input, resultItem) || titleArg;
      // Claude 的 Bash 自带一句 description（同 VSCode 扩展的工具标题），有就用它，命令留在展开区
      target = str(input.description) || command;
      const run = commandResult(agent, tool, resultItem, text);
      if (tool.status === "error") {
        note = run.exitCode !== null ? `退出码 ${run.exitCode}` : firstLine(run.output);
      }
      body = { type: "command", command, ...run };
      break;
    }
    case "fetch": {
      verb = "抓取";
      target = hostOf(str(input.url) || titleArg);
      break;
    }
    case "websearch": {
      // codex 的 webSearch 带 openPage 动作时按抓取显示
      const action = asRecord(resultItem.action);
      const openUrl = str(action.url);
      if (agent === "codex" && openUrl) {
        verb = "抓取";
        target = hostOf(openUrl);
      } else {
        verb = "搜索";
        const query = str(resultItem.query) || str(input.query);
        target = query ? `"${query}"` : "";
      }
      break;
    }
    case "todo": {
      verb = "更新待办";
      const todos = Array.isArray(input.todos) ? input.todos.length : 0;
      note = todos ? `${todos} 项` : "";
      break;
    }
    case "task": {
      verb = "委派";
      target = str(input.description) || oneLine(str(input.prompt), 60);
      break;
    }
    case "filechange": {
      const item = Object.keys(resultItem).length > 0 ? resultItem : input;
      const changes = Array.isArray(item.changes) ? item.changes.map(asRecord) : [];
      // 一次改多个文件时每块标出所属路径（DiffView 的 chunk title）
      const chunks: DiffBodyChunk[] = changes.map((c) => ({
        ...(changes.length > 1 ? { title: relPath(str(c.path), cwd) } : {}),
        ...parseUnifiedDiff(str(c.diff), str(asRecord(c.kind).type)),
      }));
      const kinds = changes.map((c) => str(asRecord(c.kind).type));
      verb =
        changes.length !== 1 ? "编辑"
        : kinds[0] === "add" ? "写入"
        : kinds[0] === "delete" ? "删除"
        : asRecord(changes[0]?.kind).move_path ? "移动"
        : "编辑";
      target =
        changes.length === 1 ? relPath(str(changes[0]?.path), cwd)
        : changes.length > 1 ? `${changes.length} 个文件`
        : "";
      note = diffNote(sumLines(chunks, "added"), sumLines(chunks, "removed"));
      body = { type: "diff", path: target, chunks };
      break;
    }
    case "mcp": {
      verb = "调用";
      const item = Object.keys(resultItem).length > 0 ? resultItem : input;
      target = [str(item.server), str(item.tool)].filter(Boolean).join("/");
      break;
    }
    case "delete":
    case "move": {
      verb = cls === "delete" ? "删除" : "移动";
      target = pathOf();
      break;
    }
    default: {
      verb = name;
      target = unknownTarget(input, tool.input);
      break;
    }
  }

  if (tool.status === "error" && cls !== "command") {
    note = firstLine(text) || note;
  }
  // 失败时展开体也要能看到完整错误：读取/编辑的 body 在原有内容之外附错误全文
  if (tool.status === "error" && text && (body.type === "read" || body.type === "diff")) {
    body = { ...body, error: text };
  }

  return { verb, target, note, body };
}

// ── 分类 ─────────────────────────────────────────────

const BY_NAME: Record<string, ToolClass> = {
  read: "read",
  grep: "grep",
  glob: "glob",
  edit: "edit",
  multiedit: "edit",
  write: "write",
  bash: "command",
  webfetch: "fetch",
  fetchurl: "fetch",
  websearch: "websearch",
  todowrite: "todo",
  task: "task",
  commandexecution: "command",
  filechange: "filechange",
  mcptoolcall: "mcp",
};

function classify(
  name: string,
  title: string,
  kind: string,
): { cls: ToolClass; titleArg: string } {
  const titled = parseHumanTitle(title);
  const named = BY_NAME[name.toLowerCase()];
  // kind（ACP 枚举）优先，但 read/edit/other 粒度比名字粗，用名字与人话标题细化
  if (kind === "execute") return { cls: "command", titleArg: titled.arg };
  if (kind === "search") return { cls: "grep", titleArg: titled.arg };
  if (kind === "fetch") return { cls: "fetch", titleArg: titled.arg };
  if (kind === "delete") return { cls: "delete", titleArg: titled.arg };
  if (kind === "move") return { cls: "move", titleArg: titled.arg };
  if (kind === "edit") {
    if (named === "write") return { cls: "write", titleArg: titled.arg };
    if (named && named !== "edit") return { cls: named, titleArg: titled.arg };
    if (!named && titled.cls === "write") return { cls: "write", titleArg: titled.arg };
    return { cls: "edit", titleArg: titled.arg };
  }
  if (kind === "read") {
    if (named) return { cls: named, titleArg: titled.arg };
    if (titled.cls === "grep" || titled.cls === "glob") return { cls: titled.cls, titleArg: titled.arg };
    return { cls: "read", titleArg: titled.arg };
  }
  // kind 为 other/think/缺省时按名字 → 人话标题 → 未知。
  // 不按入参形状（command/old_string）猜测：名字、标题、kind 都认不出就是未知工具，
  // 一律 raw 回落，免得把陌生工具错标成「运行/编辑」还丢掉原始信息。
  if (named) return { cls: named, titleArg: titled.arg };
  if (titled.cls !== "unknown") return { cls: titled.cls, titleArg: titled.arg };
  return { cls: "unknown", titleArg: "" };
}

// kimi 更新后的人话标题（PROTOCOL-NOTES「kimi 2.1.1 工具调用字段」实测形态）
function parseHumanTitle(title: string): { cls: ToolClass; arg: string } {
  const t = title.trim();
  const none = { cls: "unknown" as ToolClass, arg: "" };
  let m = /^Reading\s+(.+)$/.exec(t);
  if (m) return { cls: "read", arg: m[1]! };
  m = /^Running:\s*(.+)$/.exec(t);
  if (m) return { cls: "command", arg: m[1]! };
  m = /^Fetching:\s*(.+)$/.exec(t);
  if (m) return { cls: "fetch", arg: m[1]! };
  m = /^Editing\s+(.+)$/.exec(t);
  if (m) return { cls: "edit", arg: m[1]! };
  m = /^Writing\s+(.+)$/.exec(t);
  if (m) return { cls: "write", arg: m[1]! };
  m = /^Searching for '([^']+)'/.exec(t);
  if (m) return { cls: "grep", arg: m[1]! };
  m = /^Searching\s+(.+)$/.exec(t);
  if (m) return { cls: "glob", arg: m[1]! };
  return none;
}

// ── 命令提取与结果 ───────────────────────────────────

export interface CodexExecCall {
  name: string;
  argument: string;
  fields: Record<string, string>;
  command?: string;
}

interface ExecToken { text: string; start: number; end: number; literal?: string }

// 保守的词法扫描，不执行 JS。动态模板、正则字面量等不支持的语法整段 raw 回落。
// 字符串/注释里的 tools.* 不当作调用；所有括号必须完整且配对。
function execTokens(source: string): ExecToken[] | null {
  const tokens: ExecToken[] = [];
  for (let i = 0; i < source.length;) {
    const start = i;
    const c = source[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i + 2); i = end < 0 ? source.length : end; continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2); if (end < 0) return null; i = end + 2; continue;
    }
    if (c === "/") return null;
    if (c === '"' || c === "'" || c === "`") {
      let value = ""; let closed = false; i++;
      while (i < source.length) {
        const ch = source[i++]!;
        if (ch === c) { closed = true; break; }
        if (c === "`" && ch === "$" && source[i] === "{") return null;
        if (c !== "`" && /[\r\n\u2028\u2029]/.test(ch)) return null;
        if (ch !== "\\") { value += ch; continue; }
        if (i >= source.length) return null;
        const escape = source[i++]!;
        if (escape === "\n" || escape === "\u2028" || escape === "\u2029") continue;
        if (escape === "\r") { if (source[i] === "\n") i++; continue; }
        const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
        if (escape === "x" || escape === "u") {
          let hex: string;
          if (escape === "u" && source[i] === "{") {
            const end = source.indexOf("}", ++i); if (end < 0) return null;
            hex = source.slice(i, end); i = end + 1;
            if (!/^[\da-fA-F]{1,6}$/.test(hex) || parseInt(hex, 16) > 0x10ffff) return null;
          } else {
            const size = escape === "x" ? 2 : 4; hex = source.slice(i, i + size); i += size;
            if (hex.length !== size || !/^[\da-fA-F]+$/.test(hex)) return null;
          }
          value += String.fromCodePoint(parseInt(hex, 16));
        } else {
          if (/[1-9]/.test(escape) || (escape === "0" && /\d/.test(source[i] ?? ""))) return null;
          value += simple[escape] ?? escape;
        }
      }
      if (!closed) return null;
      tokens.push({ text: source.slice(start, i), start, end: i, literal: value }); continue;
    }
    if (/[\w$]/.test(c)) {
      while (i < source.length && /[\w$]/.test(source[i]!)) i++;
    } else i++;
    tokens.push({ text: source.slice(start, i), start, end: i });
  }
  return tokens;
}

/** 提取源码顺序中的直接 tools.name(...)。不能确定任何 cmd 时整段回落，避免部分漏报。 */
export function parseCodexExec(source: string): CodexExecCall[] | null {
  const tokens = execTokens(source);
  if (!tokens) return null;
  const pairs = new Map<number, number>(); const stack: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.literal !== undefined) continue;
    if (["(", "[", "{"].includes(token.text)) stack.push(i);
    else if ([")", "]", "}"].includes(token.text)) {
      const open = stack.pop();
      const expected: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
      if (open === undefined || tokens[open]!.text !== expected[token.text]) return null;
      pairs.set(open, i);
    }
  }
  if (stack.length) return null;
  const calls: CodexExecCall[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]!.text !== "tools" || tokens[i]!.literal !== undefined || tokens[i - 1]?.text === ".") continue;
    if (tokens[i + 1]?.text !== "." || !/^[A-Za-z_$][\w$]*$/.test(tokens[i + 2]?.text ?? "") || tokens[i + 3]?.text !== "(") return null;
    const end = pairs.get(i + 3); if (end === undefined) return null;
    const name = tokens[i + 2]!.text;
    const argument = source.slice(tokens[i + 3]!.end, tokens[end]!.start).trim();
    const fields: Record<string, string> = Object.create(null);
    const open = i + 4;
    if (tokens[open]?.text === "{") {
      const close = pairs.get(open)!;
      if (close >= end || (close + 1 !== end && !(tokens[close + 1]?.text === "," && close + 2 === end))) return null;
      for (let k = open + 1; k < close;) {
        const key = tokens[k]!.literal ?? tokens[k]!.text;
        if (tokens[k + 1]?.text !== ":" || !/^[\w$]+$/.test(key)) {
          if (name === "exec_command") return null;
          break; // 其他工具仍能按名字归类；动态参数完整留在展开体。
        }
        const valueStart = k + 2; let valueEnd = valueStart;
        while (valueEnd < close && tokens[valueEnd]!.text !== ",") valueEnd = (pairs.get(valueEnd) ?? valueEnd) + 1;
        if (key === "cmd" && (Object.hasOwn(fields, key) || valueEnd !== valueStart + 1 || tokens[valueStart]?.literal === undefined)) return null;
        if (valueEnd === valueStart + 1) fields[key] = tokens[valueStart]!.literal ?? tokens[valueStart]!.text;
        k = valueEnd + 1;
      }
    }
    if (name === "exec_command" && !Object.hasOwn(fields, "cmd")) return null;
    const literal = tokens[open]?.literal;
    // apply_patch 等可直接传字符串；末尾逗号不改变该参数，也不能误吞拼接表达式。
    const onlyLiteral = literal !== undefined && (open + 1 === end || (tokens[open + 1]?.text === "," && open + 2 === end));
    calls.push({ name, argument: onlyLiteral ? literal : argument, fields,
      ...(name === "exec_command" ? { command: fields.cmd! } : {}) });
  }
  return calls.length ? calls : null;
}

// codex 命令常包成 /bin/bash -lc '…'，显示时剥掉这层外壳；命令可能是字符串或数组
function commandText(command: unknown): string {
  if (Array.isArray(command)) {
    const parts = command.map(String);
    // 数组形式的外壳没有引号：["bash", "-lc", "echo hi"] → "echo hi"
    if (/(?:^|\/)(?:bash|sh|zsh)$/.test(parts[0] ?? "") && /^-[a-zA-Z]*c$/.test(parts[1] ?? "")) {
      return parts.slice(2).join(" ");
    }
    return parts.join(" ");
  }
  if (typeof command === "string") return command;
  return "";
}

function stripShellWrapper(command: string): string {
  const m = /^\s*(?:\S*\/)?(?:bash|sh|zsh)\s+-[a-zA-Z]*c\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  return m ? m[2]! : command;
}

function commandOf(agent: AgentKind, input: Record<string, unknown>, resultItem: Record<string, unknown>): string {
  const raw =
    agent === "codex"
      ? (resultItem.command ?? input.command)
      : input.command;
  return stripShellWrapper(commandText(raw));
}

function commandResult(
  agent: AgentKind,
  tool: ToolSummarySource,
  resultItem: Record<string, unknown>,
  text: string,
): { output: string; exitCode: number | null; truncated: boolean; signal: string | null } {
  if (agent === "codex") {
    return {
      output: typeof resultItem.aggregatedOutput === "string" ? resultItem.aggregatedOutput : text,
      exitCode: typeof resultItem.exitCode === "number" ? resultItem.exitCode : null,
      truncated: false,
      signal: null,
    };
  }
  const term = tool.terminalOutput;
  if (term) {
    return { output: term.output, exitCode: term.exitCode, truncated: term.truncated, signal: term.signal };
  }
  // kimi 完成态 content 只有终端引用（看不到输出）；claude 失败时首行是「Exit code N」
  let output = isTerminalRefOnly(tool.rawResult) ? "" : text;
  let exitCode: number | null = null;
  const m = /^Exit code (\d+)\n?/.exec(output);
  if (m) {
    exitCode = Number(m[1]);
    output = output.slice(m[0].length);
  }
  return { output, exitCode, truncated: false, signal: null };
}

function isTerminalRefOnly(rawResult: unknown): boolean {
  if (!Array.isArray(rawResult) || rawResult.length === 0) return false;
  return rawResult.every((block) => asRecord(block).type === "terminal");
}

// ── 编辑与 diff ──────────────────────────────────────

function editChunksOf(input: Record<string, unknown>): { removed: string; added: string }[] {
  if (Array.isArray(input.edits)) {
    return input.edits.map(asRecord).map((e) => ({
      removed: str(e.old_string),
      added: str(e.new_string),
    }));
  }
  return [{ removed: str(input.old_string), added: str(input.new_string) }];
}

// codex fileChange 的 diff 是统一 diff 文本（kind:add 时也可能只是无前缀的新内容）
function parseUnifiedDiff(diff: string, kindType: string): { removed: string; added: string } {
  const removed: string[] = [];
  const added: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("@@") || line.startsWith("diff ") || line.startsWith("index ")) continue;
    if (line.startsWith("new file") || line.startsWith("deleted file")) continue;
    if (line.startsWith("+")) { added.push(line.slice(1)); continue; }
    if (line.startsWith("-")) { removed.push(line.slice(1)); continue; }
    if (line === "" || line.startsWith(" ")) continue; // 上下文与结尾空行
    if (kindType === "add") added.push(line);
    else if (kindType === "delete") removed.push(line);
  }
  return { removed: removed.join("\n"), added: added.join("\n") };
}

function sumLines(chunks: { removed: string; added: string }[], field: "removed" | "added"): number {
  // 按逐行对齐后的实际增删计数，与 DiffView 显示一致
  const op = field === "added" ? "+" : "-";
  return chunks.reduce((sum, c) => sum + lineDiff(c.removed, c.added).filter(([o]) => o === op).length, 0);
}

// ── 原始数据归一 ─────────────────────────────────────

// 原始入参对象：rawInput 是对象就用；否则试把展示文本（claude 旧 transcript 的 JSON）解析回来
function rawInputObject(tool: ToolSummarySource): Record<string, unknown> {
  if (tool.rawInput && typeof tool.rawInput === "object" && !Array.isArray(tool.rawInput)) {
    return tool.rawInput as Record<string, unknown>;
  }
  const text = (tool.input ?? "").trim();
  if (text.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // partialInput 流式半截 JSON 解析失败属正常，落空对象
    }
  }
  return {};
}

// 结果文本：优先从原始 result/content 提取（kimi 的 content 是嵌套块数组），否则用展示字段
function resultText(tool: ToolSummarySource): string {
  return extractText(tool.rawResult) || tool.result || "";
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value
      .map(asRecord)
      .map((block) => {
        if (block.type === "text" && typeof block.text === "string") return block.text;
        if (block.type === "content") {
          const inner = asRecord(block.content);
          if (inner.type === "text" && typeof inner.text === "string") return inner.text;
        }
        return null;
      })
      .filter((part): part is string => part !== null);
    if (parts.length > 0) return parts.join("\n");
  }
  return "";
}

// ── 小工具 ───────────────────────────────────────────

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// 路径显示成相对 cwd 的形式；cwd 外的保留绝对路径
export function relPath(path: string, cwd: string): string {
  if (!path || !cwd) return path;
  const base = cwd.endsWith("/") ? cwd : `${cwd}/`;
  if (path === cwd) return ".";
  if (path.startsWith(base)) return path.slice(base.length);
  return path;
}

function hostOf(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// 行数统计：去掉末尾换行后按 \n 计（与闸门卡片口径一致）
function countTextLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n+$/, "").split("\n").length;
}

// Grep 结果像不像 content 模式（每行都是 path:行号:内容）：没给 output_mode 时的辅助判定
function grepResultLooksLikeContent(text: string): boolean {
  const lines = text.replace(/\n+$/, "").split("\n").filter(Boolean);
  return lines.length > 0 && lines.every((line) => /^\S+?:\d+:/.test(line));
}

function diffNote(added: number, removed: number): string {
  if (added > 0 && removed > 0) return `+${added} −${removed}`;
  if (added > 0) return `+${added}`;
  if (removed > 0) return `−${removed}`;
  return "";
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return oneLine(line, 80);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// 未知工具的对象：挑一个最有辨识度的字段，兜底截断的入参文本
function unknownTarget(input: Record<string, unknown>, inputText: string): string {
  for (const key of ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description"]) {
    const value = str(input[key]);
    if (value) return oneLine(value, 60);
  }
  return oneLine(inputText || stringifyBlock(input), 60);
}
