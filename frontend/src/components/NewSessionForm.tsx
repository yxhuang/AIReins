import { t } from "../i18n";
import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { AgentKind, ConfigOptionId, DriverConfigOption, SessionRecord } from "../types";
import type { CreateSessionInput } from "../api";
import { store } from "../store";
import { shallowEqual, useStore } from "../useStore";
import { ConfigPills, PlusIcon, SendIcon, type MenuGroup } from "./ConfigMenu";
import { configOptionsForModel, modelConfigPatch, newSessionConfig, pillText } from "../config-view";
import { DirectoryContents } from "./DirectoryBrowser";
import { normalizeDirectoryPath } from "../directory-path";
import { uploadAttachment } from "../api";
import { AgentIcon } from "./AgentIcon";
import { attachmentMention, prepareImageForUpload, type Attachment } from "../attachments";
import { filterCommands, noteCommandUsed } from "../commands";
import { newSessionCommands } from "../new-session-input";
import { appendRefineCommand, refineCommandFor } from "../session-ui";

type NewAttachment = Attachment & { file?: File };

const CWD_STORAGE_KEY = "workbench-last-cwd";

// 隐私模式下 localStorage 访问器本身就会抛异常，与主题读写同一纪律：try/catch 兜底。
function readSavedCwd(): string {
  try {
    return localStorage.getItem(CWD_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

// cwd 预填三级回退：① localStorage 里上次成功建会话的 cwd → ② 最近活跃会话的 cwd → ③ /api/meta 的 defaultCwd
function pickInitialCwd(): string {
  const saved = readSavedCwd();
  if (saved) return saved;
  const latest = [...store.sessions].sort(
    (a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt),
  )[0];
  if (latest?.cwd) return latest.cwd;
  return store.meta?.defaultCwd ?? "";
}

/** children：主页标志，与 agent 切换同在输入卡片上方一块，卡片本身垂直居中。 */
export function NewSessionForm({ children }: { children?: ReactNode }) {
  const meta = useStore(value => value.meta);
  const sessions = useStore(value => value.sessions);
  const initialCwd = useStore(value => value.newSessionCwd);
  const cwdRequest = useStore(value => value.newSessionRequest);
  const [cwd, setCwd] = useState(() => initialCwd ?? pickInitialCwd());
  const [agent, setAgent] = useState<AgentKind>("claude");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 外部换到另一个目录（回填、组「+」）时换 key 重新挂载地址栏；地址栏内导航只改 cwd。
  const [browse, setBrowse] = useState(() => ({ key: 0, from: cwd }));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cwdTouched = useRef(false);
  const lastCwdRequest = useRef(cwdRequest);
  const [configSel, setConfigSel] = useState<Partial<Record<ConfigOptionId, string>>>(() => newSessionConfig("claude"));
  const [attachments, setAttachments] = useState<NewAttachment[]>([]);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [composing, setComposing] = useState(false);
  const [selectedCommand, setSelectedCommand] = useState(0);
  const createdSession = useRef<SessionRecord | null>(null);
  const submitting = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const previewUrls = useRef(new Set<string>());
  const attachmentSequence = useRef(0);
  const commands = useStore(value => newSessionCommands(agent, cwd, value.sessions, value.commands), shallowEqual);
  const slashQuery = /^[\/、]([^\s]*)$/.exec(message)?.[1] ?? null;
  const slashOpen = !busy && !dismissed && !composing && commands.length > 0 && (slashMenuOpen || slashQuery !== null);
  const filteredCommands = filterCommands(commands, slashQuery ?? "");
  const activeCommand = filteredCommands[Math.min(selectedCommand, Math.max(0, filteredCommands.length - 1))];
  const attachEnabled = !busy && meta?.drivers[agent]?.mentions === true;
  const options = meta?.drivers[agent]?.options ?? [];
  const windowsPaths = meta?.capabilities.windowsPaths === true;
  const applyCwd = (path: string) => {
    setCwd(path);
    store.setNewSessionCwd(path);
    if (path !== cwd) setBrowse(previous => ({ key: previous.key + 1, from: path }));
  };
  const navigateCwd = (path: string) => {
    cwdTouched.current = true;
    setCwd(path);
    store.setNewSessionCwd(path);
  };

  // 显式目录请求可重复发起；只换目录与焦点，保留首条消息、agent 和配置。
  useEffect(() => {
    const requested = lastCwdRequest.current !== cwdRequest;
    lastCwdRequest.current = cwdRequest;
    if (requested || !cwdTouched.current) {
      if (!createdSession.current) applyCwd(initialCwd ?? pickInitialCwd());
      cwdTouched.current = false;
    }
    // 手机进新建页不弹输入法，免得遮住目录选择（用户 10-17）
    if (!window.matchMedia("(max-width: 720px), (pointer: coarse)").matches) textareaRef.current?.focus();
  }, [cwdRequest]);

  // meta / 会话列表晚到时补填；手动选择以后不再覆盖。
  useEffect(() => {
    if (cwdTouched.current || cwd) return;
    const next = pickInitialCwd();
    if (next) applyCwd(next);
  }, [cwd, meta, sessions]);

  useEffect(() => {
    const field = textareaRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }, [message]);
  useEffect(() => {
    const urls = previewUrls.current;
    return () => { for (const url of urls) URL.revokeObjectURL(url); };
  }, []);
  useEffect(() => { setSelectedCommand(0); }, [message, agent]);
  useEffect(() => {
    if (!slashOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest(".new-command-panel,.new-slash,.new-form textarea")) {
        setSlashMenuOpen(false); setDismissed(true);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [slashOpen]);
  const addFiles = (files: File[]) => {
    if (!attachEnabled) return;
    setAttachments(previous => [...previous, ...files.map(file => {
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
      if (previewUrl) previewUrls.current.add(previewUrl);
      return { id: `new-att-${++attachmentSequence.current}`, source: "upload" as const,
        status: "ready" as const, name: file.name, file, previewUrl, size: file.size };
    })]);
  };
  const removeAttachment = (id: string) => {
    setAttachments(previous => previous.filter(item => {
      if (item.id !== id) return true;
      if (item.previewUrl) { URL.revokeObjectURL(item.previewUrl); previewUrls.current.delete(item.previewUrl); }
      return false;
    }));
  };
  const insertCommand = (name: string) => {
    setMessage(`${slashQuery !== null || !message ? "" : `${message}\n`}/${name} `); setSlashMenuOpen(false); setDismissed(true);
    textareaRef.current?.focus();
  };
  const refineCommand = refineCommandFor(agent);
  const appendRefine = () => {
    if (!refineCommand) return;
    setMessage(appendRefineCommand(textareaRef.current?.value ?? message, refineCommand)); setSlashMenuOpen(false); setDismissed(true);
    textareaRef.current?.focus();
  };
  const submit = async () => {
    if (!cwd.trim() || submitting.current) return;
    const text = message.trim();
    if (agent === "codex" && text.startsWith("/") && (!/^\/review(?:\s|$)/.test(text) || attachments.length > 0)) {
      setError(t("ui.SessionView.unknown_codex_command_or_command_with_attachments")); return;
    }
    submitting.current = true;
    setBusy(true);
    setError(null);
    const config = Object.fromEntries(Object.entries(configSel).filter(([, value]) => value));
    const input: CreateSessionInput = {
      snapshot: "skip",
      agent,
      cwd: normalizeDirectoryPath(cwd, windowsPaths),
      ...(Object.keys(config).length > 0 ? { config } : {}),
    };
    try {
      const session = createdSession.current ?? await store.create(input);
      createdSession.current = session;
      // 上传端点要求真实 sessionId；创建前只保留本地 File/预览，成功建会话后按原协议上传。
      const uploaded: NewAttachment[] = [];
      for (const attachment of attachments) {
        if (!attachment.file || attachment.path) { uploaded.push(attachment); continue; }
        setAttachments(previous => previous.map(item => item.id === attachment.id ? { ...item, status: "uploading" } : item));
        try {
          const prepared = await prepareImageForUpload({ blob: attachment.file, name: attachment.name, type: attachment.file.type });
          const saved = await uploadAttachment(session.id, prepared.blob, prepared.name);
          const ready = { ...attachment, ...saved, status: "ready" as const };
          uploaded.push(ready);
          setAttachments(previous => previous.map(item => item.id === attachment.id ? ready : item));
        } catch (error) {
          setAttachments(previous => previous.map(item => item.id === attachment.id ? { ...item, status: "error", error: String(error) } : item));
          throw error;
        }
      }
      const mentions = uploaded.flatMap(attachment => { const mention = attachmentMention(attachment); return mention ? [mention] : []; });
      if (text || mentions.length) {
        // 启动期间命令表可能尚未到达；复用本次选命令的表，服务端仍负责校验。
        if (!store.commands.get(session.id)?.length && commands.length) store.commands.set(session.id, commands);
        const sent = await store.sendComposerInput(session.id, text, mentions);
        if (!sent) store.restoreComposerSend(session.id, text, mentions);
        else if (/^\/([^\s]+)/.test(text)) noteCommandUsed(agent, /^\/([^\s]+)/.exec(text)![1]!);
      }
      try { localStorage.setItem(CWD_STORAGE_KEY, session.cwd); } catch { /* 仅本次不记忆 */ }
      store.navigateCreatedSession(session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return <form className={`new-form agent-${agent}`} onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div className="new-form-head">
      {children}
      <div className="new-agents" role="group" aria-label={t("ui.Sidebar.select_agent")}>
        {(["claude", "codex", "kimi"] as const).map(kind => <button key={kind} type="button"
          className={`new-agent agent-${kind}${agent === kind ? " selected" : ""}`} aria-pressed={agent === kind}
          disabled={busy || !!createdSession.current} onClick={() => { setAgent(kind); setConfigSel(newSessionConfig(kind)); setDismissed(false); setSlashMenuOpen(false); }}>
          <AgentIcon agent={kind} label={kind} /><span>{{ claude: "Claude", codex: "Codex", kimi: "Kimi" }[kind]}</span>
        </button>)}
      </div>
    </div>
    <div className="composer-box" onDragOver={event => {
      if (attachEnabled && event.dataTransfer.types.includes("Files")) event.preventDefault();
    }} onDrop={event => {
      if (!attachEnabled || !event.dataTransfer.files.length) return;
      event.preventDefault(); addFiles(Array.from(event.dataTransfer.files));
    }}>
      {attachments.length > 0 && <div className="attach-bar" aria-label={t("ui.SessionView.pending_attachments")}>
        {attachments.map(attachment => <div key={attachment.id} className={`attach-card${attachment.status === "error" ? " is-error" : ""}`}>
          {attachment.previewUrl ? <img className="attach-thumb" src={attachment.previewUrl} alt={attachment.name} />
            : <span className="attach-name mono" title={attachment.path ?? attachment.name}>{attachment.name}</span>}
          {attachment.status === "uploading" && <span className="attach-status">{t("ui.SessionView.uploading")}</span>}
          {attachment.status === "error" && <span className="attach-err" role="alert">{attachment.error}</span>}
          <button type="button" className="attach-remove" disabled={busy}
            aria-label={t("ui.SessionView.remove_attachment", { p0: attachment.name })} onClick={() => removeAttachment(attachment.id)}>×</button>
        </div>)}
        {attachments.length > 20 && <span className="mention-missing">{t("ui.SessionView.attachments_and_references_total_over_extra_items_sentence", { p0: 20 })}</span>}
      </div>}
      <div className="composer-input">
        <textarea ref={textareaRef} value={message} onChange={event => { setMessage(event.target.value); setDismissed(false); }} rows={3}
          aria-label={t("ui.Sidebar.first_message_optional")} placeholder={t("ui.Sidebar.first_message_optional")}
          disabled={busy} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
          onPaste={event => {
            if (!attachEnabled || !event.clipboardData.files.length) return;
            event.preventDefault(); addFiles(Array.from(event.clipboardData.files));
          }} onKeyDown={event => {
            if (event.nativeEvent.isComposing || composing || event.keyCode === 229) return;
            if (slashOpen) {
              if (event.key === "Escape") { event.preventDefault(); setDismissed(true); setSlashMenuOpen(false); return; }
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault(); setSelectedCommand(value => (value + (event.key === "ArrowDown" ? 1 : -1) + filteredCommands.length) % Math.max(1, filteredCommands.length)); return;
              }
              if ((event.key === "Enter" || event.key === "Tab") && activeCommand) { event.preventDefault(); insertCommand(activeCommand.name); return; }
            }
            if (event.key !== "Enter" || event.shiftKey) return;
            event.preventDefault(); void submit();
          }} />
        {!busy && refineCommand && message.trim() && <button type="button" className="refine-btn"
          title={t("ui.SessionView.append", { p0: refineCommand })} aria-label={t("ui.SessionView.append", { p0: refineCommand })}
          onPointerDown={event => event.preventDefault()} onClick={appendRefine}>R</button>}
      </div>
      <div className="cfg-bar">
        <button type="button" className="attach-btn" disabled={!attachEnabled}
          title={t("ui.SessionView.add_attachments_photos_screenshots_or_files_on")} aria-label={t("ui.SessionView.add_attachment")}
          onClick={() => fileInputRef.current?.click()}><PlusIcon /></button>
        <button type="button" className="attach-btn new-slash" disabled={busy || !commands.length}
          title={commands.length ? t("ui.SlashMenu.browse_slash_commands") : t("ui.NewSessionForm.no_commands")}
          aria-label={t("ui.SlashMenu.browse_slash_commands")} aria-haspopup="listbox" aria-expanded={slashOpen}
          onClick={() => { setSlashMenuOpen(value => !value); setDismissed(false); textareaRef.current?.focus(); }}>/</button>
        <NewConfigPills options={options} selected={configSel} onChange={setConfigSel} agent={agent} busy={busy || !!createdSession.current} />
        <button type="submit" className="send-btn new-submit" disabled={busy || !cwd.trim()}
          aria-label={t("ui.Sidebar.create_and_open")} title={t("ui.Sidebar.create_and_open")} aria-busy={busy}>
          {busy ? <span className="new-send-busy" role="status" aria-label={t("ui.Sidebar.creating")}>…</span> : <SendIcon />}
        </button>
        {slashOpen && <div className="cmd-panel new-command-panel" role="listbox" aria-label={t("ui.common.slash_commands")}>
          {!filteredCommands.length && <div className="cmd-empty">{t("ui.SessionView.no_matching_commands")}</div>}
          {filteredCommands.map((command, index) => <button key={command.name} type="button" role="option"
            aria-selected={command === activeCommand} className={`cmd-item${command === activeCommand ? " selected" : ""}`}
            onMouseEnter={() => setSelectedCommand(index)} onMouseDown={event => event.preventDefault()} onClick={() => insertCommand(command.name)}>
            <span className="cmd-name mono">/{command.name}</span><span className="cmd-desc">{command.description}</span>
          </button>)}
        </div>}
      </div>
    </div>
    <input ref={fileInputRef} type="file" multiple hidden onChange={event => {
      addFiles(Array.from(event.target.files ?? [])); event.target.value = "";
    }} />
    <div className="new-form-foot">
      <fieldset className="new-project-row" aria-label={t("ui.NewSessionForm.project")} disabled={busy || !!createdSession.current}>
        {/* 读不了的目录清空选择，免得带着旧目录误建会话 */}
        <DirectoryContents key={browse.key} initialPath={browse.from} includeFiles={false} collapsible allowWindowsPicker
          onSelectFile={() => {}} onPathChange={navigateCwd} onPathLost={() => navigateCwd("")} />
      </fieldset>
      {!cwd.trim() && <p className="new-hint">{t("ui.Sidebar.enter_a_working_directory_first")}</p>}
      {error && <p className="new-error" role="alert">{error}</p>}
    </div>
  </form>;
}

// 新建表单的配置胶囊：""=跟随配置（可选回，建会话时不传该字段）；其余同会话输入框底栏。
function NewConfigPills({
  options,
  selected,
  onChange,
  agent,
  busy,
}: {
  agent: AgentKind;
  busy: boolean;
  options: DriverConfigOption[];
  selected: Partial<Record<ConfigOptionId, string>>;
  onChange: Dispatch<SetStateAction<Partial<Record<ConfigOptionId, string>>>>;
}) {
  const meta = useStore(value => value.meta);
  const defaults = agent === "claude" ? meta?.claudeDefaults : undefined;
  const modelOptions = configOptionsForModel(options, selected.model || defaults?.model);
  const build = (option: DriverConfigOption) => {
    // default 为 null 的那条 values 项带后端给的「跟随 … 配置」标签，优先用它
    const followLabel = option.values.find((v) => v.value === null)?.label ?? t("ui.common.use_configuration");
    const group: MenuGroup = {
      id: option.id,
      disabled: busy,
      title: option.name,
      selected: selected[option.id] ?? "",
      slider: option.id === "effort",
      items: [
        { value: "", label: followLabel },
        ...option.values
          .filter((v): v is { value: string; label: string } => v.value !== null)
          .map((v) => ({ value: v.value, label: v.label })),
      ],
      onSelect: (value) => onChange((prev) => {
        if (option.id !== "model") return { ...prev, [option.id]: value };
        const patch = modelConfigPatch(options, prev, value || null);
        return { ...prev, model: value, ...(patch.effort === null ? { effort: "" } : {}) };
      }),
    };
    const effective = option.id === "model" || option.id === "effort" ? defaults?.[option.id] : undefined;
    return { group, text: pillText(option, selected[option.id], effective) };
  };
  const byId = (id: ConfigOptionId) => modelOptions.find((o) => o.id === id);
  const main = [byId("model"), byId("effort")].filter((o): o is DriverConfigOption => Boolean(o)).map(build);
  const perm = byId("permissionMode");
  return (
    <ConfigPills
      main={main}
      perm={perm ? build(perm) : null}
      permMode={selected.permissionMode || perm?.default || ""}
      placement="down"
    />
  );
}
