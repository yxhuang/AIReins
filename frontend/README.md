# Workbench 前端

Vite + React + TypeScript 调度台，将 Claude Code、Codex、Kimi 会话放在同一列表，跨会话显示审批与提问。本文记录现行开发约定；后续待办见 [HANDOFF.md](../HANDOFF.md)，接口契约见 [server/README.md](../server/README.md)。

## 构建与开发

在仓库根目录执行，依赖安装在根 `node_modules`：

```bash
npm install
npm run server                 # 后端默认 :8790；从 / 托管 frontend/dist
npm run dev                    # Vite :5173，需后端先启动
npm run build                  # frontend/dist + 静态资源预压缩
npm run typecheck              # 根配置：后端与 spikes
npm run typecheck:frontend     # 前端独立 tsc --noEmit
npm test                       # 前后端聚合回归
node frontend/scripts/smoke-ws.mjs  # 需后端；会创建测试会话、批准闸门并校验落盘
```

开发代理包含 `/api`、`/pages` 和 `/ws`，目标为 `127.0.0.1:8790`；配置见 [vite.config.ts](vite.config.ts) 与 [package.json](../package.json)。没有 `@vitejs/plugin-react`，automatic JSX 下开发热更新退化为整页刷新。
针对功能可用根目录 `test:*` 脚本；直接运行前端逻辑测试用 `node --import tsx frontend/scripts/<name>.test.mjs`。`check:theme` 当前只检查文件浏览与侧栏入口样式，不能替代完整主题检查。

## 架构

- [App.tsx](src/App.tsx) 管布局，hash 路由由 [store.ts](src/store.ts) 处理：`#/session/<id>`、`#/history`、`#/page/<id>`、`#/dispatches` 及派单详情/多单高亮链接。
- 手机（≤720px）另有 `#/terminal`、`#/files`；会话与面板导航 push 完整视图及来源到 `history.state.workbenchNavigation`，系统后退/前进恢复对应会话和面板。返回/关闭按钮确认本次运行的上一条是来源时用 `history.back()`，冷启动或刷新后无法确认则 `replaceState` 回来源（无来源回会话/主页）；桌面仍沿用原 hash 语义，终端/文件开关不写 history。
- [types.ts](src/types.ts) 对应后端类型，[api.ts](src/api.ts) 处理 REST 信封与错误；后端是会话记录、能力位、配置选项的事实源。
- [render-items.ts](src/render-items.ts) 统一事件归一、工具配对/分组、闸门与提问；[StreamItems.tsx](src/components/StreamItems.tsx) 渲染实时块，[HistoryTimeline.tsx](src/components/HistoryTimeline.tsx) 复用到历史和外部续聊。
- 终端和派单视图按需加载；主会话在右侧面板打开时保持挂载。终端、文件、派单互斥，窄屏 ≤720px 面板全屏；入口共用 [PanelActions.tsx](src/components/PanelActions.tsx)，手机会话入口在「更多」菜单。

### 状态模型

- 单一 `Store` 经 [useStore.ts](src/useStore.ts) 的 `useSyncExternalStore` 订阅；优先 selector 与稳定引用，派生 tuple 用 `shallowEqual`，避免每次通知重绘全部组件。
- `sessions` 保存列表摘要；未打开会话只更新标题、seq、未决数与状态，不预取全部快照。标题优先后端 `session.title`，首条结构化命令可从 `/name 参数` 派生，兼容事件派生见 [shared/session-title.ts](../shared/session-title.ts)。
- `data` 按会话保存已加载事件、replay 游标、分页游标、未决闸门、用量/缓存信息；配置、RC、后台任务来自会话记录。普通事件推断状态，2 秒防抖重拉列表对齐，列表不覆盖较新 WS 摘要。
- 流式文本、思考、工具更新和调试事件通知按 `requestAnimationFrame` 合批；其他通知立即发出。活动会话时钟每秒更新，全局空闲改为 30 秒；实现见 [store.ts](src/store.ts)。

### 连接与恢复

- 一条全局 `/ws` 收所有会话事件。首连/重连刷新列表，对已加载会话发送 `{type:"replay", sessionId, afterSeq}`；`replay_complete` 后顺序应用缓冲帧，不再对每个会话一律重取快照。
- 快照请求去重并带代次戳，期间实时事件先缓存；响应原子替换旧窗口后追加较新帧。只接受推进 seq 的持久事件，重复帧忽略；临时工具更新不推进游标。
- seq 缺口、`resync_required` 或补发失败退回快照；重连作废受影响的在途快照。断线退避 1 秒起、封顶 15 秒，回前台可立即重连；见 [store.ts](src/store.ts)。
- 用户输入、审批回执、中断、配置和 RC 控制共用 WS；配置错误就地显示，其余进入可关联会话的全局错误条。发送被拒绝时保留文本与草稿，不把发送帧写出视为模型完成。Codex 消息的 `turn/start` 后续失败目前通过 `session_error` 显示，不自动还回已确认输入；Codex 斜杠命令失败则在输入仍为空时还回提交原文，保留随后新写的草稿。消息输入框有稳定的无障碍标签「消息」。

### 闸门与提问

- 闸门用琥珀金硬边直角，命令全文默认展开，编辑/写入复用 [DiffView.tsx](src/components/DiffView.tsx)；仅「允许」「拒绝」，不把 permission suggestions 当作工具入参回传。
- 发送成功才进入提交中并禁用按钮，等 `permission_resolved` 广播转中性；dead 会话清未决数、显示失效卡片。跨会话徽标、标签页标题与未决定位贴条共用同一待处理计数；见 [SessionView.tsx](src/components/SessionView.tsx)、[StreamItems.tsx](src/components/StreamItems.tsx)。
- 提问每题答完后一次提交；协议允许时提供「其他」文本，与选项互斥。答案 key 逐字使用问题原文，多选按选项顺序逗号合并；跳过为 deny，计入未决闸门。规则见 [ask.ts](src/ask.ts)。

## 长会话快照分页

- 进入会话或 resync 取 `GET /api/sessions/:id/snapshot?tail=1`；首屏为最近完整段，`seq` 始终是当前 replay 游标。会话标题、命令、最新用量、缓存 TTL/时间、配置切换态由 `session.title` / `snapshotState` 补齐。
- 顶部附近 160px 自动请求 `/api/sessions/:id/events?beforeSeq=<firstSeq>`；必须使用上一响应的 `firstSeq`。失败保留内容并暂停自动重试，点提示重试；`hasMore=false` 后停止。
- 页边界不拆用户回合和工具/闸门生命周期；阈值为 30 个非 steer 用户回合、未压缩事件 JSON 1.5 MiB，至少留一个不可拆段，超大段可超阈值。不安全游标返回 400；见 [server/event-pages.ts](../server/event-pages.ts)。
- prepend 在响应落地前记录可见元素，布局后恢复阅读位置；关闭浏览器自动滚动锚定。旧页不推进 seq、不重放旧配置/用量覆盖当前状态；并发复用、去重，resync 作废旧页。
- 分页模式保留已加载完整段；仅兼容旧全量响应时采用 2000 条事件窗口并保护未决请求。实现见 [store.ts](src/store.ts)、[SessionView.tsx](src/components/SessionView.tsx)，回归见 [snapshot-paging.test.mjs](scripts/snapshot-paging.test.mjs)。

## 侧栏内面板

- 底栏第一行「历史会话 │ AI 用量等扩展页」（可换行），第二行「设置、直达」；直达复用设置浮层，打开时刷新 `/api/links`，按 `pages/links.json` 的 group 分组，以普通新标签链接打开。输入框有文字时，Claude/Codex 的 R 在末尾追加 `/refine-prompt` / `$refine-prompt` 并保留焦点；手机替换缓存时间槽位，Kimi 暂无确切 skill 语法而隐藏。

- 主列表只放 `status !== "dead"` 且 `lastActivityAt` 距当前不超过 72 小时（含边界）的工作台会话，仍按活动时间倒序；`running` / `starting` 不限时间，未决闸门始终优先进「等待处理」。当前打开的旧非 dead 会话临时保留并显示选中项，切走后恢复时间筛选；消息事件更新活动时间后自然回列表。筛选见 [sidebar-sessions.ts](src/sidebar-sessions.ts)，复用 `store.now` 时钟，不另加轮询。
- 「等待处理」之下按区块排列：**置顶** → **各用户分组**（可折叠标题，折叠状态按设备存 localStorage，标题行 ⋮ 可重命名分组/删除分组＝成员移回普通分区）→ **进行中**（running/starting 或最近 2 小时有活动，含恰好 2h 边界）→ **今天**（`lastActivityAt` 是本地时间今天）→ **更早**（仍受 72h 窗口约束）；空分区不显示标签，组内按最后活动倒序。置顶/分组会话不受 72h 限制、不在时间分区重复出现，dead 也保留显示（用户主动整理）。状态点：空闲绿点只给最近 2 小时内有活动的会话，「今天/更早」的空闲行只显示右侧时间；running/后台任务/未决闸门/error 在任何分区照常显示。分区与状态点规则是 [sidebar-sessions.ts](src/sidebar-sessions.ts) 的 `selectSidebarSections` / `sidebarStatusDot`，重新分组复用 `store.now` 时钟。
- 会话行「⋮」菜单：**置顶 P**（已置顶显示「取消置顶」）/ **重命名 R** / **移到分组 ›** / **删除 D**（红色 `--danger`，走既有「从工作台移除」行内确认，原生记录不动）。桌面悬停或键盘聚焦行时右侧出 ⋮（暂时替换时间显示），右键弹同一菜单；手机 500ms 长按弹同一菜单，左滑 52px 露出 ⋮（方向锁定只响应行内向左滑动，不与 iOS 边缘后退冲突）。菜单与 `settings-pop`/`.cfg-menu` 同一浮层令牌，打开时快捷键字母生效，↑↓ 选择、Esc/点外部关闭。「移到分组」切到菜单内子屏：已有分组 + 「新建分组…」（输入名创建并移入）+ 已在分组时「移出分组」。重命名是行内输入框（Enter/失焦保存、Esc 取消、空串恢复自动标题、16px 防 iOS 放大）。滑动/快捷键纯函数在 [sidebar-menu.ts](src/sidebar-menu.ts)，菜单组件在 [SidebarActionMenu.tsx](src/components/SidebarActionMenu.tsx)；置顶/分组/自定义标题持久化在服务端，经 `session_organization_updated` 帧同步其他页面（见 server README）。
- 已结束及超时会话从「历史会话」查找，工作台记录带「工作台」来源标签；已移除「N 个工作台会话」折叠。预览底部「打开会话」仍能进入主列表外会话：已释放的原会话可发送并原地续接，dead 显示「新建会话并续接」，不因当前打开而进入主列表；手机后退/前进仍恢复历史预览/列表。
- 「历史会话」及扩展页内容覆盖侧栏会话区，底部入口不重排，同刻只开一个；标题/收起/Esc 关闭。会话列表保持挂载但不可聚焦，关闭恢复滚动；见 [Sidebar.tsx](src/components/Sidebar.tsx)。
- 桌面保留当前会话并恢复路由；手机历史列表与全屏预览共用 `#/history`，由版本 1 的 `history.state.workbenchNavigation.route.historySelection` 区分。列表点行 push 预览，预览换选 replace 当前 state；系统后退回列表、前进恢复预览，列表再后退回进入列表前的来源。列表持续挂载，保留筛选/分页/滚动位置。刷新后仍恢复预览；主动返回只有确认本次运行的前条是列表才 back，否则 replace 回列表（无列表来源的旧 state 也只清预览）。桌面选择/返回仍不新增 history。关闭历史或换页后再打开重新加载；旧 history/page hash 仍可进入。
- 历史列表每页 150 条，关键词 250ms 防抖，agent 由后端筛选；来源只过滤已加载条目并明示范围。空会话隐藏，`truncated/skipped` 为中性说明，导入对照 `agent + nativeSessionId`；见 [HistoryView.tsx](src/components/HistoryView.tsx)、[history.ts](src/history.ts)。
- 扩展页只在启动取列表，未知类型跳过；只在打开/重试时查 health。不可达或 `embeddable:false` 不挂 iframe；true 正常嵌入，null/缺省保留空白提示与新标签出口；见 [PageView.tsx](src/components/PageView.tsx)、[pages.ts](src/pages.ts)。
- iframe 使用 manifest URL，`proxy:true` 则走同源 `/pages/<id>/`；侧栏忽略主区 maxWidth，收起卸载。跨源 iframe 内 Esc 不可捕获；非代理 loopback 页面在远程入口显示电脑端提示，不能把手机的 localhost 当成服务端。

## 派单面板

- `#/dispatches` / `#/dispatches/<runId>` / `?runs=` 打开右侧只读面板，关闭恢复原会话或历史预览；与终端共用宽度记忆，拖拽、方向键、双击复位。入口与壳见 [DispatchPanel.tsx](src/components/DispatchPanel.tsx)、[SidePanelResize.tsx](src/components/SidePanelResize.tsx)。
- 派单树数据由 [dispatch-flow.ts](src/dispatch-flow.ts) 的 `buildDispatchTree` 纯函数生成，节点分 executor/run/subagent，执行端分 idle/single/group：单派单直接显示执行 agent；同一执行端多单时上层每单一行摘要（默认最多三行，`+N` 展开；折叠只收摘要行，下层任务块和子代理始终完整画出），下层分别画任务块，连线按派单顺序从执行端卡片底边的独立锚点出发；Codex 子代理连接所属派单或父 thread 节点，递归不限层。DispatchView.tsx 只负责紧凑卡片渲染和 ResizeObserver 几何测量；每层节点最大 148px、派单人最大 208px，窄面板按可用宽度收窄，长文本保留在 title；模型显示短名（`sol · xhigh`）。空闲执行端只显示小胶囊；Claude 执行端用珊瑚橙身份色（如 `opus · high`），delegate 派单可打开详情；Claude 原生子代理保持只读展示，不打开 delegate 详情，无近期记录时隐藏。标题按三家 `parent.sessionId` + 执行端匹配工作台/原生 id，独立 CLI 父会话复用服务端 `parent.title`，缺标题则显示短 ID，模型优先匹配会话值、否则 `parent.model`；按主运行时合成树（Claude → Codex → Kimi，无派单者隐藏），跨工具派单连接实际父节点。Codex/Luna 与 Kimi 原生子代理可由独立会话发现，均只读展示。
- 多个派单会话沿用派单人卡片的一行摘要，包含标题和各自运行单数，完整标题保留在 title；工作台/原生 id 别名去重，单会话保持原显示。
- 列表只读 `/api/dispatches?limit=50`，可见每 3 秒刷新、每秒走时，隐藏暂停、恢复立即刷新，慢请求不重叠；关闭清理请求/计时器，失败保留旧数据并重试。会话内派单链接独立轮询；见 [dispatch-polling.ts](src/dispatch-polling.ts)。
- 图中仅显示运行中及结束 30 分钟内派单；结束时间可由 startedAt + elapsedS 推算，lost 无结束时间用本次首次观察计时，其他结束时间不明者不显示。不读取或清理本机派单目录。
- 连线运行中为 `flow`，结束 10 分钟内（含边界）为 `finish`，之后为 `idle` 灰色；子 agent 独立按自身 `lastActivityAt` 判断，运行中不受时间影响。`FINISHED_WIRE_MS` 与卡片 30 分钟窗口 `RECENT_DISPATCH_MS` 分开。
- 详情原文默认前 5 行，可展开；过程复用历史时间线，原生记录不可读退回 stdout 尾部。结束显示 summary、STATUS/ACCEPT、可用 credits 与只复制的续接命令；下方近 7 天结束历史每页 20 单，见 [DispatchDetail.tsx](src/components/DispatchDetail.tsx)、[DispatchHistory.tsx](src/components/DispatchHistory.tsx)。

## 输入、配置与附件

- 新建 cwd 依次取上次成功目录、最近会话目录、meta.defaultCwd；用户改动后不再回填，空值显示禁用原因。当前新建显式 `snapshot:"skip"`，不走历史快照预检弹窗；见 [Sidebar.tsx](src/components/Sidebar.tsx)。
- 配置值/可变性来自 meta，胶囊优先显示会话覆盖、有效值、后端默认。`config_updated` 才回写，切换中禁用；restart 项说明重启续接代价，next_turn 提示下一轮生效。推理滑块拖动只改草稿、松手提交，键盘停 600ms 或关闭时提交；见 [ConfigMenu.tsx](src/components/ConfigMenu.tsx)、[config-view.ts](src/config-view.ts)。
- 草稿按会话内存与 localStorage 保存，刷新可恢复；成功仅清本次文本，异步发送不覆盖新输入，失败保留。dead/error 提供同 agent/cwd/nativeSessionId 新建续接，无原生 id 给出原因；见 [store.ts](src/store.ts)、[SessionView.tsx](src/components/SessionView.tsx)。
- `/` 行首触发命令，`@` 在光标处 token 触发；↑↓/Enter/Tab/Esc 保留 textarea 焦点，IME 组合期间不触发/发送。命令表由快照、REST、WS 更新，是否结构化发送由能力位决定；见 [commands.ts](src/commands.ts)、[SessionView.tsx](src/components/SessionView.tsx)。
- `@token` 整体先精确查真实文件，失败才剥尾部标点/截句读候选；保留原文本，按最终路径去重、合计 ≤20。含空白路径无法作为完整 token；显示标签与解析规则分离，见 [mentions.ts](src/mentions.ts)、[store.ts](src/store.ts)。
- 「+」支持手机选文件、电脑文件浏览、粘贴/拖入。上传为原始字节 POST `/api/uploads?sessionId&name`，本机文件只引用绝对路径；ready 才进发送帧，失败不进，发送成功清附件/预览 URL，失败保留；见 [attachments.ts](src/attachments.ts)。
- `image/*` 超 3.5 MiB 或非 png/jpeg/gif/webp，尝试长边 ≤2048、JPEG 0.85；解码失败原样上传。上传上限 25 MiB，image mention 上限 10 MiB；附件与 `@` 共用 20 个上限，Codex 命令带附件明确拒绝，其他结构化命令带附件改走文本+mentions。
- 用户气泡图片从 `/api/uploads/file?path=` 取缩略图，失败降级文件名；历史和快照复用同链路。附件状态属 Composer，切会话卸载会回收预览，不能当作持久草稿；见 [StreamItems.tsx](src/components/StreamItems.tsx)、[SessionView.tsx](src/components/SessionView.tsx)。

### 命令菜单

- Claude「/」按扩展分成「上下文 / 模型 / 自定义 / 设置 / 支持」；「管理插件」「MCP 服务器」放在自定义，副标题直接说明可启停/重载/重连。MCP 和插件均为 `role="switch"`；MCP 回复中可操作，启动或审批时在控件旁说明原因，操作后读回。Thinking 放在模型组，默认开启、会话保存，点后保持菜单展开；失败就地提示。Fast 通过能力接口读取原生 `supportsFastMode`，只在支持时显示，点击发用户命令 `/fast`。见 [SlashMenu.tsx](src/components/SlashMenu.tsx)。
- `/tasks` 面板消费实时 `session.backgroundTasks`；停止前确认，控制成功不提前移除任务，等 CLI 元数据更新。`/btw` 弹窗问答不进入 store 主事件流，只在组件内保存历史（最多传 20 轮），支持取消，关闭会取消请求并清空问答；synthetic/null 不加入历史。见 [ClaudeMenuPanels.tsx](src/components/ClaudeMenuPanels.tsx)。
- 配置文件链接只提供 VSCode 路径，不启动编辑器或写文件，部分设置需续接生效。Thinking 的 0/31999 控制覆盖由后端在 worker 初始化时重发，不写 `~/.claude/settings.json`。新增样式字号只用 14/15/16，复用现有冷色 switch。
- 导出使用原生 `export_conversation` 文本，可复制/下载，不把前端事件窗口当完整存档；Rewind 尚未接入。面板渲染见 [ClaudeMenuPanels.tsx](src/components/ClaudeMenuPanels.tsx)。
- Codex 提供 status/model/mcp/skills/compact/review/new/interrupt 客户端命令；未知命令明确报错。compact/review/new 限空闲无审批，interrupt 限运行中，错误就地展示；见 [CodexCommandPanel.tsx](src/components/CodexCommandPanel.tsx)、[SessionView.tsx](src/components/SessionView.tsx)。
- Codex `$` 使用真实 skills/list 名称/描述与路径，过滤、键盘选择、IME 保护，插入 `$name` 并由后端附结构化 skill input；不展示禁用项、不改全局配置，Claude/Kimi 不触发；见 [codex-skills.ts](src/codex-skills.ts)。

## 消息与原生历史

- 助手用 `react-markdown` + GFM，禁原始 HTML、过滤 URL，外链加 noopener/noreferrer；单换行保留，代码/表格块内横滚，复制使用原文并提示失败。见 [MarkdownMessage.tsx](src/components/MarkdownMessage.tsx)。
- 代码按需加载轻量词法着色，源码先转义；无/未知语言或 >2000 行纯文本，流式整轮结束后着色并丢弃过期结果；不是完整语法解析器，支持语言见 [code-highlight.ts](src/code-highlight.ts)、[highlight-languages.ts](src/highlight-languages.ts)。
- 同回合 text/thought/tool 共用时间线，闸门/提问独立；正常结束不额外显示系统行，异常如实显示。连续 ≥3 个成功只读工具合并摘要，读取路径去重，未知工具回落原名/原始内容；命令先展示 20 行，可展开全部。见 [tool-summary.ts](src/tool-summary.ts)、[render-items.ts](src/render-items.ts)。
- 调试行仅在渲染层由 `RAW_EVENT_NOISE` 降噪：隐藏 Codex diff 更新、hook 开始/明确成功完成、账户更新和 Claude 工具进度/命令生命周期；hook 失败或未知状态、未知事件保留。命令 `outputDelta` 仅在对应已完成工具卡片包含该输出时隐藏，实时或独有输出保留；Claude `user` 仅过滤已展示的文本回显，后台完成通知、跨会话消息等独有内容保留。服务端事件和 transcript 不变。
- Focus view 在「/」菜单切换并按浏览器保存：实时及历史隐藏工具、思考、调试和中性系统行，保留用户/助手、闸门/提问与错误；见 `focusVisible`、[HistoryTimeline.tsx](src/components/HistoryTimeline.tsx)。
- 历史预览、导入区共用 PagedHistory，首次最新 50 条并滚到底，nextCursor 向前 prepend，无原 500 条上限；旧页失败可重试，空窗口仍能翻页。导入首页使用 historyCursor 截止导入时刻，失效才回退最新页；见 [ResumedHistory.tsx](src/components/ResumedHistory.tsx)、[resumed-history.ts](src/resumed-history.ts)。
- 外部续聊通过 `external_messages_added` 入流，文本/工具/可用思考复用历史渲染；原生历史只读，不伪造缺失状态。超长正文仍可能截断，跨页工具结果不另补读；跳转已导入会话优先非 dead、再按活动时间，见 [history.ts](src/history.ts)。

## 终端与文件

- 终端入口只认 `meta.capabilities.terminal`，Ctrl+` 切换且忽略自动重复；首次打开懒加载 xterm，隐藏仅 CSS，实例、连接、PTY 保留。标签条列出全部未退出终端（激活的已退出终端也保留），同种 shell 按注册表顺序编号，「＋」菜单新建 bash/PowerShell；单 xterm 实例，切标签 = detach 旧的 + attach 新的并回放，激活 id 存 localStorage `workbench-term-active`，刷新优先重连；见 [TerminalPanel.tsx](src/components/TerminalPanel.tsx)、[terminal.ts](src/terminal.ts) 的 `buildTermTabs`/`pickBootTerminal`。
- 专用 `/ws/terminal` 每次 open 重新 attach，收到 attached 先 reset 再回放；省略输出给提示，resize 只在尺寸变化时发送。退避与回前台重连沿全局规则；kill 就地二次确认，exit 显示退出码、允许新建；见 [terminal.ts](src/terminal.ts)。
- 终端/派单宽默认 480px，clamp 至 `[320, 视口−480]`，窄屏全屏；手机 Esc/Tab/Ctrl-C/Ctrl-D/方向键与粘贴，Clipboard 失败退回手动 prompt，经 xterm.paste 处理。终端主题读 CSS 令牌，随主题/系统变化；契约见 [terminal-panel-design.md](../docs/terminal-panel-design.md)。
- 等宽字体优先本地 Maple Mono NF CN/Nerd Font，不下载字体；字体就绪或 1.5 秒超时重新度量 fit，不阻塞连接。终端字号默认按「宽屏 16 / 手机 13px × 整体比例」自动；设置里「终端字号」滑块（10–24px，localStorage `workbench-term-font`，按设备分开）设过就用设定值，见 `readTermFontSize`（[body-font.ts](src/body-font.ts)）。关闭尝试把焦点还给输入框。
- 文件面板宽单独记忆（默认 280、最小 240），目录浏览与新建 cwd 选择共用 [DirectoryBrowser.tsx](src/components/DirectoryBrowser.tsx)。点文件复制完整路径，仅当前非 dead、支持 mentions、cwd 内且相对路径无空白时插入 `@`；不满足则说明只复制，见 [FilePanel.tsx](src/components/FilePanel.tsx)。
- 目录浏览打开时后台预取三家原生历史 `q=/mnt/&limit=1`，Windows 按钮比较历史与工作台最近活动的 `/mnt/` 目录，无记录用 `/mnt/c/Users`。按钮不等待历史；慢请求/失败期间用本地结果，返回后仅供后续点击，不自动改变当前目录。关键词也匹配标题，仅遇到非 `/mnt/` 目录时继续最小页，1.5 秒后不再追加请求；接口自身超时仍由 `api.ts` 管理。历史列表会遍历目录和 stat，并按需读取文件头/检查用户消息，不预取完整历史消息。

## RC、释放与重启

- RC 胶囊仅 Claude，状态与 URL 由 session / `remote_control_updated` 驱动，失败原因可见于 title；快照/重连恢复，链接只打开 claude.ai。默认开启选项读写 Claude 启动设置；见 [SessionView.tsx](src/components/SessionView.tsx)、[SettingsMenu.tsx](src/components/SettingsMenu.tsx)。
- 远程 user 只在 connecting/connected/reconnecting 识别，排除子代理/合成消息，本机回显 FIFO 最多 20 条且不随 result 清空；worker 替换按设置/此前状态恢复 RC，见 [server/drivers/claude.ts](../server/drivers/claude.ts)。
- 「更多 → VSCode 继续」仅 idle 且有原生 id 可释放；成功复制 resumeCommand，失败退回 prompt，桌面尝试协议导航，手机只复制。释放不标 dead，输入框可再发，由后端磁盘续接；见 [SessionView.tsx](src/components/SessionView.tsx)、[server/README.md](../server/README.md)。
- 空闲释放档位 0/15/30/60/120 分钟，经 `/api/prefs` 保存，写失败回滚；running、待审批、RC 已连接等跳过，释放事件更新列表。设置重启先重读忙会话数并确认，POST 202 后须观察 WS 断开再恢复，60 秒超时提示失败；见 [restart.ts](src/restart.ts)。

## 外观与通用边界

- 配色裁决以 [styles.css 顶部注释](src/styles.css) 为准：`--gate` 系专属闸门/提问/待处理，消息与终端内容有明确例外；终端 chrome 中性/冷色，会话状态点红绿灯。浅色外框 chrome、画布 bg、浮起 surface 分层，别把旧“暖色只用于审批”当完整规则。
- 主题三态、整体字号四档 0.9/1/1.15/1.25 保存本机，首屏内联恢复；localStorage 不可用回退默认。sidebar/main 使用 zoom，AI 用量 iframe 抵消 zoom，终端独立 fit；手机侧栏按百分比包含块铺满，≤360px 顶栏收紧间距，窄空间底栏允许换行；设置/直达浮层尺寸受缩放后的视口约束；见 [font-scale.ts](src/font-scale.ts)、[index.html](index.html)。
- 正文字号 14–20px、步长 0.5、默认 16，旧 22/无效值回退；作用于 stream 用户/助手/思考正文，代码块和工具细节用 `max(14px, 正文−2px)`，与整体 zoom 叠加；见 [body-font.ts](src/body-font.ts)、[styles.css](src/styles.css)。
- 主题切换复用 [Segmented.tsx](src/components/Segmented.tsx)，保持单选/方向键和禁用语义，滑块按实际布局度量；减少动态偏好关闭动画。设置浮层限高滚动、focus trap、Esc/外点关闭并还焦点。
- 会话移除行内二次确认，Esc 取消，成功清本地状态/草稿并作废旧请求；只移除工作台条目和停 worker，原生 transcript 保留。手机左滑 80px 露入口，10px 锁方向，纵向保留滚动，同刻只展开一行；见 [Sidebar.tsx](src/components/Sidebar.tsx)、[store.ts](src/store.ts)。
- 设置存储面板打开时读一次，清理需弹窗确认，可选移除结束会话；清理只涉及工作台副本，原生记录保留，返回最新统计再刷新会话列表；见 [WorkbenchStorage.tsx](src/components/WorkbenchStorage.tsx)。
- 不引入 UI/图标/路由库；图标用 Unicode/内联 SVG，错误与禁用原因尽量可见。所有输入/审批/配置按后端能力与状态约束，`riskyMode` 警示不能替代实际 driver 权限契约。

## 只做过代码或打桩复核的前端路径

需要用户真机看的事项统一记在 `HANDOFF.md`「等用户真机看 / 确认的」；这里只列日常使用碰不到、仍只有代码或打桩证据的路径：

- Codex 图片附件 `localImage` 只核对过协议与单测，未真实投递；iOS 文件三选项、拖放、HEIC→JPEG canvas 压缩未真机。
- 中文 IME 组字状态下 `/`、`@`、`$skill` 面板的筛选与键盘交互。
- 终端 kill 时恰好断线后的退出码恢复、断线后重复 attach/reset。
- 快照分页：加载失败后点提示重试、图片/Markdown 异步撑高时的阅读位置（只做过 DOM 接线复核）。
- 设置面板 focus trap / 焦点返回、`prefers-reduced-motion` 的真实键盘与浏览器流程。

- 左下扩展页面入口（包括 AI 用量）打开后变为“‹ 后退”，再次点击收起页面并回到会话列表；图标态也保留返回箭头和可访问标签，与历史会话一致。
