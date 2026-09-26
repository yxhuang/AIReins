import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CommandInfo, DriverConfigOption, MetaInfo, SessionRecord } from "../types";
import { compactTokens, duration, asRecord, truncateDisplayWidth } from "../format";
import { buildRenderItems, promptCacheExpiry } from "../render-items";
import { filterCommands, noteCommandUsed, readRecentCommands, recentInTable } from "../commands";
import { extractMentionTokens, mentionQueryAt, mentionTokenEnd } from "../mentions";
import { needsRestartNote, effectiveFor, pillText, EFFECTIVE_SOURCE_LABELS, ALIAS_NOTE, RESTART_NOTE } from "../config-view";
import { fetchFiles } from "../api";
import { MAX_MENTIONS, store, type Store } from "../store";
import { shallowEqual, useStore } from "../useStore";
import { GateBlock, QuestionBlock, RawLine, SystemLine, TextBlockView, ThoughtBlockView, ToolCard, UserBlockView } from "./StreamItems";
import { ResumedHistory } from "./ResumedHistory";
import { ClockIcon, ConfigPills, SendIcon, type MenuGroup, type MenuItem } from "./ConfigMenu";
import { STATUS_HINTS, STATUS_LABELS } from "./Sidebar";

const selectMeta = (value: Store) => value.meta;
const selectWsState = (value: Store) => value.wsState;
const selectNow = (value: Store) => value.now;

/** 触屏设备（手机、平板）：软键盘的回车只换行，发送靠按钮或 Ctrl/⌘+Enter。 */
const TOUCH = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true;

export function SessionView({ session }: { session: SessionRecord }) {
  const running = session.status === "running" || session.status === "starting";
  const dead = session.status === "dead";
  const selectData = useCallback((value: Store) => value.data.get(session.id), [session.id]);
  const data = useStore(selectData);
  const meta = useStore(selectMeta);
  const wsState = useStore(selectWsState);
  const caps = meta?.drivers[session.agent];
  const items = useMemo(
    () => (data ? buildRenderItems(data.events, session.agent) : []),
    // resync 可以用相同 seq 原子替换事件窗口，所以 events 引用也是必要失效键。
    [data?.seq, data?.dropped, data?.events, session.agent],
  );

  const streamRef = useRef<HTMLDivElement>(null);
  const gateRefs = useRef(new Map<string, HTMLElement>());
  const [hiddenPending, setHiddenPending] = useState(0);

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
    const firstRequestId = pendingGateIds[0];
    if (!firstRequestId) return;
    const target = gateRefs.current.get(firstRequestId);
    if (target) {
      target.scrollIntoView({ block: "center" });
      return;
    }
    void store.recoverMissingPendingGate(session.id);
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
            <UsageView agent={session.agent} usage={data?.latestUsage} meta={meta} />
            <ElapsedTime session={session} running={running} />
            <span> · seq {data?.seq ?? session.seq}</span>
            <span title={STATUS_HINTS[session.status] ?? session.status}>
              {" · "}{STATUS_LABELS[session.status] ?? session.status}
            </span>
            <ConfigSummary session={session} />
            {/* 建会话时的自动快照位置；git 目录/跳过快照/旧会话该字段缺省，不显示 */}
            {session.snapshotPath && (
              <span
                className="session-snapshot"
                title="本次会话开始前对工作目录做的完整备份，改坏文件后可从这里找回"
              >
                {" · 快照 "}
                {session.snapshotPath}
              </span>
            )}
          </div>
        </div>
        <div className="session-head-actions">
          <span className={`ws-dot ws-${wsState}`} title={`连接：${wsState}`} />
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
        {/* 续接会话：历史消息区在实时事件流上方，向上翻即可见（不默认折叠） */}
        {session.resumedFrom && <ResumedHistory session={session} streamRef={streamRef} />}
        {!data && <p className="system-line">载入会话…</p>}
        {data && data.dropped > 0 && (
          <p className="system-line">有 {data.dropped} 条较早事件已省略（内存上限）；快照仍保留全量。</p>
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
        })}
      </div>

      {pendingGateIds.length > 0 && hiddenPending > 0 && (
        <button type="button" className="pending-bar" onClick={scrollToFirstPending}>
          {pendingGateIds.length} 个闸门等待处理 ↑
        </button>
      )}

      <Composer session={session} dead={dead} errored={session.status === "error"} />
    </div>
  );
}

/** running 时只有这一个小组件订阅秒级 now，避免时钟击穿整个 SessionView 子树。 */
function ElapsedTime({ session, running }: { session: SessionRecord; running: boolean }) {
  const selectNow = useCallback(
    (value: Store) => (running ? value.now : 0),
    [running],
  );
  const now = useStore(selectNow);
  return (
    <span>
      {" · 用时 "}
      {duration(
        session.createdAt,
        running ? new Date(now).toISOString() : session.lastActivityAt,
      )}
    </span>
  );
}

// 会话头的只读配置摘要（如「opus · xhigh · manual」，未覆盖项显示实际生效值或「跟随配置」）；
// 可交互控件只在输入框上方一处，会话头不再放可点的，避免两处不一致。
function ConfigSummary({ session }: { session: SessionRecord }) {
  const meta = useStore(selectMeta);
  const options = meta?.drivers[session.agent]?.options ?? [];
  if (options.length === 0) return null;
  const parts = options.map((option) => {
    const current = session.config?.[option.id];
    if (current) return current;
    // claude 跟随配置时并入实际生效值（首轮前是设置别名，init 后是精确 id；精度差异见控件旁标注）
    const effective = effectiveFor(session, option.id);
    if (effective) return effective.value;
    return "跟随配置";
  });
  return <span title="当前配置摘要；可更改的项在输入框上方"> · {parts.join(" · ")}</span>;
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
  const options = meta?.drivers[session.agent]?.options ?? [];
  const pending = store.configPending.get(session.id);
  // 重启切换进行中（claude model/effort）：全部控件禁用，就地显示后端给的过渡文案
  const live = Boolean(session.processId) && session.status !== "dead";
  if (options.length === 0) return null;

  const build = (option: DriverConfigOption) => {
    const current = session.config?.[option.id];
    const currentKey = current ?? "";
    // default 为 null 的那条 values 项带后端给的「跟随 … 配置」标签，优先用它。
    const followLabel =
      option.values.find((v) => v.value === null)?.label ?? "跟随配置";
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
        ? "此项需新建会话才能更改"
        : !live
          ? "会话已结束，无法更改"
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
                    ? "Claude 运行时回报的精确值"
                    : effective.source === "settings" && option.id === "model"
                      ? ALIAS_NOTE
                      : "来自 Claude 分层设置合并"
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
        if (value) store.setConfig(session.id, { [option.id]: value });
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
    return { group, text: pillText(option, current ?? undefined, effective?.value), reason };
  };

  const byId = (id: string) => options.find((o) => o.id === id);
  const main = [byId("model"), byId("effort")].filter((o): o is DriverConfigOption => Boolean(o)).map(build);
  const perm = byId("permissionMode");
  return (
    <ConfigPills
      main={main}
      perm={perm ? build(perm) : null}
      permMode={session.config?.permissionMode ?? perm?.default ?? ""}
    />
  );
}

// claude prompt 缓存剩余时间（同 VSCode 扩展输入框的「🕐 56m」）：过期后下一条消息要按全价重建缓存。
// 回合进行中缓存随每次请求续期，不显示；判定不了 TTL（还没跑过回合）显示「—」，不猜。
function CacheTimer({ session }: { session: SessionRecord }) {
  const selectExpiry = useCallback(
    (value: Store) => promptCacheExpiry(value.data.get(session.id)?.events ?? []),
    [session.id],
  );
  const expiry = useStore(selectExpiry);
  const now = useStore(selectNow);
  if (session.status === "running" || session.status === "starting") return null;
  if (expiry === null) {
    return (
      <span className="cache-timer expired" title="Prompt 缓存剩余时间：这个会话还没有完成过回合，第一轮结束后开始倒计时">
        <ClockIcon />—
      </span>
    );
  }
  const left = expiry - now;
  const minutes = Math.ceil(left / 60_000);
  return (
    <span
      className={`cache-timer${left <= 0 ? " expired" : ""}`}
      title={`Prompt 缓存${left > 0 ? `约剩 ${minutes} 分钟` : "已过期"}（自上个回合结束起算）；过期后下一条消息要重建缓存，更慢也更贵`}
    >
      <ClockIcon />
      {left > 0 ? `${minutes}m` : "已过期"}
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

function Composer({ session, dead, errored }: { session: SessionRecord; dead: boolean; errored: boolean }) {
  const meta = useStore(selectMeta);
  const selectCommands = useCallback(
    (value: Store) => value.commands.get(session.id),
    [session.id],
  );
  const commands = useStore(selectCommands);
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
  const listRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** 选中补全项后要落到的光标位置（setText 之后在 effect 里应用） */
  const pendingCursor = useRef<number | null>(null);
  /** @ 检索序号：晚到的旧响应丢弃 */
  const searchSeq = useRef(0);

  const caps = meta?.drivers[session.agent];
  const commandsSupported = caps?.commands === true;
  const mentionsSupported = caps?.mentions === true;
  const table = commands ?? [];

  // 仅行首 / 触发（整段文本即「/query」形态）；行中间的 /（如路径）是普通字符
  const slashQuery = /^\/([^\s]*)$/.exec(text)?.[1] ?? null;
  const slashOpen = commandsSupported && !dead && slashQuery !== null && !dismissed;
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

  // @ 引用：光标处 token 以 @ 开头即触发（句中也可以，不同于 / 的整行锚定）；
  // IME 组合期间不触发；与 / 面板互斥（slashOpen 时不评估 @）。
  const mention =
    mentionsSupported && !dead && !slashOpen && !composing
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

  useEffect(() => setSelected(0), [slashQuery, mentionQuery]);

  // @ 检索：250ms 防抖 + 序号作废旧响应；检索结果同时写进存在性缓存
  useEffect(() => {
    if (!mentionOpen) {
      setFiles([]);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      fetchFiles(session.id, mentionQuery ?? "")
        .then((list) => {
          if (searchSeq.current !== seq) return; // 晚到的旧响应丢弃
          store.noteFiles(session.id, list);
          setFiles(list);
        })
        .catch(() => {
          if (searchSeq.current === seq) setFiles([]);
        });
    }, 250);
    return () => clearTimeout(timer);
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
    if (!slashOpen && !mentionOpen) return;
    listRef.current?.querySelector(".cmd-item.selected")?.scrollIntoView({ block: "nearest" });
  }, [slashOpen, mentionOpen, sel, selM, active?.name, activeFile]);

  // 补全插入后把光标落到插入路径之后
  useEffect(() => {
    if (pendingCursor.current !== null && textareaRef.current) {
      textareaRef.current.setSelectionRange(pendingCursor.current, pendingCursor.current);
      pendingCursor.current = null;
    }
  }, [text]);

  const confirm = (cmd: CommandInfo, fillOnly: boolean) => {
    if (!fillOnly && !cmd.argHint) {
      // 无参数命令：确认即直接发（结构化 command，不拼 text）；失败保留文本，错误条提示
      noteCommandUsed(session.agent, cmd.name);
      if (store.sendCommand(session.id, cmd.name, "")) setText("");
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
    if (!trimmed || dead) return;
    // 「/命令 参数」整行形态经 sendComposerInput 走结构化 command，同样记入最近使用
    if (willBeCommand && cmdMatch) noteCommandUsed(session.agent, cmdMatch[1]!);
    // 先清空（mentions 异步路径下「确认成功」不好定义）；失败时把文本还回输入框。
    // 草稿语义统一走草稿缓存：输入即草稿；发送成功由 store 侧清草稿（文本框也已清空）；
    // 失败时草稿本来就在，这里只需把可见文本还回。
    // 失败提示走 send() 已置的 lastError 全局错误条，不静默。
    setText("");
    setDismissed(false);
    void store.sendComposerInput(session.id, trimmed).then((ok) => {
      // 用户趁间隙输入了新内容时不覆盖，只在自己清出的空框里还回
      if (!ok) setText((current) => (current === "" ? trimmed : current));
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
      {(dead || errored) && (
        <div className="composer-dead">
          {/* error 与 dead 共用续接出口（同 agent/cwd/nativeSessionId），文案区分 */}
          <span>{dead ? "会话已结束。" : "会话出错了。"}</span>
          <button
            type="button"
            className="btn btn-primary"
            disabled={resumeBusy || !session.nativeSessionId}
            title={
              session.nativeSessionId
                ? "用同一 agent、同一工作目录新建会话并续接原生会话"
                : "该会话没有可续接的原生会话 id"
            }
            onClick={() => void resume()}
          >
            {resumeBusy ? "新建中…" : "新建会话并续接"}
          </button>
          {/* 没有原生会话 id（如没跑起来就死了）时写明禁用原因，不只靠 title */}
          {!session.nativeSessionId && (
            <span>该会话没有可续接的原生会话 id</span>
          )}
          {resumeError && (
            <span className="config-error" role="alert">
              {resumeError}
            </span>
          )}
        </div>
      )}
      {slashOpen && (
        <div className="cmd-panel" role="listbox" aria-label="斜杠命令" ref={listRef}>
          {filtered.length === 0 && <div className="cmd-empty">没有匹配的命令</div>}
          {filtered.map((cmd, i) => (
            <Fragment key={cmd.name}>
              {recentCount > 0 && i === 0 && (
                <div className="cmd-section" aria-hidden="true">
                  最近使用
                </div>
              )}
              {recentCount > 0 && i === recentCount && (
                <div className="cmd-section" aria-hidden="true">
                  全部命令
                </div>
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
        <div className="cmd-panel" role="listbox" aria-label="文件引用" ref={listRef}>
          {files.length === 0 && <div className="cmd-empty">没有匹配的文件</div>}
          {files.map((file, i) => (
            <div
              key={file}
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
      {tokens.length > 0 && (
        <div className="mention-preview">
          {attachable.length > 0 && (
            <span>
              将附加 {attachable.length} 个文件：{attachable.join(" · ")}
            </span>
          )}
          {missing.map((token) => (
            <span key={token} className="mention-missing">
              @{token} 未找到，不会附加
            </span>
          ))}
          {checking > 0 && <span>{checking} 个引用检查中…</span>}
          {tokens.length > MAX_MENTIONS && (
            <span className="mention-missing">
              超过 {MAX_MENTIONS} 个引用，超出的不会附加
            </span>
          )}
        </div>
      )}
      {!slashOpen && activeCmd?.argHint && (
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
      <div className="composer-box">
        <textarea
          ref={textareaRef}
          value={text}
          rows={2}
          disabled={dead}
          placeholder={
            dead
              ? "会话已结束，新建会话可续接"
              : TOUCH
                ? "发消息给这个 agent…"
                : "发消息给这个 agent…（Enter 发送，Shift+Enter 换行）"
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
          onKeyDown={onKeyDown}
        />
        <div className="cfg-bar">
          {session.agent === "claude" && <CacheTimer session={session} />}
          <ConfigControls session={session} />
          <button
            type="button"
            className="send-btn"
            aria-label="发送"
            title="发送"
            disabled={dead || !text.trim()}
            onClick={send}
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </div>
  );
}

// 命令筛选与「最近使用」已抽到 ../commands（纯逻辑，单测见 scripts/render-items.test.mjs）。
