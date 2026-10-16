# AIReins 前端

Vite + React + TypeScript 调度台，将 Claude Code、Codex、Kimi 会话放在同一列表，跨会话显示审批与提问。本文记录现行开发约定；接手规则与后续待办见根目录 [AGENTS.md](../AGENTS.md)，接口契约见 [server/README.md](../server/README.md)。

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

`frontend/dist/` 不入库。`install.sh` 安装/更新时执行 `npm run build`（含预压缩），构建失败则安装失败；`aireins` 启动前缺少 `frontend/dist/index.html` 时也会自动构建，失败则退出。构建使用 `emptyOutDir: false`，保留已打开页面引用的旧 hash 资源，不要清空 dist。
针对功能可用根目录 `test:*` 脚本；直接运行前端逻辑测试用 `node --import tsx frontend/scripts/<name>.test.mjs`。`check:theme` 当前只检查文件浏览与侧栏入口样式，不能替代完整主题检查。

## 架构

- [App.tsx](src/App.tsx) 管布局，hash 路由由 [store.ts](src/store.ts) 处理：`#/session/<id>`、`#/history`、`#/page/<id>`、`#/dispatches` 及派单详情/多单高亮链接。
- 手机（≤720px）另有 `#/terminal`、`#/files`；会话与面板导航 push 完整视图及来源到 `history.state.workbenchNavigation`，系统后退/前进恢复对应会话和面板。返回/关闭按钮确认本次运行的上一条是来源时用 `history.back()`，冷启动或刷新后无法确认则 `replaceState` 回来源（无来源回会话/主页）。桌面面板共用一条 `history.state.workbenchDesktopPanels` 记录，保存当前视图和左右侧打开顺序；目录浏览状态下，鼠标侧键/浏览器后退先按本次文件侧栏的成功访问历史逐次返回目录（可为无关路径，不等同上一级）；目录返回失败保留当前列表和历史，加载期间不重复请求；没有目录历史时关闭最近打开的一侧，左侧历史/额度回会话标签列表，右侧文件/终端/派单收起，另一侧和当前会话保留。同侧切换不重放旧面板；文件预览状态仍按面板后退保留草稿。目录历史在文件面板组件内保存，预览/返回时保留，收起再开/切会话/刷新重置；工作目录/附件弹窗和手机全屏路由保持原行为。普通文件/终端仍保持会话 URL；关闭按钮只消耗本次运行亲自创建的面板历史，刷新后用 replace；缩到手机时转换为手机路由快照。
- [types.ts](src/types.ts) 对应后端类型，[api.ts](src/api.ts) 处理 REST 信封与错误；后端是会话记录、能力位、配置选项的事实源。
- [render-items.ts](src/render-items.ts) 统一事件归一、工具配对/分组、闸门与提问；[StreamItems.tsx](src/components/StreamItems.tsx) 渲染实时块，[HistoryTimeline.tsx](src/components/HistoryTimeline.tsx) 复用到历史和外部续聊。
- 终端和派单视图按需加载；主会话在右侧面板打开时保持挂载。终端、文件、派单互斥，窄屏 ≤720px 面板全屏；入口共用 [PanelActions.tsx](src/components/PanelActions.tsx)，手机会话入口在「更多」菜单。
- 桌面顶栏共用的圆钮保留 32px 视觉外观，使用 40×40px 点击区域且不增加顶栏高度；水平按钮预留空间，视觉间距约 12px、点击区域之间保留 4px 空隙，覆盖侧栏刷新/收起、会话面板入口/更多及右侧面板圆钮。窄侧栏品牌文字可省略，按钮保持可点；手机尺寸规则沿用现有布局。

### 状态模型

- 单一 `Store` 经 [useStore.ts](src/useStore.ts) 的 `useSyncExternalStore` 订阅；优先 selector 与稳定引用，派生 tuple 用 `shallowEqual`，避免每次通知重绘全部组件。
- `sessions` 保存列表摘要；未打开会话只更新标题、seq、未决数与状态，不预取全部快照。标题优先后端 `session.title`，首条结构化命令可从 `/name 参数` 派生，兼容事件派生见 [shared/session-title.ts](../shared/session-title.ts)。主会话桌面/手机顶栏固定显示开头 12 个可见字符，超出追加省略号；左侧会话标签按字体和当前行可用宽度实际截短 DOM 文本及悬停提示，拖动侧栏/缩放字号后重新计算。原标题保留在记录与重命名输入中；截短逻辑见 [SessionTitle.tsx](src/components/SessionTitle.tsx)。
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

- 左上角 **AR 标志（`BrandMark`：单色随文字色，粗笔画、宽字形，R 是一根带缝线的皮缰绳摆成、尾端绕成缰绳圈；高 18px（收起态 16px）放进 35px 按钮，不改变顶栏高度；启动页同一标志放大到 64px；应用图标 `public/icon.svg` 同形）｜当前主机** 整体为主机选择按钮（描边/高光/轻投影，无小箭头）：本机入口显示「本机」，远程用 Tailscale MagicDNS 机器名；窗口标题同步连接身份且保留未决闸门计数。300px 菜单的本机项显示「机器名（本机）」；本机名来自 meta.hostName，并随来源返回上下文携带；旧后端缺字段时回退「本机」，需要后端重启后生效。菜单支持整页切换、新标签和管理主机，设置「主机」组的「主机与连接（Tailscale）」直接打开此菜单。地址只存浏览器，通过经过校验的 fragment 带到目标源并在 `store.init()` 前消费；目标列表合并保留，手机直接远程不产生 localhost 返回入口。文件保存/未保存与未发送输入有保护，切换不操作后台任务。连接与两机安装见 [主机连接说明](../docs/host-connections.md)，逻辑在 `host-connections.ts`，控件在 `HostSwitcher.tsx`。

- 底栏第一行「历史会话 │ AI 用量等扩展页」（可换行），第二行「设置、直达」；直达为200px浮层，锚定直达按钮上方8px、右边缘对齐按钮，向左展开；链接去掉默认及行末箭头，保留配置的图标，打开时刷新 `/api/links`，按用户数据目录 `~/.workbench/pages/links.json`（可由 `WORKBENCH_HOME` 覆盖）的 group 分组，以普通新标签链接打开。输入框有文字时，Claude/Codex 的 R 在末尾追加 `/refine-prompt` / `$refine-prompt` 并保留焦点；手机替换缓存时间槽位，Kimi 暂无确切 skill 语法而隐藏。收起态侧栏宽 48px（用户 10-13 由 52 收窄），底栏按钮与顶部刷新、展开同为 32px 圆形浮起钮、图标 20px，从下到上为设置、历史、扩展页面、直达（同展开态从左到右）；桌面收起态的设置与直达浮层改为 fixed，贴侧栏右侧（left 56px）弹出、底边对齐侧栏底部，不被侧栏 overflow 裁切。

- 主列表只放 `status !== "dead"` 且 `lastActivityAt` 距当前不超过 72 小时（含边界）的工作台会话，仍按活动时间倒序；`running` / `starting` 不限时间，未决闸门始终优先进「等待处理」。当前打开的旧非 dead 会话临时保留并显示选中项，切走后恢复时间筛选；消息事件更新活动时间后自然回列表。筛选见 [sidebar-sessions.ts](src/sidebar-sessions.ts)，复用 `store.now` 时钟，不另加轮询。
- 「等待处理」之下按区块排列：**置顶** → **各用户分组**（可折叠标题，折叠状态按设备存 localStorage，标题行 ⋮ 可重命名分组/删除分组＝成员移回普通分区）→ **进行中**（running/starting 或最近 2 小时有活动，含恰好 2h 边界）→ **今天**（`lastActivityAt` 是本地时间今天）→ **更早**（仍受 72h 窗口约束）；进行中/今天的折叠状态按设备存 localStorage，「更早」每次打开页面都折叠、展开只在本次页面内有效（`store.sidebarEarlierOpen`）；空分区不显示标签，组内按最后活动倒序。置顶/分组会话不受 72h 限制、不在时间分区重复出现，dead 也保留显示（用户主动整理）。状态点：空闲绿点只给最近 2 小时内有活动的会话，「今天/更早」的空闲行只显示右侧时间；running/后台任务/未决闸门/error 在任何分区照常显示。分区与状态点规则是 [sidebar-sessions.ts](src/sidebar-sessions.ts) 的 `selectSidebarSections` / `sidebarStatusDot`，重新分组复用 `store.now` 时钟。
- 会话行「⋮」菜单：**置顶 P**（已置顶显示「取消置顶」）/ **重命名 R** / **移到分组 ›** / **移除 D**（走「从工作台移除」行内确认，原生记录不动）/ **彻底删除**（红色 `--danger`，仅Codex/Kimi，打开默认取消的模态确认框）。桌面悬停或键盘聚焦行时右侧出 ⋮（暂时替换时间显示），右键弹同一菜单；手机 500ms 长按弹同一菜单，左滑 52px 露出 ⋮（方向锁定只响应行内向左滑动，不与 iOS 边缘后退冲突）。菜单与 `settings-pop`/`.cfg-menu` 同一浮层令牌，打开时快捷键字母生效，↑↓ 选择、Esc/点外部关闭。「移到分组」切到菜单内子屏：已有分组 + 「新建分组…」（输入名创建并移入）+ 已在分组时「移出分组」。重命名是行内输入框（Enter/失焦保存、Esc 取消、空串恢复自动标题、16px 防 iOS 放大）。滑动/快捷键纯函数在 [sidebar-menu.ts](src/sidebar-menu.ts)，菜单组件在 [SidebarActionMenu.tsx](src/components/SidebarActionMenu.tsx)；置顶/分组/自定义标题持久化在服务端，经 `session_organization_updated` 帧同步其他页面（见 server README）。
- 已结束及超时会话从「历史会话」查找，工作台记录带「工作台」来源标签；已移除「N 个工作台会话」折叠。预览底部「打开会话」仍能进入主列表外会话：已释放的原会话可发送并原地续接，dead 显示「新建会话并续接」，不因当前打开而进入主列表；手机后退/前进仍恢复历史预览/列表。
- 「历史会话」及扩展页内容覆盖侧栏会话区，底部入口不重排，同刻只开一个；标题/收起/Esc 关闭。会话列表保持挂载但不可聚焦，关闭恢复滚动；见 [Sidebar.tsx](src/components/Sidebar.tsx)。扩展页不做任何缩放适配，比一屏高时页内滚动（用户 10-16，Tibo 卡片占高时也一样）。
- 桌面保留当前会话并恢复路由；手机历史列表与全屏预览共用 `#/history`，由版本 1 的 `history.state.workbenchNavigation.route.historySelection` 区分。列表点行 push 预览，预览换选 replace 当前 state；系统后退回列表、前进恢复预览，列表再后退回进入列表前的来源。列表持续挂载，保留筛选/分页/滚动位置。刷新后仍恢复预览；主动返回只有确认本次运行的前条是列表才 back，否则 replace 回列表（无列表来源的旧 state 也只清预览）。桌面选择/返回仍不新增 history。关闭历史或换页后再打开重新加载；旧 history/page hash 仍可进入。
- 历史列表每页 150 条，关键词 250ms 防抖，agent 由后端筛选；来源只过滤已加载条目并明示范围。空会话隐藏，`truncated/skipped` 为中性说明，导入对照 `agent + nativeSessionId`。历史面板选定目录时，左上角「新建会话」直接以该目录为默认工作目录（原「在此目录新建会话」按钮已并入）；见 [HistoryView.tsx](src/components/HistoryView.tsx)、[history.ts](src/history.ts)。
- 扩展页只在启动取列表，未知类型跳过；只在打开/重试时查 health。不可达或 `embeddable:false` 不挂 iframe；true 正常嵌入，null/缺省保留空白提示与新标签出口；见 [PageView.tsx](src/components/PageView.tsx)、[pages.ts](src/pages.ts)。
- iframe 使用 manifest URL，`proxy:true` 则走同源 `/pages/<id>/`；侧栏忽略主区 maxWidth，收起卸载。跨源 iframe 内 Esc 不可捕获；非代理 loopback 页面在远程入口显示电脑端提示，不能把手机的 localhost 当成服务端。

## 派单面板

- 主体与近 7 天历史卡片统一标题字号、水平边距和标题高度，卡片之间保留 12px 间距；没有派单时只在主体卡片内显示一次空状态。历史仍默认折叠，展开后才加载。

- `#/dispatches` / `#/dispatches/<runId>` / `?runs=` 打开右侧只读面板（会话顶栏「查看派单」与手机派单徽章一律走 `?runs=` 流程图高亮，只有一张也不直达详情；详情从流程图卡片、历史派单进入），关闭恢复原会话或历史预览；与终端共用宽度记忆，拖拽、方向键、双击复位。入口与壳见 [DispatchPanel.tsx](src/components/DispatchPanel.tsx)、[SidePanelResize.tsx](src/components/SidePanelResize.tsx)。
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
- 输入栏 Permission 左侧显示上下文圆环，悬停/键盘聚焦显示约占百分比；Codex 取最新请求 `usage.last.totalTokens / modelContextWindow`，Kimi 取 `used / size`，Claude 在打开及回合用量更新后调用现有只读 context 接口。缺失数据显示未知，不用累计 token 猜测，不轮询或唤醒已释放 worker。
- 手机输入栏 Codex 权限标签缩写为 `Ask / Auto / Full`，桌面和权限菜单仍显示完整名称；圆环两端均显示，模型名可按剩余宽度截短。输入框聚焦时（键盘弹起）去掉 `.app` 底部安全区留白、`.composer` 底边距收到 4px；iOS 弹键盘不缩 `100dvh` 而是平移可视视口，所以手机键盘打开（`visualViewport` 比 `innerHeight` 矮 120px 以上且未双指缩放）时 `main.tsx` 给 `<html>` 加 `data-keyboard`，`.app` 改为 fixed 并按 `visualViewport` 的 offsetTop/height 铺满可见区，输入框贴住键盘；键盘上方的 ∧ ∨ ✓ 条是 iOS Safari 系统表单辅助栏，网页无法隐藏（用户 10-16）。
- `/` 行首触发命令，`@` 在光标处 token 触发；↑↓/Enter/Tab/Esc 保留 textarea 焦点，IME 组合期间不触发/发送。命令表由快照、REST、WS 更新，是否结构化发送由能力位决定；见 [commands.ts](src/commands.ts)、[SessionView.tsx](src/components/SessionView.tsx)。
- `@` 面板显示会话 cwd、检索中及接口错误；请求失败不冒充“没有匹配”。更换关键词立即清空旧候选，关闭面板后丢弃迟到响应；检索中 Enter 不发送未完成引用。
- `@token` 整体先精确查真实文件，失败才剥尾部标点/截句读候选；保留原文本，按最终路径去重、合计 ≤20。含空白路径无法作为完整 token；显示标签与解析规则分离，见 [mentions.ts](src/mentions.ts)、[store.ts](src/store.ts)。
- 「+」支持手机选文件、电脑文件浏览、粘贴/拖入。上传为原始字节 POST `/api/uploads?sessionId&name`，本机文件只引用绝对路径；ready 才进发送帧，失败不进，发送成功清附件/预览 URL，失败保留；见 [attachments.ts](src/attachments.ts)。
- `image/*` 超 3.5 MiB 或非 png/jpeg/gif/webp，尝试长边 ≤2048、JPEG 0.85；解码失败原样上传。上传上限 25 MiB，image mention 上限 10 MiB；附件与 `@` 共用 20 个上限，Codex 命令带附件明确拒绝，其他结构化命令带附件改走文本+mentions。
- 用户气泡图片从 `/api/uploads/file?path=` 取缩略图，失败降级文件名；历史和快照复用同链路。附件状态属 Composer，切会话卸载会回收预览，不能当作持久草稿；见 [StreamItems.tsx](src/components/StreamItems.tsx)、[SessionView.tsx](src/components/SessionView.tsx)。

### 命令菜单

- Claude「/」按扩展分成「上下文 / 模型 / 自定义 / 设置 / 支持」；「管理插件」「MCP 服务器」放在自定义，副标题直接说明可启停/重载/重连。MCP 和插件均为 `role="switch"`；MCP 回复中可操作，启动或审批时在控件旁说明原因，操作后读回。Thinking 放在模型组，默认开启、会话保存，点后保持菜单展开；失败就地提示。Fast 通过能力接口读取原生 `supportsFastMode`，只在支持时显示，点击发用户命令 `/fast`。见 [SlashMenu.tsx](src/components/SlashMenu.tsx)。
- `/tasks` 面板消费实时 `session.backgroundTasks`；停止前确认，控制成功不提前移除任务，等 CLI 元数据更新。侧问面板（Claude `/btw`、Codex `/side` 及别名 `/btw`）不进入 store 主事件流，只在组件内保存历史（最多传 20 轮），支持取消，关闭会取消请求并清空问答；synthetic/null 不加入历史。输入框打 `/` 即可补全这几个命令（`withSideCommands` 补进命令表，同名 CLI 项去重），整行「/btw 问题」发送时被 `parseSideCommand` 拦下、不发主对话，带问题打开面板并立即提问（延后一拍，StrictMode 不重复）；补全面板里对侧问命令按 Enter 直接打开空面板，Tab 只填充。Claude 的「/」菜单 `/btw` 入口打开同一面板（Codex 菜单无此入口）。Codex 请求上限 320 秒（服务端回合 300 秒），Claude 80 秒。见 [ClaudeMenuPanels.tsx](src/components/ClaudeMenuPanels.tsx)、[commands.ts](src/commands.ts)。
- 配置文件链接只提供 VSCode 路径，不启动编辑器或写文件，部分设置需续接生效。Thinking 的 0/31999 控制覆盖由后端在 worker 初始化时重发，不写 `~/.claude/settings.json`。新增界面字号沿用 12/13/14/15 阶梯（触屏输入至少 16px），复用现有冷色 switch；布局须兼容浏览器最小字号 14px。
- 导出使用原生 `export_conversation` 文本，可复制/下载，不把前端事件窗口当完整存档；Rewind 尚未接入。面板渲染见 [ClaudeMenuPanels.tsx](src/components/ClaudeMenuPanels.tsx)。
- Codex 提供 status/model/mcp/skills/compact/review/new/interrupt 客户端命令；未知命令明确报错。compact/review/new 限空闲无审批，interrupt 限运行中，错误就地展示；见 [CodexCommandPanel.tsx](src/components/CodexCommandPanel.tsx)、[SessionView.tsx](src/components/SessionView.tsx)。
- Codex `$` 使用真实 skills/list 名称/描述与路径，过滤、键盘选择、IME 保护，插入 `$name` 并由后端附结构化 skill input；不展示禁用项、不改全局配置，Claude/Kimi 不触发；见 [codex-skills.ts](src/codex-skills.ts)。

## 消息与原生历史

- 顺序追加事件由持久 reducer 增量折叠，更新条目使用新对象；分组和已完成行缓存，仅更新末尾。事件窗口引用替换、`dropped`、乱序/重复 seq 和 Codex 回溯输出依赖会全量重建。流式 Markdown 每 100ms 最多解析一次，停止流式后立即使用完整原文，代码着色仍等整轮结束。正文实际提交后同步贴底与“回到最新”状态，阅读历史时保持滚动位置。回归见 [long-session-scroll.test.mjs](scripts/long-session-scroll.test.mjs)、 [long-session-render.test.mjs](scripts/long-session-render.test.mjs)。
- 助手用 `react-markdown` + GFM，禁原始 HTML、过滤 URL，外链加 noopener/noreferrer；单换行保留，代码/表格块内横滚，复制使用原文并提示失败。见 [MarkdownMessage.tsx](src/components/MarkdownMessage.tsx)。
- 代码按需加载轻量词法着色，源码先转义；无/未知语言或 >2000 行纯文本，流式整轮结束后着色并丢弃过期结果；不是完整语法解析器，支持语言见 [code-highlight.ts](src/code-highlight.ts)、[highlight-languages.ts](src/highlight-languages.ts)。
- 同回合 text/thought/tool 共用时间线，闸门/提问独立；正常结束不额外显示系统行，异常如实显示。连续 ≥3 个成功只读工具合并摘要，读取路径去重，未知工具回落原名/原始内容；命令先展示 20 行，可展开全部。见 [tool-summary.ts](src/tool-summary.ts)、[render-items.ts](src/render-items.ts)。
- 调试行仅在渲染层由 `RAW_EVENT_NOISE` 降噪：隐藏 Codex diff 更新、hook 开始/明确成功完成、账户更新和 Claude 工具进度/命令生命周期；hook 失败或未知状态、未知事件保留。命令 `outputDelta` 仅在对应已完成工具卡片包含该输出时隐藏，实时或独有输出保留；Claude `user` 仅过滤已展示的文本回显，后台完成通知、跨会话消息等独有内容保留。服务端事件和 transcript 不变。
- 按停止后回合结束显示中性行「已打断，可直接发消息继续」，不进出错态：Claude 认 driver 的 `interrupted:true`，Codex 认 `status:"interrupted"`，Kimi 认 `stopReason:"cancelled"`；见 [render-items.ts](src/render-items.ts)。
- Focus view 在「/」菜单切换并按浏览器保存：实时及历史隐藏工具、思考、调试和中性系统行，保留用户/助手、闸门/提问与错误；见 `focusVisible`、[HistoryTimeline.tsx](src/components/HistoryTimeline.tsx)。
- 历史预览、导入区共用 PagedHistory，首次最新 50 条并滚到底，nextCursor 向前 prepend，无原 500 条上限；旧页失败可重试，空窗口仍能翻页。导入首页使用 historyCursor 截止导入时刻，失效才回退最新页；见 [ResumedHistory.tsx](src/components/ResumedHistory.tsx)、[resumed-history.ts](src/resumed-history.ts)。
- 外部续聊通过 `external_messages_added` 入流，文本/工具/可用思考复用历史渲染；原生历史只读，不伪造缺失状态。超长正文仍可能截断，跨页工具结果不另补读；跳转已导入会话优先非 dead、再按活动时间，见 [history.ts](src/history.ts)。

## 终端与文件

- 终端入口只认 `meta.capabilities.terminal`，Ctrl+` 切换且忽略自动重复；首次打开懒加载 xterm，隐藏仅 CSS，实例、连接、PTY 保留。标签条列出全部未退出终端（激活的已退出终端也保留），同种 shell 按注册表顺序编号，「＋」菜单新建 bash/PowerShell；单 xterm 实例，切标签 = detach 旧的 + attach 新的并回放，激活 id 存 localStorage `workbench-term-active`，刷新优先重连；见 [TerminalPanel.tsx](src/components/TerminalPanel.tsx)、[terminal.ts](src/terminal.ts) 的 `buildTermTabs`/`pickBootTerminal`。
- 专用 `/ws/terminal` 每次 open 重新 attach，收到 attached 先 reset 再回放；省略输出给提示，resize 只在尺寸变化时发送。退避与回前台重连沿全局规则；kill 就地二次确认，exit 显示退出码、允许新建；见 [terminal.ts](src/terminal.ts)。
- 终端/派单宽默认 480px，clamp 至 `[320, 视口−480]`，窄屏全屏；手机 Esc/Tab/Ctrl-C/Ctrl-D/方向键与粘贴，Clipboard 失败退回手动 prompt，经 xterm.paste 处理。终端主题读 CSS 令牌，随主题/系统变化；契约见 [terminal-panel-design.md](../docs/terminal-panel-design.md)。
- 等宽字体优先本地 Maple Mono NF CN/Nerd Font，不下载字体；字体就绪或 1.5 秒超时重新度量 fit，不阻塞连接。终端字号默认按「宽屏 16 / 手机 13px × 整体比例」自动；设置里「终端字号」滑块（10–24px，localStorage `workbench-term-font`，按设备分开）设过就用设定值，见 `readTermFontSize`（[body-font.ts](src/body-font.ts)）。关闭尝试把焦点还给输入框。
- 文件面板宽单独记忆（默认 340、最小 320，容纳标题栏导航按钮），目录浏览与新建 cwd 选择共用 [DirectoryBrowser.tsx](src/components/DirectoryBrowser.tsx)。点文件打开当前预览，顶栏“返回”恢复目录；引用与复制路径是显式操作。引用仍要求当前非 dead、支持 mentions、cwd 内且相对路径无空白；打开文件不改变 cwd，见 [FilePanel.tsx](src/components/FilePanel.tsx)。浏览位置（`store.fileDirectory`）记录所属会话：同一会话收起再开沿用，切到其他会话时从该会话 cwd 开始。
- [FilePreview.tsx](src/components/FilePreview.tsx) 按点击读取，仅在 store 中保留当前文件：UTF-8（可含 BOM）文本最多 32 MiB，超过 4 MiB 时先显示大小与“仍然加载”按钮，确认后带 `large` 重新读取（超时放宽到 120 秒），直接在轻量文本框编辑并显式“保存”（源码中 Ctrl/Cmd+S 同效）；Markdown 源码/预览使用现有库，CSV/TSV 原文可编辑、表格最多200行100列且正确处理引号与字段换行。文本源码、Markdown代码块随面板宽度自动换行，仅改变显示，不向文件内容插入换行符。文本框编辑时浏览器将换行归一为 LF；未编辑的原文不重写。其他编码/二进制/Office及超限文件可见地拒绝编辑。图片原生显示；PDF只查看，以 iframe 导航至原生查看器，文件操作集中到单行顶栏，按“返回、引用、复制路径、外部打开”排列；普通文本（TXT、Markdown、CSV/TSV）第四个入口为“下载”，避免与原本也触发下载的外部打开重复。HTML保留外部打开与下载。下载前显示浏览器确认框，取消留在当前预览且保留草稿；确认下载已保存的文件，不自动保存未提交编辑。窄面板按钮显示图标（触屏图标 20px、按钮宽 39px，顶栏高度不变），保留可访问名称和提示；极窄时顶栏可横向滚动。预览/源码（CSV/TSV为表格/源码）复用终端的分段滑块，编辑文件的保存也在顶栏。移除重新读取与底部操作区，正常预览不显示路径、字节数、只读标签或浏览器查看器说明，保留实际错误与未保存提醒。`navigator.pdfViewerEnabled=false` 时直接提示未启用内嵌查看，不创建空白查看区；旧浏览器没有该字段时仍尝试内嵌。用户已确认本机 PDF 可以正常打开；其他设备仍取决于浏览器原生能力与设置。
- HTML 源码可编辑，预览用无权限 `sandbox` iframe + CSP，移除脚本/跳转等主动内容，仅支持内联 CSS 与 data 图片；相对及外部图片/CSS 不加载。Markdown 文件预览保留文本与表格，不自动加载图片或导航文档链接。媒体最多32MiB，服务端路径和版本约束见[文件接口契约](../server/README.md)。
- 未保存草稿在收起面板、切会话和手机后退时保留，重开面板可继续；换文件/返回目录前确认是否放弃，刷新关闭页面触发 beforeunload 提醒（由设备浏览器决定是否显示）。保存冲突或失败保留草稿，不能直接覆盖 Agent 的新版本；返回目录后重新打开可重新读取文件，仍需确认放弃草稿。保存中不能修改或切到其他文件。迟到读取不会覆盖当前文件，返回目录后重新打开可以重试媒体显示。
- Claude 的 `SendUserFile` 工具调用（input `{files,caption,display}`）不渲染成普通工具行，而是常显的“发送文件”卡片：标题旁显示 caption，每个文件一行（文件名 + 目录），`files` 按原始路径使用（不当作链接剥 `#`/`?`/行号或解码），相对路径接到会话 cwd 后，点击在右侧文件面板预览（root 规则同下方本地链接）；专注视图也保留，历史解析不截断该工具入参，调用失败时回落普通工具卡显示错误。`display`（render/attach）不区分。scratchpad 文件由后端 Claude 临时目录授权根放行。回归：`frontend/scripts/tool-card-title.test.mjs`。
- 当前、恢复与在外部继续的会话消息共用本地链接打开：以消息所属 cwd 解析相对路径，支持中文空格、Windows 盘符、`file://`、`vscode://file`、行号/片段；普通 http/https 网页仍新标签打开。链接的会话身份传入后端，授权根为 HOME、Windows盘、Claude 会话临时目录及已登记会话 cwd，逻辑/真实路径同时校验，目录外软链不可读取。新定向逻辑回归：`node --import tsx frontend/scripts/file-preview.test.mjs`。
- 本机支持原生选择窗口时，文件面板地址栏最左侧显示黄色文件夹按钮，悬停提示“Windows 浏览窗口”：调用 `/api/fs/pick-file`，以当前浏览目录为起点，显示所有扩展名文件；选中后直接预览，返回目录时浏览所选文件的父目录，不修改会话 cwd。取消保留当前目录，失败在面板内提示并保留网页导航。选择期间禁用导航与文件点击，关闭面板或切换会话后丢弃迟到选择；远程不显示原生入口。新建会话仍使用目录选择窗口。
- 新建工作目录和目录浏览地址栏支持粘贴 Windows 盘符绝对路径（如 `C:\Users\user\项目`，支持“复制为路径”的双引号），统一转换为 `/mnt/c/Users/user/项目`；Linux 路径保持原样。地址栏按 Enter（手机输入法“前往”键）读取目标，不再单设“前往”按钮，成功后才能选定目录；失败保留输入并提示，不选用上次目录（新建表单经 `onPathLost` 清空工作目录、禁用创建）。地址栏 Enter 只导航，不提交创建会话。
- 文件浏览地址栏默认显示可点击的目录层级，Linux从 `/` 开始、Windows挂载路径从 `C:` 等盘符开始；每层的title为完整路径，点击任意层直接导航。长路径横向滚动，进入目录默认露出末尾；点击空白处或分隔符切换完整路径输入，自动选中原地址，支持输入/粘贴、Enter前往；Esc放弃编辑并恢复当前目录层级，不关闭面板。层级按钮获得焦点时粘贴也可进入输入模式；成功导航返回层级显示，失败保留输入。输入与最近目录同栏，右侧箭头打开与地址栏动态等宽的主题菜单；菜单路径字号12px、行高1.35，长路径换行。复用浮层的外点/焦点关闭，支持方向键、Home/End、Enter选择与Esc返回下拉按钮；触屏条目至少44px。文件侧栏、文件选择弹窗和工作目录选择弹窗共用这一地址栏，不另显示路径层级行。第二行“WSL”打开主目录。文件侧栏地址栏右侧为“会话”（当前目录及子目录的对话）；地址栏下方是标签页行（沿用终端标签外形、换面板底色，桌面约34px、触屏约40px，低于地址栏），右端“+”新建标签页（会话 cwd）；目录行右键/长按菜单首项“在新标签页内打开”，文件夹在新标签浏览、文件在新标签预览（返回到其所在目录）。预览文件时标签行在顶栏下方。store 以 `fileTabs`/`fileTabId` 记标签，当前标签的目录与预览仍是 `fileDirectory`/`filePreview`，切走时存回标签（各标签的侧键返回记录由面板按标签保存，面板卸载即清空）；保存中不切换/新建，切走时中断的读取在切回时重读；关闭含未保存修改的标签需确认，beforeunload 覆盖所有标签；最后一个标签不可关闭；标签不跨刷新保存。
- 文件列表由 `DirectoryTable.tsx` 直接显示名称、大小、修改日期的紧凑表格（目录模式下标签行右端有「隐藏文件」开关，点亮＝列出 `.` 开头的隐藏项，默认点亮，按浏览器 localStorage `workbench-file-show-hidden` 记住，只在前端过滤；列出时其图标用 `--file-icon-hidden` / `--folder-*-hidden` 半透明变暗，名称不变；文件图标令牌 `--file-icon` 深色比 `--text-muted` 略亮），无目录列表iframe、大路径标题或额外上级目录行；沿用 AIReins 地址栏与导航。表体只在目录变化时创建文本DOM，排序复用 `directory-path.ts` 并只移动位置改变的行；类型图标用CSS背景绘制，不增加逐行框架状态或图标节点；文件夹使用独立的Windows黄色令牌，地址栏原生选择按钮和目录选择列表同步用黄。表头、名称、大小、日期均为14px，行高1.4、单元格上下2px留白；大小/日期保持单行，日期列155px，宽面板目录项约25px高，窄面板分行约50px，触屏行命中区域不少于44px。点击任一列打开该目录/文件，名称按钮也支持键盘；数据一律通过 `textContent` 写入，不解释文件名HTML。事件在表体集中处理，不需要模板脚本、消息转发或主题观察器。深浅主题、字体、Esc直接继承宿主；文件夹始终在前，未知元数据显示“—”并在同类末尾，零字节显示“0 B”、文件夹大小留空。窄面板把元数据放在名称下方，宽面板并排成列；排序不重新请求接口。旧服务端未带元数据时仍可浏览/打开；目录选择模式保留原列表。原Chromium组件/vendor源保留供历史对比，已不进入生产引用图。PDF/HTML预览自身的iframe用途保持不变。
- 文件面板「发送到设备」（Taildrop）：目录表格行右键/菜单键/Android 长按走 `contextmenu`，iOS 触屏自己计时 500ms（移动超 10px 取消，长按后吞掉随之而来的点击）；预览顶栏「发送」按钮弹同一菜单。[TaildropMenu.tsx](src/components/TaildropMenu.tsx) 复用 `SidebarActionMenu`，打开时读 `/api/tailscale/file-targets`，当前访问设备排第一标「（本机）」，离线设备禁用。选中后菜单关闭，面板提示「正在发送…」，请求结束显示结果或错误；文件夹由服务端打包为 zip 后发送。
- 文件面板把刷新、上一级（↑）、WSL、Windows 渲染进标题栏“文件”右侧（`DirectoryContents` 的 `navTarget` 门户；槽位未挂载时不渲染，弹窗仍用第二行内联按钮）。刷新重读当前目录及 Git 状态，不轮询、不监听。
- `/api/fs/dirs?files=1` 在 Git 工作区内并行跑 `git --no-optional-locks rev-parse --show-prefix` 与 `status -z -- .`（各 1.5s 超时），返回 `git`：直接子项名 → M/A/R/D/U/!，文件夹取其下最高状态。当前目录不在仓库时（如 `~/projects`），含 `.git` 的子文件夹各跑一次 `status`（并发 4、总预算 2s），取整仓最高状态，干净仓库不标。返回 `git` 时表格名称左侧留 14px 槽：文件显示字母、文件夹显示圆点，悬停提示含状态。非仓库且无子仓库、git 不可用或超时不返回该字段、不显示标记；见 [dir-list.ts](../server/dir-list.ts)。
- 新建表单（用户 10-16）：agent 按钮下只有一行「可直接粘贴目录」，下方直接内嵌目录浏览（`DirectoryContents`，地址栏＋上一级/WSL/Windows＋子目录列表，无「浏览…」和「选定此目录」），工作目录就是浏览器当前目录；桌面整块最高 40dvh，且目录列表按剩余空间限高，让「创建并进入」最低到侧栏一半处（ResizeObserver 跟随侧栏/表单尺寸，列表最少留两行，窗口过矮时才越过一半）；手机（≤720px）不限半屏，列表撑到会话列表区底部，超出时列表滚动；首条消息输入框单行；表单打开时侧栏临时拉到拖动上限（`.sidebar-new-open`，默认宽 ×1.5，已更宽则不变），创建或取消后回到原宽度；地址栏在非触屏下收紧（高 34px、层级按钮 28px 高/内边距 2.5px 4px、分隔符左右 1.5px、Windows 文件夹钮 35px 宽/图标 22px、最近目录箭头 30px 宽）；所有地址栏触屏统一按 41px 高（用户 10-16，原 44px）；触屏下最近目录下拉的路径 14px（桌面 12px）；「上一级」用文件面板同款圆形箭头钮（`upIcon`，高度跟随同行按钮），目录行上下内边距 4px。首条消息占位只写「首条消息（可选）」，「创建并进入」桌面上下内边距 4px（触屏仍 44px）。地址栏与文件子页面同一形态（可点的路径层级、点空白处编辑路径、右侧最近目录下拉）。本机入口 `meta.capabilities.windowsDirectoryPicker=true` 时地址栏左侧显示文件夹按钮，调用现代 Windows 文件夹窗口（PowerShell 7 WinForms），选定后浏览器跳到该目录；取消保留当前目录，失败在浏览器内报错。远程入口不提供原生窗口。最近目录取（本设备上次创建目录＋当前表单初始目录＋工作台会话，去重最多8个，原生 Windows 历史最多补1个）；手机可横滑路径层级或用“最近目录”选择电脑目录。
- 目录浏览打开时后台预取三家原生历史 `q=/mnt/&limit=1`，Windows 按钮比较历史与工作台最近活动的 `/mnt/` 目录，无记录用 `/mnt/c/Users`。按钮不等待历史；慢请求/失败期间用本地结果，返回后仅供后续点击，不自动改变当前目录。关键词也匹配标题，仅遇到非 `/mnt/` 目录时继续最小页，1.5 秒后不再追加请求；接口自身超时仍由 `api.ts` 管理。历史列表会遍历目录和 stat，并按需读取文件头/检查用户消息，不预取完整历史消息。

- 文件面板地址栏左侧的蓝色文件夹图标打开 Windows 浏览窗口，按钮比右侧最近目录下拉宽 4px，提供悬停提示；本机能力未确认或远程入口不显示。取消保持当前目录，选文件沿用原预览接口。WSL（弹窗第二行，文件面板在标题栏）打开 Linux 主目录，Windows 仍跳到最近使用的 Windows 目录。

## RC、释放与重启

- RC 胶囊仅 Claude，状态与 URL 由 session / `remote_control_updated` 驱动，失败原因可见于 title；快照/重连恢复，链接只打开 claude.ai。默认开启选项读写 Claude 启动设置；见 [SessionView.tsx](src/components/SessionView.tsx)、[SettingsMenu.tsx](src/components/SettingsMenu.tsx)。
- 远程 user 只在 connecting/connected/reconnecting 识别，排除子代理/合成消息，本机回显 FIFO 最多 20 条且不随 result 清空；worker 替换按设置/此前状态恢复 RC，见 [server/drivers/claude.ts](../server/drivers/claude.ts)。
- 「更多」保留「复制会话 ID」与「VSCode 继续」；复制项仅在有原生 id 时可用。「VSCode 继续」仅 idle 且有原生 id 可释放；成功复制 resumeCommand，失败退回 prompt，桌面尝试协议导航，手机只复制。释放不标 dead，输入框可再发，由后端磁盘续接；见 [SessionView.tsx](src/components/SessionView.tsx)、[server/README.md](../server/README.md)。
- 空闲释放档位 0/15/30/60/120 分钟，经 `/api/prefs` 保存，写失败回滚；running、待审批、RC 已连接等跳过，释放事件更新列表。设置重启先重读忙会话数，有忙会话时弹与清理存储同款的确认弹层（默认聚焦取消，「仍要重启」才继续），重启中/失败提示也用同款弹层，POST 202 后须观察 WS 断开再恢复，60 秒超时提示失败；见 [restart.ts](src/restart.ts)。「关机」先弹与清理存储同款的确认弹层（默认聚焦取消），确认后交给后端 `/api/power-off`：无忙会话直接关机，否则后端等全部完成再关；等待/已排定时按钮显示状态并可点击取消，此时菜单打开期间每 3 秒刷新状态。设置面板桌面两栏，各为一个 `.settings-col`：左「会话（底部存储占用与清理）│ 重启 AIReins」，右「外观 │ 主机（主机与连接、关机）」；手机按同序单栏。「主机与连接（Tailscale）」关闭设置并派发 `OPEN_HOST_MENU_EVENT`，直接打开左上角品牌按钮的主机菜单。

## 外观与通用边界

- 配色裁决以 [styles.css 顶部注释](src/styles.css) 为准：`--gate` 系专属闸门/提问/待处理，消息与终端内容有明确例外；终端 chrome 中性/冷色，会话状态点红绿灯。浅色外框 chrome、画布 bg、浮起 surface 分层，别把旧“暖色只用于审批”当完整规则。
- 主题三态、整体字号四档 0.9/1/1.15/1.25 保存本机，首屏内联恢复；localStorage 不可用回退默认。sidebar/main 使用 zoom，AI 用量 iframe 抵消 zoom，终端独立 fit；手机侧栏按百分比包含块铺满，≤360px 顶栏收紧间距，窄空间底栏允许换行；设置/直达浮层尺寸受缩放后的视口约束；见 [font-scale.ts](src/font-scale.ts)、[index.html](index.html)。
- 正文字号 13–20px、步长 0.5、默认 15，旧 22/无效值回退；作用于 stream 用户/助手/思考正文，代码块和工具细节用 `max(12px, 正文−2px)`（默认 13px），与整体 zoom 叠加；见 [body-font.ts](src/body-font.ts)、[styles.css](src/styles.css)。
- 界面字号：会话/历史标题、设置条目、通用按钮与表单标签用 14px（侧栏会话列表例外，用户 10-12 定：会话标题 14.5px、行尾时间 13.5px、分组标题 14px；手机 ≤720px 各大一档，用户 10-13 定：15.5px / 14px / 15px）；菜单、分组标题、胶囊、说明和系统行用 13px；时间、计数及元信息用 12px。其他界面主标题用 15px，大标题下调一档；品牌、终端字号与 AI 用量 iframe 保留独立规则。桌面输入默认 15px，触屏输入至少 16px 防 iOS 聚焦放大。浏览器把小于 14px 的文字放大到 14px 时，关键文案须完整显示；使用可增长的高度、换行或滚动，不用窄固定尺寸截断。侧栏底栏「历史」「额度」胶囊文字 13px、图标 18px、高 32px，内边距图标侧 9px、文字侧 12px、图文间距 5px（桌面与手机一致），质感同左上角主机按钮（内描边/高光/轻投影，描边用 inset 阴影不占宽度），打开后的「‹ 后退」为凹陷按下态；设置齿轮与直达不随字号缩小，保持 36px、图标 22px，用负外边距吃进底栏内边距，底栏高度仍按 32px 计；手机胶囊文字 14px、历史/额度图标 20px、齿轮与直达图标 24px；手机底栏的齿轮、历史/额度胶囊与直达统一 40px，行高按 34px 计、负外边距吃进内边距，底栏比 32px 时只高 2px（用户 10-16）；放不下一行时先收起历史/额度图标、只留文字（内边距 10px），「后退」收紧为 8px/间距 3px（桌面按底栏容器宽度，英文 ≤281px、各语言 ≤233px，英文 ≤235px 再收到 6px 且「后退」去掉箭头；手机英文 ≤409px；按 `<html data-locale>` 区分），仍放不下才换行（目前仅英文 + 最小字号 14 + 224px 最窄侧栏），触屏命中区至少 44px。
- 主题切换复用 [Segmented.tsx](src/components/Segmented.tsx)，保持单选/方向键和禁用语义，滑块按实际布局度量；减少动态偏好关闭动画。设置浮层限高滚动、focus trap、Esc/外点关闭并还焦点。
- 会话移除行内二次确认，Esc 取消，成功清本地状态/草稿并作废旧请求；只移除工作台条目和停 worker，原生 transcript 保留。手机左滑 80px 露入口，10px 锁方向，纵向保留滚动，同刻只展开一行；见 [Sidebar.tsx](src/components/Sidebar.tsx)、[store.ts](src/store.ts)。
- 设置存储面板打开时读一次，清理需弹窗确认，可选移除结束会话；清理只涉及工作台副本，原生记录保留，返回最新统计再刷新会话列表；见 [WorkbenchStorage.tsx](src/components/WorkbenchStorage.tsx)。
- 不引入 UI/图标/路由库；图标用 Unicode/内联 SVG，错误与禁用原因尽量可见。所有输入/审批/配置按后端能力与状态约束，`riskyMode` 警示不能替代实际 driver 权限契约。

## 只做过代码或打桩复核的前端路径

需要用户真机看的事项统一记在仓库根目录的本地 `HANDOFF.md`（若有，不入库）「等用户真机看 / 确认的」；这里只列日常使用碰不到、仍只有代码或打桩证据的路径：

- Codex 图片附件 `localImage` 只核对过协议与单测，未真实投递；iOS 文件三选项、拖放、HEIC→JPEG canvas 压缩未真机。
- 中文 IME 组字状态下 `/`、`@`、`$skill` 面板的筛选与键盘交互。
- 终端 kill 时恰好断线后的退出码恢复、断线后重复 attach/reset。
- 快照分页：加载失败后点提示重试、图片/Markdown 异步撑高时的阅读位置（只做过 DOM 接线复核）。
- 设置面板 focus trap / 焦点返回、`prefers-reduced-motion` 的真实键盘与浏览器流程。

- 左下扩展页面入口（包括 AI 用量）打开后变为“‹ 后退”，再次点击收起页面并回到会话列表；图标态也保留返回箭头和可访问标签，与历史会话一致。

- 会话菜单的「删除」已改为「移除」；其下方「彻底删除」打开模态确认框，列出完整标题、工具与原生ID，说明无法恢复。默认聚焦取消，支持Esc/遮罩取消和Tab循环；进行中不可取消/重复提交。Codex/Kimi可确认；Claude菜单不显示彻底删除，缺失原生ID显示原因并禁用确认；执行中/后台任务需先停止。成功清除会话状态、草稿、选中的原生历史并触发历史重载；失败保留弹层及AIReins条目。新增前端调用专用接口，旧后端返回404，不误执行移除。见 [PermanentDeleteConfirm.tsx](src/components/PermanentDeleteConfirm.tsx) 与 `.work-orders/2026-10-05-permanent-session-delete/REPORT.md`。

## 平台入口（2026-10-12）

界面使用 `/api/meta` 的 `platform` 和 `capabilities`，不以浏览器操作系统猜测后端平台。能力缺失或 false 时隐藏入口：`appWindow` 控制 AIReins 独立 App 窗口，`windowsDirectoryPicker` 控制文件/目录/历史的原生选择按钮，`powerOff` 控制关机，`powershell` 控制终端 shell 选择，`taildrop`/`folderTaildrop` 分别控制普通文件/目录的发送菜单。目录行的「在新标签页内打开」始终可用，不因 Taildrop 缺失而隐藏。

`windowsPaths` 为 true 时保留 WSL 主目录、最近 Windows 目录和盘符转换；否则按钮显示「主目录」，不预取 `/mnt` 历史，不提供 Windows 导航/提示，输入与文件链接不转换盘符，`/mnt/c` 按普通 POSIX 目录显示。新建会话、历史目录筛选、文件面板和消息文件链接沿用同一能力判断。前端不展示托盘或网关安装入口；后端字段用于平台契约。

macOS 实验性 `fileEdit:false`：文件 metadata 的 `editable` 同时为 false，源码只读、保存按钮隐藏，后端拒绝写入。`folderTaildrop:false` 时目录行菜单仍允许开标签页，隐藏设备发送项并不请求 Taildrop 列表。远程 `terminal` 仍仅在 remote.json 显式 true 时可见。所有 API 继续独立验证访问控制，UI 隐藏不承担授权职责。

## 中英双语界面

轻量入口 [i18n.ts](src/i18n.ts) 合并 `src/i18n/` 内的 `core`、`ui`、`server` 三组 `zh-CN` / `en` 词典，无新增依赖。默认按 `navigator.language` 选择：`zh*` 使用简体中文，其他使用英文。设置「外观 → 语言」可选跟随系统、中文、English，偏好以 `workbench-language` 保存到浏览器 localStorage，沿用字号/字体的本机偏好机制；切换后整页刷新生效。各浏览器独立保存；无法读取存储时跟随系统。页面 `lang`、数量、日期和相对时间使用所选语言。窗口标题随语言输出（`core.131`–`core.133`）；Windows 托盘的 `IsWbTitle` 同时识别中英文标题与升级前的旧格式。

新增文案时在对应两份词典中添加相同键，组件调用 `t(key, {name: value})`。动态值使用 `{name}` 占位符，不在调用处拼接汉字；`{product}` 由入口统一替换为 `PRODUCT_NAME`（定义在 `shared/product-name.ts`）。数字参数自动按语言格式化，日期/相对时间使用 `formatDate` / `formatRelativeTime`；原始 ID 和版本号作为字符串传入。英文数量文案用复数语法 `{name, plural, one {…#…} other {…#…}}`（`#` 为格式化后的数量，规则见 TERMS.md）；中文不需要复数。术语以 [TERMS.md](src/i18n/TERMS.md) 为准。服务端自产文案的 `i18n` 元数据在 API / WS / 终端接收入口译成显示字段，旧信封和未知键保留原文，用户/模型正文不翻译；接口详见 server README。

提交前运行 `npm run check:i18n`：使用现有构建工具的 TS/TSX parser 查中文字面量（不检查注释和 console 输出），检查两份词典键集、空译文、参数占位符（含复数块）、英文中文残留，以及英文「数字占位符 + 可数名词」必须走复数语法（误报在 `pluralExceptions` 登记）。兼容性/数据识别/校准例外逐条登记在 [check-i18n.mjs](scripts/check-i18n.mjs)，历史 vendor 模板以精确 hash 固定。同一命令还运行服务端覆盖守卫 [check-server-i18n.mjs](scripts/check-server-i18n.mjs)：`server/` 非测试源码里每处中文字面量必须匹配 `server/i18n/coverage.json` 已登记模板或带原因的例外；新增未登记文案、模板已删或行号漂移都会失败并给出修复提示。已有文案测试通过 `i18n-zh.mjs` 在模块加载前固定中文；`npm run test:i18n` 覆盖语言选择、插值、复数、回退、服务端元数据、覆盖守卫与英文视图渲染。

## Tibo 额度重置提醒

设置 → 会话 →「Tibo 额度重置提醒」默认关闭；开启后服务端固定每 10 分钟查询 AIHOT。`CodexResets.tsx` 在 App 全局以 portal 渲染公告弹窗，沿用目录弹窗、主题令牌和键盘焦点约束；正文优先中文，原文可折叠，上下文以引用显示，适用范围以「适用：…」标注。多条按最新逐条确认；「知道了」通过共享 ack 与 `codex_resets_updated` 控制帧同步所有页面。Esc 只收起本端当前弹窗，不代替确认；刷新或重连后仍可恢复未读。去额度页不写 ack。

`ai-usage` 的 PageView 顶部独立渲染紧凑卡片（包括 iframe 不可达时），展示待生效时间、推算标识、相对倒计时，或最近一次事件（一行：「最近一次：重置 / 重置卡」+ 右侧相对时间，时间即原帖链接）；「最近 5 个事件」与「数据来源 AIHOT」同一行，展开后列表占满整行、数据来源换到下方；监控过期显示中性提示。iframe 代理与 sandbox 决策保持原样。底栏入口仅追加绝对定位圆点，不参与布局，保持底栏高度（桌面 43px、手机 45px）与既有窄宽度换行规则。状态在全局 WS 每次连通时取 GET，并以版本戳防止旧请求覆盖新帧；不由浏览器轮询 AIHOT。
