import { useState } from "react";
import type { SessionInfoKind } from "../api";

type Rec = Record<string, unknown>;
const rec = (value: unknown): Rec => value && typeof value === "object" && !Array.isArray(value) ? value as Rec : {};
const rows = (value: unknown): Rec[] => Array.isArray(value) ? value.map(rec) : [];
const str = (value: unknown): string => typeof value === "string" ? value : "";
const text = (value: unknown): string => value == null ? "—" : typeof value === "object" ? JSON.stringify(value) : String(value);

export function SettingsFileLinks({ files, hooks = false }: { files: unknown; hooks?: boolean }) {
  return <div className="info-group">
    <p className="new-hint">{hooks ? "在 VSCode 中编辑对应 settings.json 的 hooks。" : "在 VSCode 中编辑对应 settings.json。"}保存后可重新打开面板查看；部分设置在下次续接后生效。</p>
    <div className="info-actions">{rows(files).map(file => <FileLink key={str(file.path)} file={file}
      label={`编辑${str(file.label)}${hooks ? " Hooks" : ""}`} />)}</div>
  </div>;
}

function FileLink({ file, label }: { file: Rec; label?: string }) {
  // 仅消费后端生成的协议链接；CLI 文本不能注入 javascript: URL。
  const uri = str(file.uri);
  return uri.startsWith("vscode://")
    ? <a className="btn info-file-link" href={uri} title={str(file.path)}>{label || str(file.label) || str(file.path)}</a>
    : <span className="info-meta mono">{str(file.path)}</span>;
}

export function ClaudeMenuPanel({ kind, data }: { kind: SessionInfoKind; data: Rec }) {
  if (kind === "export") return <ExportConversation data={data} />;
  if (kind === "settings") return <SettingsFileLinks files={data.settingsFiles} />;
  if (kind === "status") return <>{rows(data.sections).map((section, i) => <div className="info-group" key={i}>
    <div className="info-group-head info-name">{str(section.title)}</div>
    {rows(section.rows).map((row, j) => <div className="info-row" key={j}>
      <span className="info-name">{str(row.label)}</span><div className="info-code">{text(row.value)}</div>
    </div>)}
  </div>)}</>;
  if (kind === "usage") {
    const session = rec(data.session);
    const limits = rec(data.rate_limits);
    const names: Record<string, string> = { session: "当前时段", weekly_all: "每周总用量", weekly_opus: "每周 Opus", weekly_sonnet: "每周 Sonnet" };
    return <>
      <div className="info-row">订阅：{text(data.subscription_type)}</div>
      <div className="info-row">会话费用：${text(session.total_cost_usd)}</div>
      <div className="info-row">文件改动：+{text(session.total_lines_added)} / -{text(session.total_lines_removed)}</div>
      {data.rate_limits_available === false && <p className="new-hint">当前账户没有可查询的用量额度。</p>}
      {rows(limits.limits).map((limit, i) => <div className="info-row" key={i}>
        <span className="info-name">{names[str(limit.kind)] || str(limit.kind)}</span>
        <div className="info-meta">已用 {text(limit.percent)}%{str(limit.resets_at) ? ` · 重置 ${new Date(str(limit.resets_at)).toLocaleString()}` : ""}</div>
      </div>)}
    </>;
  }
  if (kind === "memory" || kind === "instructions") {
    const files = rows(data.files);
    const memories = rows(data.memories);
    return <>
      {kind === "memory" && <div className="info-row">自动记忆：{rec(data.auto_memory).enabled ? "开启" : "关闭"}</div>}
      {files.map((file, i) => <div className="info-row" key={i}>
        <FileLink file={file} />
        <div className="info-meta mono">{str(file.path)}{file.exists === false ? " · 尚未创建" : ""}</div>
      </div>)}
      {kind === "memory" && <>
        {rows(data.folders).map((file, i) => <div className="info-row" key={i}><FileLink file={file} /></div>)}
        {memories.map((file, i) => <div className="info-row" key={i}><FileLink file={file} /></div>)}
        {memories.length === 0 && <p className="new-hint">没有已保存的自动记忆条目。</p>}
        <SettingsFileLinks files={data.settingsFiles} />
      </>}
    </>;
  }
  if (kind === "skills") {
    const skills = rows(data.skills);
    const states: Record<string, string> = { on: "启用", "name-only": "仅名称", "user-invocable-only": "仅手动调用", off: "停用" };
    return skills.length ? <>{skills.map((skill, i) => <details className="info-row" key={i}>
      <summary><span className="info-name">{str(skill.display_name) || str(skill.name)}</span> · {states[str(skill.state)] || str(skill.state)}</summary>
      <div className="info-meta">{str(skill.source)}</div>
      <div className="info-code">{str(skill.description)}</div>
    </details>)}</> : <p className="new-hint">没有可用 Skills。</p>;
  }
  if (kind === "sandbox") {
    const deps = rec(data.dependencies);
    const restrictions = rec(data.restrictions);
    return <>
      <div className="info-row">沙箱：{data.enabled ? "开启" : "关闭"} · {text(data.mode)}</div>
      {data.supported === false && <p className="new-hint">当前环境不支持沙箱。</p>}
      {data.locked === true && <p className="new-hint">沙箱设置由组织策略锁定。</p>}
      <div className="info-row">允许无沙箱回退：{data.unsandboxed_fallback ? "是" : "否"}</div>
      {[...(Array.isArray(deps.errors) ? deps.errors : []), ...(Array.isArray(deps.warnings) ? deps.warnings : [])]
        .map((value, i) => <div className="info-row info-code" key={i}>{text(value)}</div>)}
      {Object.entries(restrictions).filter(([, values]) => Array.isArray(values) && values.length > 0).map(([name, values]) =>
        <div className="info-row" key={name}><span className="info-name">{name}</span><div className="info-code mono">{(values as unknown[]).map(text).join("\n")}</div></div>)}
    </>;
  }
  if (kind === "output") return <>
    <div className="info-row">当前样式：<span className="info-name">{text(data.outputStyle)}</span></div>
    <p className="new-hint">可在设置文件中修改 outputStyle，也可使用已有斜杠命令。</p>
    {(Array.isArray(data.availableStyles) ? data.availableStyles : []).map((style, i) => <div className="info-row info-code" key={i}>{text(style)}</div>)}
  </>;
  return null;
}

function ExportConversation({ data }: { data: Rec }) {
  const [notice, setNotice] = useState("");
  const content = str(data.text);
  const filename = str(data.default_filename).split(/[\\/]/).at(-1)?.replace(/[\x00-\x1f<>:"|?*]/g, "_") || "conversation.txt";
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("已下载纯文本对话。");
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(content); setNotice("已复制对话。"); }
    catch { setNotice("复制失败，请下载文件或从预览中选择文字。"); }
  };
  if (typeof data.text !== "string") return <p className="new-error" role="alert">{str(data.error) || "CLI 没有返回对话文本。"}</p>;
  return <>
    <p className="new-hint">导出 CLI 提供的当前会话纯文本。</p>
    <div className="info-actions">
      <button type="button" className="btn" onClick={download}>下载 .txt</button>
      <button type="button" className="btn" onClick={() => void copy()}>复制对话</button>
    </div>
    {notice && <p className="new-hint" role="status">{notice}</p>}
    <pre className="info-row info-code menu-export-preview">{content || "（空对话）"}</pre>
  </>;
}
