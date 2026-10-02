import { useEffect, useRef, useState } from "react";
import type { SessionRecord } from "../types";
import { fetchClaudeCapabilities, fetchSessionInfo, manageSessionMcp, setSessionPlugin, setSessionThinking, type SessionInfoKind } from "../api";
import { ClaudeMenuPanel, SettingsFileLinks, ClaudeTasksDialog, ClaudeSideQuestionDialog } from "./ClaudeMenuPanels";
import { compactTokens } from "../format";
import { store, type Store } from "../store";
import { useStore } from "../useStore";

// 输入框底栏「/」菜单：VSCode 扩展 2.1.286 的常用查看、MCP 管理、文件编辑与纯文本导出。
// 协议以本机 CLI 2.1.285 实测为准；Rewind 缺少文件检查点，不接破坏性操作。

const INFO_LABELS: Record<SessionInfoKind, string> = {
  mcp: "MCP 服务器",
  hooks: "Hooks",
  permissions: "权限规则",
  context: "上下文用量",
  plugins: "管理插件",
  status: "状态",
  usage: "账户与用量",
  memory: "Memory",
  instructions: "Instructions · CLAUDE.md",
  skills: "Skills",
  sandbox: "Sandbox",
  output: "输出样式",
  settings: "Claude 设置",
  export: "导出对话",
};

const selectFocusView = (value: Store) => value.focusView;

export function SlashMenu({ session, commandsSupported, onBrowseCommands, onCodexCommand, canInsertCommand = true }: {
  session: SessionRecord;
  commandsSupported: boolean;
  onBrowseCommands: () => void;
  onCodexCommand?: (name: string) => void;
  canInsertCommand?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<SessionInfoKind | null>(null);
  const [panel, setPanel] = useState<"tasks" | "btw" | null>(null);
  const [supportsFast, setSupportsFast] = useState(false);
  const [thinkingPending, setThinkingPending] = useState(false);
  const [thinkingError, setThinkingError] = useState("");
  const [thinkingOverride, setThinkingOverride] = useState<{ id: string; value: boolean } | null>(null);
  const thinkingBusy = useRef(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const focusView = useStore(selectFocusView);
  const claude = session.agent === "claude";
  const commands = useStore(value => value.commands.get(session.id));
  const workerReady = session.status !== "dead" && Boolean(session.processId || session.released);

  const thinking = thinkingOverride?.id === session.id ? thinkingOverride.value : session.config.thinkingLevel !== "off";
  useEffect(() => { setThinkingOverride(null); }, [session.id, session.config.thinkingLevel]);
  useEffect(() => {
    setSupportsFast(false);
    if (!open || !claude || !workerReady || session.status === "starting") return;
    let alive = true;
    fetchClaudeCapabilities(session.id).then(value => { if (alive) setSupportsFast(value.supportsFastMode === true); }).catch(() => {});
    return () => { alive = false; };
  }, [open, claude, workerReady, session.id, session.model, session.config.model, session.status]);
  const toggleThinking = async () => {
    if (thinkingBusy.current) return;
    thinkingBusy.current = true; setThinkingPending(true); setThinkingError("");
    try {
      const { session: updated } = await setSessionThinking(session.id, !thinking);
      setThinkingOverride({ id: session.id, value: updated.config.thinkingLevel !== "off" });
    } catch (error) { setThinkingError(error instanceof Error ? error.message : String(error)); }
    finally { thinkingBusy.current = false; setThinkingPending(false); }
  };

  // Esc 或点外部关闭（与「+」菜单同一纪律）
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  return (
    <span className="attach-menu-wrap" ref={rootRef}>
      <button type="button" className="attach-btn" title="命令与设置" aria-label="命令与设置"
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <SlashIcon />
      </button>
      {open && (
        <div className="attach-menu slash-menu" role="menu" aria-label="命令与设置">
          {session.agent === "codex" && commandsSupported && onCodexCommand && <>
            <div className="slash-group">Codex 命令</div>
            {(commands ?? []).map(command => <button key={command.name} type="button" className="attach-item" role="menuitem"
              disabled={!workerReady || (["compact", "review", "new"].includes(command.name) && session.status !== "idle")
                || (command.name === "review" && !canInsertCommand)
                || (command.name === "interrupt" && session.status !== "running")}
              title={command.description} onClick={() => { setOpen(false); onCodexCommand(command.name); }}>
              /{command.name} · {command.description}
            </button>)}
          </>}
          {claude && (
            <>
              <div className="slash-group">上下文</div>
              <button type="button" className="attach-item" role="menuitem" disabled={!workerReady}
                onClick={() => { setOpen(false); setInfo("context"); }}>上下文用量</button>
              <button type="button" className="attach-item" role="menuitem" disabled={!workerReady}
                onClick={() => { setOpen(false); setInfo("export"); }}>导出对话</button>
              <button type="button" className="attach-item" role="menuitem"
                onClick={() => { setOpen(false); setPanel("tasks"); }}>/tasks · 后台任务<span className="slash-subtitle">查看运行任务并停止</span></button>
              <button type="button" className="attach-item" role="menuitem" disabled={!workerReady}
                onClick={() => { setOpen(false); setPanel("btw"); }}>/btw · 侧问<span className="slash-subtitle">单独问答，不加入主对话</span></button>
              <div className="slash-group">模型</div>
              <button type="button" className="attach-item slash-toggle" role="switch" aria-label="Thinking" aria-checked={thinking}
                disabled={!workerReady || thinkingPending || session.status === "starting"}
                onClick={() => void toggleThinking()}>
                <span>Thinking{thinkingPending && <span className="slash-subtitle">切换中…</span>}</span>
                <span className={`slash-switch${thinking ? " on" : ""}`} aria-hidden="true" />
              </button>
              {thinkingError && <p className="new-error" role="alert">{thinkingError}</p>}
              {supportsFast && <button type="button" className="attach-item" role="menuitem" disabled={!workerReady || !canInsertCommand || session.status === "starting"}
                onClick={() => { if (store.sendUserMessage(session.id, "/fast")) setOpen(false); }}>切换 Fast mode<span className="slash-subtitle">/fast · 更快的模型回复</span></button>}
              <button type="button" className="attach-item" role="menuitem" disabled={!workerReady}
                onClick={() => { setOpen(false); setInfo("usage"); }}>账户与用量</button>
              <div className="slash-group">自定义</div>
              {(["plugins", "mcp", "instructions", "memory", "skills", "hooks", "output", "permissions", "sandbox", "status"] as SessionInfoKind[]).map(kind => (
                <button key={kind} type="button" className="attach-item" role="menuitem" disabled={!workerReady && kind !== "plugins"}
                  onClick={() => { setOpen(false); setInfo(kind); }}>{INFO_LABELS[kind]}
                  {kind === "plugins" && <span className="slash-subtitle">启用、停用与重载</span>}
                  {kind === "mcp" && <span className="slash-subtitle">开关、重连与连接状态</span>}
                </button>
              ))}
              {commandsSupported && canInsertCommand && <button type="button" className="attach-item" role="menuitem"
                onClick={() => { setOpen(false); onBrowseCommands(); }}>浏览斜杠命令</button>}
              <div className="slash-group">设置</div>
              <button type="button" className="attach-item" role="menuitem"
                onClick={() => { setOpen(false); setInfo("settings"); }}>Claude 设置</button>
              <button type="button" className="attach-item slash-toggle" role="menuitemcheckbox" aria-checked={focusView}
                title="只显示你的输入和回复，隐藏工具、思考和调试行" onClick={() => store.setFocusView(!focusView)}>
                <span>Focus view</span><span className={`slash-switch${focusView ? " on" : ""}`} aria-hidden="true" />
              </button>
              <div className="slash-group">支持</div>
              <a className="attach-item" role="menuitem" href="https://code.claude.com/docs/en/vs-code" target="_blank" rel="noreferrer"
                onClick={() => setOpen(false)}>帮助文档</a>
            </>
          )}
          {!claude && commandsSupported && canInsertCommand && (
            <>
              <div className="slash-group">斜杠命令</div>
              <button type="button" className="attach-item" role="menuitem"
                onClick={() => { setOpen(false); onBrowseCommands(); }}>浏览斜杠命令</button>
            </>
          )}
          {!claude && <>
          <div className="slash-group">设置</div>
          {/* 开关项点了不关菜单，与扩展 keepMenuOpen 一致 */}
          <button type="button" className="attach-item slash-toggle" role="menuitemcheckbox" aria-checked={focusView}
            title="只显示你的输入和回复，隐藏工具、思考和调试行" onClick={() => store.setFocusView(!focusView)}>
            <span>Focus view</span>
            <span className={`slash-switch${focusView ? " on" : ""}`} aria-hidden="true" />
          </button>
          </>}
        </div>
      )}
      {panel === "tasks" && <ClaudeTasksDialog key={session.id} session={session} onClose={() => setPanel(null)} />}
      {panel === "btw" && <ClaudeSideQuestionDialog key={session.id} sessionId={session.id} onClose={() => setPanel(null)} />}
      {info && <InfoDialog key={`${session.id}:${info}`} session={session} kind={info} onClose={() => setInfo(null)} />}
    </span>
  );
}

function InfoDialog({ session, kind, onClose }: { session: SessionRecord; kind: SessionInfoKind; onClose: () => void }) {
  const [data, setData] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pendingPlugin, setPendingPlugin] = useState<string | null>(null);
  const [pluginNotice, setPluginNotice] = useState<string | null>(null);
  const [pendingServer, setPendingServer] = useState<string | null>(null);
  const mcpPending = useRef(false);
  const pluginPending = useRef(false);
  const aliveRef = useRef(true);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeButton.current?.focus();
    let alive = true;
    aliveRef.current = true;
    fetchSessionInfo(session.id, kind)
      .then((value) => { if (alive) setData(value); })
      .catch((e: unknown) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; aliveRef.current = false; };
  }, [session.id, kind]);

  const togglePlugin = async (plugin: Rec) => {
    if (pluginPending.current) return;
    pluginPending.current = true;
    setPendingPlugin(pluginKey(plugin));
    setError(null);
    setPluginNotice(null);
    try {
      const result = await setSessionPlugin(session.id, str(plugin.id), !pluginEnabled(plugin), str(plugin.scope) || undefined);
      if (!aliveRef.current) return;
      setData(result);
      setPluginNotice(result.reloaded ? "已保存并重载当前会话的插件。" : "已保存，新会话或重新续接后生效。");
      if (result.reloadError) setError(`设置已保存，当前会话重载失败：${result.reloadError}`);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      pluginPending.current = false;
      if (aliveRef.current) setPendingPlugin(null);
    }
  };

  const refreshPlugins = async () => {
    if (pluginPending.current) return;
    pluginPending.current = true;
    setPendingPlugin("refresh");
    setError(null);
    try {
      const result = await fetchSessionInfo(session.id, "plugins");
      if (aliveRef.current) setData(result);
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      pluginPending.current = false;
      if (aliveRef.current) setPendingPlugin(null);
    }
  };

  const updateMcp = async (action: "toggle" | "reconnect" | "refresh", server: Rec = {}) => {
    if (mcpPending.current) return;
    mcpPending.current = true;
    setPendingServer(str(server.name) || "refresh");
    setError(null);
    setPluginNotice(null);
    try {
      const result = action === "refresh" ? await fetchSessionInfo(session.id, "mcp")
        : await manageSessionMcp(session.id, action, str(server.name), action === "toggle" ? server.status === "disabled" : undefined);
      if (!aliveRef.current) return;
      setData(result);
      const refreshError = str(rec(result).refreshError);
      if (refreshError) setError(`操作已成功，状态读回失败：${refreshError}。请刷新列表。`);
      else setPluginNotice(action === "refresh" ? "已刷新服务器状态。" : "操作已完成；连接可能仍在建立，可刷新查看最新状态。");
    } catch (e) {
      if (aliveRef.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      mcpPending.current = false;
      if (aliveRef.current) setPendingServer(null);
    }
  };

  return (
    <div className="dir-overlay" onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dir-dialog info-dialog" role="dialog" aria-modal="true" aria-label={INFO_LABELS[kind]}>
        <div className="dir-heading">
          <h2>{INFO_LABELS[kind]}</h2>
          <button ref={closeButton} className="btn" type="button" onClick={onClose}>关闭</button>
        </div>
        <div className="dir-list info-body">
          {error && <p className="new-error" role="alert">{error}</p>}
          {kind === "plugins" && <>
            <p className="new-hint">有活动进程时自动重载；否则新会话或重新续接后生效。</p>
            <button type="button" className="btn" disabled={pendingPlugin !== null || (data === undefined && !error)}
              onClick={() => void refreshPlugins()}>刷新列表</button>
          </>}
          {pluginNotice && <p className="new-hint" role="status">{pluginNotice}</p>}
          {kind === "mcp" && <>
            <p className="new-hint">开关与重连用于当前会话，回复中也可操作；启动或审批期间请稍候。</p>
            <button type="button" className="btn" disabled={pendingServer !== null || data === undefined}
              onClick={() => void updateMcp("refresh")}>刷新状态</button>
          </>}
          {data !== undefined && ["hooks", "permissions", "sandbox", "skills", "output"].includes(kind)
            && <SettingsFileLinks files={rec(data).settingsFiles} hooks={kind === "hooks"} />}
          {data === undefined ? (!error && <p className="new-hint">正在读取…</p>)
            : <InfoBody kind={kind} data={data} onTogglePlugin={togglePlugin} pendingPlugin={pendingPlugin}
                onMcpAction={updateMcp} pendingServer={pendingServer} mcpLockReason={session.status === "starting" ? "启动结束后可切换" : (session.pendingGateCount ?? 0) > 0 ? "审批结束后可切换" : session.status === "dead" ? "会话已结束" : ""} />}
        </div>
      </div>
    </div>
  );
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" ? v as Rec : {});
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : []);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const pluginKey = (p: Rec) => `${str(p.id)}:${str(p.scope)}`;
const pluginEnabled = (p: Rec) => p.enabled === true;

function InfoBody({ kind, data, onTogglePlugin, pendingPlugin, onMcpAction, pendingServer, mcpLockReason }: {
  kind: SessionInfoKind;
  data: unknown;
  onTogglePlugin: (plugin: Rec) => void;
  pendingPlugin: string | null;
  onMcpAction: (action: "toggle" | "reconnect", server: Rec) => void;
  pendingServer: string | null;
  mcpLockReason: string;
}) {
  const d = rec(data);
  if (kind === "mcp") {
    const servers = arr(d.mcpServers);
    if (servers.length === 0) return <p className="new-hint">没有配置 MCP 服务器。</p>;
    return <>{servers.map((s) => {
      const config = rec(s.config);
      const tools = arr(s.tools);
      return (
        <div className="info-row" key={str(s.name)}>
          <div className="info-row-head">
            <span className="info-name">{str(s.name)}</span>
            <span className={`info-status info-status-${str(s.status)}`}>{str(s.status)}</span>
          </div>
          <div className="info-meta mono">
            {str(s.scope)} · {str(config.type)}{tools.length > 0 ? ` · ${tools.length} 个工具` : ""}
          </div>
          <div className="info-meta mono">{str(config.url) || [str(config.command), ...(Array.isArray(config.args) ? config.args.map(String) : [])].join(" ")}</div>
          <div className="info-actions">
            <button type="button" className="btn slash-toggle" role="switch" aria-checked={s.status !== "disabled"}
              aria-label={`${str(s.name)} MCP 开关`} disabled={pendingServer !== null || Boolean(mcpLockReason)}
              onClick={() => onMcpAction("toggle", s)}>
              <span>{pendingServer === str(s.name) ? "处理中…" : s.status === "disabled" ? "未启用" : "已启用"}</span>
              <span className={`slash-switch${s.status !== "disabled" ? " on" : ""}`} aria-hidden="true" />
            </button>
            <button type="button" className="btn" disabled={pendingServer !== null || Boolean(mcpLockReason) || s.status === "disabled"}
              onClick={() => onMcpAction("reconnect", s)}>重连</button>
            {mcpLockReason && <span className="info-meta">{mcpLockReason}</span>}
          </div>
        </div>
      );
    })}</>;
  }
  if (!["hooks", "permissions", "plugins", "context"].includes(kind)) return <ClaudeMenuPanel kind={kind} data={d} />;
  if (kind === "hooks") {
    const hooks = arr(d.hooks);
    if (hooks.length === 0) return <p className="new-hint">没有配置 hooks。</p>;
    return <>{arr(d.events).filter((e) => Number(e.hookCount) > 0).map((event) => (
      <div className="info-group" key={str(event.name)}>
        <div className="info-group-head"><span className="info-name">{str(event.name)}</span> <span className="info-meta">{str(event.summary)}</span></div>
        {hooks.filter((h) => h.event === event.name).map((h, i) => (
          <div className="info-row" key={i}>
            <div className="info-meta">{str(h.pluginName) ? `插件 ${str(h.pluginName)}` : str(h.sourceLabel)}{str(h.matcher) ? ` · 匹配 ${str(h.matcher)}` : ""}</div>
            <div className="info-code mono">{str(h.commandText) || str(h.displayText)}</div>
          </div>
        ))}
      </div>
    ))}</>;
  }
  if (kind === "permissions") {
    const rules = arr(rec(d.state).rules);
    if (rules.length === 0) return <p className="new-hint">没有权限规则。</p>;
    return <>{(["allow", "ask", "deny"] as const).map((behavior) => {
      const group = rules.filter((r) => r.behavior === behavior);
      if (group.length === 0) return null;
      return (
        <div className="info-group" key={behavior}>
          <div className="info-group-head"><span className="info-name">{{ allow: "允许", ask: "询问", deny: "拒绝" }[behavior]}</span> <span className="info-meta">{group.length} 条</span></div>
          {group.map((r, i) => (
            <div className="info-row" key={i}>
              <div className="info-code mono">{str(r.rule)}</div>
              <div className="info-meta">{str(r.source)}</div>
            </div>
          ))}
        </div>
      );
    })}</>;
  }
  if (kind === "plugins") {
    const plugins = arr(d.plugins);
    if (plugins.length === 0) return <p className="new-hint">没有安装插件。</p>;
    return <>{plugins.map((p) => {
      const [name, marketplace] = str(p.id).split("@");
      const enabled = pluginEnabled(p);
      return (
        <div className="info-row" key={pluginKey(p)}>
          <div className="info-row-head">
            <span className="info-name">{name}</span>
            <button type="button" className="btn slash-toggle" role="switch" aria-checked={enabled}
              aria-label={`${str(p.id)}${str(p.scope) ? `（${str(p.scope)}）` : ""}`}
              disabled={pendingPlugin !== null} onClick={() => onTogglePlugin(p)}>
              <span>{pendingPlugin === pluginKey(p) ? "切换中…" : enabled ? "已启用" : "未启用"}</span>
              <span className={`slash-switch${enabled ? " on" : ""}`} aria-hidden="true" />
            </button>
          </div>
          <div className="info-meta mono">{marketplace} · {str(p.scope)} · {str(p.version)}</div>
        </div>
      );
    })}</>;
  }
  // context
  const total = Number(d.totalTokens ?? 0), max = Number(d.maxTokens ?? 0);
  return <>
    <div className="info-row">
      <div className="info-row-head">
        <span className="info-name">{compactTokens(total)} / {compactTokens(max)}</span>
        <span className="info-meta">{String(d.percentage ?? "")}%{str(d.model) ? ` · ${str(d.model)}` : ""}</span>
      </div>
    </div>
    {arr(d.categories).map((c) => (
      <div className="info-row info-row-inline" key={str(c.name)}>
        <span>{str(c.name)}</span>
        <span className="info-meta mono">{compactTokens(Number(c.tokens ?? 0))}</span>
      </div>
    ))}
  </>;
}

function SlashIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" aria-hidden="true">
      <path d="M15 4L9 20" />
    </svg>
  );
}
