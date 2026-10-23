import { t } from "../i18n";
import { Fragment, type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CommandInfo, DriverConfigOption, Mention, SessionRecord } from "../types";
import { sessionTitle, truncateDisplayWidth } from "../format";
import { compactCwd, awayFromLatest, syncStreamViewport, showComposerInterrupt, appendRefineCommand, refineCommandFor } from "../session-ui";
import { createRenderItemsBuilder } from "../render-items";
import { filterCommands, noteCommandUsed, parseSideCommand, readRecentCommands, recentInTable, withSideCommands } from "../commands";
import { extractMentionTokens, mentionQueryAt, mentionTokenEnd } from "../mentions";
import { configOptionsForModel, modelConfigPatch, needsRestartNote, effectiveFor, modelShortName, pillText, EFFECTIVE_SOURCE_LABELS, ALIAS_NOTE, RESTART_NOTE } from "../config-view";
import { fetchFiles, uploadAttachment, fetchCodexSkills, runCodexCommand, type CodexSkillInfo } from "../api";
import { filterSkills, insertSkill, skillQueryAt } from "../codex-skills";
import { CodexCommandPanel, type CodexCommandResult } from "./CodexCommandPanel";
import { attachmentMention, localImageMimeType, prepareImageForUpload, type Attachment } from "../attachments";
import { MAX_MENTIONS, store, type Store } from "../store";
import { shallowEqual, useStore } from "../useStore";
import { GateBlock, QuestionBlock, RawLine, ReadOnlyToolGroup, SystemLine, TextBlockView, ThoughtBlockView, ToolCard, UserBlockView } from "./StreamItems";
import { ExternalHistoryView } from "./HistoryTimeline";
import { ResumedHistory } from "./ResumedHistory";
import { ClockIcon, ConfigPills, PlusIcon, SendIcon, StopIcon, type MenuGroup, type MenuItem } from "./ConfigMenu";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { insertFileMention, planFileMention } from "./FilePanel";
import { InfoDialog, SlashMenu } from "./SlashMenu";
import { SideQuestionDialog } from "./ClaudeMenuPanels";
import { AgentIcon, VSCodeIcon } from "./AgentIcon";
import { SessionDispatchBadge, SessionDispatchLink, useSessionDispatches } from "./SessionDispatchLink";
import { PanelActions, PanelMenuItems } from "./PanelActions";
import { PageIcon } from "./Sidebar";
import { shortSessionTitle } from "./SessionTitle";
import { MarkdownCommitContext } from "./MarkdownMessage";
import { ContextUsage } from "./ContextUsage";

const selectMeta = (value: Store) => value.meta;
const selectWsState = (value: Store) => value.wsState;
const selectFocusView = (value: Store) => value.focusView;
const selectNow = (value: Store) => value.now;

/** 触屏设备（手机、平板）：软键盘的回车只换行，发送靠按钮或 Ctrl/⌘+Enter。 */
const TOUCH = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

/** 手机顶栏（参照 Claude App）：返回 · 标题 · 「⋯」。mobileTail 是「⋯」左侧的闸门计数；
 *  usage 是收进「⋯」的 AI 用量入口，两者由 App 提供。 */
export function SessionView({ session, mobileTail, usage }: { session: SessionRecord; mobileTail?: ReactNode; usage?: UsageEntry }) {
  const running = session.status === "running" || session.status === "starting";
  const dead = session.status === "dead";
  const selectData = useCallback((value: Store) => value.data.get(session.id), [session.id]);
  const data = useStore(selectData);
  const snapshotError = useStore(useCallback((value: Store) => value.snapshotErrors.get(session.id), [session.id]));
  const wsState = useStore(selectWsState);
  // 三家均按原生会话身份查询派单；后台任务计数仍由 Claude 原生事件提供。
  const backgroundCount = session.agent === "claude" ? session.backgroundTasks?.length ?? 0 : 0;
  const dispatchRuns = useSessionDispatches(session.nativeSessionId ?? session.id, backgroundCount, session.agent);
  const renderBuilder = useMemo(() => createRenderItemsBuilder(session.agent), [session.id, session.agent]);
  const items = useMemo(
    () => renderBuilder.update(data?.events ?? [], data?.dropped),
    // resync 可以用相同 seq 原子替换事件窗口，所以 events 引用也是必要失效键。
    [data?.seq, data?.dropped, data?.events, renderBuilder],
  );

  const title = shortSessionTitle(sessionTitle(session, renderBuilder.firstUser ? [renderBuilder.firstUser] : []));

  const focusView = useStore(selectFocusView);
  const prefixVersion = renderBuilder.prefixVersion;
  const shown = useMemo(() => renderBuilder.display(focusView, session.cwd, data?.toolFrames),
    [renderBuilder, data, focusView, session.cwd]);

  const streamRef = useRef<HTMLDivElement>(null);
  const earlierRef = useRef<HTMLDivElement>(null);
  const readingAnchor = useRef<{ element?: HTMLElement; top: number; height: number; scrollTop: number } | null>(null);
  const gateRefs = useRef(new Map<string, HTMLElement>());
  const [hiddenPending, setHiddenPending] = useState(0);
  const [showLatest, setShowLatest] = useState(false);

  // dead 会话的未决闸门渲染为「已失效」中性态，不计入待处理数。
  const pendingGateIds = useMemo(
    () =>
      dead
        ? []
        : [...(data?.pendingGates.entries() ?? [])]
            .sort((a, b) => a[1] - b[1])
            .map(([requestId]) => requestId),
    [data?.seq, data?.pendingGates, dead],
  );

  // 未决闸门滚出视口时，底部贴暖色细条提示。
  const updateHiddenPending = useCallback(() => {
    const container = streamRef.current;
    if (!container) return;
    const box = container.getBoundingClientRect();
    let hidden = 0;
    for (const requestId of pendingGateIds) {
      const el = gateRefs.current.get(requestId);
      // 全量 pending 集合里存在、当前 2000 条窗口却没有 ref，也属于不可见闸门。
      if (!el) {
        hidden++;
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.bottom < box.top || rect.top > box.bottom) hidden++;
    }
    setHiddenPending(hidden);
  }, [pendingGateIds]);

  useEffect(() => {
    updateHiddenPending();
  }, [updateHiddenPending, items.length]);

  // 贴底跟随：是否贴底按用户最后一次滚动时的位置记，初始为贴底。
  // 不能在更新后再量——进会话、刷新、重连补齐时整批事件一次撑高，更新后量永远不在底部。
  const stickToBottom = useRef(true);
  const hiddenPendingUpdater = useRef(updateHiddenPending);
  hiddenPendingUpdater.current = updateHiddenPending;
  // Stable context value: streaming deltas must not invalidate every old message.
  const onMarkdownCommit = useCallback(() => {
    const container = streamRef.current;
    if (!container || readingAnchor.current) return;
    setShowLatest(syncStreamViewport(container, stickToBottom.current));
    hiddenPendingUpdater.current();
  }, []);
  const loadEarlier = useCallback(() => {
    void store.loadOlder(session.id, () => {
      const container = streamRef.current;
      if (!container) return;
      const box = container.getBoundingClientRect();
      const element = [...container.children].find((child) => child instanceof HTMLElement
        && child !== earlierRef.current && child.getBoundingClientRect().bottom > box.top) as HTMLElement | undefined;
      readingAnchor.current = { element, top: element?.getBoundingClientRect().top ?? 0, height: container.scrollHeight, scrollTop: container.scrollTop };
      stickToBottom.current = false;
    });
  }, [session.id]);
  const onStreamScroll = useCallback(() => {
    const container = streamRef.current;
    if (container) {
      const away = awayFromLatest(container.scrollHeight, container.scrollTop, container.clientHeight);
      stickToBottom.current = !away;
      setShowLatest(away);
    }
    updateHiddenPending();
  }, [updateHiddenPending]);
  useLayoutEffect(() => {
    const container = streamRef.current;
    const anchor = readingAnchor.current;
    if (container && anchor) {
      container.scrollTop = anchor.element?.isConnected
        ? anchor.scrollTop + anchor.element.getBoundingClientRect().top - anchor.top
        : anchor.scrollTop + container.scrollHeight - anchor.height;
      readingAnchor.current = null;
    } else if (container && stickToBottom.current) container.scrollTop = container.scrollHeight;
    if (container) setShowLatest(awayFromLatest(container.scrollHeight, container.scrollTop, container.clientHeight));
  }, [items, data?.seq, data?.dropped, data?.events, data?.prependVersion, data?.toolFrames]);

  useEffect(() => {
    const container = streamRef.current;
    const sentinel = earlierRef.current;
    if (!container || !sentinel || !data?.hasMore || data.loadingOlder || data.olderError) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) loadEarlier();
    }, { root: container, rootMargin: "160px 0px 0px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [session.id, data?.hasMore, data?.firstSeq, data?.loadingOlder, data?.olderError, loadEarlier]);

  const scrollToFirstPending = () => {
    const firstRequestId = pendingGateIds[0];
    if (!firstRequestId) return;
    const target = gateRefs.current.get(firstRequestId);
    if (target) {
      target.scrollIntoView({ block: "center" });
      return;
    }
    void store.recoverMissingPendingGate(session.id);
  };

  const renderItem = (item: (typeof shown)[number], index: number) => {
    const isLast = index === shown.length - 1;
    const next = shown[index + 1];
    if (item.kind === "tool-group") {
      const continues = (next?.kind === "text" || next?.kind === "thought" || next?.kind === "tool" || next?.kind === "tool-group") && next.turn === item.turn;
      return <ReadOnlyToolGroup key={item.key} item={item} agent={session.agent} cwd={session.cwd} continues={continues} />;
    }
    if (item.kind === "text" || item.kind === "thought" || item.kind === "tool") {
      const continues = (next?.kind === "text" || next?.kind === "thought" || next?.kind === "tool" || next?.kind === "tool-group") && next.turn === item.turn;
      const dot = item.kind === "tool" ? ` timeline-${item.status}` : "";
      const view = item.kind === "text"
        ? <TextBlockView item={item} streaming={isLast && running} cwd={session.cwd} sessionId={session.id} />
        : item.kind === "thought" ? <ThoughtBlockView item={item} /> : <ToolCard item={item} agent={session.agent} cwd={session.cwd} sessionId={session.id} />;
      return <div key={item.key} className={`timeline-item${continues ? " timeline-continues" : ""}${dot}`}>{view}</div>;
    }
    switch (item.kind) {
      case "user":
        return <UserBlockView key={item.key} item={item} />;
      case "external-history":
        return <ExternalHistoryView key={item.key} item={item} agent={session.agent} cwd={session.cwd} sessionId={session.id} />;
      case "gate": {
        // AskUserQuestion 渲染为提问选择卡片；与普通闸门共用 pendingGates/贴条机制
        const Block = item.questions?.length ? QuestionBlock : GateBlock;
        return (
          <Block
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
      }
      case "system":
        return <SystemLine key={item.key} item={item} />;
      case "raw":
        return <RawLine key={item.key} item={item} />;
      default:
        return null;
    }
  };
  // Keep one keyed children array: moving rows between prefix/tail arrays would
  // remount tools and gates when new blocks arrive, losing their local state.
  const rowCache = useRef<{ deps: unknown[]; rows: ReactNode[]; length: number } | null>(null);
  const rows = useMemo(() => {
    const deps = [items, prefixVersion, focusView, session.id, session.agent, session.cwd, dead, running];
    const cached = rowCache.current;
    if (cached && deps.every((value, i) => value === cached.deps[i])) {
      for (const i of renderBuilder.changedDisplayIndices) cached.rows[i] = renderItem(shown[i]!, i);
      for (let i = Math.max(0, cached.length - 1); i < shown.length; i++) cached.rows[i] = renderItem(shown[i]!, i);
      cached.length = shown.length;
      return cached.rows;
    }
    const rows = shown.map(renderItem);
    rowCache.current = { deps, rows, length: shown.length };
    return rows;
  }, [items, data, prefixVersion, focusView, session.id, session.agent, session.cwd, dead, running]);

  return (
    <div className={`session agent-${session.agent}`}>
      <header className="session-head">
        <button type="button" className="btn mobile-round mobile-back" aria-label={t("ui.SessionView.back_to_session_list")} title={t("ui.SessionView.session_list")} onClick={() => store.backFromSession()}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <div className="session-head-main">
          <AgentIcon agent={session.agent} label={session.agent} />
          <span className="session-title" title={title}>{title}</span>
          <span className="session-model mono"><ConfigSummary session={session} /></span>
          <span className="session-cwd mono" title={session.cwd}>{compactCwd(session.cwd)}</span>
        </div>
        <div className="mobile-title">
          <span className="mobile-title-text">{title}</span>
        </div>
        <div className="session-head-actions">
          <SessionDispatchLink runs={dispatchRuns} backgroundCount={backgroundCount} desktop />
          <div className="session-panel-controls">
            <PanelActions dispatchRuns={dispatchRuns} />
            {mobileTail && <div className="mobile-tail">{mobileTail}</div>}
            <SessionDispatchBadge runs={dispatchRuns} backgroundCount={backgroundCount} />
            <SessionMoreMenu session={session} usage={usage} />
          </div>
          {wsState !== "open" && <span className="ws-note" role="status">{wsState === "connecting" ? t("ui.SessionView.reconnecting") : t("ui.SessionView.disconnected")}</span>}
        </div>
      </header>

      <SessionDispatchLink runs={dispatchRuns} backgroundCount={backgroundCount} />

      {session.riskyMode && (
        <div className="risky-banner" role="alert">{t("ui.SessionView.tool_approvals_follow_the_permission_mode_selected")}</div>
      )}

      <div className="stream-region">
      <div className="stream" ref={streamRef} onScroll={onStreamScroll} style={{ overflowAnchor: "none" }}>
        {/* 续接会话：历史消息区在实时事件流上方，向上翻即可见（不默认折叠） */}
        {session.resumedFrom && <ResumedHistory session={session} streamRef={streamRef} />}
        {data?.hasMore && (
          <div className="earlier-messages" ref={earlierRef} role="status">
            {data.olderError
              ? <button type="button" onClick={loadEarlier} title={data.olderError}>{t("ui.SessionView.failed_to_load_earlier_messages_click_to")}</button>
              : t("ui.SessionView.loading_earlier_messages")}
          </div>
        )}
        {snapshotError && <p className="system-line" role="alert">{snapshotError}{" "}
          <button type="button" className="btn" onClick={() => void store.resync(session.id)}>{t("ui.common.retry")}</button>
        </p>}
        {!data && !snapshotError && <p className="system-line">{t("ui.SessionView.loading_session")}</p>}
        {data && data.dropped > 0 && (
          <p className="system-line">{t("ui.SessionView.earlier_events_omitted_due_to_the_memory_sentence", { p0: (data.dropped) })}</p>
        )}
        <MarkdownCommitContext value={onMarkdownCommit}>{rows}</MarkdownCommitContext>
      </div>

      {showLatest && <button type="button" className="back-to-latest" onClick={() => {
        const container = streamRef.current;
        if (!container) return;
        stickToBottom.current = true;
        container.scrollTop = container.scrollHeight;
        setShowLatest(false);
        updateHiddenPending();
      }}>{t("ui.SessionView.back_to_latest")}</button>}
      </div>

      {pendingGateIds.length > 0 && hiddenPending > 0 && (
        <button type="button" className="pending-bar" onClick={scrollToFirstPending}>{t("ui.SessionView.approvals_pending_sentence", { p0: (pendingGateIds.length) })}</button>
      )}

      <Composer session={session} dead={dead} errored={session.status === "error"} />
    </div>
  );
}

// 「VSCode 继续」：释放 worker、复制续接命令，桌面浏览器再打开 VSCode 协议链接。
// 三家都显示；菜单内直接说明不可用原因，进度与结果留在标题栏。
type UsageEntry = { icon: string; open: () => void };

function SessionMoreMenu({ session, usage }: { session: SessionRecord; usage?: UsageEntry }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  const menuId = useId();
  const closeMenu = useCallback(() => setOpen(false), []);

  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  useEffect(() => {
    if (!open) {
      if (wasOpen.current) triggerRef.current?.focus();
      wasOpen.current = false;
      return;
    }
    wasOpen.current = true;
    // 手机专用项在桌面 display:none，跳过不可见按钮
    const firstVisible = [...menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []].find((button) => button.offsetParent);
    (firstVisible ?? menuRef.current)?.focus();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) closeMenu();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, closeMenu]);

  const showNotice = (text: string, error: boolean) => {
    clearTimeout(noticeTimer.current);
    setNotice({ text, error });
    noticeTimer.current = setTimeout(() => setNotice(null), 6000);
  };

  const disabledReason = busy
    ? t("ui.SessionView.releasing_worker_please_wait")
    : session.released
      ? t("ui.SessionView.worker_released_the_next_message_will_resume")
      : !session.nativeSessionId
        ? t("ui.SessionView.no_native_session_id_before_the_first")
        : session.status !== "idle"
          ? t("ui.SessionView.the_session_must_be_idle_to_release")
          : null;
  const canRelease = disabledReason === null;
  const title = disabledReason ?? t("ui.SessionView.continue_in_vs_code_release_the_worker");

  const onClick = async () => {
    if (!canRelease) return;
    closeMenu();
    setBusy(true);
    try {
      const { resumeCommand: command, vscodeUri } = await store.release(session.id);
      let copied = false;
      try {
        await navigator.clipboard.writeText(command);
        copied = true;
      } catch {
        // 剪贴板不可用（权限/非安全上下文）：弹窗让用户手动复制
        window.prompt(t("ui.SessionView.released_copy_the_resume_command_manually"), command);
      }
      const openVSCode = Boolean(vscodeUri) && !window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;
      showNotice(copied
        ? openVSCode ? t("ui.SessionView.released_command_copied_opening_vs_code") : t("ui.SessionView.released_command_copied")
        : openVSCode ? t("ui.SessionView.released_opening_vs_code_copy_the_command") : t("ui.SessionView.released_copy_the_command_manually"), false);
      if (openVSCode) window.location.href = vscodeUri!;
    } catch (error) {
      showNotice(error instanceof Error ? error.message : String(error), true);
    } finally {
      setBusy(false);
    }
  };

  const copyId = async () => {
    const id = session.nativeSessionId;
    if (!id) return;
    closeMenu();
    try {
      await navigator.clipboard.writeText(id);
      showNotice(t("ui.SessionView.session_id_copied"), false);
    } catch {
      window.prompt(t("ui.SessionView.copy_the_session_id_manually"), id);
    }
  };

  const feedback = busy ? { text: t("ui.SessionView.releasing"), error: false } : notice;

  return (
    <>
      {feedback && (
        <span className={`release-note${feedback.error ? " release-note-error" : ""}`} role={feedback.error ? "alert" : "status"}>
          {feedback.text}
        </span>
      )}
      <span className="session-more" ref={rootRef}>
        <button ref={triggerRef} type="button" className="btn chrome-icon-btn session-more-trigger" aria-label={t("ui.common.more")} title={t("ui.common.more")} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
          onClick={() => open ? closeMenu() : setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
          }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
        </button>
        <div id={menuId} className="session-more-menu" role="menu" aria-label={t("ui.SessionView.more_session_actions")} ref={menuRef} tabIndex={-1} hidden={!open} onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            [...menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []].find((button) => button.offsetParent)?.focus();
          }
        }}>
          <PanelMenuItems onDone={closeMenu} />
          {usage && <button type="button" className="btn session-more-item session-more-mobile" role="menuitem" onClick={() => { closeMenu(); usage.open(); }}>
            <PageIcon icon={usage.icon} />{t("ui.SessionView.ai_usage")}</button>}
          <hr className="session-more-mobile session-more-sep" />
          <button type="button" className="btn session-more-item" role="menuitem" disabled={!session.nativeSessionId} aria-disabled={!session.nativeSessionId}
            title={session.nativeSessionId ? t("ui.SessionView.copy_native_session_id", { p0: (session.nativeSessionId) }) : t("ui.SessionView.no_native_session_id_until_the_first")} onClick={() => void copyId()}>
            <CopyIcon />{t("ui.SessionView.copy_session_id")}</button>
          <button type="button" className="btn session-more-item" role="menuitem" aria-label={t("ui.SessionView.continue_in_vs_code")} disabled={!canRelease} aria-disabled={!canRelease}
            aria-describedby={disabledReason ? `${menuId}-reason` : undefined} title={title} onClick={() => void onClick()}>
            <VSCodeIcon />{t("ui.SessionView.continue_in_vs_code")}</button>
          {disabledReason && <p id={`${menuId}-reason`} className="session-more-reason">{disabledReason}</p>}
        </div>
      </span>
    </>
  );
}

// 会话头单行模型/推理摘要（如「opus-5.5 · high」，未覆盖项显示实际生效值或「跟随配置」）；
// 可交互控件只在输入框上方一处，会话头不再放可点的，避免两处不一致。
function ConfigSummary({ session }: { session: SessionRecord }) {
  const meta = useStore(selectMeta);
  const options = meta?.drivers[session.agent]?.options ?? [];
  if (options.length === 0) return null;
  const parts = options.filter((option) => option.id === "model" || option.id === "effort").map((option) => {
    const current = session.config?.[option.id];
    if (current) return option.id === "model" ? modelShortName(current) : current;
    // claude 跟随配置时并入实际生效值（首轮前是设置别名，init 后是精确 id；精度差异见控件旁标注）
    const effective = effectiveFor(session, option.id);
    if (effective) return option.id === "model" ? modelShortName(effective.value) : effective.value;
    return t("ui.common.use_configuration");
  });
  return <span title={t("ui.SessionView.current_configuration_summary_editable_options_are_above")}>{parts.join(" · ")}</span>;
}

// 模型/推理强度/审批模式控件：选项全部来自 /api/meta 的 options，
// 前端不硬编码任何值；活改走 WS set_config，等 config_updated 广播回来才更新显示。
// 渲染位置在输入框底栏：模型+推理强度合成一个胶囊（「Opus 5.5 High」），审批模式单独一个靠右；
// 过渡文案 / 提示 / 错误由 ConfigStatus 在输入框上方单独一行显示。
function useConfigState(sessionId: string) {
  const selectConfigState = useCallback(
    (value: Store) => [
      [...(value.configPending.get(sessionId) ?? [])].sort().join(","),
      value.configErrors.get(sessionId),
      value.configHints.get(sessionId),
      value.configSwitching.get(sessionId),
    ] as const,
    [sessionId],
  );
  const [, error, hint, switching] = useStore(selectConfigState, shallowEqual);
  return { error, hint, switching };
}

function ConfigControls({ session }: { session: SessionRecord }) {
  const meta = useStore(selectMeta);
  const { switching } = useConfigState(session.id);
  const schemaOptions = meta?.drivers[session.agent]?.options ?? [];
  const options = configOptionsForModel(schemaOptions, session.config?.model);
  const pending = store.configPending.get(session.id);
  // 重启切换进行中（claude model/effort）：全部控件禁用，就地显示后端给的过渡文案
  // 已释放会话改配置时后端会先按原生 id 续接再改（ensureWorker）
  const live = (Boolean(session.processId) || Boolean(session.released)) && session.status !== "dead";
  if (options.length === 0) return null;

  const build = (option: DriverConfigOption) => {
    const current = session.config?.[option.id];
    const currentKey = current ?? "";
    // default 为 null 的那条 values 项带后端给的「跟随 … 配置」标签，优先用它。
    const followLabel =
      option.values.find((v) => v.value === null)?.label ?? t("ui.common.use_configuration");
    const known = new Set(option.values.map((v) => v.value));
    const disabled =
      !option.mutable || !live || Boolean(switching) || Boolean(pending?.has(option.id));
    // claude 跟随配置时，把实际生效值与来源一并显示（codex/kimi 恒 null，不追加）。
    // 首轮前只能是设置里的别名（source=settings），首轮 init 后升级为精确 id（source=init），
    // 精度差异是真实的，用极小字标来源，不伪装成一致。
    const effective = currentKey === "" ? effectiveFor(session, option.id) : null;
    const aliasNote =
      session.agent === "claude" && option.id === "model" ? ALIAS_NOTE : undefined;
    const reason = switching
      ? undefined
      : !option.mutable
        ? t("ui.SessionView.start_a_new_session_to_change_this")
        : !live
          ? t("ui.SessionView.this_session_has_ended_and_cannot_be")
          : undefined;
    const items: MenuItem[] = [];
    if (currentKey === "") {
      // 「跟随配置」只作展示（不能用来撤销会话级覆盖，后端也只接受字符串值）
      items.push({
        value: "",
        inert: true,
        label: (
          <>
            {/* 跟随配置时把实际生效值并进同一处显示（别名/精确 id 的精度差异由旁边的来源小字标注） */}
            {effective ? `${followLabel}（${effective.value}）` : followLabel}
            {effective && (
              <span
                className="config-effective-src"
                title={
                  effective.source === "init"
                    ? t("ui.SessionView.exact_value_reported_by_the_claude_runtime")
                    : effective.source === "settings" && option.id === "model"
                      ? ALIAS_NOTE
                      : t("ui.SessionView.from_merged_claude_settings")
                }
              >
                {EFFECTIVE_SOURCE_LABELS[effective.source]}
              </span>
            )}
          </>
        ),
      });
    }
    if (currentKey !== "" && !known.has(currentKey)) items.push({ value: currentKey, label: currentKey });
    for (const v of option.values) {
      if (v.value !== null) items.push({ value: v.value, label: v.label });
    }
    const group: MenuGroup = {
      id: option.id,
      title: option.name,
      items,
      selected: currentKey,
      disabled,
      slider: option.id === "effort",
      effective: effective?.value,
      onSelect: (value) => {
        if (value) store.setConfig(session.id, option.id === "model"
          ? modelConfigPatch(schemaOptions, session.config, value) : { [option.id]: value });
      },
      note: (
        <>
          {/* 禁用原因直接写进菜单，不 hover 也能看到 */}
          {reason && <div>{reason}</div>}
          {/* mutableVia:"restart" 的代价如实标注：事实说明，不是警告 */}
          {needsRestartNote(option) && <div>{RESTART_NOTE}</div>}
          {effective && aliasNote && effective.source === "settings" && <div>{aliasNote}</div>}
        </>
      ),
    };
    return { group, text: pillText(option, current ?? undefined, effective?.value), fullText: current || effective?.value || option.default || t("ui.common.use_configuration"), reason };
  };

  const byId = (id: string) => options.find((o) => o.id === id);
  const main = [byId("model"), byId("effort")].filter((o): o is DriverConfigOption => Boolean(o)).map(build);
  const perm = byId("permissionMode");
  return (
    <ConfigPills
      main={main}
      perm={perm ? build(perm) : null}
      permMode={session.config?.permissionMode ?? perm?.default ?? ""}
      cwd={session.cwd}
      beforePerm={<ContextUsage session={session} />}
    />
  );
}

// claude prompt 缓存剩余时间（同 VSCode 扩展输入框的「🕐 56m」）：过期后下一条消息要按全价重建缓存。
// 回合进行中缓存随每次请求续期，不显示；判定不了 TTL（还没跑过回合）显示「—」，不猜。
function CacheTimer({ session, className = "" }: { session: SessionRecord; className?: string }) {
  const selectExpiry = useCallback(
    (value: Store) => value.promptCacheExpiry(session.id),
    [session.id],
  );
  const expiry = useStore(selectExpiry);
  const now = useStore(selectNow);
  if (session.status === "running" || session.status === "starting") return null;
  if (expiry === null) {
    return (
      <span className={`cache-timer expired ${className}`} title={t("ui.SessionView.prompt_cache_time_remaining_this_session_has")}>
        <ClockIcon />—
      </span>
    );
  }
  const left = expiry - now;
  const minutes = Math.ceil(left / 60_000);
  return (
    <span
      className={`cache-timer${left <= 0 ? " expired" : ""} ${className}`}
      title={t("ui.SessionView.prompt_cache_since_the_last_turn_ended", { p0: (left > 0 ? t("ui.SessionView.about_minutes_left_detail", { p0: (minutes) }) : t("ui.SessionView.expired_detail")) })}
    >
      <ClockIcon />
      {left > 0 ? `${minutes}m` : t("ui.SessionView.expired")}
    </span>
  );
}

function RemoteControlPill({ session }: { session: SessionRecord }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLSpanElement>(null);
  const state = session.remoteControl ?? { status: "disconnected" as const };
  const busy = state.status === "connecting" || state.status === "reconnecting" || state.status === "disconnecting";
  const connected = state.status === "connected";
  const label = state.status === "connecting" ? t("ui.SessionView.connecting") : state.status === "reconnecting" ? t("ui.SessionView.reconnecting_2")
    : state.status === "disconnecting" ? t("ui.SessionView.closing") : state.status === "error" ? t("ui.SessionView.connection_failed") : "Remote Control";
  const title = connected ? t("ui.SessionView.remote_control_connected", { p0: (state.sessionUrl ?? t("ui.SessionView.session_link_unavailable_detail")) })
    : state.status === "error" ? t("ui.SessionView.remote_control_failed", { p0: (state.reason ?? t("ui.SessionView.unknown_reason_detail")) })
    : busy ? `Remote Control ${label}${state.reason ? `：${state.reason}` : ""}`
    : t("ui.SessionView.remote_control_is_off");
  const link = connected ? state.sessionUrl : undefined;

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
      <button type="button" className={`rc-pill rc-${state.status}`} title={title}
        aria-label={`Remote Control：${label}`} aria-haspopup="menu" aria-expanded={open}
        disabled={session.status === "dead" || (!session.processId && !session.released)}
        onClick={() => setOpen((v) => !v)}>
        {/* 手机宽度缩成 RC（styles.css 的 720px 断点） */}
        {label === "Remote Control" ? <><span className="rc-long">Remote Control</span><span className="rc-short">RC</span></> : label}
      </button>
      {open && (
        <div className="attach-menu rc-menu" role="menu" aria-label="Remote Control">
          <button type="button" className="attach-item" role="menuitem" disabled={busy}
            onClick={() => { setOpen(false); store.setRemoteControl(session.id, !connected); }}>
            {connected ? t("ui.SessionView.turn_off_remote_control") : state.status === "error" ? t("ui.SessionView.retry_enabling_remote_control") : t("ui.SessionView.turn_on_remote_control")}
          </button>
          {link ? (
            <a className="attach-item" role="menuitem" href={link} target="_blank" rel="noopener noreferrer"
              title={link} onClick={() => setOpen(false)}>{t("ui.SessionView.open_this_session_on_claude_ai")}</a>
          ) : (
            <button type="button" className="attach-item" role="menuitem" disabled
              title={t("ui.SessionView.the_session_link_becomes_available_after_remote")}>{t("ui.SessionView.open_this_session_on_claude_ai")}</button>
          )}
        </div>
      )}
    </span>
  );
}

function ConfigStatus({ session }: { session: SessionRecord }) {
  const { error, hint, switching } = useConfigState(session.id);
  if (!error && !hint && !switching) return null;
  return (
    <div className="session-config">
      {switching && (
        <span className="config-hint" role="status">
          {switching}
        </span>
      )}
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

/** 被拒引用恢复为可再次手动发送的附件；已上传文件沿用原路径，不重新上传。 */
export function restoreComposerInput(currentText: string, attachments: Attachment[], restored: { text: string; mentions: Mention[]; version: number }): { text: string; attachments: Attachment[] } | null {
  if (currentText.trim() !== "") return null;
  const paths = new Set(attachments.map((attachment) => attachment.path));
  const added: Attachment[] = [];
  for (const [index, mention] of restored.mentions.entries()) {
    if (paths.has(mention.path)) continue;
    paths.add(mention.path);
    added.push({
      id: `restore-${restored.version}-${index}`, source: "local", status: "ready", path: mention.path,
      name: mention.name ?? mention.path.split(/[\\/]/).filter(Boolean).pop() ?? t("ui.SessionView.attachments"),
      ...(mention.type === "image" ? { mimeType: mention.mimeType } : {}),
    });
  }
  return { text: restored.text, attachments: [...attachments, ...added] };
}

export function Composer({ session, dead, errored }: { session: SessionRecord; dead: boolean; errored: boolean }) {
  const meta = useStore(selectMeta);
  const selectCommands = useCallback(
    (value: Store) => value.commands.get(session.id),
    [session.id],
  );
  const commands = useStore(selectCommands);
  const fileMentionRequest = useStore((value) => value.fileMentionRequest);
  // 发送被本地拦下的原因（有待决闸门 / 配置切换中）与服务端拒绝后的完整输入还回请求
  const sendNotice = useStore((value) => value.sendNotices.get(session.id));
  const sendTextRestore = useStore((value) => value.sendTextRestore);
  useStore((value) => value.mentionVersion);
  // 草稿随会话恢复：SessionView 按会话 id key 重挂载，useState 惰性初始值即该会话草稿
  const [text, setText] = useState(() => store.getDraft(session.id));
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState(0);
  // dead/error 会话的「新建会话并续接」提交态
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeError, setResumeError] = useState<string | null>(null);
  // Esc 关闭面板后，到下一次输入变化前不再自动弹出
  const [dismissed, setDismissed] = useState(false);
  // IME 组合输入期间：不触发检索、不弹/不更新面板、Enter 不当确认（很多输入法用 Enter 上屏组合串）
  const [composing, setComposing] = useState(false);
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [skills, setSkills] = useState<CodexSkillInfo[]>([]);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [codexResult, setCodexResult] = useState<CodexCommandResult | null>(null);
  // /btw、/side 侧问面板（question 为输入框带入的首问，可为空）
  const [sideQuestion, setSideQuestion] = useState<{ question: string } | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const codexBusy = useRef(false);
  const closeCodexResult = useCallback(() => setCodexResult(null), []);
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** 选中补全项后要落到的光标位置（setText 之后在 effect 里应用） */
  const pendingCursor = useRef<number | null>(null);
  const focusAfterInsert = useRef(false);
  /** @ 检索序号：晚到的旧响应丢弃 */
  const searchSeq = useRef(0);
  // 「+」附件：附件条状态、弹出菜单、「电脑上的文件」浏览器
  const [attachments, setAttachments] = useState<Attachment[]>(() => {
    // 其他会话中发生拒绝，回到本会话时文本已从草稿加载，引用也要一起加载。
    const restored = store.sendTextRestore;
    return restored?.sessionId === session.id && restored.text === store.getDraft(session.id)
      ? restoreComposerInput("", [], restored)!.attachments : [];
  });
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);
  const [fileBrowseOpen, setFileBrowseOpen] = useState(false);
  const attachMenuRef = useRef<HTMLSpanElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attachSeq = useRef(0);
  /** 图片卡片的 createObjectURL 预览：移除卡片/卸载组件时必须 revoke，防泄漏 */
  const previewUrls = useRef(new Set<string>());

  const caps = meta?.drivers[session.agent];
  const commandsSupported = caps?.commands === true;
  const mentionsSupported = caps?.mentions === true;
  /** 附件入口可用 = 会话活着且 driver 支持 mentions（与 @ 引用同一能力位） */
  const attachEnabled = !dead && mentionsSupported;
  // ready 附件 → 上行 mentions（uploading/error 不进发送帧）
  const readyMentions = attachments.flatMap((att) => {
    const mention = attachmentMention(att);
    return mention ? [mention] : [];
  });
  const table = useMemo(() => withSideCommands(session.agent, commands ?? []), [session.agent, commands]);
  const refineCommand = refineCommandFor(session.agent);
  const showRefine = !dead && Boolean(text.trim() && refineCommand);
  const appendRefine = () => {
    if (!refineCommand || dead) return;
    const next = appendRefineCommand(textareaRef.current?.value ?? text, refineCommand);
    setDismissed(true);
    setCursor(next.length);
    setText(next);
    // 即使防重复而文本不变，也要恢复焦点并移到末尾。
    textareaRef.current?.focus();
    textareaRef.current?.setSelectionRange(next.length, next.length);
    if (next !== text) {
      pendingCursor.current = next.length;
      focusAfterInsert.current = true;
    }
  };

  // 仅行首 / 触发（整段文本即「/query」形态）；行中间的 /（如路径）是普通字符。
  // 中文输入法的中文标点模式下「/」键打出「、」，行首同样触发；选中命令后整段换成「/命令」。
  const slashQuery = /^[\/、]([^\s]*)$/.exec(text)?.[1] ?? null;
  const slashOpen = commandsSupported && !dead && !composing && slashQuery !== null && !dismissed;
  // 最近使用（每 agent 独立记忆；localStorage 不可用时为空数组，静默降级）：
  // 面板打开期间读一次，空 query 置顶成「最近使用」段，有 query 时作排序加权。
  const recentNames = useMemo(
    () => (slashOpen ? readRecentCommands(session.agent) : []),
    [slashOpen, session.agent],
  );
  const filtered = slashOpen ? filterCommands(table, slashQuery ?? "", recentNames) : [];
  // 空 query 时结果前 recentCount 条是「最近使用」段（渲染分隔标签用）
  const recentCount = slashOpen && slashQuery === "" ? recentInTable(table, recentNames).length : 0;
  const sel = Math.min(selected, Math.max(filtered.length - 1, 0));
  const active = filtered[sel];
  const skillToken = session.agent === "codex" && !dead && !slashOpen && !composing ? skillQueryAt(text, cursor) : null;
  const skillOpen = skillToken !== null && !dismissed;
  const skillQuery = skillToken?.query ?? "";
  const filteredSkills = filterSkills(skills, skillQuery);
  const selSkill = Math.min(selected, Math.max(filteredSkills.length - 1, 0));
  const activeSkill = filteredSkills[selSkill];

  // @ 引用：光标处 token 以 @ 开头即触发（句中也可以，不同于 / 的整行锚定）；
  // IME 组合期间不触发；与 / 面板互斥（slashOpen 时不评估 @）。
  const mention =
    mentionsSupported && !dead && !slashOpen && !skillOpen && !composing
      ? mentionQueryAt(text, cursor)
      : null;
  const mentionOpen = mention !== null && !dismissed;
  const mentionQuery = mention?.query ?? null;
  const selM = Math.min(selected, Math.max(files.length - 1, 0));
  const activeFile = files[selM];

  // 已确认命令的参数提示：文本进入「/name 参数…」形态后显示该命令的 argHint
  const typedName = /^\/([^\s]+)\s/.exec(text)?.[1];
  const activeCmd = typedName ? table.find((c) => c.name === typedName) : undefined;
  // 发送时会走结构化 command 的形态（与 store.sendComposerInput 同一判定）：不解析 mentions
  const cmdMatch = commandsSupported ? /^\/([^\s]+)(?:\s+[\s\S]*)?$/.exec(text) : null;
  const willBeCommand = cmdMatch !== null && table.some((c) => c.name === cmdMatch[1]);

  // 待附加文件预览：当前文本会解析出的 @token（去重、保持出现顺序）；
  // 显示「最终生效路径」——尾部标点剥离后命中的，显示剥离后的那个，让用户看得见实际附加了什么。
  const tokens =
    mentionsSupported && !dead && !willBeCommand ? extractMentionTokens(text) : [];
  const attachable: string[] = [];
  const missing: string[] = [];
  let checking = 0;
  tokens.forEach((token, index) => {
    if (store.fileKnownSync(session.id, token) === true) {
      if (index < MAX_MENTIONS) attachable.push(token);
      return;
    }
    const resolved = store.mentionPathSync(session.id, token);
    if (typeof resolved === "string") {
      if (index < MAX_MENTIONS) attachable.push(resolved);
    } else if (resolved === null) {
      missing.push(token);
    } else {
      checking++;
    }
  });

  useEffect(() => setSelected(0), [slashQuery, mentionQuery, skillQuery]);

  useEffect(() => {
    if (!skillOpen) return;
    const controller = new AbortController();
    setSkillsLoading(true);
    setSkillError(null);
    fetchCodexSkills(session.id, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      setSkills(result.skills);
      if (result.errors.length) setSkillError(t("ui.SessionView.some_skills_could_not_be_read_see"));
    }).catch(error => {
      if (!controller.signal.aborted) { setSkills([]); setSkillError(error instanceof Error ? error.message : String(error)); }
    }).finally(() => { if (!controller.signal.aborted) setSkillsLoading(false); });
    return () => controller.abort();
  }, [skillOpen, session.id]);

  // @ 检索：250ms 防抖；新查询、关闭面板或卸载时中止旧请求。
  useEffect(() => {
    const seq = ++searchSeq.current;
    const controller = new AbortController();
    setFiles([]);
    setFilesError(null);
    setFilesLoading(mentionOpen);
    if (!mentionOpen) {
      return;
    }
    const timer = setTimeout(() => {
      fetchFiles(session.id, mentionQuery ?? "", undefined, controller.signal)
        .then((list) => {
          if (controller.signal.aborted || searchSeq.current !== seq) return; // 晚到的旧响应丢弃
          store.noteFiles(session.id, list);
          setFiles(list);
          setFilesLoading(false);
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || searchSeq.current !== seq) return;
          setFilesError(error instanceof Error ? error.message : String(error));
          setFilesLoading(false);
        });
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
    // store 是模块级单例，不进依赖
  }, [mentionOpen, mentionQuery, session.id]);

  // 输入即草稿：每会话独立（切走再切回文本仍在）；空文本清条目。
  // 发送成功 store 侧也会清（仅当草稿仍是本次发送内容），这里是输入路径的兜底。
  useEffect(() => {
    store.setDraft(session.id, text);
  }, [text, session.id]);

  // 预览条：对未确认的 token 解析最终生效路径（整 token 优先 → 尾部标点逐级剥离，
  // store 内缓存 + in-flight 去重）
  useEffect(() => {
    if (!mentionsSupported || dead || willBeCommand) return;
    for (const token of extractMentionTokens(text).slice(0, MAX_MENTIONS)) {
      if (store.fileKnownSync(session.id, token) === true) continue;
      if (store.mentionPathSync(session.id, token) === undefined) {
        void store.resolveMentionPath(session.id, token);
      }
    }
  }, [text, mentionsSupported, dead, willBeCommand, session.id]);

  // 选中项滚动进可视区（长列表必须可达）
  useEffect(() => {
    if (!slashOpen && !mentionOpen && !skillOpen) return;
    listRef.current?.querySelector(".cmd-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [slashOpen, mentionOpen, skillOpen, sel, selM, selSkill, active?.name, activeFile]);

  // 输入框随内容长高（参照 VSCode 扩展），上限由 CSS max-height 管，超过才出滚动条
  const fitTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, []);
  useLayoutEffect(fitTextarea, [text, fitTextarea]);
  // 宽度变了（手机缓存计时器出现/消失、转屏）换行数会变，也要重算；只看宽度，避免改高度又触发自己
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitTextarea();
    });
    observer.observe(el);
      return () => observer.disconnect();
  }, [fitTextarea]);

  // 补全插入后把光标落到插入路径之后
  useEffect(() => {
    if (pendingCursor.current !== null && textareaRef.current) {
      if (focusAfterInsert.current) textareaRef.current.focus();
      textareaRef.current.setSelectionRange(pendingCursor.current, pendingCursor.current);
      pendingCursor.current = null;
      focusAfterInsert.current = false;
    }
  }, [text]);

  // 消费一次性面板请求；cursor 即输入框失焦前保存的位置。
  useEffect(() => {
    if (!fileMentionRequest || fileMentionRequest.sessionId !== session.id || store.currentId !== session.id) return;
    if (!store.consumeFileMention(fileMentionRequest.version)) return;
    const plan = planFileMention(session, mentionsSupported, fileMentionRequest.path);
    if (dead || plan.path === null) return;
    const next = insertFileMention(text, cursor, plan.path);
    pendingCursor.current = next.cursor;
    focusAfterInsert.current = true;
    setText(next.text);
    setCursor(next.cursor);
    setDismissed(false);
  }, [fileMentionRequest, session.id, session.cwd, dead, mentionsSupported, text, cursor]);

  // 拒绝后只在空输入框还回文字与引用；保留间隙新增和仍在上传的附件。
  useEffect(() => {
    if (!sendTextRestore || sendTextRestore.sessionId !== session.id) return;
    const restored = store.consumeSendTextRestore(sendTextRestore.version);
    if (restored === null) return;
    const currentText = textareaRef.current?.value ?? text;
    const plan = restoreComposerInput(currentText, attachments, { ...restored, version: sendTextRestore.version });
    if (!plan) {
      // 输入可能已更新、草稿 effect 还没写入：以当前可见文字为准。
      store.setDraft(session.id, currentText);
      return;
    }
    setText(plan.text);
    setAttachments(plan.attachments);
  }, [sendTextRestore, session.id, text, attachments]);

  // 卸载时回收全部本地预览 URL
  useEffect(() => {
    const urls = previewUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, []);

  // 「+」菜单：Esc 或点外部关闭（与配置胶囊浮层同一纪律）
  useEffect(() => {
    if (!attachMenuOpen) return;
    const onMenuKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setAttachMenuOpen(false);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setAttachMenuOpen(false);
      }
    };
    document.addEventListener("keydown", onMenuKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onMenuKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [attachMenuOpen]);

  const updateAttachment = (id: string, patch: Partial<Attachment>) => {
    setAttachments((list) => list.map((att) => (att.id === id ? { ...att, ...patch } : att)));
  };

  const removeAttachment = (id: string) => {
    setAttachments((list) => {
      const target = list.find((att) => att.id === id);
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
        previewUrls.current.delete(target.previewUrl);
      }
      return list.filter((att) => att.id !== id);
    });
  };

  // 选中/粘贴/拖入的文件统一入口：先按需重编码图片，再上传；卡片从 uploading → ready/error
  const uploadFiles = (picked: File[]) => {
    for (const file of picked) {
      const id = `att-${++attachSeq.current}`;
      setAttachments((list) => [
        ...list,
        { id, source: "upload", name: file.name || t("ui.SessionView.attachments"), status: "uploading", size: file.size },
      ]);
      void (async () => {
        try {
          const prepared = await prepareImageForUpload({ blob: file, name: file.name || "image", type: file.type });
          if (prepared.type.startsWith("image/")) {
            const previewUrl = URL.createObjectURL(prepared.blob);
            previewUrls.current.add(previewUrl);
            updateAttachment(id, { previewUrl });
          }
          const saved = await uploadAttachment(session.id, prepared.blob, prepared.name);
          updateAttachment(id, {
            status: "ready",
            path: saved.path,
            mimeType: saved.mimeType,
            name: saved.name,
            size: saved.size,
          });
        } catch (error) {
          updateAttachment(id, {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }
  };

  // 「电脑上的文件」：不上传，直接按绝对路径引用（mimeType 按扩展名猜，非图片省略）
  const addLocalFile = (path: string, name: string) => {
    const mimeType = localImageMimeType(name);
    setAttachments((list) => [
      ...list,
      {
        id: `att-${++attachSeq.current}`,
        source: "local",
        name,
        status: "ready",
        path,
        ...(mimeType ? { mimeType } : {}),
      },
    ]);
  };

  const executeCodex = async (name: string, args?: string, submittedText?: string) => {
    if (codexBusy.current) return;
    codexBusy.current = true;
    setCodexResult({ name });
    try {
      const data = await runCodexCommand(session.id, name, args);
      setCodexResult(current => current ? { name, data } : null);
      if (name === "new" && data.session) {
        const next = data.session as SessionRecord;
        await store.resync(next.id);
        store.navigate(next.id);
      }
    } catch (error) {
      setCodexResult(current => current ? { name, error: error instanceof Error ? error.message : String(error) } : null);
      if (submittedText !== undefined) setText(current => current === "" ? submittedText : current);
    } finally { codexBusy.current = false; }
  };

  const confirmSkill = (skill: CodexSkillInfo) => {
    if (!skillToken) return;
    const next = insertSkill(text, skillToken, skill.name);
    pendingCursor.current = next.cursor;
    setText(next.text);
    setCursor(next.cursor);
    setDismissed(false);
  };

  const confirm = (cmd: CommandInfo, fillOnly: boolean) => {
    if (!fillOnly && session.agent === "claude" && cmd.name === "mcp") {
      noteCommandUsed(session.agent, cmd.name);
      setText(""); setDismissed(false); setMcpOpen(true);
      return;
    }
    if (!fillOnly && parseSideCommand(session.agent, `/${cmd.name}`) !== null) {
      // 侧问命令：补全面板里回车直接打开空面板（Tab 仍只填充，便于接着写问题）
      noteCommandUsed(session.agent, cmd.name);
      setText("");
      setDismissed(false);
      setSideQuestion({ question: "" });
      return;
    }
    if (!fillOnly && !cmd.argHint) {
      // 无参数命令：确认即直接发（结构化 command，不拼 text）；失败保留文本，错误条提示
      noteCommandUsed(session.agent, cmd.name);
      if (session.agent === "codex") {
        if (codexBusy.current) return;
        setText("");
        void executeCodex(cmd.name, undefined, text || `/${cmd.name}`);
      } else if (store.sendCommand(session.id, cmd.name, "")) setText("");
    } else {
      // 有参数（或 Tab 只填充）：填入「/name 」，光标留在末尾参数位等用户补完
      setText(`/${cmd.name} `);
    }
    setDismissed(false);
  };

  // 选中文件：把 @相对路径 插回光标处（整 token 替换），光标移到插入路径后并补一个空格
  const confirmMention = (path: string) => {
    if (!mention) return;
    const end = mentionTokenEnd(text, cursor);
    const inserted = `@${path} `;
    const nextCursor = mention.start + inserted.length;
    pendingCursor.current = nextCursor;
    setText(text.slice(0, mention.start) + inserted + text.slice(end));
    setCursor(nextCursor);
    setDismissed(false);
  };

  const send = () => {
    const trimmed = text.trim();
    if (dead) return;
    if (!trimmed && readyMentions.length === 0) return;
    if (session.agent === "claude" && trimmed === "/mcp") {
      noteCommandUsed(session.agent, "mcp");
      setText(""); setDismissed(false); setMcpOpen(true);
      return;
    }
    const side = parseSideCommand(session.agent, trimmed);
    if (side !== null) {
      // 侧问不进主对话：打开面板直接提问，附件条留在输入框
      noteCommandUsed(session.agent, /^\/(\S+)/.exec(trimmed)![1]!);
      setText("");
      setDismissed(false);
      setSideQuestion({ question: side });
      return;
    }
    if (session.agent === "codex" && trimmed.startsWith("/")) {
      if (!willBeCommand || !cmdMatch || readyMentions.length) {
        setCodexResult({ name: "status", error: t("ui.SessionView.unknown_codex_command_or_command_with_attachments") });
        return;
      }
      if (codexBusy.current) return;
      noteCommandUsed(session.agent, cmdMatch[1]!);
      setText("");
      setDismissed(false);
      void executeCodex(cmdMatch[1]!, /^\/\S+\s+([\s\S]*)$/.exec(trimmed)?.[1], text);
      return;
    }
    // 「/命令 参数」整行形态经 sendComposerInput 走结构化 command，同样记入最近使用；
    // 带附件时 store 不走 command 分支（按文本+mentions 发），这里也就不记
    if (readyMentions.length === 0 && willBeCommand && cmdMatch) noteCommandUsed(session.agent, cmdMatch[1]!);
    // 本次实际提交的附件（ready 才有 mention）；发送成功只清这几个，
    // 上传中/上传失败的附件条必须留下，不被一起清掉。
    const submittedIds = new Set(attachments.filter((att) => attachmentMention(att)).map((att) => att.id));
    // 先清空（mentions 异步路径下「确认成功」不好定义）；失败时把文本还回输入框、附件条原样保留。
    // 草稿语义统一走草稿缓存：输入即草稿；发送成功由 store 侧清草稿（文本框也已清空）；
    // 失败时草稿本来就在，这里只需把可见文本还回。
    // 失败提示走 send() 已置的 lastError 全局错误条，不静默。
    setText("");
    setDismissed(false);
    void store.sendComposerInput(session.id, trimmed, readyMentions).then((ok) => {
      // 用户趁间隙输入了新内容时不覆盖，只在自己清出的空框里还回
      if (!ok) {
        setText((current) => (current === "" ? trimmed : current));
        return;
      }
      // 发送成功只移除本次提交的附件并回收其预览 URL；其余附件条保留（与草稿纪律一致）
      setAttachments((list) => {
        for (const att of list) {
          if (submittedIds.has(att.id) && att.previewUrl) {
            URL.revokeObjectURL(att.previewUrl);
            previewUrls.current.delete(att.previewUrl);
          }
        }
        return list.filter((att) => !submittedIds.has(att.id));
      });
    });
  };

  // dead/error 会话的出口：同 agent + 同 cwd + 原生会话 id 续接，成功后进入新会话
  const resume = async () => {
    if (resumeBusy || !session.nativeSessionId) return;
    setResumeBusy(true);
    setResumeError(null);
    try {
      const next = await store.create({
        agent: session.agent,
        cwd: session.cwd,
        resumeSessionId: session.nativeSessionId,
      });
      store.navigate(next.id);
    } catch (e) {
      setResumeError(e instanceof Error ? e.message : String(e));
      setResumeBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组合期间：Enter/Tab 等都是输入法上屏键，不当确认也不发送
    if (e.nativeEvent.isComposing) return;
    if (skillOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (filteredSkills.length) setSelected(i => (i + (e.key === "ArrowDown" ? 1 : -1) + filteredSkills.length) % filteredSkills.length);
        return;
      }
      if (e.key === "Escape") { e.preventDefault(); setDismissed(true); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && activeSkill)) {
        e.preventDefault();
        if (activeSkill) confirmSkill(activeSkill);
        return;
      }
    }
    if (slashOpen) {
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
    if (mentionOpen) {
      if (e.key === "Enter" && !e.shiftKey && filesLoading) {
        e.preventDefault(); // 等待候选时 Enter 不意外发送未完成的引用
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (files.length > 0) {
          const delta = e.key === "ArrowDown" ? 1 : -1;
          setSelected((i) => (i + delta + files.length) % files.length);
        }
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault(); // 焦点留在输入框
        if (activeFile) confirmMention(activeFile);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && activeFile) {
        e.preventDefault();
        confirmMention(activeFile);
        return;
      }
      // 无匹配时 Enter 落回普通发送（未知路径本就不会附加）
    }
    if (e.key === "Enter" && !e.shiftKey && (!TOUCH || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="composer">
      {/* 配置的过渡文案 / 提示 / 错误；可交互的胶囊在输入框底栏，会话头留只读摘要 */}
      <ConfigStatus session={session} />
      {/* 发送被本地拦下的原因（有待决闸门 / 配置切换中）：就地提示，文字保留在输入框 */}
      {sendNotice && (
        <div className="session-config">
          <span className="config-error" role="alert">
            {sendNotice}
            <button
              type="button"
              className="config-error-close"
              onClick={() => store.clearSendNotice(session.id)}
            >
              ×
            </button>
          </span>
        </div>
      )}
      {(dead || errored) && (
        <div className="composer-dead">
          {/* error 与 dead 共用续接出口（同 agent/cwd/nativeSessionId），文案区分 */}
          <span>{dead ? t("ui.SessionView.this_session_has_ended") : t("ui.SessionView.this_session_encountered_an_error")}</span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={resumeBusy || !session.nativeSessionId}
            title={
              session.nativeSessionId
                ? t("ui.SessionView.create_a_session_with_the_same_agent")
                : t("ui.SessionView.this_session_has_no_native_session_id")
            }
            onClick={() => void resume()}
          >
            {resumeBusy ? t("ui.SessionView.creating") : t("ui.SessionView.create_a_session_and_resume")}
          </button>
          {/* 没有原生会话 id（如没跑起来就死了）时写明禁用原因，不只靠 title */}
          {!session.nativeSessionId && (
            <span>{t("ui.SessionView.this_session_has_no_native_session_id")}</span>
          )}
          {resumeError && (
            <span className="config-error" role="alert">
              {resumeError}
            </span>
          )}
        </div>
      )}
      {slashOpen && (
        <div className="cmd-panel" role="listbox" aria-label={t("ui.common.slash_commands")} ref={listRef}>
          {filtered.length === 0 && <div className="cmd-empty">{t("ui.SessionView.no_matching_commands")}</div>}
          {filtered.map((cmd, i) => (
            <Fragment key={cmd.name}>
              {recentCount > 0 && i === 0 && (
                <div className="cmd-section" aria-hidden="true">{t("ui.SessionView.recently_used")}</div>
              )}
              {recentCount > 0 && i === recentCount && (
                <div className="cmd-section" aria-hidden="true">{t("ui.SessionView.all_commands")}</div>
              )}
              <div
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
            </Fragment>
          ))}
        </div>
      )}
      {mentionOpen && (
        <div className="cmd-panel file-mention-panel" role="listbox" aria-label={t("ui.SessionView.file_references")} ref={listRef}>
          <div className="cmd-section" title={session.cwd}>{t("ui.SessionView.files_sentence", { p0: (session.cwd) })}</div>
          {filesLoading && <div className="cmd-empty" role="status">{t("ui.SessionView.searching_files")}</div>}
          {filesError && <div className="cmd-empty config-error" role="alert">{t("ui.SessionView.file_search_failed_sentence", { p0: (filesError) })}</div>}
          {!filesLoading && !filesError && files.length === 0 && <div className="cmd-empty">{t("ui.SessionView.no_matching_files")}</div>}
          {files.map((file, i) => (
            <div
              key={file}
              title={file}
              role="option"
              aria-selected={i === selM}
              className={`cmd-item${i === selM ? " selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // 不抢输入框焦点，键盘可继续输入
                confirmMention(file);
              }}
              onMouseEnter={() => setSelected(i)}
            >
              <span className="cmd-name mono">@{file}</span>
            </div>
          ))}
        </div>
      )}
      {skillOpen && <div className="cmd-panel" role="listbox" aria-label={t("ui.SessionView.codex_skills")} ref={listRef}>
        <div className="cmd-section">{t("ui.SessionView.skills_select_to_insert_name")}</div>
        {skillsLoading && <div className="cmd-empty">{t("ui.SessionView.reading_skills")}</div>}
        {skillError && <div className="cmd-empty config-error" role="alert">{skillError}</div>}
        {!skillsLoading && filteredSkills.length === 0 && <div className="cmd-empty">{t("ui.SessionView.no_matching_skills")}</div>}
        {filteredSkills.map((skill, i) => <div key={skill.path} role="option" aria-selected={i === selSkill}
          className={`cmd-item${i === selSkill ? " selected" : ""}`} title={skill.description}
          onMouseDown={e => { e.preventDefault(); confirmSkill(skill); }} onMouseEnter={() => setSelected(i)}>
          <span className="cmd-name mono">${skill.name}</span><span className="cmd-desc">{skill.description}</span>
        </div>)}
      </div>}
      {tokens.length > 0 && (
        <div className="mention-preview">
          {attachable.length > 0 && (
            <span>{t("ui.SessionView.will_attach_files_sentence", { p0: (attachable.length), p1: (attachable.join(" · ")) })}</span>
          )}
          {missing.map((token) => (
            <span key={token} className="mention-missing">{t("ui.SessionView.not_found_will_not_attach_sentence", { p0: (token) })}</span>
          ))}
          {checking > 0 && <span>{t("ui.SessionView.references_being_checked_sentence", { p0: (checking) })}</span>}
          {tokens.length > MAX_MENTIONS && (
            <span className="mention-missing">{t("ui.SessionView.over_references_extra_references_will_not_attach_sentence", { p0: (MAX_MENTIONS) })}</span>
          )}
        </div>
      )}
      {!slashOpen && activeCmd?.argHint && (
        <div className="composer-hint">
          <span className="mono">/{activeCmd.name}</span> {t("ui.SessionView.arguments")}{activeCmd.argHint}
        </div>
      )}
      {codexResult && <CodexCommandPanel result={codexResult} onClose={closeCodexResult} />}
      {mcpOpen && <InfoDialog session={session} kind="mcp" onClose={() => { setMcpOpen(false); textareaRef.current?.focus(); }} />}
      {sideQuestion && <SideQuestionDialog sessionId={session.id} agent={session.agent} initialQuestion={sideQuestion.question}
        onClose={() => { setSideQuestion(null); textareaRef.current?.focus(); }} />}
      {session.agent === "kimi" && session.status === "running" && (
        <div className="composer-hint" role="status">{t("ui.SessionView.kimi_does_not_support_steering_during_execution")}</div>
      )}
      {attachments.length > 0 && (
        <div className="attach-bar" aria-label={t("ui.SessionView.pending_attachments")}>
          {attachments.map((att) => (
            <div key={att.id} className={`attach-card${att.status === "error" ? " is-error" : ""}`}>
              {att.previewUrl ? (
                <img className="attach-thumb" src={att.previewUrl} alt={att.name} />
              ) : (
                <span className="attach-name mono" title={att.path ?? att.name}>{att.name}</span>
              )}
              {att.status === "uploading" && <span className="attach-status">{t("ui.SessionView.uploading")}</span>}
              {att.status === "error" && (
                <span className="attach-err" role="alert" title={att.error}>{att.error ?? t("ui.SessionView.upload_failed")}</span>
              )}
              <button
                type="button"
                className="attach-remove"
                aria-label={t("ui.SessionView.remove_attachment", { p0: (att.name) })}
                title={t("ui.SessionView.remove_attachment_2")}
                onClick={() => removeAttachment(att.id)}
              >
                ×
              </button>
            </div>
          ))}
          {readyMentions.length + tokens.length > MAX_MENTIONS && (
            <span className="mention-missing">{t("ui.SessionView.attachments_and_references_total_over_extra_items_sentence", { p0: (MAX_MENTIONS) })}</span>
          )}
        </div>
      )}
      <div
        className="composer-box"
        onDragOver={(e) => {
          // 只拦文件拖入；文本拖动不受影响
          if (attachEnabled && e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          const dropped = Array.from(e.dataTransfer.files);
          if (dropped.length === 0 || !attachEnabled) return;
          e.preventDefault();
          uploadFiles(dropped);
        }}
      >
        {/* 手机：缓存时间不是按钮，挪到发送键上方的空位，底栏留给按钮 */}
        <div className="composer-input">
          <textarea
            aria-label={t("ui.SessionView.message")}
            ref={textareaRef}
            value={text}
            rows={1}
            disabled={dead}
            placeholder={
              dead
                ? t("ui.SessionView.this_session_has_ended_create_a_new")
                : TOUCH
                  ? t("ui.SessionView.message_this_agent")
                  : t("ui.SessionView.message_this_agent_enter_to_send_shift")
            }
            onChange={(e) => {
              setText(e.target.value);
              setCursor(e.target.selectionStart);
              setDismissed(false);
            }}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={(e) => {
              // 组合结束后再按当前文本评估是否触发 @ 面板
              setComposing(false);
              setText(e.currentTarget.value);
              setCursor(e.currentTarget.selectionStart);
            }}
            onPaste={(e) => {
              // 剪贴板里有文件（截图等）时上传为附件；纯文本粘贴走默认行为
              const pasted = Array.from(e.clipboardData.files);
              if (pasted.length === 0 || !attachEnabled) return;
              e.preventDefault();
              uploadFiles(pasted);
            }}
            onKeyDown={onKeyDown}
          />
          {showRefine ? <button type="button" className="refine-btn" title={t("ui.SessionView.append", { p0: String(refineCommand) })} aria-label={t("ui.SessionView.append", { p0: String(refineCommand) })}
            onPointerDown={(event) => event.preventDefault()} onClick={appendRefine}>R</button>
            : session.agent === "claude" && <CacheTimer session={session} className="cache-timer-top" />}
        </div>
        <div className="cfg-bar">
          <span className="attach-menu-wrap" ref={attachMenuRef}>
            <button
              type="button"
              className="attach-btn"
              disabled={!attachEnabled}
              title={attachEnabled ? t("ui.SessionView.add_attachments_photos_screenshots_or_files_on") : t("ui.SessionView.this_session_does_not_support_attachments")}
              aria-label={t("ui.SessionView.add_attachment")}
              aria-haspopup="menu"
              aria-expanded={attachMenuOpen}
              onClick={() => setAttachMenuOpen((v) => !v)}
            >
              <PlusIcon />
            </button>
            {attachMenuOpen && (
              <div className="attach-menu" role="menu" aria-label={t("ui.SessionView.add_attachment")}>
                {/* 不设 accept：iOS 才会给 照片图库/拍照/选取文件 三选项 */}
                <button
                  type="button"
                  className="attach-item"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                >{t("ui.SessionView.photos_files")}</button>
                <button
                  type="button"
                  className="attach-item"
                  role="menuitem"
                  onClick={() => {
                    setAttachMenuOpen(false);
                    setFileBrowseOpen(true);
                  }}
                >{t("ui.SessionView.files_on_computer")}</button>
              </div>
            )}
          </span>
          <SlashMenu session={session} commandsSupported={commandsSupported && !dead}
            canInsertCommand={!text}
            onSideQuestion={() => setSideQuestion({ question: "" })}
            onCodexCommand={name => {
              if (name === "review") { setText("/review "); textareaRef.current?.focus(); }
              else void executeCodex(name);
            }}
            onBrowseCommands={() => {
              setText("/");
              setCursor(1);
              setDismissed(false);
              textareaRef.current?.focus();
            }} />
          {session.agent === "claude" && <RemoteControlPill session={session} />}
          <ConfigControls session={session} />
          {session.agent === "claude" && <CacheTimer session={session} className="cache-timer-bar" />}
          {showComposerInterrupt(session.status, caps?.interrupt, session.processId, text) && (
            <button type="button" className="composer-interrupt" aria-label={t("ui.SessionView.interrupt")} title={t("ui.SessionView.interrupt_current_execution")}
              onClick={() => store.interrupt(session.id)}><StopIcon /></button>
          )}
          {/* 运行中且输入框为空：发送键变中断键；有内容时插话，Kimi 降级为排队 */}
          {session.status === "running" && caps?.interrupt && session.processId
            && !text.trim() && readyMentions.length === 0 ? (
            <button
              type="button"
              className="send-btn"
              aria-label={t("ui.SessionView.interrupt")}
              title={t("ui.SessionView.interrupt_current_execution")}
              onClick={() => store.interrupt(session.id)}
            >
              <StopIcon />
            </button>
          ) : (
            <button
              type="button"
              className="send-btn"
              aria-label={t("ui.common.send")}
              title={session.status === "running" ? t("ui.SessionView.steer_without_interrupting") : t("ui.common.send")}
              disabled={dead || (!text.trim() && readyMentions.length === 0)}
              onClick={send}
            >
              <SendIcon />
            </button>
          )}
        </div>
      </div>
      {/* 隐藏的文件选择器：照片/文件入口；再次选择同名文件也要触发 change */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (picked.length > 0) uploadFiles(picked);
        }}
      />
      {fileBrowseOpen && (
        <DirectoryBrowser
          mode="file"
          initialPath={session.cwd}
          onSelect={() => setFileBrowseOpen(false)}
          onSelectFile={addLocalFile}
          onClose={() => setFileBrowseOpen(false)}
        />
      )}
    </div>
  );
}

// 命令筛选与「最近使用」已抽到 ../commands（纯逻辑，单测见 scripts/render-items.test.mjs）。

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}
