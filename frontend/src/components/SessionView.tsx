import { useCallback, useEffect, useRef, useState } from "react";
import type { MetaInfo, SessionRecord } from "../types";
import { compactTokens, duration } from "../format";
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

  const pendingGates = items.filter(
    (item): item is GateView => item.kind === "gate" && !item.decision,
  );

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
            {session.model && <span>{session.model} · </span>}
            <UsageView agent={session.agent} usage={data?.latestUsage} meta={store.meta} />
            <span> · 用时 {duration(session.createdAt, session.lastActivityAt)}</span>
            <span> · seq {data?.seq ?? session.seq}</span>
          </div>
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

      <div className="stream" ref={streamRef} onScroll={updateHiddenPending}>
        {!data && <p className="system-line">载入会话…</p>}
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
                  disabled={dead}
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

      <Composer dead={dead} onSend={(text) => store.sendUserMessage(session.id, text)} />
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

  // detailed：claude {usage:{input_tokens,...}, costUsd}；codex {usage: tokenUsage}。
  const detail = (usage.usage ?? usage) as Record<string, unknown>;
  const pick = (...keys: string[]): number => {
    for (const key of keys) {
      const value = Number(detail[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return 0;
  };
  const input = pick("input_tokens", "inputTokens");
  const output = pick("output_tokens", "outputTokens");
  const cost = Number(usage.costUsd ?? 0);
  const parts: string[] = [];
  if (input) parts.push(`输入 ${compactTokens(input)}`);
  if (output) parts.push(`输出 ${compactTokens(output)}`);
  if (cost > 0) parts.push(`$${cost.toFixed(4)}`);
  if (parts.length === 0) return <span>用量 —</span>;
  return <span>{parts.join(" · ")}</span>;
}

function Composer({ dead, onSend }: { dead: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState("");
  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || dead) return;
    onSend(trimmed);
    setText("");
  };
  return (
    <div className="composer">
      <textarea
        value={text}
        rows={2}
        disabled={dead}
        placeholder={dead ? "会话已结束，新建会话可续接" : "发消息给这个 agent…（Enter 发送，Shift+Enter 换行）"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
      />
      <button type="button" className="btn btn-primary" disabled={dead || !text.trim()} onClick={send}>
        发送
      </button>
    </div>
  );
}
