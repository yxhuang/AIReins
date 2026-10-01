import { useEffect, useMemo, useRef, useState } from "react";
import { fetchDispatchDetail, fetchDispatchLog, fetchDispatchMessages } from "../api";
import { dispatchName, dispatchSeconds, dispatchTime, dispatcherTitle } from "../dispatch-flow";
import type { DispatchSessionTitle } from "../dispatch-flow";
import type { AgentKind, DispatchDetail as Detail, HistoryMessage } from "../types";
import { modelShortName } from "../config-view";
import { store } from "../store";
import { HistoryTimeline } from "./HistoryTimeline";
import { MarkdownMessage } from "./MarkdownMessage";

/** Show only the current dispatch's process after its last matching prompt; keep delta indices intact. */
export function dispatchProcessMessages(messages: HistoryMessage[], prompt: string | null | undefined): HistoryMessage[] {
  const original = prompt?.trim();
  if (!original) return messages;
  const prefix = Array.from(original).slice(0, 200).join("");
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "user") continue;
    const text = message.text.trim();
    if (text === original || text.startsWith(prefix)) return messages.slice(index + 1);
  }
  return messages;
}

export function DispatchDetail({ runId, sessions, terminalOpen }: { runId: string; sessions: DispatchSessionTitle[]; terminalOpen: boolean }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [messages, setMessages] = useState<HistoryMessage[]>([]);
  const [nativeAgent, setNativeAgent] = useState<AgentKind | null>(null);
  const [log, setLog] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);
  useEffect(() => {
    let active = true;
    let request: AbortController | null = null;
    let cursor: string | null = null;
    let offset: number | undefined;
    let finished = false;
    const visible = () => document.visibilityState !== "hidden"
      && !(terminalOpen && window.matchMedia("(max-width: 720px)").matches);
    const poll = async () => {
      if (!active || request || !visible() || finished) return;
      const controller = new AbortController();
      request = controller;
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]);
      try {
        const [run, flow] = await Promise.all([fetchDispatchDetail(runId, signal), fetchDispatchMessages(runId, cursor, signal)]);
        const part = flow.source === "stdout" ? await fetchDispatchLog(runId, offset, signal) : null;
        if (!active || request !== controller || !visible()) return;
        setDetail(run);
        setError("");
        setTruncated(flow.truncated);
        if (flow.source === "native" && flow.agent) {
          cursor = flow.cursor;
          setNativeAgent(flow.agent);
          setMessages((previous) => !flow.messages.length && flow.replaceFrom === previous.length
            ? previous : previous.slice(0, flow.replaceFrom).concat(flow.messages));
        } else if (part) {
          setNativeAgent(null);
          offset = part.nextOffset;
          setLog((previous) => ((part.reset ? "" : previous) + part.text).slice(-64 * 1024));
        }
        // Allow one final refresh for delayed transcript flushes after completion.
        if (run.status !== "running") {
          if (settled) finished = true;
          settled = true;
        } else settled = false;
      } catch (cause) {
        if (active && request === controller && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { if (request === controller) request = null; }
    };
    let settled = false;
    let tick: number | undefined;
    const visibility = () => {
      if (tick !== undefined) window.clearInterval(tick);
      tick = undefined;
      if (!visible()) { request?.abort(); request = null; }
      else {
        setNow(Date.now());
        tick = window.setInterval(() => setNow(Date.now()), 1000);
        void poll();
      }
    };
    const mobile = window.matchMedia("(max-width: 720px)");
    document.addEventListener("visibilitychange", visibility);
    mobile.addEventListener("change", visibility);
    visibility();
    const timer = window.setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      request?.abort();
      window.clearInterval(timer);
      if (tick !== undefined) window.clearInterval(tick);
      document.removeEventListener("visibilitychange", visibility);
      mobile.removeEventListener("change", visibility);
    };
  }, [runId, terminalOpen]);

  const copy = async () => {
    if (!detail?.resume) return;
    try {
      await navigator.clipboard.writeText(detail.resume);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch { setError("复制失败，请手动选择续接命令复制。"); }
  };
  const parent = detail?.parent;
  const dispatcher = detail ? parent?.agent === "claude" ? dispatcherTitle([detail], sessions)
    : parent ? `${parent.agent} · ${parent.sessionId || parent.runId || "来源未知"}` : "派单来源未知" : "";
  const prompt = detail?.prompt ?? "派单原文尚未生成";
  const processMessages = useMemo(() => dispatchProcessMessages(messages, detail?.prompt), [messages, detail?.prompt]);
  return <section className={`dispatch-view dispatch-detail agent-${detail?.tool || "codex"}`} aria-label="派单详情">
    <div className="dispatch-detail-nav"><button className="btn" onClick={() => store.navigateDispatches()}>‹ 返回派单</button><span>只读详情</span></div>
    {error && <p className="dispatch-error" role="alert">{error}</p>}
    {!detail ? <p className="dispatch-empty">正在加载派单…</p> : <>
      <header className="dispatch-detail-head" data-tool={detail.tool}>
        <p className="dispatch-detail-source">{dispatcher} → {detail.tool === "codex" ? "Codex" : detail.tool === "kimi" ? "Kimi" : "Copilot"}</p>
        <h1>{dispatchName(detail)}</h1>
        <div className="dispatch-detail-meta"><span className="mono">{detail.model ? modelShortName(detail.model) : "模型未知"} / {detail.effort || "继承"}</span>
          <span className="mono" aria-label="已跑时长">{dispatchTime(dispatchSeconds(detail, now))}</span>
          <span className={`dispatch-badge ${["TOOL_FAIL", "ACCEPT_FAIL", "TIMEOUT", "lost"].includes(detail.status) ? "failed" : ""}`}>STATUS {detail.status === "running" ? "运行中" : detail.status}</span>
          {detail.status !== "running" && <span title={detail.acceptResult || undefined} className={`dispatch-badge ${detail.status === "ACCEPT_FAIL" ? "failed" : ""}`}>ACCEPT {detail.acceptResult?.split("←")[0]?.trim() || "未知"}</span>}
          {detail.credits !== null && <span className="dispatch-badge">{detail.credits.toFixed(2)} credits</span>}
        </div>
        <p className="dispatch-detail-id mono">{detail.runId}</p>
      </header>
      <section className="dispatch-detail-section"><div className="dispatch-section-head"><h2>派单原文</h2>
        <button className="btn" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起" : "展开全文"}</button></div>
        <pre className={`dispatch-prompt${expanded ? "" : " collapsed"}`}>{expanded ? prompt : prompt.split("\n").slice(0, 5).join("\n")}</pre>
        {detail.promptTruncated && <p className="dispatch-note">原文超过 64 KiB，此处显示前 64 KiB。</p>}
      </section>
      <section className="dispatch-detail-section" aria-label="执行过程"><div className="dispatch-section-head"><h2>执行过程</h2><span>{nativeAgent ? "原生会话" : "stdout 尾部"}{detail.status === "running" ? " · 实时更新" : ""}</span></div>
        {truncated && <p className="dispatch-note">显示最新过程；较早消息或超长正文已省略。</p>}
        {nativeAgent ? <HistoryTimeline messages={processMessages} agent={nativeAgent} cwd={detail.cwd || ""} />
          : <><p className="dispatch-note">原生会话暂不可读，显示执行端输出。</p><pre className="dispatch-log">{log || "暂无输出"}</pre></>}
      </section>
      {detail.status !== "running" && <section className="dispatch-detail-section"><h2>交付摘要</h2>
        {detail.summary ? <pre className="dispatch-summary">{detail.summary}</pre> : detail.final ? <MarkdownMessage text={detail.final} /> : <p className="dispatch-note">尚无交付摘要</p>}
        {detail.resume && detail.resume !== "?" && <div className="dispatch-resume"><div className="dispatch-section-head"><h2>续接命令</h2><button className="btn" onClick={() => void copy()}>{copied ? "已复制" : "复制"}</button></div><pre>{detail.resume}</pre></div>}
      </section>}
    </>}
  </section>;
}
