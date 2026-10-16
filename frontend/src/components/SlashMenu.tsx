import { t } from "../i18n";
import { useEffect, useRef, useState } from "react";
import type { SessionRecord } from "../types";
import { fetchClaudeCapabilities, fetchSessionInfo, manageSessionMcp, setSessionPlugin, setSessionThinking, type SessionInfoKind, type SessionMcpAction } from "../api";
import { ClaudeMenuPanel, SettingsFileLinks, ClaudeTasksDialog } from "./ClaudeMenuPanels";
import { compactTokens } from "../format";
import { store, type Store } from "../store";
import { useStore } from "../useStore";

// 输入框底栏「/」菜单：VSCode 扩展 2.1.286 的常用查看、MCP 管理、文件编辑与纯文本导出。
// 协议以本机 CLI 2.1.285 实测为准；Rewind 缺少文件检查点，不接破坏性操作。

const INFO_LABELS: Record<SessionInfoKind, string> = {
  mcp: t("ui.SlashMenu.mcp_servers"),
  hooks: "Hooks",
  permissions: t("ui.SlashMenu.permission_rules"),
  context: t("ui.SlashMenu.context_usage"),
  plugins: t("ui.SlashMenu.manage_plugins"),
  status: t("ui.common.status"),
  usage: t("ui.SlashMenu.account_and_usage"),
  memory: "Memory",
  instructions: "Instructions · CLAUDE.md",
  skills: "Skills",
  sandbox: "Sandbox",
  output: t("ui.SlashMenu.output_style"),
  settings: t("ui.SlashMenu.claude_settings"),
  export: t("ui.SlashMenu.export_conversation"),
};

const selectFocusView = (value: Store) => value.focusView;

export function SlashMenu({ session, commandsSupported, onBrowseCommands, onSideQuestion, onCodexCommand, canInsertCommand = true }: {
  session: SessionRecord;
  commandsSupported: boolean;
  onBrowseCommands: () => void;
  onSideQuestion: () => void;
  onCodexCommand?: (name: string) => void;
  canInsertCommand?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<SessionInfoKind | null>(null);
  const [panel, setPanel] = useState<"tasks" | null>(null);
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
      <button type="button" className="attach-btn" title={t("ui.SlashMenu.commands_and_settings")} aria-label={t("ui.SlashMenu.commands_and_settings")}
        aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <SlashIcon />
      </button>
      {open && (
        <div className="attach-menu slash-menu" role="menu" aria-label={t("ui.SlashMenu.commands_and_settings")}>
          {session.agent === "codex" && commandsSupported && onCodexCommand && <>
            <div className="slash-group">{t("ui.SlashMenu.codex_commands")}</div>
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
              <div className="slash-group">{t("ui.SlashMenu.context")}</div>
              <button type="button" className="attach-item" role="menuitem" disabled={!workerReady}
                onClick={() => { setOpen(false); setInfo("context"); }}>{t("ui.SlashMenu.context_usage")}</button>
              <button type="button" className="attach-item" role="menuitem" disabled={!workerReady}
                onClick={() => { setOpen(false); setInfo("export"); }}>{t("ui.SlashMenu.export_conversation")}</button>
              <button type="button" className="attach-item" role="menuitem"
                onClick={() => { setOpen(false); setPanel("tasks"); }}>{t("ui.SlashMenu.tasks_background_tasks")}<span className="slash-subtitle">{t("ui.SlashMenu.view_running_tasks_and_stop_them")}</span></button>
              <button type="button" className="attach-item" role="menuitem" disabled={!workerReady}
                onClick={() => { setOpen(false); onSideQuestion(); }}>{t("ui.SlashMenu.btw_side_question")}<span className="slash-subtitle">{t("ui.SlashMenu.ask_separately_without_adding_to_the_main")}</span></button>
              <div className="slash-group">{t("ui.SlashMenu.model")}</div>
              <button type="button" className="attach-item slash-toggle" role="switch" aria-label={t("ui.SlashMenu.thinking")} aria-checked={thinking}
                disabled={!workerReady || thinkingPending || session.status === "starting"}
                onClick={() => void toggleThinking()}>
                <span>{t("ui.SlashMenu.thinking")}{thinkingPending && <span className="slash-subtitle">{t("ui.SlashMenu.switching")}</span>}</span>
                <span className={`slash-switch${thinking ? " on" : ""}`} aria-hidden="true" />
              </button>
              {thinkingError && <p className="new-error" role="alert">{thinkingError}</p>}
              {supportsFast && <button type="button" className="attach-item" role="menuitem" disabled={!workerReady || !canInsertCommand || session.status === "starting"}
                onClick={() => { if (store.sendUserMessage(session.id, "/fast")) setOpen(false); }}>{t("ui.SlashMenu.toggle_fast_mode")}<span className="slash-subtitle">{t("ui.SlashMenu.fast_faster_model_responses")}</span></button>}
              <button type="button" className="attach-item" role="menuitem" disabled={!workerReady}
                onClick={() => { setOpen(false); setInfo("usage"); }}>{t("ui.SlashMenu.account_and_usage")}</button>
              <div className="slash-group">{t("ui.SlashMenu.custom")}</div>
              {(["plugins", "mcp", "instructions", "memory", "skills", "hooks", "output", "permissions", "sandbox", "status"] as SessionInfoKind[]).map(kind => (
                <button key={kind} type="button" className="attach-item" role="menuitem" disabled={!workerReady && kind !== "plugins"}
                  onClick={() => { setOpen(false); setInfo(kind); }}>{INFO_LABELS[kind]}
                  {kind === "plugins" && <span className="slash-subtitle">{t("ui.SlashMenu.enable_disable_and_reload")}</span>}
                  {kind === "mcp" && <span className="slash-subtitle">{t("ui.SlashMenu.toggle_reconnect_and_view_connection_status")}</span>}
                </button>
              ))}
              {commandsSupported && canInsertCommand && <button type="button" className="attach-item" role="menuitem"
                onClick={() => { setOpen(false); onBrowseCommands(); }}>{t("ui.SlashMenu.browse_slash_commands")}</button>}
              <div className="slash-group">{t("ui.common.settings")}</div>
              <button type="button" className="attach-item" role="menuitem"
                onClick={() => { setOpen(false); setInfo("settings"); }}>{t("ui.SlashMenu.claude_settings")}</button>
              <button type="button" className="attach-item slash-toggle" role="menuitemcheckbox" aria-checked={focusView}
                title={t("ui.SlashMenu.show_only_your_messages_and_replies_hide")} onClick={() => store.setFocusView(!focusView)}>
                <span>{t("ui.SlashMenu.focus_view")}</span><span className={`slash-switch${focusView ? " on" : ""}`} aria-hidden="true" />
              </button>
              <div className="slash-group">{t("ui.SlashMenu.support")}</div>
              <a className="attach-item" role="menuitem" href="https://code.claude.com/docs/en/vs-code" target="_blank" rel="noreferrer"
                onClick={() => setOpen(false)}>{t("ui.SlashMenu.help_documentation")}</a>
            </>
          )}
          {!claude && commandsSupported && canInsertCommand && (
            <>
              <div className="slash-group">{t("ui.common.slash_commands")}</div>
              <button type="button" className="attach-item" role="menuitem"
                onClick={() => { setOpen(false); onBrowseCommands(); }}>{t("ui.SlashMenu.browse_slash_commands")}</button>
            </>
          )}
          {!claude && <>
          <div className="slash-group">{t("ui.common.settings")}</div>
          {/* 开关项点了不关菜单，与扩展 keepMenuOpen 一致 */}
          <button type="button" className="attach-item slash-toggle" role="menuitemcheckbox" aria-checked={focusView}
            title={t("ui.SlashMenu.show_only_your_messages_and_replies_hide")} onClick={() => store.setFocusView(!focusView)}>
            <span>{t("ui.SlashMenu.focus_view")}</span>
            <span className={`slash-switch${focusView ? " on" : ""}`} aria-hidden="true" />
          </button>
          </>}
        </div>
      )}
      {panel === "tasks" && <ClaudeTasksDialog key={session.id} session={session} onClose={() => setPanel(null)} />}
      {info && <InfoDialog key={`${session.id}:${info}`} session={session} kind={info} onClose={() => setInfo(null)} />}
    </span>
  );
}

export function InfoDialog({ session, kind, onClose }: { session: SessionRecord; kind: SessionInfoKind; onClose: () => void }) {
  const [data, setData] = useState<unknown>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [pendingPlugin, setPendingPlugin] = useState<string | null>(null);
  const [pluginNotice, setPluginNotice] = useState<string | null>(null);
  const [pendingServer, setPendingServer] = useState<string | null>(null);
  const [oauth, setOauth] = useState<Rec | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
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
      setPluginNotice(result.reloaded ? t("ui.SlashMenu.plugins_saved_and_reloaded_in_this_session") : t("ui.SlashMenu.saved_takes_effect_in_a_new_session"));
      if (result.reloadError) setError(t("ui.SlashMenu.settings_saved_but_the_current_session_could", { p0: (result.reloadError) }));
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

  const updateMcp = async (action: SessionMcpAction | "refresh", server: Rec = {}) => {
    if (mcpPending.current) return;
    mcpPending.current = true;
    setPendingServer(str(server.name) || "refresh");
    setError(null);
    setPluginNotice(null);
    try {
      const result = action === "refresh" ? await fetchSessionInfo(session.id, "mcp")
        : await manageSessionMcp(session.id, action, str(server.name), action === "toggle" ? server.status === "disabled" : undefined,
          action === "oauth_callback" ? callbackUrl : undefined);
      if (!aliveRef.current) return;
      setData(result);
      const outcome = rec(result);
      const actionError = str(outcome.actionError);
      const refreshError = str(outcome.refreshError);
      if (outcome.auth) { setOauth({ ...rec(outcome.auth), serverName: server.name }); setCallbackUrl(""); }
      else if (!refreshError && oauth && ((!actionError && action === "oauth_callback")
        || arr(outcome.mcpServers).some(s => s.name === oauth.serverName && ["connected", "disabled"].includes(str(s.status))))) {
        setOauth(null); setCallbackUrl("");
      }
      if (actionError || refreshError) setError([actionError, refreshError ? t("ui.SlashMenu.status_refresh_failed", { error: refreshError }) : ""].filter(Boolean).join("\n"));
      else setPluginNotice(action === "refresh" ? t("ui.SlashMenu.server_status_refreshed") : t("ui.SlashMenu.action_completed_the_connection_may_still_be"));
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
          <button ref={closeButton} className="btn" type="button" onClick={onClose}>{t("ui.common.close")}</button>
        </div>
        <div className="dir-list info-body">
          {error && <p className="new-error" role="alert">{error}</p>}
          {kind === "plugins" && <>
            <p className="new-hint">{t("ui.SlashMenu.automatically_reloads_active_processes_otherwise_takes_effect")}</p>
            <button type="button" className="btn" disabled={pendingPlugin !== null || (data === undefined && !error)}
              onClick={() => void refreshPlugins()}>{t("ui.SlashMenu.refresh_list")}</button>
          </>}
          {pluginNotice && <p className="new-hint" role="status">{pluginNotice}</p>}
          {kind === "mcp" && <>
            <p className="new-hint">{t("ui.SlashMenu.toggles_and_reconnect_apply_to_this_session")}</p>
            <button type="button" className="btn" disabled={pendingServer !== null || (data === undefined && !error)}
              onClick={() => void updateMcp("refresh")}>{t("ui.SlashMenu.refresh_status")}</button>
          </>}
          {data !== undefined && ["hooks", "permissions", "sandbox", "skills", "output"].includes(kind)
            && <SettingsFileLinks files={rec(data).settingsFiles} hooks={kind === "hooks"} />}
          {data === undefined ? (!error && <p className="new-hint">{t("ui.common.reading")}</p>)
            : <InfoBody kind={kind} data={data} onTogglePlugin={togglePlugin} pendingPlugin={pendingPlugin}
                oauth={oauth} callbackUrl={callbackUrl} onCallbackUrl={setCallbackUrl} cwd={session.cwd}
                onMcpAction={updateMcp} pendingServer={pendingServer} mcpLockReason={session.status === "starting" ? t("ui.SlashMenu.available_after_startup") : (session.pendingGateCount ?? 0) > 0 ? t("ui.SlashMenu.available_after_approval") : session.status === "dead" ? t("ui.SlashMenu.session_ended") : ""} />}
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

function InfoBody({ kind, data, onTogglePlugin, pendingPlugin, onMcpAction, pendingServer, mcpLockReason, oauth, callbackUrl, onCallbackUrl, cwd }: {
  kind: SessionInfoKind;
  data: unknown;
  onTogglePlugin: (plugin: Rec) => void;
  pendingPlugin: string | null;
  onMcpAction: (action: SessionMcpAction, server: Rec) => void;
  pendingServer: string | null;
  mcpLockReason: string;
  oauth: Rec | null;
  callbackUrl: string;
  onCallbackUrl: (url: string) => void;
  cwd: string;
}) {
  const d = rec(data);
  if (kind === "mcp") {
    const servers = arr(d.mcpServers);
    if (servers.length === 0) return <p className="new-hint">{t("ui.SlashMenu.no_mcp_servers_configured")}</p>;
    return <>{servers.map((s) => {
      const config = rec(s.config);
      const tools = arr(s.tools);
      const auth = oauth?.serverName === s.name ? oauth : null;
      const authUrl = str(auth?.authUrl);
      const locked = pendingServer !== null || Boolean(mcpLockReason) || Boolean(d.refreshError);
      const loginCommand = `claude mcp login '${str(s.name).replaceAll("'", "'\\''")}'`;
      return (
        <div className="info-row" key={str(s.name)}>
          <div className="info-row-head">
            <span className="info-name">{str(s.name)}</span>
            <span className={`info-status info-status-${str(s.status)}`}>{str(s.status)}</span>
          </div>
          <div className="info-meta mono">
            {str(s.scope)} · {str(config.type)}{tools.length > 0 ? t("ui.SlashMenu.tools", { p0: (tools.length) }) : ""}
          </div>
          <div className="info-meta mono">{str(config.url) || [str(config.command), ...(Array.isArray(config.args) ? config.args.map(String) : [])].join(" ")}</div>
          <div className="info-actions">
            <button type="button" className="btn slash-toggle" role="switch" aria-checked={s.status !== "disabled"}
              aria-label={t("ui.SlashMenu.toggle_mcp", { p0: (str(s.name)) })} disabled={locked}
              onClick={() => onMcpAction("toggle", s)}>
              <span>{pendingServer === str(s.name) ? t("ui.SlashMenu.processing") : s.status === "disabled" ? t("ui.SlashMenu.disabled") : t("ui.SlashMenu.enabled")}</span>
              <span className={`slash-switch${s.status !== "disabled" ? " on" : ""}`} aria-hidden="true" />
            </button>
            <button type="button" className="btn" disabled={locked || s.status === "disabled"}
              onClick={() => onMcpAction("reconnect", s)}>{t("ui.SlashMenu.reconnect")}</button>
            {mcpLockReason && <span className="info-meta">{mcpLockReason}</span>}
          </div>
          {(s.status === "needs-auth" || auth) && <>
            <p className="new-hint">{t("ui.SlashMenu.oauth_hint")}</p>
            <button type="button" className="btn" disabled={locked} onClick={() => onMcpAction("authenticate", s)}>{t("ui.SlashMenu.authenticate")}</button>
            {/^https?:\/\//i.test(authUrl) && <div className="new-field">
              <a href={authUrl} target="_blank" rel="noopener noreferrer">{t("ui.SlashMenu.open_auth_link")}</a>
              <input aria-label={t("ui.SlashMenu.auth_link")} readOnly value={authUrl} onFocus={e => e.currentTarget.select()} />
            </div>}
            {auth?.callbackExpected === true && <div className="info-actions">
              <label className="new-field">{t("ui.SlashMenu.callback_url")}<input type="url" value={callbackUrl} autoComplete="off"
                onChange={e => onCallbackUrl(e.target.value)} /></label>
              <button type="button" className="btn" disabled={locked || !callbackUrl.trim()}
                onClick={() => onMcpAction("oauth_callback", s)}>{t("ui.SlashMenu.submit_callback")}</button>
            </div>}
            <p className="new-hint">{t("ui.SlashMenu.oauth_fallback", { cwd })}</p>
            <label className="new-field">{t("ui.SlashMenu.login_command")}<input readOnly value={loginCommand} onFocus={e => e.currentTarget.select()} /></label>
          </>}
        </div>
      );
    })}</>;
  }
  if (!["hooks", "permissions", "plugins", "context"].includes(kind)) return <ClaudeMenuPanel kind={kind} data={d} />;
  if (kind === "hooks") {
    const hooks = arr(d.hooks);
    if (hooks.length === 0) return <p className="new-hint">{t("ui.SlashMenu.no_hooks_configured")}</p>;
    return <>{arr(d.events).filter((e) => Number(e.hookCount) > 0).map((event) => (
      <div className="info-group" key={str(event.name)}>
        <div className="info-group-head"><span className="info-name">{str(event.name)}</span> <span className="info-meta">{str(event.summary)}</span></div>
        {hooks.filter((h) => h.event === event.name).map((h, i) => (
          <div className="info-row" key={i}>
            <div className="info-meta">{str(h.pluginName) ? t("ui.SlashMenu.plugin", { p0: (str(h.pluginName)) }) : str(h.sourceLabel)}{str(h.matcher) ? t("ui.SlashMenu.match", { p0: (str(h.matcher)) }) : ""}</div>
            <div className="info-code mono">{str(h.commandText) || str(h.displayText)}</div>
          </div>
        ))}
      </div>
    ))}</>;
  }
  if (kind === "permissions") {
    const rules = arr(rec(d.state).rules);
    if (rules.length === 0) return <p className="new-hint">{t("ui.SlashMenu.no_permission_rules")}</p>;
    return <>{(["allow", "ask", "deny"] as const).map((behavior) => {
      const group = rules.filter((r) => r.behavior === behavior);
      if (group.length === 0) return null;
      return (
        <div className="info-group" key={behavior}>
          <div className="info-group-head"><span className="info-name">{{ allow: t("ui.common.allow"), ask: t("ui.SlashMenu.ask"), deny: t("ui.common.deny") }[behavior]}</span> <span className="info-meta">{t("ui.SlashMenu.entries_sentence", { p0: (group.length) })}</span></div>
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
    if (plugins.length === 0) return <p className="new-hint">{t("ui.SlashMenu.no_plugins_installed")}</p>;
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
              <span>{pendingPlugin === pluginKey(p) ? t("ui.SlashMenu.switching") : enabled ? t("ui.SlashMenu.enabled") : t("ui.SlashMenu.disabled")}</span>
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
