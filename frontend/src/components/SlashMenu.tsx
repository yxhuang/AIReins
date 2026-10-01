import { useEffect, useRef, useState } from "react";
import type { SessionRecord } from "../types";
import { fetchSessionInfo, setSessionPlugin, type SessionInfoKind } from "../api";
import { compactTokens } from "../format";
import { store, type Store } from "../store";
import { useStore } from "../useStore";

// 输入框底栏「/」菜单：仿 VSCode 扩展同名按钮（2.1.285 的 commandRegistry 分组）。
// Claude 的查看（MCP / Hooks / 权限规则 / 上下文用量走 control_request，插件通过 CLI 列表及启停）、
// 浏览斜杠命令（打开现有命令面板）、Focus view 开关。

const INFO_LABELS: Record<SessionInfoKind, string> = {
  mcp: "MCP 服务器",
  hooks: "Hooks",
  permissions: "权限规则",
  context: "上下文用量",
  plugins: "插件",
};

const selectFocusView = (value: Store) => value.focusView;

export function SlashMenu({ session, commandsSupported, onBrowseCommands }: {
  session: SessionRecord;
  commandsSupported: boolean;
  onBrowseCommands: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<SessionInfoKind | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  const focusView = useStore(selectFocusView);
  const claude = session.agent === "claude";
  const workerReady = session.status !== "dead" && Boolean(session.processId || session.released);

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
          {claude && (
            <>
              <div className="slash-group">查看</div>
              {(Object.keys(INFO_LABELS) as SessionInfoKind[]).map((kind) => (
                <button key={kind} type="button" className="attach-item" role="menuitem" disabled={!workerReady && kind !== "plugins"}
                  title={workerReady || kind === "plugins" ? undefined : "会话已结束，查看不到"}
                  onClick={() => { setOpen(false); setInfo(kind); }}>
                  {INFO_LABELS[kind]}
                </button>
              ))}
            </>
          )}
          {commandsSupported && (
            <>
              <div className="slash-group">斜杠命令</div>
              <button type="button" className="attach-item" role="menuitem"
                onClick={() => { setOpen(false); onBrowseCommands(); }}>浏览斜杠命令</button>
            </>
          )}
          <div className="slash-group">设置</div>
          {/* 开关项点了不关菜单，与扩展 keepMenuOpen 一致 */}
          <button type="button" className="attach-item slash-toggle" role="menuitemcheckbox" aria-checked={focusView}
            title="只显示你的输入和回复，隐藏工具、思考和调试行" onClick={() => store.setFocusView(!focusView)}>
            <span>Focus view</span>
            <span className={`slash-switch${focusView ? " on" : ""}`} aria-hidden="true" />
          </button>
        </div>
      )}
      {info && <InfoDialog key={`${session.id}:${info}`} session={session} kind={info} onClose={() => setInfo(null)} />}
    </span>
  );
}

function InfoDialog({ session, kind, onClose }: { session: SessionRecord; kind: SessionInfoKind; onClose: () => void }) {
  const [data, setData] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pendingPlugin, setPendingPlugin] = useState<string | null>(null);
  const [pluginNotice, setPluginNotice] = useState<string | null>(null);
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
          {data === undefined ? (!error && <p className="new-hint">正在读取…</p>)
            : <InfoBody kind={kind} data={data} onTogglePlugin={togglePlugin} pendingPlugin={pendingPlugin} />}
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

function InfoBody({ kind, data, onTogglePlugin, pendingPlugin }: {
  kind: SessionInfoKind;
  data: unknown;
  onTogglePlugin: (plugin: Rec) => void;
  pendingPlugin: string | null;
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
        </div>
      );
    })}</>;
  }
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
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <path d="M14.5 8l-5 8" />
    </svg>
  );
}
