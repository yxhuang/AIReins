# AIReins 前端

Vite + React + TypeScript 调度台，将 Claude Code、Codex、Kimi 会话放在同一列表，跨会话显示审批与提问。本文记录现行开发约定；接手规则与后续待办见根目录 [AGENTS.md](../AGENTS.md)，接口契约见 [server/README.md](../server/README.md)。

## 构建与开发

在仓库根目录执行，依赖安装在根 `node_modules`：

```bash
npm install
npm run server                 # 后端默认 :8790；从 / 托管 frontend/dist
npm run dev                    # Vite :5173，需后端先启动
npm run build                  # frontend/dist + 静态资源预压缩 + 7 天旧资源清理
npm run typecheck              # 根配置：后端与 spikes
npm run typecheck:frontend     # 前端独立 tsc --noEmit
npm test                       # 前后端聚合回归
node frontend/scripts/smoke-ws.mjs  # 需后端；会创建测试会话、批准闸门并校验落盘
```

开发代理包含 `/api`、`/pages` 和 `/ws`，目标为 `127.0.0.1:8790`；配置见 [vite.config.ts](vite.config.ts) 与 [package.json](../package.json)。没有 `@vitejs/plugin-react`，automatic JSX 下开发热更新退化为整页刷新。

`frontend/dist/` 不入库。`install.sh` 安装/更新时执行 `npm run build`（含预压缩），构建失败则安装失败；`aireins` 启动前缺少 `frontend/dist/index.html` 时也会自动构建，失败则退出。构建使用 `emptyOutDir: false`，保留已打开页面引用的旧 hash 资源，不要清空 dist。预压缩后运行 [prune-assets.mjs](scripts/prune-assets.mjs)：根据当前 `index.html` 与 Vite manifest 的静态/动态 chunk、CSS 和资源引用链，只删除 `dist/assets` 中未被引用且原资源 mtime 早于 7 天的文件，并删除其 `.gz` / `.map` 伴生文件（伴生文件沿用原资源年龄，避免预压缩刷新 `.gz` 时间后无法清理）。当前构建的被引用资源即使超过 7 天仍保留；缺失或损坏的 manifest 不执行删除。回归只在临时目录构建和清理，见 [prune-assets.test.mjs](scripts/prune-assets.test.mjs)。
针对功能可用根目录 `test:*` 脚本；直接运行前端逻辑测试用 `node --import tsx frontend/scripts/<name>.test.mjs`。`check:theme` 当前只检查文件浏览与侧栏入口样式，不能替代完整主题检查。

## 架构

- [App.tsx](src/App.tsx) 管布局，hash 路由由 [store.ts](src/store.ts) 处理：`#/new`、`#/session/<id>`、`#/history`、`#/page/<id>`、`#/dispatches` 及派单详情/多单高亮链接。
- 主页始终显示新建表单；侧栏「新建会话」取消当前会话选择并跳 `#/new`、聚焦首条消息（手机/触屏不自动聚焦，免得输入法遮住目录选择）。手机（≤720px）`#/new` 以主区全屏显示，返回按钮与系统前进/后退沿用完整路由快照并恢复所选目录；文件、终端、派单的往返也保留该目录。手机从新建表单提交后，`navigateCreatedSession` 替换新建页为会话，返回列表；来源不是列表或直接打开新建链接时，先把新建条目替换为列表，再进入会话，确保按钮、手势、系统后退和刷新后的返回都不回已提交表单。未提交的新建页与面板往返仍保留目录，桌面提交沿用原导航。手机另有 `#/terminal`、`#/files`；会话与面板导航 push 完整视图及来源到 `history.state.workbenchNavigation`，系统后退/前进恢复对应会话和面板。返回/关闭按钮确认本次运行的上一条是来源时用 `history.back()`，冷启动或刷新后无法确认则 `replaceState` 回来源（无来源回会话/主页）。桌面面板共用一条 `history.state.workbenchDesktopPanels` 记录，保存当前视图和左右侧打开顺序；目录浏览状态下，鼠标侧键/浏览器后退先按本次文件侧栏的成功访问历史逐次返回目录（可为无关路径，不等同上一级）；目录返回失败保留当前列表和历史，加载期间不重复请求；没有目录历史时关闭最近打开的一侧，左侧历史/额度回会话标签列表，右侧文件/终端/派单收起，另一侧和当前会话保留。同侧切换不重放旧面板；文件预览状态仍按面板后退保留草稿。目录历史在文件面板组件内保存，预览/返回时保留，收起再开/切会话/刷新重置；工作目录/附件弹窗和手机全屏路由保持原行为。普通文件/终端仍保持会话 URL；关闭按钮只消耗本次运行亲自创建的面板历史，刷新后用 replace；缩到手机时转换为手机路由快照。
- [types.ts](src/types.ts) 对应后端类型，[api.ts](src/api.ts) 处理 REST 信封与错误；后端是会话记录、能力位、配置选项的事实源。
- [render-items.ts](src/render-items.ts) 统一事件归一、工具配对/分组、闸门与提问；[StreamItems.tsx](src/components/StreamItems.tsx) 渲染实时块，[HistoryTimeline.tsx](src/components/HistoryTimeline.tsx) 复用到历史和外部续聊。
- 终端和派单视图按需加载；主会话在右侧面板打开时保持挂载。终端、文件、派单互斥，窄屏 ≤720px 面板全屏；入口共用 [PanelActions.tsx](src/components/PanelActions.tsx)，从左到右为文件、派单、终端（用户 10-16 把派单换到终端前面），手机会话入口在「更多」菜单（同序）；手机列表页顶栏只留文件大圆钮，派单、终端收进其右侧「⋯」（`MobilePanelLauncher`，用户 10-17，新建行多了搜索钮后三颗放不下）。
- 手机会话顶栏（实际 `.session-head`）与新建顶栏（`.view-panel-actions.mobile-topbar`）共用 44px 圆钮、22px 图标，以及手机底栏的 `--raised-bg`、`--raised-shadow-soft`、`--border-strong` 描边；悬停用 `--raised-bg-hover`，按下/展开用 `--sunk-bg` 与 `--sunk-shadow`。品牌按钮及桌面会话按钮不变，菜单条目不套用圆钮。新建页复用 `PanelActions`，保留返回、文件、派单、终端（按能力位显示）；三项面板均为工作区级，无需会话 ID，不加入复制会话 ID、续接等会话专属操作。
- 桌面顶栏共用的圆钮保留 32px 视觉外观，使用 40×40px 点击区域且不增加顶栏高度；水平按钮预留空间，视觉间距约 12px、点击区域之间保留 4px 空隙，覆盖侧栏刷新/收起、会话面板入口/更多及右侧面板圆钮。窄侧栏品牌文字可省略，按钮保持可点；手机尺寸规则沿用现有布局。

### 状态模型

- 单一 `Store` 经 [useStore.ts](src/useStore.ts) 的 `useSyncExternalStore` 订阅；优先 selector 与稳定引用，派生 tuple 用 `shallowEqual`，避免每次通知重绘全部组件。
- `sessions` 保存列表摘要；未打开或事件缓存已淘汰的会话只更新标题、seq、未决数与状态，不预取全部快照。按 `sessions` 引用失效的 id 索引提供会话查询；徽标和窗口标题聚合直接用正在遍历的摘要计算待审批数，避免重复查找。标题优先后端 `session.title`，首条结构化命令可从 `/name 参数` 派生，兼容事件派生见 [shared/session-title.ts](../shared/session-title.ts)。主会话桌面/手机顶栏固定显示开头 12 个可见字符，超出追加省略号；左侧会话标签按字体和当前行可用宽度实际截短 DOM 文本及悬停提示，拖动侧栏/缩放字号后重新计算。原标题保留在记录与重命名输入中；截短逻辑见 [SessionTitle.tsx](src/components/SessionTitle.tsx)。
- `data` 按会话保存已加载事件、replay 游标、分页游标、未决闸门、用量/缓存信息；事件缓存（含在途快照）最多保留 4 个会话，保护当前会话，其余按最近访问淘汰，后台输出不延长保留。淘汰前把 seq、待审批数写回列表摘要，作废旧快照/旧页并清理重放缓冲、命令与文件查询缓存；未落地事件沿未加载路径吸收摘要，再次打开取现有尾部快照。发送暂存与配置操作状态保留到回执，防止丢失拒绝后的输入恢复。配置、RC、后台任务来自会话记录。普通事件推断状态；未知会话或非流式事件后以 2 秒防抖重拉权威列表，补齐 idle/error、processId 等信息，列表不覆盖较新 WS 摘要。
- 流式文本、思考、工具更新和调试事件通知按 `requestAnimationFrame` 合批；seq 即时推进，列表可见状态不变且活动时间距上次发布不足 1 秒时保持 `sessions` 与行对象引用，不触发列表重拉。侧栏会话行用 `memo` 隔离无关变化，排序复用每个摘要的活动时间解析结果。其他通知立即发出。活动会话时钟每秒更新，全局空闲改为 30 秒；实现见 [store.ts](src/store.ts)。

### 连接与恢复

- 首次加载并行发起元数据、会话列表、项目排序和扩展页请求；当前会话恢复只等待列表及自己的快照，随后建立 WS，不等待排序和扩展页。元数据独立到达后校验面板能力并通知界面；后台 CLI 探测完成的 `meta_updated` 帧触发补取，建连时 pending/尚未获取的元数据也补取，迟到的旧响应不能覆盖新结果。无 pending 字段的旧后端沿用一次读取。
- 一条全局 `/ws` 收所有会话事件。首连/重连刷新列表，对已加载会话发送 `{type:"replay", sessionId, afterSeq}`；`replay_complete` 后顺序应用缓冲帧，不再对每个会话一律重取快照。
- 快照请求去重并带代次戳，期间实时事件先缓存；响应原子替换旧窗口后追加较新帧。只接受推进 seq 的持久事件，重复帧忽略；临时工具更新按 `toolCallId` 单独保存在 `toolFrames`，不改持久事件数组、不推进游标。render-items builder 在缓存的工具显示行上叠加临时参数，只重绘对应行；最终参数或完成事件移除临时帧，迟到临时帧不能覆盖最终值。缓存、流式摘要、临时参数和文件补全回归见 [review-fixes.test.mjs](scripts/review-fixes.test.mjs)。
- 快照请求失败后应用已有窗口可验证的连续缓冲帧，并照常触发权威状态刷新；有缺口时保留事件等待重试，不猜测缺失内容。首次加载和重新对齐失败均保留就地「重试」入口，重试期间保留已有对话；旧请求不得覆盖新代次的错误状态。
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

- 左上角 **AR 标志（`BrandMark`：单色随文字色，粗笔画、宽字形，R 是一根带缝线的皮缰绳摆成、尾端绕成缰绳圈；高 18px（收起态 16px）放进 35px 按钮，不改变顶栏高度；启动页同一标志放大到 64px；应用图标 `public/icon.svg` 同形）｜当前主机** 整体为主机选择按钮（描边/高光/轻投影，无小箭头）：本机入口显示「本机」，远程用 Tailscale MagicDNS 机器名；窗口标题同步连接身份且保留未决闸门计数。300px 菜单的本机项显示「机器名（本机）」；本机名来自 meta.hostName，并随来源返回上下文携带；旧后端缺字段时回退「本机」，需要后端重启后生效。菜单支持整页切换、新标签和管理主机，设置「主机」组的「主机与连接」直接打开此菜单。地址只存浏览器，通过经过校验的 fragment 带到目标源并在 `store.init()` 前消费；目标列表合并保留，手机直接远程不产生 localhost 返回入口。文件保存/未保存与未发送输入有保护，切换不操作后台任务。连接与两机安装见 [主机连接说明](../docs/host-connections.md)，逻辑在 `host-connections.ts`，控件在 `HostSwitcher.tsx`。

- 底栏第一行「历史会话 │ AI 用量等扩展页」（可换行），第二行「设置、直达」；直达为200px浮层，锚定直达按钮上方8px、右边缘对齐按钮，向左展开；链接去掉默认及行末箭头，保留配置的图标，打开时刷新 `/api/links`，按仓库 `pages/links.json` 与用户数据目录 `~/.workbench/pages/links.json`（可由 `WORKBENCH_HOME` 覆盖）合并后的 group 分组，以普通新标签链接打开。输入框有文字时，Claude/Codex 的 R 在末尾追加 `/refine-prompt` / `$refine-prompt` 并保留焦点（会话页与新建页同一逻辑，新建页的 R 在输入框右下、发送键上方）；手机替换缓存时间槽位，Kimi 暂无确切 skill 语法而隐藏。收起态侧栏宽 48px（用户 10-13 由 52 收窄），底栏按钮与顶部刷新、展开同为 32px 圆形浮起钮、图标 20px，从下到上为设置、历史、扩展页面、直达（同展开态从左到右）；桌面收起态的设置与直达浮层改为 fixed，贴侧栏右侧（left 56px）弹出、底边对齐侧栏底部，不被侧栏 overflow 裁切。

- 活跃目录候选沿用 `status !== "dead"` 且最近 72 小时（含边界）的工作台会话，`running` / `starting` 不限时间；当前打开的旧非 dead 会话临时保留，切走后重新按窗口归类。未决闸门始终先进入「等待处理」，置顶豁免 72h 并保留 dead；两者不重复进入目录组。复用 `store.now` 时钟，不另加轮询。
- 「等待处理」→「置顶」→ 活跃工作目录 →「较早的项目」折叠区，是侧栏唯一结构；每个会话只出现一次，组内按最后活动倒序。目录身份是规范化完整 cwd（重复 `/`、`.`、`..`、非根尾 `/` 合并，保留大小写），不并入父目录；会话带 `worktree`（cwd 在 git 链接工作树里）时改用其主仓库路径，归到主仓库目录下，行尾以小字显示分支名、悬停看完整 cwd；搜索也匹配主仓库路径与分支名。项目头「历史」仍只按主仓库路径及其子目录筛选，放在主仓库目录之外的 worktree 的原生历史不在其中。标题取末级目录，同名补最短可区分父级，home 显示 `~`。悬停显示完整路径，仅 `meta.capabilities.windowsPaths` 为真时将 `/mnt/<盘>/…` 显示为盘符，身份不变。选择器与状态点规则在 [sidebar-sessions.ts](src/sidebar-sessions.ts)；空闲绿点只表示最近 2h（含边界），running / 后台任务 / 错误 / 未决闸门不受此窗口影响。
- 目录标题用线条文件夹图标表示展开/折叠（打开/合上），保留 aria-expanded。目录默认折叠；组内 `sidebarStatusDot` 为 running / starting / needs-user（含后台任务）或包含当前会话时自动展开，工作结束后自动折叠。用户点击标题后以手动选择为准，按完整路径在本设备 `aireins-project-folds` 保存 `{[path]:"open"|"closed"}`，覆盖自动规则；localStorage 异常时保留内存态。搜索时全部展开；旧 `aireins-collapsed-projects` 不读取、不迁移、不删除。折叠标题显示会话数及运行 / 后台任务 / 错误 / 待审批的聚合点。组标题「+」跳主页新建并预选目录，重复点击会重新定位目录并保留已填消息、agent 和配置；⋮ 支持上移 / 下移及「在历史中查看此目录」，手机命中区至少 44px。桌面原生拖动标题时只改本地预览，放下后发一次移动操作；手机及键盘通过 ⋮ 操作。服务端 `project-order.json` 保存完整顺序，新目录首次登记到最上，已有目录不自动移动；移动以可见相邻目录为目标，暂时不可见的目录保留在服务端列表中。
- 没有活跃候选、但仍有非 dead 会话的目录收进列表末尾「较早的项目 · N / Older projects · N」；目录按最新活动倒序，同名消歧跨两区一致，活跃目录仍只列原窗口候选。较早区使用箭头，默认收起，设备 localStorage `aireins-older-projects-open` 以 `"1"` / `"0"` 记忆手动状态，读写异常保留内存态；搜索有匹配时自动展开。内部复用同一目录标题、+、历史入口与阶段 C 折叠规则，但不允许拖动，⋮ 不提供上移/下移。过窗后台会话仍按既有 active 规则归较早区，不扩张时间窗口。
- 每个活跃/较早目录按最近活动保留前 8 条普通会话；running / starting / 后台任务、needs-user 与当前会话豁免，不占 8 条名额，合并后仍按活动倒序。标题计数及聚合点使用完整候选。目录末尾「显示更多 · N / Show more · N」原地显示全部候选并变为「收起」，展开只存组件内存，刷新复原；搜索不截断且不显示此按钮。较早区标题、目录标题及更多/收起在手机的命中区至少 44px。纯逻辑见 `selectSidebarSections` / `selectProjectSessions`。
- 新建行右侧放大镜只显示图标，有 title / 无障碍标签；打开后整行变为自动聚焦的搜索框，Esc 或清空后失焦恢复。按会话实际显示标题（含本地化空标题回退、事件标题）和 cwd 忽略大小写过滤置顶与目录内会话，隐藏空目录并忽略折叠；「等待处理」始终完整显示。末尾「在历史中搜索」清除旧目录筛选，给历史搜索一次性预填；路径文本与手动输入走相同解析。48px 收起态不显示搜索。
- 会话行 ⋮ / 右键 / 手机 500ms 长按菜单顶部只读显示完整 cwd（含置顶与等待处理会话），操作为置顶 P / 重命名 R / 移除 D / 彻底删除；后两者沿用原确认流程和能力限制。手机左滑 52px 露出 ⋮，方向锁定不妨碍纵向滚动。菜单保留 ↑↓ / Esc / 外点关闭，重命名 Enter / 失焦保存、Esc 取消，空串恢复自动标题。已删除手建分组及「移到分组」。组织变更通过 `session_organization_updated {sessions, projectOrder}` 同步；启动及 WS 重连读取服务端顺序，迟到 REST 不覆盖新广播。移除当前会话后按侧栏候选顺序选择下一项。部署这次帧变更后，电脑和手机所有打开页面均需刷新；后端仍由用户择时 `aireins restart`，旧 `session-groups.json` 不自动删除，可由用户自行处理。
- 已结束会话从「历史会话」查找，超窗的非 dead 会话可从「较早的项目」或历史查找；工作台记录带「工作台」来源标签；已移除「N 个工作台会话」折叠。预览底部「打开会话」仍能进入主列表外会话：已释放的原会话可发送并原地续接，dead 显示「新建会话并续接」，不因当前打开而进入主列表；手机后退/前进仍恢复历史预览/列表。
- 「历史会话」及扩展页内容覆盖侧栏会话区，底部入口不重排，同刻只开一个；标题/收起/Esc 关闭。会话列表保持挂载但不可聚焦，关闭恢复滚动；见 [Sidebar.tsx](src/components/Sidebar.tsx)。扩展页不做任何缩放适配，比一屏高时页内滚动（用户 10-16，Tibo 卡片占高时也一样）。
- 桌面保留当前会话并恢复路由；手机历史列表与全屏预览共用 `#/history`，由版本 1 的 `history.state.workbenchNavigation.route.historySelection` 区分。列表点行 push 预览，预览换选 replace 当前 state；系统后退回列表、前进恢复预览，列表再后退回进入列表前的来源。列表持续挂载，保留筛选/分页/滚动位置。刷新后仍恢复预览；主动返回只有确认本次运行的前条是列表才 back，否则 replace 回列表（无列表来源的旧 state 也只清预览）。桌面选择/返回仍不新增 history。关闭历史或换页后再打开重新加载；旧 history/page hash 仍可进入。
- 历史列表每页 150 条，关键词 250ms 防抖，agent 由后端筛选；来源只过滤已加载条目并明示范围。空会话隐藏，`truncated/skipped` 为中性说明，导入对照 `agent + nativeSessionId`。历史面板选定目录时，左上角「新建会话」跳主页并以该目录为默认工作目录（原「在此目录新建会话」按钮已并入）；见 [HistoryView.tsx](src/components/HistoryView.tsx)、[history.ts](src/history.ts)。
- 扩展页只在启动取列表，未知类型跳过；只在打开/重试时查 health。健康检查与页面加载共用固定的主题底色和加载提示；通过检查后立即加载 iframe，等 `load` 及随后一帧绘制完成再显示，避免手机闪白，收起/重试会取消待显示回调。不可达或 `embeddable:false` 不挂 iframe；true 正常嵌入，null/缺省保留空白提示与新标签出口；见 [PageView.tsx](src/components/PageView.tsx)、[pages.ts](src/pages.ts)。
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

- 主页新建 cwd 优先取组标题「+」或历史入口显式带入的目录，否则依次取上次成功目录、最近活跃会话目录、meta.defaultCwd；meta / 会话列表晚到且尚未选择时补填，用户选择后不覆盖。空值禁用提交并显示原因，成功后才记忆目录。创建显式 `snapshot:"skip"`，不走历史快照预检弹窗；见 [NewSessionForm.tsx](src/components/NewSessionForm.tsx)。
- 主页使用紧凑品牌分段按钮、最大约 800px 输入卡片（最小高 88px、自动增高、40dvh 上限），以输入卡片本身为准、在整个主区（含顶栏）垂直居中：顶栏绝对定位浮在上方不占高度，主区上下等距留白（桌面 56px、手机 64px）不压顶栏；App 把标志作为 children 传给 `NewSessionForm`，与 agent 切换组成卡片上方的 `.new-form-head`，地址栏一块为 `.new-form-foot`，两块等分剩余高度；目录列表绝对定位浮在地址栏下方、不占布局高度，展开不挪动内容，高度由 `DirectoryContents` 量到视口底（至少 120px），超出在列表内滚动、首页不出现滚动条；卡片底栏依次为附件、命令插入、模型/档位/权限胶囊与圆形「创建并进入」发送键；项目为卡片下方与卡片同宽的内嵌地址栏（见下条「主页新建表单」）。手机保留 `#/new` 全屏与历史导航，触控目标至少 44px（含附件移除、命令候选及 WSL/Windows/浏览文件夹按钮）。
- 新建页命令只使用已加载的本机 `store.commands`：优先同 agent 同目录的最近会话，其次同 agent 最近的非空表；不预取其他会话。Codex 仅保留 `/review`，Claude/Kimi 排除侧问、MCP 面板、压缩/清理、上下文/用量/状态/任务、续接/回退/导出/退出、模型/权限/配置/Thinking/Fast 等已有会话动作，其余命令只插入文本。无候选禁用并说明；行首 `/` / `、` 补全支持 ↑↓、Enter/Tab 填入、Esc 关闭，IME 不触发。
- 首条消息不传 `initialMessage`；创建后使用 `store.sendComposerInput`，命令结构化和附件 mentions 与会话输入框共用。上传 API 要求真实 sessionId，因此点选/粘贴/拖放先暂存在页面内存，建会话后用同一 `prepareImageForUpload` 与 `/api/uploads` 上传。上传失败保留输入及附件，重试复用已创建会话且不重传已上传文件；为避免目录/agent/配置与该会话不符，重试期间锁定这些选项。上行失败通过 `restoreComposerSend` / `sendTextRestore` 回填到目标会话，异步拒绝也沿用原机制；不覆盖用户新输入。页面卸载回收本地图片预览，不保证未上传附件跨刷新保存。
- 新建模型胶囊的 Claude 跟随值来自 `meta.claudeDefaults`（只读用户设置）；Codex/Kimi 来自 option.default 与各模型 defaultsByModel。下拉保留「跟随配置」，没有可确认值才显示原默认文案；会话输入框仍优先运行时 effective 值。
- 配置值/可变性来自 meta，胶囊优先显示会话覆盖、有效值、后端默认。`config_updated` 才回写，切换中禁用；restart 项说明重启续接代价，next_turn 提示下一轮生效。推理滑块拖动只改草稿、松手提交，键盘停 600ms 或关闭时提交；见 [ConfigMenu.tsx](src/components/ConfigMenu.tsx)、[config-view.ts](src/config-view.ts)。
- 草稿按会话内存与 localStorage 保存，刷新可恢复；成功仅清本次文本，异步发送不覆盖新输入，失败保留。dead/error 提供同 agent/cwd/nativeSessionId 新建续接，无原生 id 给出原因；见 [store.ts](src/store.ts)、[SessionView.tsx](src/components/SessionView.tsx)。
- 输入栏 Permission 左侧显示上下文圆环，悬停/键盘聚焦显示约占百分比；Codex 取最新请求 `usage.last.totalTokens / modelContextWindow`，Kimi 取 `used / size`，Claude 在打开及回合用量更新后调用现有只读 context 接口。缺失数据显示未知，不用累计 token 猜测，不轮询或唤醒已释放 worker。
- 手机输入栏 Codex 权限标签缩写为 `Ask / Auto / Full`，桌面和权限菜单仍显示完整名称；圆环两端均显示，模型名可按剩余宽度截短。输入框聚焦时（键盘弹起）去掉 `.app` 底部安全区留白、`.composer` 底边距收到 4px；iOS 弹键盘不缩 `100dvh` 而是平移可视视口，所以手机键盘打开（`visualViewport` 比 `innerHeight` 矮 120px 以上且未双指缩放）时 `main.tsx` 给 `<html>` 加 `data-keyboard`，`.app` 改为 fixed 并按 `visualViewport` 的 offsetTop/height 铺满可见区，输入框贴住键盘；键盘上方的 ∧ ∨ ✓ 条是 iOS Safari 系统表单辅助栏，网页无法隐藏（用户 10-16）。
- `/` 行首触发命令，`@` 在光标处 token 触发；↑↓/Enter/Tab/Esc 保留 textarea 焦点，IME 组合期间不触发/发送。命令表由快照、REST、WS 更新，是否结构化发送由能力位决定；见 [commands.ts](src/commands.ts)、[SessionView.tsx](src/components/SessionView.tsx)。
- `@` 面板显示会话 cwd、检索中及接口错误；请求失败不冒充“没有匹配”。检索保留 250ms 防抖；更换关键词立即清空旧候选，新查询、关闭面板或组件卸载时通过 `AbortController` 中止旧请求，取消不显示错误、不写回旧结果；检索中 Enter 不发送未完成引用。
- `@token` 整体先精确查真实文件，失败才剥尾部标点/截句读候选；保留原文本，按最终路径去重、合计 ≤20。含空白路径无法作为完整 token；显示标签与解析规则分离，见 [mentions.ts](src/mentions.ts)、[store.ts](src/store.ts)。
- 「+」支持手机选文件、电脑文件浏览、粘贴/拖入。上传为原始字节 POST `/api/uploads?sessionId&name`，本机文件只引用绝对路径；ready 才进发送帧，失败不进，发送成功清附件/预览 URL，失败保留；见 [attachments.ts](src/attachments.ts)。
- `image/*` 超 3.5 MiB 或非 png/jpeg/gif/webp，尝试长边 ≤2048、JPEG 0.85；解码失败原样上传。上传上限 25 MiB，image mention 上限 10 MiB；附件与 `@` 共用 20 个上限，Codex 命令带附件明确拒绝，其他结构化命令带附件改走文本+mentions。
- 用户气泡图片从 `/api/uploads/file?path=` 取缩略图，失败降级文件名；历史和快照复用同链路。附件状态属 Composer，切会话卸载会回收预览，不能当作持久草稿；见 [StreamItems.tsx](src/components/StreamItems.tsx)、[SessionView.tsx](src/components/SessionView.tsx)。

### 命令菜单

- Claude「/」按扩展分成「上下文 / 模型 / 自定义 / 设置 / 支持」；「管理插件」「MCP 服务器」放在自定义，副标题直接说明可启停/重载/重连。MCP 和插件均为 `role="switch"`；MCP 回复中可操作，启动或审批时在控件旁说明原因，操作后读回。Thinking 放在模型组，默认开启、会话保存，点后保持菜单展开；失败就地提示。Fast 通过能力接口读取原生 `supportsFastMode`，只在支持时显示，点击发用户命令 `/fast`。见 [SlashMenu.tsx](src/components/SlashMenu.tsx)。
- Claude `/mcp` 由前端接管：补全回车、整行发送和 Tab 填充后发送都打开与菜单相同的 MCP 面板，不进入模型对话；附件留在输入框，显式带参数的原生命令仍走原路径。补全覆盖 CLI 的同名条目并去掉参数提示。
- MCP 开关取当前 `mcp_status`：disabled 为关闭，needs-auth 为已启用但待授权。启停/重连失败也使用服务端读回的最新列表，错误就地显示；若读回失败则锁住管理控件，仅允许刷新，初次查询失败同样可以重试刷新。needs-auth 行提供「授权」、可打开/选择复制的链接及完整回调 URL 输入（用于手机/远端 localhost 回调无法访问时），CLI 自己验证 OAuth state。手动回调提交成功后点「重连/刷新状态」；不支持控制请求或授权失败时，在宿主同一工作目录执行可选择复制的 `claude mcp login '<name>'`，完成后回面板启用（若关闭）、重连和刷新。不主动打开浏览器；OAuth 链接和回调只保存在面板内存。见 [SlashMenu.tsx](src/components/SlashMenu.tsx)；交互回归 `npm run test:claude-mcp`。
- `/tasks` 面板消费实时 `session.backgroundTasks`；停止前确认，控制成功不提前移除任务，等 CLI 元数据更新。侧问面板（Claude `/btw`、Codex `/side` 及别名 `/btw`）不进入 store 主事件流，只在组件内保存历史（最多传 20 轮），支持取消，关闭会取消请求并清空问答；synthetic/null 不加入历史。输入框打 `/` 即可补全这几个命令（`withSideCommands` 补进命令表，同名 CLI 项去重），整行「/btw 问题」发送时被 `parseSideCommand` 拦下、不发主对话，带问题打开面板并立即提问（延后一拍，StrictMode 不重复）；补全面板里对侧问命令按 Enter 直接打开空面板，Tab 只填充。Claude 的「/」菜单 `/btw` 入口打开同一面板（Codex 菜单无此入口）。Codex 请求上限 320 秒（服务端回合 300 秒），Claude 80 秒。见 [ClaudeMenuPanels.tsx](src/components/ClaudeMenuPanels.tsx)、[commands.ts](src/commands.ts)。
- 配置文件链接只提供 VSCode 路径，不启动编辑器或写文件，部分设置需续接生效。Thinking 的 0/31999 控制覆盖由后端在 worker 初始化时重发，不写 `~/.claude/settings.json`。新增界面字号沿用 12/13/14/15 阶梯（触屏输入至少 16px），复用现有冷色 switch；布局须兼容浏览器最小字号 14px。
- 导出使用原生 `export_conversation` 文本，可复制/下载，不把前端事件窗口当完整存档；Rewind 尚未接入。面板渲染见 [ClaudeMenuPanels.tsx](src/components/ClaudeMenuPanels.tsx)。
- Codex 提供 status/model/mcp/skills/compact/review/new/interrupt 客户端命令；未知命令明确报错。compact/review/new 限空闲无审批，interrupt 限运行中，错误就地展示；见 [CodexCommandPanel.tsx](src/components/CodexCommandPanel.tsx)、[SessionView.tsx](src/components/SessionView.tsx)。
- Codex `$` 使用真实 skills/list 名称/描述与路径，过滤、键盘选择、IME 保护，插入 `$name` 并由后端附结构化 skill input；不展示禁用项、不改全局配置，Claude/Kimi 不触发；见 [codex-skills.ts](src/codex-skills.ts)。

## 消息与原生历史

- 顺序追加事件由持久 reducer 增量折叠，更新条目使用新对象；分组和已完成行缓存，持久文本增量仅更新末尾，临时工具参数只更新对应显示行。事件窗口引用替换、`dropped`、乱序/重复 seq 和 Codex 回溯输出依赖会全量重建。流式 Markdown 每 100ms 最多解析一次，停止流式后立即使用完整原文，代码着色仍等整轮结束。正文实际提交后同步贴底与“回到最新”状态，阅读历史时保持滚动位置。回归见 [long-session-scroll.test.mjs](scripts/long-session-scroll.test.mjs)、 [long-session-render.test.mjs](scripts/long-session-render.test.mjs)。
- 助手用 `react-markdown` + GFM，禁原始 HTML、过滤 URL，外链加 noopener/noreferrer；单换行保留，代码/表格块内横滚，复制使用原文并提示失败。见 [MarkdownMessage.tsx](src/components/MarkdownMessage.tsx)。
- 代码按需加载轻量词法着色，源码先转义；无/未知语言或 >2000 行纯文本，流式整轮结束后着色并丢弃过期结果；不是完整语法解析器，支持语言见 [code-highlight.ts](src/code-highlight.ts)、[highlight-languages.ts](src/highlight-languages.ts)。
- 同回合 text/thought/tool 共用时间线，闸门/提问独立；正常结束不额外显示系统行，异常如实显示。连续 ≥3 个成功只读工具合并摘要，读取路径去重，未知工具回落原名/原始内容；命令先展示 20 行，可展开全部。见 [tool-summary.ts](src/tool-summary.ts)、[render-items.ts](src/render-items.ts)。
- 正常会话与专注视图均不显示原始通知的「调试事件」卡片；实时更新、重新打开已有会话和视图切换遵循同一显示规则。标准化的错误、工具结果、审批和提问照常显示，服务端事件和 transcript 不变。归一层仍由 `RAW_EVENT_NOISE` 去除已知重复通知，hook 失败或未知状态、未知事件、独有命令输出及 Claude 后台完成通知等原始内容保留在事件记录中供排错。
- 按停止后回合结束显示中性行「已打断，可直接发消息继续」，不进出错态：Claude 认 driver 的 `interrupted:true`，Codex 认 `status:"interrupted"`，Kimi 认 `stopReason:"cancelled"`；见 [render-items.ts](src/render-items.ts)。
- Focus view 在「/」菜单切换并按浏览器保存：实时及历史隐藏工具、思考、调试和中性系统行，保留用户/助手、闸门/提问与错误；见 `focusVisible`、[HistoryTimeline.tsx](src/components/HistoryTimeline.tsx)。
- 历史预览、导入区共用 PagedHistory，首次最新 50 条并滚到底，nextCursor 向前 prepend，无原 500 条上限；旧页失败可重试，空窗口仍能翻页。导入首页使用 historyCursor 截止导入时刻，失效才回退最新页；见 [ResumedHistory.tsx](src/components/ResumedHistory.tsx)、[resumed-history.ts](src/resumed-history.ts)。
- 外部续聊通过 `external_messages_added` 入流，文本/工具/可用思考复用历史渲染；原生历史只读，不伪造缺失状态。超长正文仍可能截断，跨页工具结果不另补读；跳转已导入会话优先非 dead、再按活动时间，见 [history.ts](src/history.ts)。

## 终端与文件

- 终端入口只认 `meta.capabilities.terminal`，Ctrl+` 切换且忽略自动重复；首次打开懒加载 xterm，隐藏仅 CSS，实例、连接、PTY 保留。标签条列出全部未退出终端（激活的已退出终端也保留），同种 shell 按注册表顺序编号，「＋」菜单新建 bash/PowerShell；单 xterm 实例，切标签 = detach 旧的 + attach 新的并回放，激活 id 存 localStorage `workbench-term-active`，刷新优先重连；见 [TerminalPanel.tsx](src/components/TerminalPanel.tsx)、[terminal.ts](src/terminal.ts) 的 `buildTermTabs`/`pickBootTerminal`。
- 专用 `/ws/terminal` 每次 open 重新 attach，收到 attached 先 reset 再回放；省略输出给提示，resize 只在尺寸变化时发送。退避与回前台重连沿全局规则；kill 就地二次确认，exit 显示退出码、允许新建；见 [terminal.ts](src/terminal.ts)。
- 终端/派单宽默认 480px，clamp 至 `[320, 视口−480]`，窄屏全屏；手机 Esc/Tab/Ctrl-C/Ctrl-D/方向键与粘贴，Clipboard 失败退回手动 prompt，经 xterm.paste 处理。终端主题读 CSS 令牌，随主题/系统变化；契约见 [terminal-panel-design.md](../docs/terminal-panel-design.md)。
- 等宽字体优先本地 Maple Mono NF CN/Nerd Font，不下载字体；字体就绪或 1.5 秒超时重新度量 fit，不阻塞连接。终端字号默认按「宽屏 16 / 手机 13px × 整体比例」自动；设置里「终端字号」滑块（10–24px，localStorage `workbench-term-font`，按设备分开）设过就用设定值，见 `readTermFontSize`（[body-font.ts](src/body-font.ts)）。关闭尝试把焦点还给输入框。
- 文件面板宽单独记忆（默认 340、最小 320，容纳标题栏导航按钮），目录浏览与新建 cwd 选择共用 [DirectoryBrowser.tsx](src/components/DirectoryBrowser.tsx)。点文件打开当前预览，顶栏“返回”恢复目录；引用与复制路径是显式操作。引用仍要求当前非 dead、支持 mentions、cwd 内且相对路径无空白；打开文件不改变 cwd，见 [FilePanel.tsx](src/components/FilePanel.tsx)。浏览位置（`store.fileDirectory`）记录所属会话：同一会话收起再开沿用，切到其他会话时从该会话 cwd 开始。新建页打开文件目录列表时对齐新建表单当前工作目录；点击文件栏刷新也返回并重读该目录（含 Git 状态）。未刷新时可独立浏览其他目录，修改新建表单目录不会打断浏览，文件栏导航也不改写新建目录；已打开的文档预览和草稿仍保留。
- [FilePreview.tsx](src/components/FilePreview.tsx) 按点击读取，仅在 store 中保留当前文件：UTF-8（可含 BOM）文本最多 32 MiB，超过 4 MiB 时先显示大小与“仍然加载”按钮，确认后带 `large` 重新读取（超时放宽到 120 秒），直接在轻量文本框编辑并显式“保存”（源码中 Ctrl/Cmd+S 同效）；Markdown 源码/预览使用现有库，CSV/TSV 原文可编辑、表格最多200行100列且正确处理引号与字段换行；表格解析仅在预览模式执行，源码编辑不计算隐藏表格。文本源码、Markdown代码块随面板宽度自动换行，仅改变显示，不向文件内容插入换行符。文本框编辑时浏览器将换行归一为 LF；未编辑的原文不重写。其他编码/二进制/Office及超限文件可见地拒绝编辑。图片原生显示；PDF只查看，以 iframe 导航至原生查看器，文件操作集中到单行顶栏，按“返回、引用、复制路径、外部打开”排列；普通文本（TXT、Markdown、CSV/TSV）第四个入口为“下载”，避免与原本也触发下载的外部打开重复。HTML保留外部打开与下载。下载前显示浏览器确认框，取消留在当前预览且保留草稿；确认下载已保存的文件，不自动保存未提交编辑。窄面板按钮显示图标（触屏图标 20px、按钮宽 39px，顶栏高度不变），保留可访问名称和提示；极窄时顶栏可横向滚动。预览/源码（CSV/TSV为表格/源码）复用终端的分段滑块，编辑文件的保存也在顶栏。移除重新读取与底部操作区，正常预览不显示路径、字节数、只读标签或浏览器查看器说明，保留实际错误与未保存提醒。`navigator.pdfViewerEnabled=false` 时直接提示未启用内嵌查看，不创建空白查看区；旧浏览器没有该字段时仍尝试内嵌。用户已确认本机 PDF 可以正常打开；其他设备仍取决于浏览器原生能力与设置。
- HTML 源码可编辑，预览用无权限 `sandbox` iframe + CSP，移除脚本/跳转等主动内容，仅支持内联 CSS 与 data 图片；相对及外部图片/CSS 不加载。Markdown 文件预览保留文本与表格，图片只显示文字说明；链接复用消息的 `MessageLink`：本地相对路径按当前 Markdown 文件所在目录解析，在文件面板预览，沿用当前 target 的 root/sessionId（越出 root 时仍按 `fileRoot` 选择文件目录并由后端校验），有未保存草稿时沿用换文件确认；外链用 `target="_blank" rel="noopener noreferrer"` 打开，锚点、无效本地路径与不安全协议不导航。媒体最多32MiB，服务端路径和版本约束见[文件接口契约](../server/README.md)。
- 未保存草稿在收起面板、切会话和手机后退时保留，重开面板可继续；换文件/返回目录前确认是否放弃，刷新关闭页面触发 beforeunload 提醒（由设备浏览器决定是否显示）。保存冲突或失败保留草稿，不能直接覆盖 Agent 的新版本；返回目录后重新打开可重新读取文件，仍需确认放弃草稿。保存中不能修改或切到其他文件。迟到读取不会覆盖当前文件，返回目录后重新打开可以重试媒体显示。
- Claude 的 `SendUserFile` 工具调用（input `{files,caption,display}`）不渲染成普通工具行，而是常显的“发送文件”卡片：标题旁显示 caption，每个文件一行（文件名 + 目录），`files` 按原始路径使用（不当作链接剥 `#`/`?`/行号或解码），相对路径接到会话 cwd 后，点击在右侧文件面板预览（root 规则同下方本地链接）；专注视图也保留，历史解析不截断该工具入参，调用失败时回落普通工具卡显示错误。`display`（render/attach）不区分。scratchpad 文件由后端 Claude 临时目录授权根放行。回归：`frontend/scripts/tool-card-title.test.mjs`。
- 当前、恢复与在外部继续的会话消息共用本地链接打开：以消息所属 cwd 解析相对路径，支持中文空格、Windows 盘符、`file://`、`vscode://file`、行号/片段；普通 http/https 网页仍新标签打开。链接的会话身份传入后端，授权根为 HOME、Windows盘、Claude 会话临时目录及已登记会话 cwd，逻辑/真实路径同时校验，目录外软链不可读取。新定向逻辑回归：`node --import tsx frontend/scripts/file-preview.test.mjs`。
- 本机支持原生选择窗口时，文件面板地址栏最左侧显示黄色文件夹按钮，悬停提示“Windows 浏览窗口”：调用 `/api/fs/pick-file`，以当前浏览目录为起点，显示所有扩展名文件；选中后直接预览，返回目录时浏览所选文件的父目录，不修改会话 cwd。取消保留当前目录，失败在面板内提示并保留网页导航。选择期间禁用导航与文件点击，关闭面板或切换会话后丢弃迟到选择；远程不显示原生入口。新建会话仍使用目录选择窗口。
- 新建工作目录和目录浏览地址栏支持粘贴 Windows 盘符绝对路径（如 `C:\Users\user\项目`，支持“复制为路径”的双引号），统一转换为 `/mnt/c/Users/user/项目`；Linux 路径保持原样。地址栏按 Enter（手机输入法“前往”键）读取目标，不再单设“前往”按钮，成功后才能选定目录；失败保留输入并提示，弹窗不允许确认错误目录；主页内嵌地址栏读不了时清空选择（禁用创建并提示），不沿用旧目录。地址栏 Enter 只导航，不提交创建会话。
- 文件浏览地址栏默认显示可点击的目录层级，Linux从 `/` 开始、Windows挂载路径从 `C:` 等盘符开始；每层的title为完整路径，点击任意层直接导航。长路径横向滚动，进入目录默认露出末尾；点击空白处或分隔符切换完整路径输入，自动选中原地址，支持输入/粘贴、Enter前往；Esc放弃编辑并恢复当前目录层级，不关闭面板。层级按钮获得焦点时粘贴也可进入输入模式；成功导航返回层级显示，失败保留输入。输入与最近目录同栏，右侧箭头打开与地址栏动态等宽的主题菜单；菜单路径字号12px、行高1.35，长路径换行。复用浮层的外点/焦点关闭，支持方向键、Home/End、Enter选择与Esc返回下拉按钮；触屏条目至少44px。文件侧栏、文件选择弹窗和工作目录选择弹窗共用这一地址栏，不另显示路径层级行。第二行“WSL”打开主目录。文件侧栏地址栏右侧为“会话”（当前目录及子目录的对话）；地址栏下方是标签页行（沿用终端标签外形、换面板底色，桌面约34px、触屏约40px，低于地址栏），右端“+”新建标签页（会话 cwd）；目录行右键/长按菜单首项“在新标签页内打开”，文件夹在新标签浏览、文件在新标签预览（返回到其所在目录）。预览文件时标签行在顶栏下方。store 以 `fileTabs`/`fileTabId` 记标签，当前标签的目录与预览仍是 `fileDirectory`/`filePreview`，切走时存回标签（各标签的侧键返回记录由面板按标签保存，面板卸载即清空）；保存中不切换/新建，切走时中断的读取在切回时重读；关闭含未保存修改的标签需确认，beforeunload 覆盖所有标签；只有一个标签时，目录页隐藏关闭按钮，文件预览显示关闭按钮，点击后返回此前目录并保留标签；多标签时所有标签均显示关闭按钮，关闭会移除整个标签；从会话消息等入口打开文件会自动新建标签。标签不跨刷新保存。
- 本机文件行右键/长按菜单保留“在新标签页内打开”和发送功能，并显示“用默认程序打开”；所有普通文件均可使用，包括网页不支持预览的 Office 文件及大文件。文件夹对应“在文件管理器中打开”。由服务端交给所在电脑的系统处理：WSL 调用 Windows 文件关联/资源管理器，macOS 使用默认应用/Finder，原生 Linux 不显示；不下载副本。入口受 `capabilities.systemOpen` 控制，远程或缺少系统启动器时隐藏，打开失败在文件面板显示原因。
- 文件列表由 `DirectoryTable.tsx` 直接显示名称、大小、修改日期的紧凑表格（目录模式下标签行右端有「隐藏文件」开关，点亮＝列出 `.` 开头的隐藏项，默认点亮，按浏览器 localStorage `workbench-file-show-hidden` 记住，只在前端过滤；列出时其图标用 `--file-icon-hidden` / `--folder-*-hidden` 半透明变暗，名称不变；文件图标令牌 `--file-icon` 深色比 `--text-muted` 略亮），无目录列表iframe、大路径标题或额外上级目录行；沿用 AIReins 地址栏与导航。表体只在目录变化时创建文本DOM，排序复用 `directory-path.ts` 并只移动位置改变的行；类型图标用CSS背景绘制，不增加逐行框架状态或图标节点；文件夹使用独立的Windows黄色令牌，地址栏原生选择按钮和目录选择列表同步用黄。表头、名称、大小、日期均为14px，行高1.4、单元格上下2px留白；大小/日期保持单行，日期列155px，宽面板目录项约25px高，窄面板分行约50px，触屏行命中区域不少于44px。点击任一列打开该目录/文件，名称按钮也支持键盘；数据一律通过 `textContent` 写入，不解释文件名HTML。事件在表体集中处理，不需要模板脚本、消息转发或主题观察器。深浅主题、字体、Esc直接继承宿主；文件夹始终在前，未知元数据显示“—”并在同类末尾，零字节显示“0 B”、文件夹大小留空。窄面板把元数据放在名称下方，宽面板并排成列；排序不重新请求接口。旧服务端未带元数据时仍可浏览/打开；目录选择模式保留原列表。原Chromium组件/vendor源保留供历史对比，已不进入生产引用图。PDF/HTML预览自身的iframe用途保持不变。
- 文件面板「发送到设备」（Taildrop）：目录表格行右键/菜单键/Android 长按走 `contextmenu`，iOS 触屏自己计时 500ms（移动超 10px 取消，长按后吞掉随之而来的点击）；预览顶栏「发送」按钮弹同一菜单。[TaildropMenu.tsx](src/components/TaildropMenu.tsx) 复用 `SidebarActionMenu`，打开时读 `/api/tailscale/file-targets`，当前访问设备排第一标「（本机）」，离线设备禁用。选中后菜单关闭，面板提示「正在发送…」，请求结束显示结果或错误；文件夹由服务端打包为 zip 后发送。
- 文件面板把刷新、上一级（↑）、WSL、Windows 渲染进标题栏“文件”右侧（`DirectoryContents` 的 `navTarget` 门户；槽位未挂载时不渲染，弹窗仍用第二行内联按钮）。刷新重读当前目录及 Git 状态，不轮询、不监听。
- `/api/fs/dirs?files=1` 在 Git 工作区内并行跑 `git --no-optional-locks rev-parse --show-prefix` 与 `status -z -- .`（各 1.5s 超时），返回 `git`：直接子项名 → M/A/R/D/U/!，文件夹取其下最高状态。当前目录不在仓库时（如 `~/projects`），含 `.git` 的子文件夹各跑一次 `status`（并发 4、总预算 2s），取整仓最高状态，干净仓库不标。返回 `git` 时表格名称左侧留 14px 槽：文件显示字母、文件夹显示圆点，悬停提示含状态。非仓库且无子仓库、git 不可用或超时不返回该字段、不显示标记；见 [dir-list.ts](../server/dir-list.ts)。
- 主页新建表单：[NewSessionForm.tsx](src/components/NewSessionForm.tsx) 保留 agent 按钮、配置胶囊、可选首条消息与创建失败报错。大输入框 Enter 创建、Shift+Enter 换行，输入法组合期间不提交；触屏输入至少 16px。下方「项目」是内嵌的 `DirectoryContents`（`collapsible`），不再弹窗：地址栏所在目录即工作目录，每次成功导航直接选定，没有「选定此目录」。地址栏同文件面板：中间面包屑点任意层、点空白处或粘贴改路径，右侧下拉只列最近目录（选中即用并收起列表）；最左侧在本机能力位 `windowsDirectoryPicker` 为真时是 Windows 浏览窗口按钮（确认后导航到该目录即选定，取消保留原选择），远程、Mac/Linux 上改为展开/收起目录列表。地址栏下方左侧为 WSL、Windows（仅 `windowsPaths` 时显示，Mac/Linux 不显示），右侧「浏览文件夹 / 收起」。目录列表每次进主页默认收起，点面包屑、WSL、Windows 或开关时展开，选最近目录或 Esc 收起；展开时浮在下方、量到视口底，内部滚动。空目录时不自动打开主目录，点开关才读主目录。组标题「+」、历史入口和晚到回填换成另一目录时以新 key 重新挂载地址栏；地址栏内导航只改 cwd。创建期间及已建会话待重试时整块（`fieldset disabled`）禁用。必须选工作目录后才能创建；按钮禁用时同时显示原因。创建仍传 `snapshot: "skip"`，成功才保存 `workbench-last-cwd`，再进入会话。重复点击组标题「+」重新预选目录，同时保留首条消息、agent 与配置；移除原侧栏内嵌表单、临时拉宽与半屏限高逻辑。
- 目录浏览打开时后台预取三家原生历史 `q=/mnt/&limit=1`，Windows 按钮比较历史与工作台最近活动的 `/mnt/` 目录，无记录用 `/mnt/c/Users`。按钮不等待历史；慢请求/失败期间用本地结果，返回后仅供后续点击，不自动改变当前目录。关键词也匹配标题，仅遇到非 `/mnt/` 目录时继续最小页，1.5 秒后不再追加请求；接口自身超时仍由 `api.ts` 管理。历史列表会遍历目录和 stat，并按需读取文件头/检查用户消息，不预取完整历史消息。

- 文件面板地址栏左侧的蓝色文件夹图标打开 Windows 浏览窗口，按钮比右侧最近目录下拉宽 4px，提供悬停提示；本机能力未确认或远程入口不显示。取消保持当前目录，选文件沿用原预览接口。WSL（弹窗第二行，文件面板在标题栏）打开 Linux 主目录，Windows 仍跳到最近使用的 Windows 目录。

更新弹窗区分安装与普通构建待办，构建重试不重复拉取或安装，并保留后端重启和托盘重开提示。

## RC、释放与重启

- RC 胶囊仅 Claude，状态与 URL 由 session / `remote_control_updated` 驱动，失败原因可见于 title；快照/重连恢复，链接只打开 claude.ai。默认开启选项读写 Claude 启动设置；见 [SessionView.tsx](src/components/SessionView.tsx)、[SettingsMenu.tsx](src/components/SettingsMenu.tsx)。
- 远程 user 只在 connecting/connected/reconnecting 识别，排除子代理/合成消息，本机回显 FIFO 最多 20 条且不随 result 清空；worker 替换按设置/此前状态恢复 RC，见 [server/drivers/claude.ts](../server/drivers/claude.ts)。
- 「更多」保留「复制会话 ID」与「VSCode 继续」；复制项仅在有原生 id 时可用。「VSCode 继续」仅 idle 且有原生 id 可释放；成功复制 resumeCommand，失败退回 prompt，桌面尝试协议导航，手机只复制。释放不标 dead，输入框可再发，由后端磁盘续接；见 [SessionView.tsx](src/components/SessionView.tsx)、[server/README.md](../server/README.md)。
- 空闲释放档位 0/15/30/60/120 分钟，经 `/api/prefs` 保存，写失败回滚；running、待审批、RC 已连接等跳过，释放事件更新列表。设置重启先重读忙会话数，有忙会话时弹与清理存储同款的确认弹层（默认聚焦取消，「仍要重启」才继续），重启中/失败提示也用同款弹层，POST 202 后须观察 WS 断开再恢复，60 秒超时提示失败；见 [restart.ts](src/restart.ts)。「关机」先弹与清理存储同款的确认弹层（默认聚焦取消），确认后交给后端 `/api/power-off`：无忙会话直接关机，否则后端等全部完成再关；等待/已排定时按钮显示状态并可点击取消，此时菜单打开期间每 3 秒刷新状态。设置面板桌面两栏，各为一个 `.settings-col`：左「外观 │ 主机（主机与连接、关机并排一行）」，右「会话（底部存储占用与清理）│ 重启 AIReins、更新 AIReins 并排一行」；并排按钮用 `.settings-action-row` 各占一半，文字长时在按钮内换行；手机按同序单栏，外观最先，组内内容不变。「主机与连接」关闭设置并派发 `OPEN_HOST_MENU_EVENT`，直接打开左上角品牌按钮的主机菜单。「更新 AIReins」（[SelfUpdate.tsx](src/components/SelfUpdate.tsx)）点击即弹同款弹层并调 `GET /api/update` 与远端对比：只落后时列出远端新提交，普通更新确认「拉取并构建」，涉及依赖、安装/部署/启动组件时预告并确认「拉取并安装」，自动运行 `bash install.sh --update`；安装失败后重新检查会显示「完成上次安装 / 重试安装」，无需再次拉取。完成后给「刷新页面」，需要后端重启时另给「重启 AIReins」（走上面的重启流程）；WSL 的托盘文件更新后单独提示择时退出并重开托盘，明确退出会停止所有会话，更新过程本身不重启服务；只领先或有未提交改动时列出本地提交与改动，提交说明输入框预填按改动目录生成的默认说明，可改，清空也用默认，确认「提交并推送」；分叉只说明、交给终端；执行中不可关闭。 更新检查与推送的网络代理来自后端本机偏好 `proxyUrl`，与浏览器代理独立；超时显示具体时限，推送失败说明本地提交已保留，可重新检查后再次推送。

## 外观与通用边界

- 配色裁决以 [styles.css 顶部注释](src/styles.css) 为准：`--gate` 系专属闸门/提问/待处理，消息与终端内容有明确例外；终端 chrome 中性/冷色，会话状态点红绿灯。浅色外框 chrome（`#F0EEE6`）、画布 bg（`#F5F4ED`）、输入框与浮起 surface（暖白 `#FAF8F2`）分层，滚动条使用暖灰轨道与较深滑块；显式浅色与跟随系统浅色均生效，避免大面积纯白。别把旧“暖色只用于审批”当完整规则。
- 主题三态、整体字号四档 0.9/1/1.15/1.25 保存本机，首屏内联恢复；localStorage 不可用回退默认。sidebar/main 使用 zoom，AI 用量 iframe 抵消 zoom，终端独立 fit；手机侧栏按百分比包含块铺满，≤360px 顶栏收紧间距，窄空间底栏允许换行；设置/直达浮层尺寸受缩放后的视口约束；见 [font-scale.ts](src/font-scale.ts)、[index.html](index.html)。
- 正文字号 13–20px、步长 0.5、默认 15，旧 22/无效值回退；作用于 stream 用户/助手/思考正文，代码块和工具细节用 `max(12px, 正文−2px)`（默认 13px），与整体 zoom 叠加；见 [body-font.ts](src/body-font.ts)、[styles.css](src/styles.css)。
- 界面字号：会话/历史标题、设置条目、通用按钮与表单标签用 14px（侧栏会话列表例外，用户 10-12 定：会话标题 14.5px、行尾时间 13.5px、分组标题 14px；手机 ≤720px 各大一档，用户 10-13 定：15.5px / 14px / 15px）；菜单、分组标题、胶囊、说明和系统行用 13px；时间、计数及元信息用 12px。其他界面主标题用 15px，大标题下调一档；品牌、终端字号与 AI 用量 iframe 保留独立规则。桌面输入默认 15px，触屏输入至少 16px 防 iOS 聚焦放大。浏览器把小于 14px 的文字放大到 14px 时，关键文案须完整显示；使用可增长的高度、换行或滚动，不用窄固定尺寸截断。侧栏底栏「历史」「额度」胶囊文字 13px、图标 18px、高 32px，内边距图标侧 9px、文字侧 12px、图文间距 5px（桌面与手机一致），质感同左上角主机按钮（内描边/高光/轻投影，描边用 inset 阴影不占宽度），打开后的「‹ 后退」为凹陷按下态；设置齿轮与直达不随字号缩小，保持 36px、图标 22px，用负外边距吃进底栏内边距，底栏高度仍按 32px 计；手机胶囊文字 14px、历史/额度图标 20px、齿轮与直达图标 24px；手机底栏的齿轮、历史/额度胶囊与直达统一 40px，行高按 34px 计、负外边距吃进内边距，底栏比 32px 时只高 2px（用户 10-16）；放不下一行时先收起历史/额度图标、只留文字（内边距 10px），「后退」收紧为 8px/间距 3px（桌面按底栏容器宽度，英文 ≤281px、各语言 ≤233px，英文 ≤235px 再收到 6px 且「后退」去掉箭头；手机英文 ≤409px；按 `<html data-locale>` 区分），仍放不下才换行（目前仅英文 + 最小字号 14 + 224px 最窄侧栏），触屏命中区至少 44px。
- 主题切换复用 [Segmented.tsx](src/components/Segmented.tsx)，保持单选/方向键和禁用语义，滑块按实际布局度量；减少动态偏好关闭动画。设置浮层限高滚动、focus trap、Esc/外点关闭并还焦点。
- 会话移除行内二次确认，Esc 取消，成功清本地状态/草稿并作废旧请求；只移除工作台条目和停 worker，原生 transcript 保留。手机左滑 80px 露入口，10px 锁方向，纵向保留滚动，同刻只展开一行；见 [Sidebar.tsx](src/components/Sidebar.tsx)、[store.ts](src/store.ts)。
- 设置存储面板打开时读一次，清理需弹窗确认，可选移除结束会话；清理只涉及工作台副本，原生记录保留，返回最新统计再刷新会话列表；见 [WorkbenchStorage.tsx](src/components/WorkbenchStorage.tsx)。
- 不引入 UI/图标/路由库；图标用 Unicode/内联 SVG，错误与禁用原因尽量可见。所有输入/审批/配置按后端能力与状态约束，`riskyMode` 警示不能替代实际 driver 权限契约。

## 只做过代码或打桩复核的前端路径

需要用户真机看的事项统一记在本地 `.private/HANDOFF.md`（若有，不入库）「等用户真机看 / 确认的」；这里只列日常使用碰不到、仍只有代码或打桩证据的路径：

- Codex 图片附件 `localImage` 只核对过协议与单测，未真实投递；iOS 文件三选项、拖放、HEIC→JPEG canvas 压缩未真机。
- 中文 IME 组字状态下 `/`、`@`、`$skill` 面板的筛选与键盘交互。
- 终端 kill 时恰好断线后的退出码恢复、断线后重复 attach/reset。
- 快照分页：加载失败后点提示重试、图片/Markdown 异步撑高时的阅读位置（只做过 DOM 接线复核）。
- 设置面板 focus trap / 焦点返回、`prefers-reduced-motion` 的真实键盘与浏览器流程。

- 左下扩展页面入口（包括 AI 用量）打开后变为“‹ 后退”，再次点击收起页面并回到会话列表；图标态也保留返回箭头和可访问标签，与历史会话一致。

- 会话菜单的「删除」已改为「移除」；其下方「彻底删除」打开模态确认框，列出完整标题、工具与原生ID，说明无法恢复。默认聚焦取消，支持Esc/遮罩取消和Tab循环；进行中不可取消/重复提交。Codex/Kimi可确认；Claude菜单不显示彻底删除，缺失原生ID显示原因并禁用确认；执行中/后台任务需先停止。成功清除会话状态、草稿、选中的原生历史并触发历史重载；失败保留弹层及AIReins条目。新增前端调用专用接口，旧后端返回404，不误执行移除。见 [PermanentDeleteConfirm.tsx](src/components/PermanentDeleteConfirm.tsx)。

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

`ai-usage` 的 PageView 底部（iframe 或降级面板下方，用户 10-17 由顶部移下）独立渲染紧凑卡片（包括 iframe 不可达时），展示待生效时间、推算标识、相对倒计时，或最近一次事件（一行：「最近一次：重置 / 重置卡」+ 右侧相对时间，时间即原帖链接）；「最近 5 个事件」与「数据来源 AIHOT」同一行，展开后列表占满整行、数据来源换到下方；监控过期显示一行中性提示，按原因区分：本机超过 1 小时未拉取成功、AIHOT monitor 非 healthy（显示其状态和最近完整检查 `lastVerifiedAt` 的相对时间）、其余为 AIHOT outage。iframe 代理与 sandbox 决策保持原样。底栏入口仅追加绝对定位圆点，不参与布局，保持底栏高度（桌面 43px、手机 45px）与既有窄宽度换行规则。状态在全局 WS 每次连通时取 GET，并以版本戳防止旧请求覆盖新帧；不由浏览器轮询 AIHOT。
