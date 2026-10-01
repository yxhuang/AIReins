import { useEffect, useRef } from "react";

export interface CodexCommandResult {
  name: string;
  data?: Record<string, unknown>;
  error?: string;
}

const labels: Record<string, string> = {
  status: "状态", model: "可用模型", mcp: "MCP 状态", skills: "Skills",
  compact: "压缩上下文", review: "代码审查", new: "新建会话", interrupt: "中断执行",
};
const rec = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(rec) : [];
const str = (value: unknown) => typeof value === "string" ? value : "";

export function CodexCommandPanel({ result, onClose }: { result: CodexCommandResult; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);
  const data = result.data;
  const entries = data ? rows(result.name === "skills" ? data.skills : data.data) : [];
  return <div className="dir-overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="dir-dialog info-dialog codex-command-modal" role="dialog" aria-modal="true" aria-label={`Codex · ${labels[result.name]}`}>
      <div className="dir-heading"><h2>Codex · {labels[result.name]}</h2><button ref={closeRef} type="button" className="btn" aria-label="关闭" onClick={onClose}>关闭</button></div>
      <div className="dir-list info-body">
        {result.error && <p className="config-error" role="alert">{result.error}</p>}
        {!data && !result.error && <p role="status">正在读取…</p>}
        {data && ["skills", "model", "mcp"].includes(result.name) && <>
          {entries.length === 0 && <p>没有可用条目。</p>}
          {entries.map((entry, i) => <div className="info-row" key={i}>
            <div className="info-name mono">{result.name === "skills" ? "$" : ""}{str(entry.name) || str(entry.displayName) || str(entry.model) || str(entry.id)}</div>
            {entry.description ? <p>{str(entry.description)}</p> : null}
            {result.name === "skills" && <p className="mono">{str(entry.scope)} · {str(entry.path)}</p>}
            {result.name === "mcp" && <>
              <p>连接：{str(entry.runtimeStatus) || "未报告"} · 认证：{str(entry.authStatus) || "未报告"} · {Object.keys(rec(entry.tools)).length} 个工具</p>
              {entry.toolsError ? <p className="config-error">{str(entry.toolsError)}</p> : null}
            </>}
          </div>)}
          {result.name === "model" && <p>切换模型请使用输入框底栏的模型菜单；在下一次发送时生效。</p>}
          {result.name === "skills" && rows(data.errors).map((error, i) => <p key={i} className="config-error">{str(error.path)}：{str(error.message)}</p>)}
        </>}
        {data && result.name === "status" && <pre className="codex-command-json mono">{JSON.stringify(data, null, 2)}</pre>}
        {data && typeof data.message === "string" && <p role="status">{data.message}</p>}
      </div>
    </div>
  </div>;
}
