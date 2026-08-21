import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { CommandInfo, MetaInfo, SessionRecord } from "../types";
import { compactTokens, duration, asRecord, truncateDisplayWidth } from "../format";
import { buildRenderItems, type GateView } from "../render-items";
import { store } from "../store";
import { useStore } from "../useStore";
import { GateBlock, RawLine, SystemLine, TextBlockView, ThoughtBlockView, ToolCard, UserBlockView } from "./StreamItems";

export function SessionView({ session }: { session: SessionRecord }) {
  const store = useStore();
  const data = store.data.get(session.id);
  const items = data ? buildRenderItems(data.events, session.agent) : [];
  const running = session.status === "running" || session.status === "starting";
  const dead = session.status === "dead";
  const caps = store.meta?.drivers[session.agent];

  const streamRef = useRef<HTMLDivElement>(null);
  const gateRefs = useRef(new Map<string, HTMLElement>());
  const [hiddenPending, setHiddenPending] = useState(0);

  // dead 会话的未决闸门渲染为「已失效」中性态，不计入待处理数。
  const pendingGates = dead
    ? []
    : items.filter((item): item is GateView => item.kind === "gate" && !item.decision);

  // 未决闸门滚出视口时，底部贴暖色细条提示。
  const updateHiddenPending = useCallback(() => {
    const container = streamRef.current;
    if (!container) return;
    const box = container.getBoundingClientRect();
    let hidden = 0;
    for (const gate of pendingGates) {
      const el = gateRefs.current.get(gate.requestId);
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom < box.top || rect.top > box.bottom) hidden++;
    }
    setHiddenPending(hidden);
  }, [pendingGates]);

  useEffect(() => {
    updateHiddenPending();
  }, [updateHiddenPending, items.length, store.version]);

  // 新事件到达时，若用户本就在底部附近则跟随滚动。
  const lastSeq = data?.seq ?? 0;
  useEffect(() => {
    const container = streamRef.current;
    if (!container) return;
    const nearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 120;
    if (nearBottom) container.scrollTop = container.scrollHeight;
  }, [lastSeq]);

  const scrollToFirstPending = () => {
    const first = pendingGates[0];
    if (!first) return;
    gateRefs.current.get(first.requestId)?.scrollIntoView({ block: "center" });
  };

  const canInterrupt = Boolean(caps?.interrupt && session.processId && !dead);

  return (
    <div className={`session agent-${session.agent}`}>
      <header className="session-head">
        <div className="session-head-main">
          <div className="session-title-line">
            <span className="agent-name">{session.agent}</span>
            <span className="session-cwd mono">{session.cwd}</span>
          </div>
          <div className="session-sub mono">
            <UsageView agent={session.agent} usage={data?.latestUsage} meta={store.meta} />
            <span> · 用时 {duration(session.createdAt, session.lastActivityAt)}</span>
            <span> · seq {data?.seq ?? session.seq}</span>
          </div>
          <ConfigControls session={session} />
        </div>
        <div className="session-head-actions">
          <span className={`ws-dot ws-${store.wsState}`} title={`连接：${store.wsState}`} />
          <button
            type="button"
            className="btn"
            disabled={!canInterrupt}
            title={canInterrupt ? "打断当前执行" : "当前没有可中断的执行"}
            onClick={() => store.interrupt(session.id)}
          >
            中断
          </button>
        </div>
      </header>

      {session.riskyMode && (
        <div className="risky-banner" role="alert">
          该会话已关闭 agent 主动询问，workbench 仍会拦截实际执行
        </div>
      )}

      <div className="stream" ref={streamRef} onScroll={updateHiddenPending}>
        {!data && <p className="system-line">载入会话…</p>}
        {data && data.dropped > 0 && (
          <p className="system-line">最早的 {data.dropped} 条事件已省略（内存上限）；快照仍保留全量。</p>
        )}
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          switch (item.kind) {
            case "user":
              return <UserBlockView key={item.key} item={item} />;
            case "text":
              return <TextBlockView key={item.key} item={item} streaming={isLast && running} />;
            case "thought":
              return <ThoughtBlockView key={item.key} item={item} />;
            case "tool":
              return <ToolCard key={item.key} item={item} />;
            case "gate":
              return (
                <GateBlock
                  key={item.key}
                  item={item}
                  sessionId={session.id}
                  dead={dead}
                  ref={(el) => {
                    if (el) gateRefs.current.set(item.requestId, el);
                    else gateRefs.current.delete(item.requestId);
                  }}
                />
              );
            case "system":
              return <SystemLine key={item.key} item={item} />;
            case "raw":
              return <RawLine key={item.key} item={item} />;
            default:
              return null;
          }
        })}
      </div>

      {pendingGates.length > 0 && hiddenPending > 0 && (
        <button type="button" className="pending-bar" onClick={scrollToFirstPending}>
          {pendingGates.length} 个闸门等待处理 ↑
        </button>
      )}

      <Composer session={session} dead={dead} />
    </div>
  );
}

// 会话头的模型/推理强度/审批模式控件：选项全部来自 /api/meta 的 options，
// 前端不硬编码任何值；活改走 WS set_config，等 config_updated 广播回来才更新显示。
function ConfigControls({ session }: { session: SessionRecord }) {
  const store = useStore();
  const options = store.meta?.drivers[session.agent]?.options ?? [];
  const pending = store.configPending.get(session.id);
  const error = store.configErrors.get(session.id);
  const hint = store.configHints.get(session.id);
  const live = Boolean(session.processId) && session.status !== "dead";
  if (options.length === 0 && !error) return null;

  return (
    <div className="session-config">
      {options.map((option) => {
        const current = session.config?.[option.id];
        const currentKey = current ?? "";
        // default 为 null 的那条 values 项带后端给的「跟随 … 配置」标签，优先用它。
        const followLabel =
          option.values.find((v) => v.value === null)?.label ?? "跟随配置";
        const known = new Set(option.values.map((v) => v.value));
        const disabled = !option.mutable || !live || Boolean(pending?.has(option.id));
        const title = !option.mutable
          ? "此项需新建会话才能更改"
          : !live
            ? "会话已结束，无法更改"
            : undefined;
        return (
          <label className="config-select" key={option.id} title={title}>
            <span className="config-select-name">{option.name}</span>
            <select
              value={currentKey}
              disabled={disabled}
              onChange={(e) => {
                const value = e.target.value;
                // 空值是「跟随配置」展示项，不能用于撤销会话级覆盖（后端也只接受字符串值）。
                if (value) store.setConfig(session.id, { [option.id]: value });
              }}
            >
              {currentKey === "" && (
                <option value="" disabled>
                  {/* claude 首轮 init 后才报实际模型：跟随配置时把实际值并进同一处显示 */}
                  {option.id === "model" && session.model
                    ? `${followLabel}（${session.model}）`
                    : followLabel}
                </option>
              )}
              {currentKey !== "" && !known.has(currentKey) && (
                <option value={currentKey}>{currentKey}</option>
              )}
              {option.values
                .filter((v): v is { value: string; label: string } => v.value !== null)
                .map((v) => (
                  <option key={v.value} value={v.value}>
                    {v.label}
                  </option>
                ))}
            </select>
          </label>
        );
      })}
      {hint && <span className="config-hint">{hint}</span>}
      {error && (
        <span className="config-error" role="alert">
          {error}
          <button
            type="button"
            className="config-error-close"
            onClick={() => store.clearConfigError(session.id)}
          >
            ×
          </button>
        </span>
      )}
    </div>
  );
}

// usage 按 driver 能力位分家渲染，不强行归一。
function UsageView({
  agent,
  usage,
  meta,
}: {
  agent: SessionRecord["agent"];
  usage: Record<string, unknown> | undefined;
  meta: MetaInfo | null;
}) {
  const mode = meta?.drivers[agent]?.usage;
  if (!mode) return <span>用量 —</span>;
  if (!usage) return <span>{mode === "context" ? "上下文 —" : "用量 —"}</span>;

  if (mode === "context") {
    // kimi：{used, size} 上下文占用。
    const used = Number(usage.used ?? 0);
    const size = Number(usage.size ?? 0);
    return (
      <span>
        上下文 {compactTokens(used)}
        {size > 0 ? ` / ${compactTokens(size)}` : ""}
      </span>
    );
  }

  // detailed：claude {usage:{input_tokens,output_tokens}, costUsd}；
  // codex {usage:{total:{totalTokens,inputTokens,outputTokens,...}, last:{...}, modelContextWindow}}。
  const detail = asRecord(usage.usage ?? usage);
  const total = asRecord(detail.total);
  const pickFrom = (source: Record<string, unknown>, ...keys: string[]): number => {
    for (const key of keys) {
      const value = Number(source[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  };
  const input = pickFrom(detail, "input_tokens", "inputTokens") || pickFrom(total, "inputTokens");
  const output = pickFrom(detail, "output_tokens", "outputTokens") || pickFrom(total, "outputTokens");
  const totalTokens = pickFrom(total, "totalTokens");
  const contextWindow = Number(detail.modelContextWindow ?? 0);
  const cost = Number(usage.costUsd ?? 0);
  const parts: string[] = [];
  if (contextWindow > 0 && totalTokens > 0) {
    parts.push(`上下文 ${compactTokens(totalTokens)} / ${compactTokens(contextWindow)}`);
  }
  if (input) parts.push(`输入 ${compactTokens(input)}`);
  if (output) parts.push(`输出 ${compactTokens(output)}`);
  if (cost > 0) parts.push(`$${cost.toFixed(4)}`);
  if (parts.length === 0) return <span>用量 —</span>;
  return <span>{parts.join(" · ")}</span>;
}

function Composer({ session, dead }: { session: SessionRecord; dead: boolean }) {
  const store = useStore();
  const [text, setText] = useState("");
  const [selected, setSelected] = useState(0);
  // Esc 关闭面板后，到下一次输入变化前不再自动弹出
  const [dismissed, setDismissed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  const caps = store.meta?.drivers[session.agent];
  const commandsSupported = caps?.commands === true;
  const table = store.commands.get(session.id) ?? [];

  // 仅行首 / 触发（整段文本即「/query」形态）；行中间的 /（如路径）是普通字符
  const slashQuery = /^\/([^\s]*)$/.exec(text)?.[1] ?? null;
  const panelOpen = commandsSupported && !dead && slashQuery !== null && !dismissed;
  const filtered = panelOpen ? filterCommands(table, slashQuery ?? "") : [];
  const sel = Math.min(selected, Math.max(filtered.length - 1, 0));
  const active = filtered[sel];

  // 已确认命令的参数提示：文本进入「/name 参数…」形态后显示该命令的 argHint
  const typedName = /^\/([^\s]+)\s/.exec(text)?.[1];
  const activeCmd = typedName ? table.find((c) => c.name === typedName) : undefined;

  useEffect(() => setSelected(0), [slashQuery]);

  // 选中项滚动进可视区（claude 102 条时长列表必须可达）
  useEffect(() => {
    if (!panelOpen) return;
    listRef.current?.querySelector(".cmd-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [panelOpen, sel, active?.name]);

  const confirm = (cmd: CommandInfo, fillOnly: boolean) => {
    if (!fillOnly && !cmd.argHint) {
      // 无参数命令：确认即直接发（结构化 command，不拼 text）
      store.sendCommand(session.id, cmd.name, "");
      setText("");
    } else {
      // 有参数（或 Tab 只填充）：填入「/name 」，光标留在末尾参数位等用户补完
      setText(`/${cmd.name} `);
    }
    setDismissed(false);
  };

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || dead) return;
    store.sendComposerInput(session.id, trimmed);
    setText("");
    setDismissed(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (panelOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (filtered.length > 0) {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          setSelected((i) => (i + delta + filtered.length) % filtered.length);
        }
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        if (active) confirm(active, true);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && active) {
        e.preventDefault();
        confirm(active, false);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      {panelOpen && (
        <div className="cmd-panel" role="listbox" aria-label="斜杠命令" ref={listRef}>
          {filtered.length === 0 && <div className="cmd-empty">没有匹配的命令</div>}
          {filtered.map((cmd, i) => (
            <div
              key={cmd.name}
              role="option"
              aria-selected={i === sel}
              className={`cmd-item${i === sel ? " selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // 不抢输入框焦点，键盘可继续输入
                confirm(cmd, false);
              }}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="cmd-name mono">/{cmd.name}</span>
              <span className="cmd-desc">{truncateDisplayWidth(cmd.description, 48)}</span>
            </div>
          ))}
        </div>
      )}
      {!panelOpen && activeCmd?.argHint && (
        <div className="composer-hint">
          <span className="mono">/{activeCmd.name}</span> 参数：{activeCmd.argHint}
        </div>
      )}
      {caps && !caps.commands && (
        <div
          className="composer-note"
          title="Codex app-server 没有斜杠命令枚举协议（listPrompts / customPrompts / slashCommands 等请求都返回未知方法），这里没有命令面板；行首 / 只会按普通文本发送。"
        >
          Codex 不支持斜杠命令
        </div>
      )}
      <div className="composer-row">
        <textarea
          value={text}
          rows={2}
          disabled={dead}
          placeholder={dead ? "会话已结束，新建会话可续接" : "发消息给这个 agent…（Enter 发送，Shift+Enter 换行）"}
          onChange={(e) => {
            setText(e.target.value);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="btn btn-primary" disabled={dead || !text.trim()} onClick={send}>
          发送
        </button>
      </div>
    </div>
  );
}

// 命令筛选：名称前缀 > 名称子序列模糊 > 描述子串；各组内保持命令表原顺序。
function filterCommands(commands: CommandInfo[], query: string): CommandInfo[] {
  const q = query.toLowerCase();
  if (!q) return commands;
  const prefix: CommandInfo[] = [];
  const fuzzy: CommandInfo[] = [];
  const desc: CommandInfo[] = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    if (name.startsWith(q)) prefix.push(cmd);
    else if (isSubsequence(q, name)) fuzzy.push(cmd);
    else if (cmd.description.toLowerCase().includes(q)) desc.push(cmd);
  }
  return [...prefix, ...fuzzy, ...desc];
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) {
      i++;
      if (i === needle.length) return true;
    }
  }
  return needle.length === 0;
}
