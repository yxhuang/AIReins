# Workbench 前端（M2）

Vite + React + TypeScript 的调度台界面：三家 CLI agent（claude / codex / kimi）混排在一个列表里，设计目标是并行跑多个会话时不漏掉任何一个审批请求。暖色只出现在审批相关元素上。

## 构建与开发

```bash
npm install          # 依赖装在仓库根 node_modules
npm run build        # 产出 frontend/dist/（后端静态目录就是它）
npm run server       # 后端从 / 托管构建产物
```

开发（可选，proxy 到 8790，需先启动后端）：

```bash
npm run dev          # vite dev server :5173，/api 与 /ws 代理到 127.0.0.1:8790
```

类型检查：`npm run typecheck`（根，后端）与 `npm run typecheck:frontend`（`tsc --noEmit -p frontend`）互不影响。

冒烟脚本（需后端已启动，验证全局 WS / 快照 / 审批上行语义）：

```bash
node frontend/scripts/smoke-ws.mjs
```

## 架构

```
frontend/
  index.html            SPA 入口
  vite.config.ts        root=frontend，产物输出到 frontend/dist
  tsconfig.json         前端独立 tsconfig（不碰根配置）
  scripts/smoke-ws.mjs  无头冒烟：全局 WS + 快照 + 审批
  src/
    types.ts            与 server/types.ts 对应的纯前端类型（后端是唯一事实源）
    api.ts              REST 信封客户端（code 非 0 抛中文错误消息）
    format.ts           相对时间 / 用时 / token 紧凑格式 / 会话标题派生
    render-items.ts     统一事件 → 渲染条目（文本合并、工具聚合、闸门提取；AskUserQuestion 提问识别）
    ask.ts              AskUserQuestion 纯逻辑：questions 归一 / 选择状态 / questionAnswers 合成（无 DOM 依赖，可单测）
    mentions.ts         @ 引用纯文本 token 提取 / 光标处触发判定 / 尾部标点剥离候选（无 DOM 依赖，可单测）
    store.ts            全局状态 + WS 连接恢复（见下）
    useStore.ts         useSyncExternalStore 订阅 hook
    App.tsx             布局骨架、历史预览主区与手机返回、hash 路由（#/session/<id>、#/page/<id>、#/history）、错误提示条
    pages.ts            扩展页面纯逻辑：icon 形态判定 / 未知 type 跳过 / 健康结论→渲染模式（无 DOM 依赖，可单测）
    history.ts          所有来源会话纯逻辑：/api/history 查询串构造 / 来源筛选 / 已导入对照（无 DOM 依赖，可单测）
    config-view.ts      配置控件纯逻辑：mutableVia:"restart" 代价旁注判定与文案（无 DOM 依赖，可单测）
    resumed-history.ts  续接会话历史区纯逻辑：最新一页打底 / nextCursor 翻页 prepend / DOM 上限（无 DOM 依赖，可单测）
    snapshot.ts         建会话前快照编排纯逻辑：preflight 分支决策（git 直连 / 小而够静默快照 / 超阈值或空间不足弹确认框）/ 确认框原因文案 / 三出口 → snapshot 入参（无 DOM 依赖，可单测）
    terminal.ts         终端面板纯逻辑：宽度 clamp / 快捷键栏按键→控制序列 / /ws/terminal 下行帧归约 / WS URL 构造（无 DOM 依赖，可单测）
    components/
      Sidebar.tsx       会话列表（单行：品牌图标 / 标题 / 闸门徽标 / 状态点 / 紧凑时间；状态文字收进状态点 title / 危险模式「!」标记 / 行右删除入口 ×：hover/focus 显现、Tab 可达，点击后就地变行内二次确认）+ 新建会话表单（首条消息框底栏带配置胶囊；cwd 三级预填回退 + 空 cwd 可见禁用原因；提交前快照预检 preflight，需要时弹 SnapshotConfirm）+ 底部历史/扩展页面入口及向上展开面板（覆盖会话列表，无「页面」小标题）；终端与设置入口保持原行为
      SettingsMenu.tsx  设置齿轮 + 锚定浮层（分组/条目结构，60vh 限高滚动 + focus trap）；主题三选一写 <html data-theme>、localStorage 持久化（读写均 try/catch）
      SnapshotConfirm.tsx 建会话前快照确认弹窗（暖色闸门样式 + 2px 硬边直角，模态遮罩居中；Esc/点遮罩取消、focus trap、aria-modal；写明弹框原因/快照路径/旧快照覆盖刷新；空间不足时「仍然快照」禁用并给出可见原因）
      PageView.tsx      扩展页面侧栏 iframe：忽略主区 maxWidth、适配窄工具条；进入先查健康，按 embeddable 三态渲染——不可达降级面板（reason + 重试）；embeddable:false 完全不渲染 iframe 改降级面板（服务正常但目标拒绝嵌入 + 主按钮新标签页打开）；embeddable:true 正常 iframe；null/缺省 iframe + 空白提示与常驻新标签页出口
      HistoryView.tsx   侧栏历史列表（#/history）：筛选（agent / 来源 / 关键词 250ms 防抖）+ nextCursor「加载更多」分页；导出的 HistoryPreviewPane 在主区显示分页消息预览+「导入并续接」（就地续接代价写在按钮上方）+「已在工作台中」标记与跳转
      SessionView.tsx   会话头（配置只读摘要（跟随配置时并入有效值）；2026-09-30 精简为只留配置摘要，中断并入输入框发送键）+ 危险模式警示条 + 历史消息区（resumedFrom 时）+ 事件流（AskUserQuestion 走提问选择卡片）+ 输入框（配置控件行在输入框正上方，跟随配置时显示实际生效值与来源小字；行首 / 命令面板、@ 文件引用面板与待附加预览条、结构化 command 上行、codex 降级说明；草稿按会话内存缓存，切走切回不丢；dead 会话「新建会话并续接」出口）+ 未决闸门贴条
      ResumedHistory.tsx 续接会话的历史消息区：实时流上方、默认加载最近一页、「加载更早的消息」nextCursor 翻页 prepend、弱化底色 + 分隔线与实时区区分、用户/助手两态（不伪造工具/思考块）
      StreamItems.tsx   用户消息 / 文本块 / 思考折叠块 / 工具卡片 / 闸门块 / 提问选择卡片（AskUserQuestion）/ 系统行
      TerminalPanel.tsx 终端面板：xterm + 专用 WS /ws/terminal（重连后重新 attach 回放）、可拖分隔条、标题条（cwd + 结束/隐藏/新建）、手机快捷键栏；隐藏只是 CSS 隐藏，实例与连接保留
    styles.css          颜色令牌（light-dark() 深浅成对）与全部样式
```

### 状态模型

单一 `Store`（`src/store.ts`），React 通过 `useSyncExternalStore` 订阅 `version` 计数：

- `sessions`：`GET /api/sessions` 初始加载；任何 WS 事件都本地刷新该会话的 `lastActivityAt` 并推断状态（`user_message`→running、`process_exited`→dead 等），另有 2 秒防抖的列表重拉对齐权威状态；列表刷新发现会话变 dead 时清空其未决闸门（进程已不在，闸门不可操作）；
- `data: Map<sessionId, {events, seq, dropped, pendingGates, latestUsage}>`：进入会话时先 `GET /api/sessions/:id/snapshot` 拿全量 events + seq；`pendingGates` = permission_request − permission_resolved（按 requestId 匹配），既驱动闸门块状态也驱动左栏徽标；`events` 有 2000 条内存上限，超出丢弃最旧并计数（流顶部提示一行），快照重取即可恢复全量；
- 启动时为列表里每个会话取一次快照——后端没有标题字段，左栏标题用该会话第一条 `user_message` 派生（空白压缩为单空格、按显示宽度截断，还没有首条消息时显示占位「新会话」），快照同时给出各会话的未决闸门数。

### 连接与恢复

- 一条**全局 WS**（`/ws`，不带 `sessionId`）收全部会话事件——服务端只在 client 指定了 sessionId 时才过滤，这是跨会话徽标的基础；
- 全局连接没有任何补发能力（服务端只对带 `sessionId&afterSeq` 的连接补发），因此 **WS open 后对每个会话都重取快照对齐**（不只当前会话），覆盖「启动时快照完成、WS 未建立」与断连期间丢失的审批事件；
- 快照请求按会话**去重**（in-flight 复用同一 Promise）并带**版本戳**（等待期间有更新对齐周期启动时，过期响应直接丢弃）；
- 当前会话的增量事件仅在 `seq > snapshotSeq` 时追加；发现缺口（`seq > data.seq + 1`）直接重取快照；
- 断线指数退避重连（1s 起、封顶 15s）；收到 `resync_required` 也对对应会话重取快照；
- 上行（user_message / permission_resolved / interrupt）走同一条 WS，失败帧（`type:"error"`）进入右上角错误提示条。

### 闸门块（签名元素）

流内块级元素，暖色边框 + 暖色浅底 + 直角（其余卡片 8px 圆角）。三家 payload 在 `render-items.ts` 的 `gateFromEvent` 统一提取：命令（kimi terminal/create、claude Bash、codex params.command）等宽全文默认展开；文件写入内容可折叠；兜底「完整入参」JSON。决策按钮只有「允许」「拒绝」；点击后进入提交中态（按钮禁用），直到 `permission_resolved` 广播到达、闸门降级为中性样式（显示「已允许 / 已拒绝」）。dead 会话里的未决闸门渲染为中性「会话已结束，此审批已失效」态，无暖色、不可点击。未决闸门滚出视口时，输入框上方贴暖色细条「N 个闸门等待处理 ↑」，点击滚动定位到第一个；左栏收起时收起按钮旁显示全部会话未决总数的暖色小徽标（为 0 不显示），点击展开左栏。

## 侧栏内面板（2026-10-01）

「所有来源会话」「AI 用量」与其他 `pages/` 页面点击后，标题和内容在侧栏内向上占据新建会话按钮下方、剩余底部入口上方的区域，覆盖会话列表。同一时刻只展开一个；再点标题、收起按钮或 Esc 收起。覆盖期间会话列表保持挂载但不可聚焦，收起后恢复滚动位置。图标态点击先展开侧栏再打开面板；打开旧 `#/history`、`#/page/<id>` 链接也会展开侧栏。终端和设置仍走原入口。

历史列表按 288px 侧栏适配；点行只在主区显示预览和导入续接。桌面打开面板保留当前会话，收起后恢复它的路由；手机收起面板回到侧栏会话列表，侧栏面板就是主页，点历史行进入全屏预览，顶部返回只清除预览，保留历史面板及其筛选、搜索、分页状态。关闭历史面板或切换页面后再次打开会重新加载列表。

扩展页复用 `PageView` 的健康检查、可嵌性判断、加载/失败/拒绝嵌入态和新标签页出口；侧栏模式忽略 manifest 为主区设置的 `maxWidth`，iframe 宽度填满面板，内部布局由目标页负责。只在打开或重试时检查，收起即卸载 iframe。同源 iframe（含代理页面）内支持 Esc；跨源 iframe 内的键盘事件受同源策略限制，需用父页面标题/收起按钮或回到父页面按 Esc。展开动画从下往上，`prefers-reduced-motion: reduce` 下关闭。

回归测试：`npm run test:history`、`npm run test:pages`、`npm run test:sidebar-panels`，均接入 `npm test`。测试脚本统一使用 `node --import tsx`，避免 `tsx` CLI 在受限环境创建 IPC 管道。静态渲染测试覆盖侧栏/主区分工和手机状态类；动画、真实 iframe 网络与触屏交互只做代码复核，未在浏览器实测。

## 验收自查
以下按当时版本记录实施与检查；旧 check:theme 校验脚本已在 2026-09-29 随深色令牌合并移除。当前验收以根目录的 npm test、两项 typecheck 和 build 为准。

实测日期：2026-08-21；Node v22.23.1，vite 8.2.2，react 19.2.8，后端 M1 实跑（kimi 0.38.0 / claude 2.1.238）。

- [x] **1. 构建产物位置正确。** 仓库根 `npm run build` 产出 `frontend/dist/index.html` + assets；`npm run server` 后 `curl http://127.0.0.1:8790/` 返回该页面，静态资源 200。
- [x] **2. 类型检查双绿。** `npx tsc --noEmit`（根，后端）与 `npx tsc --noEmit -p frontend` 退出码均 0。
- [x] **3. 全局 WS 支撑跨会话事件。** `frontend/scripts/smoke-ws.mjs`：不带 sessionId 连接 `/ws`，收到 `ready`、目标会话全部增量事件（seq 连续）、上行 `ack`；快照 16 条事件 seq 从 1 连续。结果 `SMOKE_OK`。
- [x] **4. 三家审批 payload 实测核对。** 用 `server/scripts/ws-demo.mjs` 实跑了 kimi（标准 `session/request_permission` + `terminal/create` 最终闸门，双闸门均 ack）与 claude（`control_request` 带两条 `permissionSuggestions`）；payload 形状与 `render-items.ts` 的提取逻辑逐字段对齐。codex 沿用 M1 已验收的形状（未在 M2 重复跑）。
- [x] **5. 开发服务器代理。** `npm run dev`（端口 5199 实测）`/api/meta` 经代理返回正常信封；WS 代理配置同源。
- [ ] **6. 深浅色 / 配色纪律 / 排版。** 两套令牌已按规范写全（`styles.css` 顶部），暖色仅用于闸门块、徽标、贴条、闸门按钮，暖色之外元素全部冷色/中性；闸门块已实现 diff 视图（claude Edit/MultiEdit 的 old_string/new_string 提取为删除/新增行，纯写入 content 全部按新增行渲染；新增行用 --ok 同色相 `--diff-add`，删除行用冷调红 `--diff-del`，深浅两套令牌均定义，未复用 --danger、未引入暖色），提取逻辑已用 tsx 对内联 Edit/MultiEdit/fs 写入样例跑通——但视觉效果（含 dark 模式、focus-visible 描边、reduced-motion）**未在浏览器里人工确认**。
- [ ] **7. 交互闭环人工确认。** 浏览器内的点击流转（新建会话 → 发送 → 闸门三按钮 → 中断 → 左栏徽标增减 → 贴条滚动定位、窄窗口收起左栏）未人工过一遍；对应逻辑均已被类型检查与真实事件形状覆盖，但无浏览器端实测。
- [ ] **8. 断线恢复实测。** 重连退避、重连后重取快照、`resync_required` 处理的代码路径已按规范实现，但未实测「杀后端再起」的浏览器端表现。

### M2 返工修复（2026-08-21）

- [x] **9. 全局 WS 补发缺口（B1）。** 全局连接无补发能力，改为 WS open 后对**每个**会话重取快照对齐（原只重取 currentId）；快照请求按会话去重（in-flight 复用同一 Promise）并带版本戳（过期响应丢弃）；seq 缺口自愈保留。证据：`npx tsc --noEmit -p frontend` 通过；smoke 全局 WS 收到全部 18 条 seq 连续事件。
- [x] **10. dead 会话僵尸闸门（B2）。** `process_exited` 事件与列表刷新发现 status=dead 时清空该会话 pendingGates；applySnapshot 遇 dead 会话不计 permission_request；渲染层未决闸门降级为中性「会话已结束，此审批已失效」态（无暖色、不可点击、不计入待处理数）。证据：类型检查通过；dead 分支逻辑已由 smoke 中「会话 DELETE 前列表对齐」路径覆盖。
- [x] **11. 移除「允许并记住」（B3）。** 后端把 updatedInput 直接采信为工具入参，前端传 suggestions[0] 会替换真实入参且无 suggestions 回传通道，故按钮整体移除，只留「允许」「拒绝」；suggestions 字段提取保留备用。证据：构建产物中已无该按钮；smoke 走「允许」闭环通过。
- [x] **12. raw_event 合并错误（B4）。** raw_event 分支插入前补 `breakRun()`，「文本A → raw → 文本B」不再错误合并。证据：类型检查通过（纯顺序逻辑修复）。
- [x] **13. Codex usage 路径（M1）。** detailed 分支可读 `usage.usage.total.*`，有 `modelContextWindow` 时显示「上下文 X / Y」分母；claude 顶层 `input_tokens/output_tokens/costUsd` 路径不变。证据：类型检查通过；字段形状对照 `spikes/PROTOCOL-NOTES.md` §2 实测样本。
- [x] **14. 事件内存上限（M2）。** 每会话 2000 条上限，超出丢弃最旧并计数，流顶部显示一行省略提示；快照永远返回全量。证据：类型检查通过。
- [x] **15. 审批 smoke 假阳性（M3）。** smoke 改用必然触发审批的消息（Shell 写 `smoke-<时间戳>.txt`），自动 allow 所有闸门，通过条件要求 `sawPermission && resolvedBroadcast && turn_completed && 文件落盘校验`，结尾只删除自己创建的文件。证据：本轮实测输出 `SMOKE_OK`（permission seq 12 → resolved seq 13 → turn_completed seq 17，文件内容逐字校验为 SMOKE，快照 18 条连续）。
- [x] **16. 审批重复提交（M4）。** GateBlock 点击决策后进入提交中态，所有决策按钮禁用，直到 `permission_resolved` 到达。证据：类型检查通过。
- [x] **17. 左栏收起总未决徽标（M5）。** 收起态在收起按钮旁显示全部会话未决闸门总数的暖色徽标（为 0 不显示），点击展开左栏。证据：类型检查 + 构建通过；视觉效果未在浏览器人工确认。

### M2 打磨（2026-08-21）

- [x] **18. 主题换 Claude 网页版风格底色。** 浅色象牙白 `#FAF9F5` / 深色暖深灰 `#1F1E1D`（非纯黑），深浅两套令牌整体替换（`--ok/--dead/--busy/--danger/--diff-*` 与字体栈不动）；claude 珊瑚橙作文字一律用 `-ink` 变体（浅 `#A8471F` / 深 `#E08B6F`，原色在象牙白上对比度仅 2.96），命中 `.new-agent.agent-claude.selected` 与会话头/会话行的 `.agent-name`，身份脊与选中边框保留原色；未决 `.gate-block` 边框加粗为 `2px solid var(--gate-border)`（已处理/失效态维持 1px；相邻块各有 10px 间隔、不共边，无需补偿对齐）。证据：构建 + 双 tsc 通过；配色视觉效果未在浏览器人工确认。
- [x] **19. 左栏会话行压成两行 ≤44px。** 第 1 行标题（14px / `--text` / 单行省略）+ 待审批徽标钉最右（`margin-left: auto`、`flex: 0 0 auto`）；第 2 行 `agent · 状态 · 相对时间`（12px / `--text-muted`），状态点保留行首；删除独立 row-status 行。盒模型：padding 4 + 标题行 line-height 18 + 行距 margin-top 2 + 元信息行 line-height 16 + padding 4 = **44px**（3px 身份脊是水平边，不占高度）。3px 身份脊、dead 行 opacity 0.55、active/hover 背景、收起态总徽标逻辑不变。证据：构建 + 双 tsc 通过；视觉未人工确认。
- [x] **20. 会话标题派生规则收紧。** `sessionTitle`：`\s+` 压成单空格后 trim；按显示宽度截断（CJK/全角计 2、其余计 1，上限 30，超出加 `…`）；首条 user_message 未到时返回占位「新会话」，不再用 cwd + 短 id 兜底。证据：tsx 单测 8 例（无事件 / 空事件 / 纯空白 / 换行压缩 / 40 个 ASCII / 20 个汉字 / 短标题 / 中英混合）输出全部符合预期；构建 + 双 tsc 通过。

### M3 设置入口与主题切换（2026-08-21）

左栏底部固定区新增设置齿轮（内联 SVG 自画，无图标库），点击弹出锚定在按钮上方的非模态浮层：「外观」组 →「主题」条目，三选一「跟随系统 / 浅色 / 深色」，默认跟随系统。主题写 `<html data-theme>`（跟随系统 = 移除该属性），localStorage key `workbench-theme` 持久化（读写均 try/catch）；`index.html` `<head>` 顶部内联脚本在样式生效前先打 `data-theme` 防首屏闪烁。CSS 三态：浅色令牌留在 `:root`；原 `@media (prefers-color-scheme: dark)` 块内选择器改为 `:root:not([data-theme="light"])`；另增 `:root[data-theme="dark"]` 块。深色令牌在两处**逐字重复**（块间注释要求同步改），理由：纯 CSS 无法用一条规则同时表达「媒体查询命中」与「属性选择器命中」两个条件，又不想引入构建期处理；两份内容已用脚本校验逐字一致。

- [x] **21. 三态可切且立即生效。** React state → `document.documentElement` 属性操作，不刷新页面。证据：代码复核（`SettingsMenu.tsx` 的 `applyTheme`/`chooseTheme`）+ 构建通过；浏览器端未人工确认。
- [x] **22. 系统深色 + 用户选浅色 → 界面浅色（选择器层面复核）。** 系统深色时命中 `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) }`，用户选浅色后 `<html>` 带 `data-theme="light"`，`:not(...)` 不再命中，回落 `:root` 浅色令牌；`:root[data-theme="dark"]` 也不命中。证据：CSS 选择器层面复核；两份深色令牌内容经脚本比对逐字一致（IDENTICAL）。
- [x] **23. 刷新保持选择；localStorage 不可用不白屏。** 读写两处均 try/catch，读不到一律按「跟随系统」渲染（移除 `data-theme`）。证据：代码复核；隐私模式未实测。
- [x] **24. 首屏无闪烁。** `index.html` 内联脚本位于 `<head>` 最前（构建后产物中确认仍排在 CSS `<link>` 之前），同步执行、在样式生效前设置 `data-theme`。证据：构建产物 `frontend/dist/index.html` 人工核对；未启浏览器实测。
- [x] **25. 收起态齿轮可见可点。** 底部区在 `!collapsed` 条件块之外渲染，52px 收起态下居中显示图标。证据：代码复核 + 构建通过；视觉未人工确认。
- [x] **26. Esc 关面板、焦点回齿轮。** 打开时焦点进面板第一个控件；Esc 或点浮层外关闭（齿轮在容器内，`pointerdown` 目标判断不会与齿轮自身 click 打架）；关闭后焦点回齿轮按钮；`prefers-reduced-motion: reduce` 时浮层无动画；所有可聚焦元素走全局 `:focus-visible` 描边。证据：代码复核；未人工过键盘流。
- [x] **27. 构建与类型检查全绿。** 实测：`npm run build`（vite 8.2.2，25 modules，无警告退出码 0）、`npx tsc --noEmit -p frontend` 与根 `npx tsc --noEmit` 均退出码 0。

已知取舍（M3 收尾）：`role="radiogroup"` 未实现方向键在选项间移动的完整 radio 键盘模式（Tab 可达各选项）。

### M4 配置控件与危险模式警示（2026-08-21）

- [x] **28. 三个下拉选项确实来自 /api/meta。** 会话头控件（`SessionView.tsx` 的 `ConfigControls`）与新建表单（`Sidebar.tsx` 的 `NewSessionForm`）都只遍历 `meta.drivers[agent].options[]` 渲染 `<option>`，值、标签、`mutable` 全部取自后端；前端唯一字面量是「跟随配置」兜底标签（仅当 values 里没有 null 项时使用，实际三家都有后端给的「跟随 … 配置」标签）。证据：**代码路径复核**，UI 无任何硬编码配置值。
- [x] **29. claude 的 model/effort 禁用态，permissionMode 可活改。** `mutable:false` 渲染 `disabled` + title「此项需新建会话才能更改」；当前值为 null 时显示后端「跟随 … 配置」标签（model 项还会并入 init 后报出的实际模型，如「跟随 Claude 配置（claude-opus-5）」，替代原会话头独立 model 文本，不重复显示）。证据：**代码复核**（`mutable` 字段由后端 schema 实测给出，见 server/README §9）。
- [x] **30. kimi 三项可活改，config_updated 到达后才更新显示。** `store.setConfig` 发 WS `set_config` 并把该控件置为发送中（禁用）；**不做乐观更新**，`handleEvent` 的 `config_updated` 分支把 payload 的完整 `config`/`model`/`effort`/`permissionMode`/`riskyMode` 写回 session 记录并解除发送中。失败时 WS `error` 帧带 sessionId，归到该会话头控件旁的冷调洋红错误（可关闭），不进全局 toast。codex 的 `effectiveFrom:"next_turn"` 在控件旁给一次性「下一轮生效」提示（8 秒后自动消失）。snapshot/list 刷新本来带 session 全量字段，config/riskyMode 随之更新。证据：**store 逻辑复核** + 类型检查。
- [x] **31. 建会话传 config → 请求体正确携带。** 新建表单默认三项都选「跟随配置」（值 `""`），提交时 `Object.entries(configSel).filter(([,v]) => v)` 只保留非默认字段，全非默认时不带 `config` 键；切 agent 时 `setConfigSel({})` 重置，不会把 claude 的值发给 kimi。证据：**代码复核**（`Sidebar.tsx` 的 `submit`）。
- [x] **32. riskyMode 警示。** `session.riskyMode === true` 时会话头下显示冷调洋红（`--danger`，非暖色）警示条「该会话已关闭 agent 主动询问，workbench 仍会拦截实际执行」；左栏该会话行第 2 行元信息里加同色「!」小标记（title 同文案前半句）。未新增设计令牌，`check:theme` 不受影响。证据：**代码复核** + 构建通过；视觉效果未在浏览器人工确认。
- [x] **33. 设置浮层两条修复。** `.settings-panel` 加 `max-height: 60vh` + `overflow-y: auto`；补 focus trap——面板打开时 Tab/Shift+Tab 在面板内可聚焦元素间循环（焦点漏出面板时也拉回），Esc 关闭与焦点回齿轮的现有行为保留。证据：**代码复核**；未人工过键盘流。
- [x] **34. 构建与前端类型检查、主题校验全绿。** 实测：`npm run typecheck:frontend` 退出码 0；`npm run check:theme` 输出「✅ 深色令牌两份一致（26 项）」（本轮未新增令牌）；`npm run build`（vite 8.2.2，25 modules，退出码 0）。根 `npm run typecheck` 本轮为红：错误全部位于 `server/**`（`UserMessageInput` / `DriverCallbacks.commands`，另一执行者并行改动中途状态），根 tsconfig 只 include server 与 spikes，与前端改动无关。

### M5 斜杠命令补全（2026-08-21）

输入框行首 `/` 弹出命令面板（行中间的 `/`，如路径 `server/index.ts`，是普通字符不弹）：按名称前缀 > 名称子序列模糊 > 描述子串筛选，↑↓ 选择、Enter 确认、Tab 只填充、Esc 关闭（到下一次输入变化前不再弹），键盘全程可操作且焦点留在输入框。面板锚定在输入框上方，与设置浮层同一套面板语言（`max-height: 45vh` + `overflow-y: auto`，复用 `settings-pop` 动画，reduced-motion 关闭），选中项 `scrollIntoView` 跟进可视区；每条显示 `/名称` + 按显示宽度截断的描述（复用 `format.ts` 的 `truncateDisplayWidth`，本轮导出共用）。选中态用冷色 `--busy` 系，不碰暖色。确认语义：无 `argHint` 的命令确认即直接结构化发送；有 `argHint` 的填入 `/name ` 并在输入框上方显示参数提示行，光标留在参数位等用户补完再 Enter 发。发送统一走 `store.sendComposerInput`：行首 `/名称` 且名称在命令表内 → 结构化 `command`（不拼 text）；能力位 `commands:false` 的 driver 一律按普通文本。命令表来源：快照内 `commands_updated` 打底 + REST 首取覆盖 + WS `commands_updated` 实时全量覆盖。codex（`commands:false`）不弹面板，输入框上方常驻克制说明「Codex 不支持斜杠命令」，title 带完整解释（app-server 无命令枚举协议），且绝不把 `/xxx` 拼成结构化 command。`types.ts` 顺带加了 `mentions` 能力位布尔，为下轮 @ 补全留位（UI 未做）。

接口侧实测（隔离实例 `WORKBENCH_PORT=8792`，三家真实会话，完事 DELETE + 按端口 kill）：

- [x] **35. claude 102 条 / kimi 51 条 / codex 空表。** `GET /api/sessions/:id/commands` 实测：claude 会话 102 条；kimi 会话 51 条，含 36 条 `skill:*`（`skill:a-stock-data` 等）且 `compact.argHint` 为 `<optional custom summarization instructions>`；codex 会话 0 条。面板滚动/筛选交互本身**未在浏览器实测**（无头环境），逻辑为代码复核 + 类型检查。
- [x] **36. kimi 结构化 `/help` 实发。** WS 上行 `{"type":"user_message","command":{"name":"help","arguments":""}}`，agent 回复以 `Available commands:` 开头的原生命令表（`HELP_OK`）。同连接还实测收到 `commands_updated`（seq=2，51 条）实时事件——store 的覆盖路径为代码复核。
- [x] **37. codex 结构化命令被后端明确拒绝。** 对 codex 会话发结构化 `compact` 收到 WS error「codex driver 不支持斜杠命令」——即使前端误发也不会静默降级为文本。
- [x] **38. 构建与检查全绿。** 实测：`npm run build` 退出码 0、`npm run typecheck:frontend` 退出码 0、根 `npm run typecheck` 退出码 0、`npm run check:theme` 输出「✅ 深色令牌两份一致（26 项）」（本轮未新增令牌）。

### M6 `@` 文件引用补全（2026-08-21）

纯 textarea + 发送时解析，不做 contenteditable/chip（用户是中文输入法用户，contenteditable 的 IME 组合输入是经典 bug 温床）：

- **触发**：光标处 token（空白分隔的一段）以 `@` 开头即触发——句中也可以（`看看 @server/index.ts 这个`），不同于 `/` 的整行锚定；`foo@bar.com` 这类 token 中间的 `@` 不触发。空 query（刚敲 `@`）也弹全量列表。
- **检索**：`GET /api/sessions/:id/files?q=`，250ms 防抖 + 序号作废旧响应；面板复用 `/` 命令面板的 `cmd-panel/cmd-item` 样式语言（冷色，`max-height: 45vh` + `overflow-y: auto`），↑↓ 选、Enter/Tab 确认、Esc 关，焦点始终在 textarea；与 `/` 面板互斥（slashOpen 时不评估 `@`）。
- **确认**：`@相对路径` 整 token 替换插回光标处，光标落到插入路径后并补一个空格。
- **预览条**：输入框上方一行小字实时反映当前文本会解析出的引用——已确认存在的显示「将附加 N 个文件：a · b」；未确认的异步做精确存在性查询（`q=完整路径`，结果里**精确命中**才算存在，因为检索是子串模糊匹配），结论缓存在 store 的 `fileKnown`（面板检索命中也写入），in-flight 去重，请求失败不缓存结论；确认不存在的标冷调 `--danger`「@路径 未找到，不会附加」（暖色只给审批闸门）；超过后端 20 个上限时提示「超出的不会附加」。发送时会走结构化 command 的文本不解析、不显示预览条。
- **发送**：`store.sendComposerInput` 在 mentions 能力位 true 时走 `sendWithMentions`——`extractMentionTokens` 解析 `@token`（去重、截断到 20），逐个用缓存/精确查询确认存在后才进 `mentions:[{type:"file",path}]`，**文本本身原样发送**（后端三家翻译都需要 `@` 锚点）；能力位 false 时不触发面板、不出预览条、纯文本原样发。`/` 结构化 command 路径不受影响（command 与 text 互斥，本轮不附 mentions）。
- **IME 处理**：textarea 监听 `compositionstart`/`compositionend`——组合期间 `composing=true`，此时不评估触发、不弹/不更新面板、不检索；`onKeyDown` 第一行 `e.nativeEvent.isComposing` 直接返回，组合期间的 Enter/Tab（输入法上屏键）不会确认补全也不会发送；`compositionend` 后用当前文本与光标重新评估是否弹面板。

- [x] **39. `@ser` 弹面板列匹配文件，选中后文本变 `@server/...`。** 触发/提取/替换逻辑 **tsx 实测 19 例全过**（行首/句中/token 内光标/email 不触发/空 query/换行分隔/去重/整 token 替换终点）；面板渲染与键盘交互为**代码复核**（无头环境未启浏览器），样式复用已验收的 `/` 面板类。
- [x] **40. 实测带引用的消息 agent 真读到内容。** 隔离实例 `WORKBENCH_PORT=8793`：`server/test-sandbox/mention-target.txt`（含唯一标记 `WB_MENTION_MARK_9F2E7B41`；注：该目录 `.gitignore` 为 `*`，靶文件不在检索列表中，但 mentions 投递不依赖检索）→ kimi 会话（cwd=test-sandbox）WS 上行 `{text:"读一下 @mention-target.txt 并回复其中的标记", mentions:[{type:"file",path:"mention-target.txt"}]}`，agent 回复「文件 `mention-target.txt` 中的唯一标记串是：`WB_MENTION_MARK_9F2E7B41`」，输出 `MENTION_OK`。同实例顺带实测 files API：400 边界（`q=../../../etc/passwd` → HTTP 400/code 40020）。完事 DELETE 两个会话、删靶文件、按端口 kill（`ss -tlnp | grep 8793` 确认关闭）。
- [x] **41. 句中触发（`看看 @server/index.ts 这个文件`）。** `mentionQueryAt` 只要求光标处 token 以 `@` 开头，tsx 用例「句中 @ser」「句中 token 终点」实测通过。
- [x] **42. 不存在路径 → 预览条「未找到，不会附加」且发送帧不含它。** **代码复核**：`fileKnownSync===false` 渲染 `mention-missing`；`sendWithMentions` 仅 `resolveFile` 返回 true 才 push 进 mentions，文本原样保留。精确存在性判定：检索结果精确 `includes`（子串模糊命中不算存在）。
- [x] **43. IME 组合期间不误触发。** **代码复核**（无头环境无法驱动真实 IME）：三个处理点——`composing` 态屏蔽触发评估、`isComposing` 屏蔽全部按键确认/发送、`compositionend` 后重新评估。
- [x] **44. 构建与检查全绿。** 实测：`npm run build`（vite 8.2.2，26 modules，退出码 0）、`npm run typecheck:frontend` 退出码 0、根 `npm run typecheck` 退出码 0、`npm run check:theme` 输出「✅ 深色令牌两份一致（26 项）」（本轮未新增令牌）。

### M7 可用性修复：cwd 预填 / dead 续接出口 / 控件归位（2026-08-22）

背景：cwd 为空时「创建并进入」永久禁用且原因只在 title 里，全新环境下用户被锁在应用外；服务重启后所有旧会话 dead、输入框禁用，没有任何出口。

- **cwd 三级预填回退**（`Sidebar.tsx` 的 `pickInitialCwd`）：① localStorage `workbench-last-cwd`（上次成功建会话的 cwd，读写均 try/catch，与主题同一纪律）→ ② 列表里 `lastActivityAt` 最新会话的 cwd → ③ `GET /api/meta` 新增的 `defaultCwd`（= server 进程 cwd）。`useState(pickInitialCwd)` 惰性初始化；meta/会话列表可能晚于表单挂载到达，另有 effect 在「用户未碰过输入框且仍为空」时补一次预填（用户故意清空后不再回填）。建会话成功后把该 cwd 写回 localStorage。cwd 为空时按钮仍禁用，但按钮下方直接渲染可见文字「请先填写工作目录」（`.new-hint`，title 作补充）。
- **dead 会话续接出口**（`SessionView.tsx` 的 `Composer`）：dead 时输入框上方渲染「会话已结束。 [新建会话并续接]」——同 agent + 同 cwd + `resumeSessionId: session.nativeSessionId` 调创建接口，成功后 navigate 进新会话；失败错误就地显示在按钮旁。`nativeSessionId` 不存在（没跑起来就死了）时按钮禁用，旁边直接写「该会话没有可续接的原生会话 id」，title 作补充。
- **配置控件挪到 Composer 正上方**（`@` 预览条/参数提示同一区域）：`ConfigControls` 从会话头移入 `Composer` 顶部；发送中禁用、错误显示（可关）、codex `next_turn`「下一轮生效」提示、`mutable:false` 禁用全部随控件走。会话头改为 `ConfigSummary` 只读摘要（`opus · xhigh · manual`，未覆盖项显示「跟随配置」，model 跟随配置时并入 init 后报出的实际模型），不再放可交互控件。
- **禁用原因写在标签里**：`mutable:false`（claude 的模型/强度）渲染为「模型（建会话时定）」，不 hover 可见；title「此项需新建会话才能更改」保留作补充。
- 新增样式 `.new-hint` / `.composer-dead` 全部冷色/中性（`--text-muted` / `--busy` / `--danger`），未新增令牌，暖色仍是闸门专用。

- [x] **45. 清掉 localStorage 打开 → cwd 已预填 → 按钮可点。** **接口侧实测**（隔离实例 `WORKBENCH_PORT=8794`）：`curl /api/meta` 返回 `defaultCwd:"/home/user/dev/workbench"`，与 server 进程 cwd 一致；前端三级回退与 localStorage 读写为**代码复核**（无头环境未启浏览器）。完事 DELETE 自建会话、`ss -tlnp | grep 8794` 找 pid kill，端口确认关闭。
- [x] **46. cwd 清空 → 禁用按钮旁有可见原因文字。** **代码复核**：`NewSessionForm` 在 `{!cwd.trim() && <p className="new-hint">请先填写工作目录</p>}` 渲染可见文字，输入合法后消失。
- [x] **47. dead 会话「新建会话并续接」→ 新会话建起且 worker 活着。** **实测**：对列表里现存 dead kimi 会话（`01J00000000000000000000001`，native `session_00000000-…`）POST `/api/sessions` 带 `resumeSessionId`，新会话 `01J00000000000000000000002` 创建成功，`GET` 确认 `status:idle`、`processId:8331`（worker 活着）、`nativeSessionId` 续上原生 id。完事只 DELETE 自建会话，未动任何既有会话/文件。
- [x] **48. 控件在输入框上方、会话头只读摘要。** **代码复核 + 构建**：`ConfigControls` 仅在 `Composer` 内渲染；会话头渲染 `ConfigSummary` 纯 `<span>` 文本（无可交互元素）。
- [x] **49. 禁用原因不 hover 可见。** **代码复核**：`mutable:false` 标签内联「（建会话时定）」；无原生 id 时续接按钮旁写明原因；空 cwd 时按钮下方写明原因。
- [x] **50. 构建与检查全绿。** **实测**：`npm run build`（vite 8.2.2，26 modules，退出码 0）、`npm run typecheck` 退出码 0、`npm run typecheck:frontend` 退出码 0、`npm run check:theme` 输出「✅ 深色令牌两份一致（26 项）」（本轮未新增令牌）、`npm run test:mentions` 输出「✅ mentions 解析单测全过（19 例）」。

### M8 左栏会话删除入口（2026-08-22）

每个会话行右侧一个 `×` 删除入口（Unicode，无图标库），行内二次确认，不弹模态。语义如实反映后端边界：`DELETE /api/sessions/:id` 只移除 workbench 注册表条目并停 worker，**各家 CLI 的原生 transcript 永不删除**（确认文案「从工作台移除此会话？<agent> 自己的对话记录不会被删除。」；运行中 starting/running 会话追加「该会话仍在运行，移除会停止它。」）。

- **布局取舍（徽标优先）**：`×` 渲染在会话行**之外**右侧（`.session-item` flex 容器内与 `.session-row` 并列，`flex: 0 0 auto`），不在标题行内部，因此待审批徽标钉在行内最右的布局不变，二者永不挤占/遮挡；进入确认态时整行替换为确认文案，徽标随原行一起临时消失，取消即还原。
- **键盘可达**：`×` 是真实 `<button>`，始终在 Tab 序里（`opacity: 0` 不阻止聚焦）；行 `:hover` 或行内任意元素 `:focus-within`（含 `×` 自身聚焦）时显现，聚焦走全局 `:focus-visible` 描边。进入确认态焦点收到行内按钮（默认落「取消」，连按 Enter 不会误删）；取消后 `requestAnimationFrame` 把焦点还给 `×`。
- **store.remove(id)**：调 `DELETE` 成功后清该会话全部本地状态（`sessions` / `data` / `commands` / `fileKnown` / `configPending` / `configErrors` / `configHints` + 计时器），并作废 in-flight 快照（版本戳自增）；`removed` 集合拦截 DELETE 后残留的 WS 事件/快照（不再重取，避免 404 污染全局错误条）。删的是当前会话时导航到剩余列表第一个（与左栏同序：`lastActivityAt` 最新），无剩余回空态。失败：错误留在行内确认态显示，可重试或取消，不静默。
- **配色**：删除入口、确认框边框、行内错误均用既有 `--danger` 冷调洋红（销毁语义，与「拒绝/错误」同类），未新增令牌，暖色仍是闸门专用。

接口侧实测（隔离实例 `WORKBENCH_PORT=8795`，完事 `ss -tlnp | grep 8795` 找 pid kill，端口确认关闭）：

- [x] **51. 自建 kimi 测试会话 → DELETE → 列表确认消失。** **实测**：POST 建会话 `01J00000000000000000000003`（kimi，status idle，processId 17440）→ DELETE 返回 `{"code":0,"data":{"removedSessionId":"01J00000000000000000000003","transcriptsDeleted":false,"workbenchTranscriptPreserved":true}}` → `GET /api/sessions` 25 条中该 id 已不在。UI 行内确认流为**代码复核**（无头环境未启浏览器）。只删了这一个自建会话，未动任何既有会话。
- [x] **52. DELETE 前后原生 transcript 仍在。** **实测**：响应无 `nativeTranscriptPath`，由 `nativeSessionId` 推至 `~/.kimi-code/sessions/wd_workbench_0123456789ab/session_00000000-…/`。DELETE 前 `ls -la`：`state.json` 365 字节（19:04）+ `agents/`；DELETE 后再 `ls -la`：逐字节一致（同尺寸同 mtime），目录未被移除。两段输出：

  ```
  === DELETE 前 ===
  drwx------  3 user user 4096 Aug 22 19:04 .
  drwx------ 45 user user 4096 Aug 22 19:04 ..
  drwx------  3 user user 4096 Aug 22 19:04 agents
  -rw-------  1 user user  365 Aug 22 19:04 state.json
  === DELETE 后 ===
  drwx------  3 user user 4096 Aug 22 19:04 .
  drwx------ 45 user user 4096 Aug 22 19:04 ..
  drwx------  3 user user 4096 Aug 22 19:04 agents
  -rw-------  1 user user  365 Aug 22 19:04 state.json
  ```
- [x] **53. 删当前会话的导航逻辑。** **代码复核**：`store.remove` 在 `currentId === id` 时按左栏同序（`lastActivityAt` 降序）取剩余第一个 `navigate(next.id)`，无剩余 `navigate(null)` 回空态；删非当前会话只原地移除、不动 hash。
- [x] **54. 徽标与删除入口共存不互相遮挡。** **代码复核 + CSS**：`×` 在 `.session-row` 之外的 flex 兄弟位，徽标仍在标题行内 `margin-left: auto` 钉最右，两者各占其位。
- [x] **55. 键盘可达与焦点管理。** **代码复核**：`×` 为真实 `<button>` 带 `aria-label`，`opacity: 0` → `.session-item:hover / :focus-within` 显现，全局 `:focus-visible` 描边生效；确认态焦点默认落「取消」，取消后焦点回 `×`。
- [x] **56. 构建与检查全绿。** **实测**：`npm run build`（vite 8.2.2，退出码 0）、`npm run typecheck` 退出码 0、`npm run typecheck:frontend` 退出码 0、`npm run check:theme` 输出「✅ 深色令牌两份一致（26 项）」（本轮未新增令牌）、`npm run test:mentions` 输出「✅ mentions 解析单测全过（19 例）」。

### M9 store 快照对齐三缺陷修复（2026-08-22）

背景：用户实测「新建会话后发送没反应，界面永远空白」。Codex 只读诊断 + 复核确认三个叠加缺陷全在 `store.ts`，只修第一个会露出二、三个：

- **缺陷 1（确定性，100% 必现）**：`alignSnapshot` 里 `snapshotGen.get(id) ?? 0` 把缺省 generation 归一为 0 但不写回 Map，校验处 `snapshotGen.get(id) === gen` 取回的仍是 `undefined`，`undefined === 0` 为 false ⇒ 新会话首次快照必被静默丢弃，`data` 永远建不起条目，事件全落「未加载」分支再 ensureLoaded 再被丢弃——死循环。**修法**：新增单调自增计数器 `nextSnapshotGen`，每个新快照请求分配唯一 generation 并立即写入 Map，不再依赖「缺省 0」；`resync` 不再手动自增（新请求的唯一 generation 天然作废旧响应），`remove` 的作废也改用同一计数器。
- **缺陷 2（竞态）**：`create()` 用 `void this.ensureLoaded(...)` 没 await 就返回，用户建完立刻发送，事件在 data 建立前到达被吞。**修法**：`create()` 改为 `await this.resync(session.id)`——等创建完成后强制重取的新快照落地再返回（resync 语义，不复用创建期间可能已发出的旧快照）。
- **缺陷 3（竞态）**：`alignSnapshot` 的 `finally { snapshotInflight.delete(id) }` 无条件删除——旧请求的 finally 误删新请求的 in-flight 条目。**修法**：所有权校验 `if (this.snapshotInflight.get(id) === promise)` 才删。

顺带把 `Store` 类具名导出（既有 `store` 单例导出不变），供回归测试直接实例化。

回归测试 `frontend/scripts/store-flow.test.mjs`（`npm run test:store`，tsx 直接 import store 模块，WebSocket/fetch 全部打桩、不需要真实 server）覆盖：① 新建会话后立即发送 → data 出现该会话、事件按 seq 累积、上行帧写出；② 新建会话后等待再发送；③ 旧快照晚到不回滚已推进的 seq + finally 不误删新请求 in-flight 条目。

- [x] **57. 修复前失败 / 修复后通过。** **实测**：对未修复代码跑 `npx tsx frontend/scripts/store-flow.test.mjs` 三例全红（「create 返回后 data 没有该会话条目」「等待后 data 仍没有该会话条目」「旧请求的 finally 误删了新请求的 in-flight 条目」，exit=1）；修复后三例全过（`✅ store 流程回归全过（3 例）`，exit=0）。「建会话 → 立即发送」的手工回放由用例 1 覆盖（打桩 WS 上行帧 + echo 事件，断言 data 事件与 seq）。
- [x] **58. 构建与检查全绿。** **实测**：`npm run build`、`npm run typecheck`、`npm run typecheck:frontend`、`npm run check:theme`、`npm run test:mentions`、`npm run test:store` 六条全部退出码 0。

### M10 发送失败不丢消息 / error 续接出口 / 删除提示与退路 / 状态说明（2026-08-22）

- **发送失败不再静默丢消息**：`store.send()` 在 socket 非 OPEN 时本已返回 false 并置 `lastError`，但 `sendUserMessage` / `sendCommand` / `sendComposerInput` / `sendWithMentions` 全部把返回值吞掉，Composer 又先发送再 `setText("")`——输入框已清空、帧没上去，文本凭空消失。修法：四个发送方法全部透出失败（`sendWithMentions` 改 `Promise<boolean>`，`sendComposerInput` 因 mentions 异步分支整体改 `Promise<boolean>`，纯文本/结构化命令分支同步出结果包 Promise）；Composer 先清空、失败后把原文还回输入框（`setText` 函数式更新，用户趁间隙输入了新内容则不覆盖），失败提示走 `send()` 已置的 `lastError` 全局错误条；命令面板「无参数命令确认即发」路径同样失败不清空。覆盖路径：纯文本、命中命令表的结构化 command、mentions 异步解析、命令面板直接确认，共四条。
- **error 态纳入续接出口**：error 与 dead 共用「新建会话并续接」按钮（同 agent/cwd/nativeSessionId 逻辑与禁用条件不变），文案区分——dead「会话已结束。」/ error「会话出错了。」。error 会话输入框保持可用（进程可能仍在），只有 dead 禁用。
- **删除成功提示说清记录还在**：`store.remove` 成功后置一次性 `removalNotice`（App 底部提示条，手动关闭）：「已从工作台移除。<agent> 的原生对话记录仍在，可新建会话时填入原生 id 续接。」DELETE 响应的 `nativeTranscriptPath` 有则以等宽小字附上；删当前会话被导航走后提示依然可见（挂在 App 层，不随会话视图卸载）。失败路径原有的行内就地报错不动。
- **删除确认态给退路**：Esc 取消（焦点本就在行内按钮上，按键冒泡到确认容器处理；busy 中不响应），取消按钮补 `title="取消（Esc）"`；30 秒超时自动还原未做（二选一，Esc 已满足）。
- **状态语义轻量版**：`STATUS_HINTS` 五状态各一句「你现在可以……」（starting/idle/running/error/dead），挂在左栏状态行（`row-meta-text` 的 `title`）与会话头新增的状态文字（`session-sub` 内 `seq` 之后的 `title`）；未重构状态系统、未做引导。

- [x] **59. send 失败回归：修复前红 / 修复后绿。** **实测**：新用例「socket 非 OPEN：sendUserMessage / sendCommand / sendComposerInput 全路径返回失败」对未修复代码跑出 `❌ … sendUserMessage 未返回 false（actual undefined, expected false），部分用例失败（通过 3 例）`，exit=1；修复后 `✅ store 流程回归全过（4 例）`，exit=0。用例覆盖两种非 OPEN 形态（socket null / readyState=CLOSED）× 三条分支（纯文本 / 结构化命令 / mentions 异步），断言返回 false、`lastError` 已置、零上行帧；并有 OPEN 对照（返回 true、帧写出）。
- [x] **60. error 态续接出口 + 文案区分。** **代码复核**：`SessionView.tsx` 的 Composer 以 `dead || errored` 渲染续接块，文案 `dead ? "会话已结束。" : "会话出错了。"`，按钮禁用条件（无 `nativeSessionId`）与 resume 逻辑未动。
- [x] **61. 删除成功提示含「原生记录仍在」。** **代码复核**：`store.remove` 置 `removalNotice`（`api.deleteSession` 改返回响应 data 以取 `nativeTranscriptPath`），`App.tsx` 渲染提示条 + 等宽小字路径 + 手动关闭。
- [x] **62. 确认态 Esc 取消。** **代码复核**：`Sidebar.tsx` 的 `.session-confirm` 容器 `onKeyDown` 处理 Escape → `cancelConfirm`（与取消按钮同一函数，含焦点还回 ×）。
- [x] **63. 五状态说明。** **代码复核**：`STATUS_HINTS`（Sidebar.tsx 导出）五 key 齐全，左栏 `row-meta-text` 与会话头状态文字各挂 `title`。
- [x] **64. 构建与检查全绿。** **实测**：`npm run build`（vite 8.2.2，退出码 0）、`npm run typecheck` 退出码 0、`npm run typecheck:frontend` 退出码 0、`npm run check:theme` 输出「✅ 深色令牌两份一致（26 项）」（未新增令牌，提示条用既有 `--border-strong`/`--text`/`--text-muted`）、`npm run test:mentions` 输出「✅ mentions 解析单测全过（19 例）」、`npm run test:store` 输出「✅ store 流程回归全过（4 例）」。

### M11 `pages/` 扩展页面（2026-08-22）

仓库根 `pages/` 的扩展页面接入前端：左栏底部各页面入口（齿轮上方，分隔线；没有「页面」小标题，收起态只显示图标，title 带名称）。自 2026-10-01 起 `#/page/<id>` 打开侧栏覆盖面板，保留主区当前会话；前进后退仍由浏览器 hash 历史支持。

- **列表来源**：`store.refreshPages()` 在 init 时取一次 `GET /api/pages`（server 也只在启动时扫描，不热插拔，前端同样不轮询）；`pages.ts` 的 `partitionPages` 只放行 `type:"iframe"` 且字段完整的条目，未知类型/残缺条目进 `skippedPages`，左栏分区底部给一行小字「已跳过 N 个暂不支持的页面类型（widget）」，绝不崩掉列表。
- **icon 两种形态**：emoji 直接文本渲染；内联 SVG 字符串（`<svg...>...</svg>`）用 `dangerouslySetInnerHTML` 渲染（server 已校验 manifest 形状）。`Sidebar.tsx` 导出 `PageIcon`，侧边栏与 PageView 工具条/降级面板共用。
- **页面视图（`PageView.tsx`）**：进入页面先查一次 `GET /api/pages/:id/health`。`reachable:false` → 降级面板：manifest `description`（ai-usage 的 description 已写明「此面板按需启动，未启动时整页不可达」）+ `reason`（冷调 `--danger` 错误语义）+ 「重试」按钮 + 「在新标签页打开」链接，**不渲染空白 iframe**；健康接口本身失败（server 不可达）走同一面板。`reachable:true` → iframe 撑满侧栏面板 + 顶部常驻工具条：右侧「在新标签页打开」（`target="_blank" rel="noreferrer"`）与小字提示「若下方空白，说明目标站点拒绝被嵌入，请用新标签页打开」。**已渲染的 iframe 不定时不轮询**，只在进入页面与点「重试」时查。
- **为什么不探测可嵌性**：已实测 `curl -I http://127.0.0.1:8788/` 响应头带 `x-frame-options: DENY` 与 `content-security-policy: frame-ancestors 'none'`——ai-usage 拒绝被 iframe 嵌入，而浏览器端无法可靠探测（跨域 fetch 拿不到头，iframe onerror 不触发）。因此工具条常驻新标签页出口是设计的一部分，不是兜底。
- **配色**：分区标题/提示用 `--text-faint`，选中态用冷色 `--busy` 内嵌脊（与设置面板选中态同一纪律），不可达 reason 用冷调 `--danger`；未新增令牌，暖色仍是闸门专用。「重试」是真实 `<button>`、新标签页是真实 `<a>`，均走全局 `:focus-visible` 描边。
- **打桩测试** `frontend/scripts/pages-flow.test.mjs`（根 package.json 本轮不动，直接 `npx tsx frontend/scripts/pages-flow.test.mjs` 跑）：覆盖未知 type 跳过、icon 判定、reachable 两分支、health 信封解析与错误信封、store 集成（refreshPages 分区 + 两类 hash 路由互斥）。

接口侧实测（2026-08-22，本机 8790 实例）：

- [x] **65. 左栏出现「AI 用量 📊」入口。** **接口侧实测**：`curl http://127.0.0.1:8790/api/pages` 返回 `data.pages[0] = {id:"ai-usage", name:"AI 用量", icon:"📊", type:"iframe", url:"http://127.0.0.1:8788", healthCheck:同址, description:"此面板按需启动…"}`。UI 渲染为**代码复核**（`PageNav` 遍历 `store.pages`；无头环境未启浏览器）。
- [x] **66. 8788 活着时 health 实测可达。** **实测**：`curl http://127.0.0.1:8790/api/pages/ai-usage/health` 返回 `{reachable:true, reason:"HTTP 200", status:200, durationMs:14}`。
- [x] **67. 不可达降级分支。** **打桩实测**：`pages-flow.test.mjs` 用例 3/4——`reachable:false`（`"超过 2000 ms 未响应"` / `"连接被拒绝"`）→ `pageRenderMode` 返回 `"fallback"`（PageView 据此渲染降级面板而非 iframe）；打桩 fetch 验证 health 信封解析与错误信封抛中文 msg。5 例全过（exit=0）。
- [x] **68. iframe 可嵌性结论：已实测 DENY。** `curl -I http://127.0.0.1:8788/` 响应头：`x-frame-options: DENY`、`content-security-policy: frame-ancestors 'none'`（HEAD 本身 405 是另一回事，两个禁嵌头照常返回）。故 reachable:true 时工具条常驻「在新标签页打开」。
- [x] **69. 未知 type 不崩。** **打桩实测**：`pages-flow.test.mjs` 用例 1/5——`type:"widget"` 与缺 url 的残缺条目进 `skippedPages`（带 id/name/type 供小字提示），支持列表只含 ai-usage；store.refreshPages 集成分区结果一致。
- [x] **70. 构建与检查全绿。** **实测**：`npm run build`（vite 8.2.2，28 modules，退出码 0）、`npm run typecheck` 退出码 0、`npm run typecheck:frontend` 退出码 0、`npm run check:theme` 输出「✅ 深色令牌两份一致（26 项）」（未新增令牌）、`npm run test:mentions` 输出「✅ mentions 解析单测全过（19 例）」、`npm run test:store` 输出「✅ store 流程回归全过（4 例）」；另 `npx tsx frontend/scripts/pages-flow.test.mjs` 输出「✅ pages 前端逻辑回归全过（5 例）」。

### M12 per-session 草稿缓存 + `@` 引用中文标点剥离（2026-08-22）

背景：两条用户实测反馈——① 切会话后输入框草稿消失；② `@a.ts，` 把句末逗号并进 token 判「未找到」。

- **草稿缓存**：store 新增内存级 `drafts: Map<sessionId, string>` 与 `getDraft/setDraft/clearDraft`（空文本即清除条目；不 notify，只有 Composer 读写）。Composer `useState(() => store.getDraft(session.id))` 挂载时恢复（SessionView 本就按会话 id `key` 重挂载，每会话独立、天然不串台）+ `useEffect` 输入即写草稿。`sendComposerInput` 改为对 `dispatchComposerInput`（原方法体重命名）的包装：真正上行成功才清草稿，且**仅当草稿内容仍是本次发送的文本**——mentions 异步解析间隙用户又输入的新内容不能误清；失败时草稿本来就在，Composer 只需把可见文本还回（原「先清空再失败还回」逻辑保留）。`store.remove` 一并删草稿，不泄漏。
- **标点剥离（证据驱动回退，不盲目剥离）**：`mentions.ts` 新增纯函数 `stripMentionCandidates`（逐级剥尾部标点产出候选，长的在前；`-`/`_` 不剥；`.` 在剥离集内但只在剥后命中真实文件时才被采纳，中段点不受影响）。store 新增 `resolveMentionPath`：**整 token 先查**（文件名真带标点也支持，不冤枉），不存在才逐级剥了再查，一旦命中真实文件即采纳，剥到底仍不中维持「未找到」；结论按 token 缓存（含 null），in-flight 去重 + finally 所有权校验，任一层查询失败不缓存结论（与 `resolveFile` 同一纪律）。预览条显示**最终生效路径**（剥离后的那个）；发送帧 mentions 用生效路径、文本原样（`@` 锚点不动）；不同 token 解析到同一路径时按生效路径去重。

- [x] **71. 草稿：A 存草稿 → 切 B → 切回 A 仍在，互不串台。** **打桩实测**（store-flow 用例「草稿按会话隔离」：两会话各存草稿，`getDraft` 分别取回各自文本）；UI 侧「挂载恢复 + 输入即写」为**代码复核**（`SessionView.tsx` Composer 的 `useState` 惰性初始值与同步 effect；无头环境未启浏览器）。修复前该用例对未修复代码跑出 `s.setDraft is not a function`（exit=1），修复后过。
- [x] **72. 发送成功清草稿 / 失败保留 / remove 清。** **打桩实测**三例：OPEN socket 发送成功 → 草稿清空（草稿带首尾空白也认得）；socket CLOSED 发送失败 → 草稿原样保留；`remove(id)` → `drafts` 条目删除。另有一例竞态：mentions 异步发送间隙用户又输入新内容，发送成功后新草稿不被误清（守卫 `drafts.get(id)?.trim() === text.trim()`）。
- [x] **73. 句末标点能剥、真带标点的文件名不被误剥、剥到底不中维持未找到、发送帧用生效路径。** **打桩实测**四例（files 接口按子串检索语义打桩）：文件名真带逗号 `report，final.txt` 整 token 命中 → 原样采用且不再发剥离查询（断言查询序列恰为 1 次）；`a.ts，` 整 token 不中 → 剥后命中 `a.ts` 被采纳（查询序列 `["a.ts，","a.ts"]`）；`ghost.txt，。` 剥到底不中 → null 且缓存「未找到」；发送帧 `text` 原样（`看看 @a.ts， 然后`）、`mentions:[{type:"file",path:"a.ts"}]`。纯函数侧 mentions 单测新增 10 例（句末逗号/连续标点/英文标点/闭括号引号/尾点/无标点无候选/`-` `_` 不剥/中段点不剥/剥空无空候选/纯标点串）。
- [x] **74. 构建与检查全绿。** **实测**：`npm test`（check:theme「✅ 深色令牌两份一致（26 项）」+ mentions 29 例 + store 13 例 + pages 5 例）退出码 0；`npm run build`（vite 8.2.2，退出码 0）；`npm run typecheck` 与 `npm run typecheck:frontend` 退出码均 0。根 package.json 本轮未动——聚合 `test` 脚本（含 pages）上一轮已就位，与要求等价。

### M13 扩展页面按 `embeddable` 三态渲染（2026-08-22）

背景：ai-usage 的 8788 服务带 `X-Frame-Options: DENY`，iframe 里渲染的是 Chrome 原始报错页（「拒绝了我们的连接请求」），上一轮的工具条小字提示救不了它。后端 health 接口本轮补了判定字段：`embeddable`（true/false/null，null = 无法确定，不猜）与 `embedReason`。

- **三态**（`pages.ts` 的 `pageRenderMode` 扩为 `"iframe" | "fallback" | "blocked" | "uncertain"`，`types.ts` 的 `PageHealth` 加 `embeddable?: boolean | null` 与 `embedReason?: string | null`）：
  - `reachable:false` → `"fallback"`：既有不可达降级面板，不变；
  - `embeddable === true` → `"iframe"`：正常渲染 iframe，工具条不再挂「若下方空白」提示（新标签页出口保留）；
  - `embeddable === false` → `"blocked"`：**完全不渲染 iframe**，降级面板说清「服务是好的，但目标站点拒绝被嵌入」——reason（HTTP 状态）与 embedReason 原样展示，措辞点明这是目标站点自己的安全策略、双方都正常；主按钮「在新标签页打开」（`.btn-primary` 冷调 `--busy`，`target="_blank" rel="noopener noreferrer"`），另有「重新检查」次按钮；说明文字用中性 `--text-muted`（新增 `.page-fallback-info`），**不用** `--danger`——这不是错误，暖色仍是闸门专用；
  - `embeddable === null`（或旧后端字段缺省）→ `"uncertain"`：仍渲染 iframe，保留「若下方空白，说明目标站点拒绝被嵌入」提示 + 常驻新标签页出口——这正是那条提示该存在的场景。
- **CSS**：新增 `.page-fallback-info`（中性说明）与 `.page-fallback-actions a.btn`（`<a>` 主按钮补 inline-block/去下划线）；`.page-toolbar` 无 hint 时新标签页链接自行靠右（`margin-left:auto` 移到链接上、有 hint 时由兄弟选择器还原），未新增设计令牌。

- [x] **75. ai-usage 页渲染降级面板而非 iframe。** **接口实测**（2026-08-22，本机 8790 实例）：`curl http://127.0.0.1:8790/api/pages/ai-usage/health` 返回 `{"reachable":true,"status":200,"embeddable":false,"embedReason":"目标站点设置了 X-Frame-Options: DENY",...}` ——`embeddable:false` 走 `"blocked"` 分支，**代码复核**该分支整树不含 `<iframe>`（PageView.tsx 只在 iframe/uncertain 两分支渲染 iframe）。无头环境未启浏览器看最终渲染。
- [x] **76. 三态单测通过。** **实测**：`pages-flow.test.mjs` 新增用例 3b——true→`"iframe"`、false（带 embedReason）→`"blocked"`、null 与字段缺省→`"uncertain"`，另覆盖 HTTP 503 仍可达与「不可达优先于 embeddable:false」；输出「✅ pages 前端逻辑回归全过（6 例）」，exit=0。
- [x] **77. 「在新标签页打开」带 `rel="noopener noreferrer"`。** **代码复核**：blocked 面板主按钮 `<a className="btn btn-primary" href={page.url} target="_blank" rel="noopener noreferrer">`（PageView.tsx）。
- [x] **78. 四条命令全绿。** **实测**：`npm test`（check:theme「✅ 深色令牌两份一致（26 项）」+ mentions 29 例 + store 13 例 + pages 6 例）退出码 0；`npm run build`（vite 8.2.2，28 modules，退出码 0）；`npm run typecheck` 与 `npm run typecheck:frontend` 退出码均 0。

### M14 所有来源会话浏览与导入（2026-08-22）

2026-10-01：入口、标题与手机返回按钮统一称「所有来源会话」，路由仍为 `#/history`。列表行使用两行：品牌图标、单行标题、可选中性色「工单」、来源与紧凑时间在第一行（悬停看完整时间/派单名与 runId）；路径与可选「已在工作台中」在第二行，触屏点击高度至少 44px。没有用户消息的会话隐藏，meta 行累计显示「N 个空会话已隐藏」。页面类面板（如 AI 用量）打开时，桌面侧栏暂宽至 `min(440px, 45vw)`，关闭恢复 288px；历史面板、手机与收起态沿用原宽度，减少动态偏好关闭宽度过渡。

后端 `/api/history` 的前端落地：左栏底部「所有来源会话」入口（扩展页面上方，收起态只显图标）。自 2026-10-01 起 `#/history` 打开侧栏历史列表，与页面面板互斥，主区当前会话保留；点历史行后主区显示 `HistoryPreviewPane`，导入续接行为不变。

- **列表**：每行复用 session-row 视觉语言（3px agent 身份色脊 + hover/active 背景），标题单行截断 + 来源徽标（「对话」中性描边 /「工作台」`--busy` 描边加粗一眼可辨 /「未知」虚线浅字如实显示，不猜）+ cwd 等宽小字 + `agent · 相对时间`。
- **筛选**：agent 三个身份色 chip + 全部；来源筛选（全部来源/对话/工作台）默认「全部」**不过滤任何东西**，且是前端侧过滤（接口没有 source 参数），开启时元信息行明示「来源筛选只作用于已加载的条目」；关键词搜索 250ms 防抖后打到 `q`，请求带代次戳，过期响应丢弃。
- **分页**：`nextCursor` +「加载更多」（每页 150 条，本机 467 候选约 4 页），不做无限滚动、不引虚拟滚动库；`truncated`（扫描预算触发）与 `skipped`（坏/空/不可读候选数，正常也可能非零）都渲染成 `--text-faint` 中性小字，不当错误；真正的失败（列表/预览/导入）才用冷调 `--danger`。
- **预览**：点侧栏历史行 → 主区 `HistoryPreviewPane`，复用 `PagedHistory` 从最新一页开始按需加载更早消息；窄屏（≤720px）全屏显示预览，返回恢复仍展开的历史面板，筛选、搜索与已加载列表不丢。
- **导入并续接**：`POST /api/sessions` 带 `{agent, cwd, resumeSessionId: nativeSessionId}`（复用 `store.create`，成功后 navigate 进新会话）。按钮上方说明就地续接会追写原生文件，并说明 Claude 工作台回合以 VSCode 扩展身份落盘、工作台新建会话可在 VSCode/CLI 的 resume 列表找到。失败错误就地显示。
- **已导入标记**：`history.ts` 的 `findImportedSession` 对照 `store.sessions` 的 `agent + nativeSessionId`，命中则行内标「已在工作台中」（`--ok` 冷色小徽标），预览面板给「跳转过去」，不再显示导入按钮。
- **配色**：全部复用既有令牌（`--busy`/`--ok`/`--danger`/`--text-faint` 等），未新增令牌，暖色仍是闸门专用；筛选 chip 选中态复用 new-agent 的身份色纪律。行是真实 `<button>`，全部走全局 `:focus-visible` 描边。
- **打桩测试** `frontend/scripts/history-flow.test.mjs`（现已接入 `npm test`，用 `npm run test:history` 单独跑）：覆盖查询串构造（空值省略/cursor 原样带回/中文编码）、来源筛选、已导入对照（agent 不匹配不算）、fetch URL 组装与 truncated/skipped 透传、错误信封抛中文 msg、旧历史链接、面板互斥、预览返回、会话保留与路由重放。

接口侧实测（2026-08-22，本机 8790 实例）：

- [x] **79. 列表真实数据。** **实测**：`curl 'http://127.0.0.1:8790/api/history?agent=claude&limit=5'` 返回真实 claude interactive 条目：「opus」（`/home/user/dev`）、「帮我把…orca，AOE…彻底清理干净」等；source 分布 interactive/workbench 如实际；`discovered:134`（claude），全量 `discovered:467 / durationMs:193`。
- [x] **80. agent 筛选 / 关键词搜索 / nextCursor 分页三通。** **实测**（curl 三变体）：`?agent=claude&limit=5` 只含 claude；`?q=opus&limit=5` 命中 3 条（claude「opus」「Tackle your toughest work with Opus 5…」+ kimi 一条，跨 agent 子串匹配 cwd/title，此页 `skipped:32` 非零属正常）；首页 nextCursor 原样带回翻第二页，5 条按 mtime 倒序衔接、`nextCursor` 继续存在。
- [x] **81. 导入并续接实测一次。** **实测**：从列表挑 `source:"workbench"` 的旧测试会话「1+1」（claude `00000000-…`，cwd 在仓库内），POST 带 `resumeSessionId` → 新会话 `01J00000000000000000000004` 创建成功，`status:idle`、`processId:95174`（worker 活着）、`nativeSessionId` 续上原生 id；预览接口 `GET /api/history/claude/00000000-…` 返回 4 条消息（user「1+1」/ assistant「2」×2）。完事 DELETE 该自建会话（响应 `transcriptsDeleted:false, workbenchTranscriptPreserved:true`），列表确认消失，worker 95174 已停止；未碰任何 interactive 会话与既有会话。
- [x] **82. 「已在工作台中」标记。** **代码复核 + 构造验证**：导入后 `GET /api/sessions` 中确有 `agent:claude + nativeSessionId:00000000-…` 的注册表条目（`findImportedSession` 的判定输入实测成立；验收 81 删除前顺手验证），打桩测试用例 3 覆盖 agent 不匹配不误判。
- [x] **83. truncated/skipped 不渲染成错误。** **代码复核**：两者只在 `.history-meta`（`--text-faint` 中性小字）拼一句说明；预览 `truncated:true` 走 `.history-note`（`--text-muted` 中性说明）；`--danger` 只用于列表/预览/导入三类真实失败。
- [x] **84. 四条命令全绿。** **实测**：`npm test`（check:theme「✅ 深色令牌两份一致（26 项）」+ mentions 29 例 + store 13 例 + pages 6 例）退出码 0；`npm run build`（vite 8.2.2，30 modules，退出码 0）；`npm run typecheck` 与 `npm run typecheck:frontend` 退出码均 0；另 `npx tsx frontend/scripts/history-flow.test.mjs` 输出「✅ history 前端逻辑回归全过（6 例）」。466 条下的渲染表现：分页每页 150 条（DOM 最多约 150 行 + 一个预览面板），无虚拟滚动库；列表接口本身 193ms 返回，UI 交互未在浏览器实测（无头环境）。

### M15 claude model/effort 重启切换 + 续接会话历史消息（2026-08-22）

后端把 claude 的 model/effort 改为 `mutable:true, mutableVia:"restart"`（停 worker → `--resume` 同一原生会话 → 带新参数重启，不是原生活改），并给 resume 建出的会话带 `resumedFrom`；本轮是这两个能力的前端落地。

**需求 1（重启切换）**：

- 两个下拉不再禁用（schema 的 `mutable:true` 直接驱动，前端无硬编码）；`mutableVia:"restart"` 的项控件旁渲染一行中性小字（逐字）：「切换会重启底层进程并续接当前会话」（`config-view.ts` 的 `RESTART_NOTE`，`.config-note` 用 `--text-faint`，事实说明不是警告）。
- 过渡态：store 新增 `configSwitching: Map<sessionId, string>`。`config_update_started` 到达时置位（payload 的 `message` 原样存入，后端实测文案「正在切换模型…」），ConfigControls 全部控件禁用 + 就地显示该文案（`.config-hint` 冷色 `--busy`，`role="status"`）；`config_updated` 到达才解除并应用新配置（`mutableVia:"restart"` / `workerRestarted:true` 为后端透传字段，前端不消费）。session/seq 不变，事件 `seq` 照常递增。断连重连后若快照里夹着未完成的 `config_update_started`，`applySnapshot` 会重建过渡态；切换中途 `session_error`（续接 worker 初始化失败）解除过渡态并把 payload.message 就地显示在控件旁。
- 两种拒绝都是刻意保护，走既有 WS error 帧 → `configErrors` 路径就地显示在控件旁（冷调 `--danger` 小字 + 可关闭），不进全局错误条、不渲染成系统故障；措辞原样展示后端的：「当前回合尚未结束，请等待或中断后再切换」「Claude 首轮完成前尚无 nativeSessionId，无法通过续接切换模型或推理强度」。

**需求 2（续接会话历史）**：

- 会话带 `resumedFrom` 时，实时事件流上方渲染 `ResumedHistory` 历史区：进入会话**默认加载最近一页**（`GET /api/history/:agent/:nativeSessionId/messages?limit=50`），顶部「加载更早的消息」按 `nextCursor` 向更早翻页，每页内部时间正序、整页 prepend（`resumed-history.ts` 纯逻辑）；翻完（无 `nextCursor`）按钮消失、显示「已到最早的消息」。prepend 后补偿 `scrollTop`，视图不跳动。不一次拉全。
- 视觉区分：历史区整体 `--surface-sunk` 弱化底色 + 圆角边框，底部居中分隔线「以上为导入前的历史对话」；**默认展开不折叠**。消息只渲染用户/助手两态（后端归一已丢弃工具调用/思考块，前端不伪造），文本原样，timestamp 等宽小字（缺失时显示「时间未知」）；页面 `truncated:true` 时给中性说明「部分页受单次读取窗口限制，个别消息可能不完整」。
- 状态不静默：初始加载「正在加载历史消息…」；失败显示「历史消息加载失败：<msg>」+「重试」；翻页中按钮变「加载中…」；翻页失败保留已加载内容、错误就地显示可重试（cursor 未前进）。
- DOM 量上限：最多加载最近 500 条（10 页），达到后翻页按钮换成说明「为控制页面长度，最多加载最近 500 条；更早的内容在原生会话文件中。」；不引虚拟滚动库。
- 配色：全部复用既有令牌（`--surface-sunk`/`--text-faint`/`--text-muted`/`--danger`/`--busy`），未新增令牌，暖色仍是闸门专用。

**打桩测试** `frontend/scripts/resume-config-flow.test.mjs`（9 例，本轮新增 `test:resume` 并挂进根 `npm test` 聚合）：`mutableVia` 旁注判定与文案逐字断言 + SessionView 接线源码断言；`config_update_started` → 过渡态 → `config_updated` 恢复；两种拒绝文案经 error 帧原样落 `configErrors`（不污染全局错误条）；`session_error` 解除过渡态；快照重建未完成过渡态；`fetchHistoryMessages` URL 组装与 `hasMore/truncated/timestamp:null` 透传；翻页 prepend 顺序与 DOM 上限；源码接线断言（resumedFrom 才挂历史区、分隔线文案、两态渲染、不伪造工具/思考块、不默认隐藏）。

- [x] **85. 下拉可用 + 旁注存在。** **打桩实测**（用例 1）：`needsRestartNote` 仅对 `mutableVia:"restart"` 为真，`RESTART_NOTE` 逐字为「切换会重启底层进程并续接当前会话」；源码断言 ConfigControls 禁用条件只认 `!option.mutable`（restart 项不再被禁）。UI 实际渲染为**代码复核**（无头环境未启浏览器）。
- [x] **86. 过渡态置位/恢复 + 两种拒绝就地显示。** **打桩实测**（用例 2/3/4/5）：`config_update_started`（payload.message「正在切换模型…」）→ `configSwitching` 置位；`config_updated` → 解除 + 应用新配置；「当前回合尚未结束，请等待或中断后再切换」与「Claude 首轮完成前尚无 nativeSessionId，无法通过续接切换模型或推理强度」两条 error 帧原样落 `configErrors` 且 `lastError` 保持 null；`session_error` 解除过渡态并就地显示失败原因；含未完成切换的快照能重建过渡态、已完成的快照不残留。
- [x] **87. 导入所有来源会话后能看到之前的消息（接口侧实测）。** **实测**（隔离实例 `WORKBENCH_PORT=8796`）：从 `GET /api/history?agent=claude&limit=200` 挑 `source:"workbench"`、cwd 在仓库内的旧测试会话「只回复 OK」（`00000000-0000-…`）；`GET /api/history/claude/00000000-…/messages?limit=5` 返回 4 条真实消息（`[user] 2026-08-22T17:04:58.066Z :: 只回复 OK` / `[assistant] … :: OK` / `[user] :: 用 Write 工具在 server/test-sandbox/…` / `[assistant] :: 已写入。`），`hasMore:false`。POST `/api/sessions` 带 `resumeSessionId` 导入 → 新会话 `01J00000000000000000000005` 的 `resumedFrom` 实测为 `{"agent":"claude","nativeSessionId":"00000000-0000-4000-8000-000000000006"}`、`status:idle`。完事只 DELETE 该自建会话（`code=0, transcriptsDeleted:false, workbenchTranscriptPreserved:true`），列表确认消失；未动任何既有会话。前端渲染链路（resumedFrom → 拉一页 → prepend → 分隔线存在）为**打桩实测**（用例 6/7/9）。
- [x] **88. 「加载更早的消息」cursor 翻页。** **打桩实测**（用例 7）：更早一页整页 prepend、页内顺序不动、翻完 nextCursor 消失。另做**接口侧只读实测**：对 interactive 会话「opus」（不导入）连取两页，第 2 页末条 `14:12:52` ≤ 第 1 页首条 `14:13:19`，两页无重复，`hasMore` 仍为 true。
- [x] **89. 历史区/实时区视觉区分 + 默认可见。** **代码复核**：`.session-history` 弱化底色 `--surface-sunk` + 边框；`.session-history-divider` 居中分隔线「以上为导入前的历史对话」；组件无任何折叠/隐藏逻辑（打桩源码断言 `display:none` 不存在）。视觉效果未在浏览器人工确认。
- [x] **90. 四条命令全绿。** **实测**：`npm test`（check:theme「✅ 深色令牌两份一致（26 项）」+ mentions 29 例 + store 13 例 + pages 6 例 + resume 9 例）退出码 0；`npm run build`（vite 8.2.2，退出码 0）；`npm run typecheck` 与 `npm run typecheck:frontend` 退出码均 0。

**这版历史加载仍会误导用户的点**（如实记录）：① 历史区只有用户/助手文本，原生会话里实际发生过的工具调用与思考完全不可见，「已写入。」这类回复看起来像是凭空说的；② `resumedFrom.messageCount` 后端默认省略，历史区头部「约 N 条消息」通常不出现，用户无法预知历史总量；③ 达到 500 条上限后提示「更早的内容在原生会话文件中」，但界面没给出该文件路径（只有原生 id）；④ 若原生 transcript 被用户在 CLI 侧继续写过，历史区不会自动刷新（仅进会话时取一次 + 手动翻页）。

### M16 claude 实际生效值显示 + AskUserQuestion 提问选择卡片（2026-08-23）

**需求 1（effective* 显示）**：`types.ts` 的 `SessionRecord` 补 `effectiveModel / effectiveEffort / effectiveModelSource / effectiveEffortSource`（可选，codex/kimi 缺省属正常）；`store.applyConfigUpdated` 在现有 config 回写之外吸收这四个字段（`"effectiveModel" in payload` 判定，codex/kimi 的广播不带、不会被写入）。`config-view.ts` 新增纯逻辑 `effectiveFor(session, optionId)`（仅 model/effort 有，值为 null 或 source 为 null 时返回 null）、`EFFECTIVE_SOURCE_LABELS`（session=会话 / settings=设置 / init=运行时）与 `ALIAS_NOTE`（「别名为 Claude 设置的最新该档位模型」）。显示形态（逐字）：跟随配置时下拉占位项显示「跟随 Claude 配置（opus）」/ init 后「跟随 Claude 配置（claude-haiku-4-5-20251001）」，控件旁极小字来源标注「设置」/「运行时」（`.config-effective-src`，title 带别名说明/精度解释）；有效值为 null 时仍只显示「跟随 Claude 配置」，不编造。会话头 `ConfigSummary` 同样并入有效值（取代旧的 `session.model` 特判，effort 也覆盖）。`config.model` 语义不动：null = 未被会话级覆盖。

**需求 2（提问选择卡片）**：`permission_request` 带 `interactionType:"ask_user_question"` + `questions[]` 时，`render-items.ts` 的 `gateFromEvent` 经 `ask.ts` 的 `normalizeQuestions` 归一（无 header/description 不伪造、无效条目过滤、归一为空回退普通审批卡片），SessionView 路由到 `QuestionBlock`（StreamItems.tsx）而非 GateBlock。卡片渲染 header（如有）/question/并列可点选项卡片（label 加粗 + description 小字，真实 `<button>`，Tab+Enter 可达，aria-pressed）；单选点选替换，多选 toggle（卡片旁小字「可多选」）；多问题全部答完（每题 ≥1 项）后底部「提交回答」一次回传。回传走 `store.resolvePermission(sessionId, requestId, "allow", undefined, questionAnswers)`（store 新增第五参，与 updatedInput 互斥）：`buildQuestionAnswers` 保证 **key 逐字 = question 原文**、**多选按选项顺序合并为逗号分隔的一个字符串**。配色：共用闸门暖色系（`.gate-block` 底 + 2px 硬边，它确实在等人出手），但视觉是问题卡片——选项是并列卡片（选中态暖色描边），**没有允许/拒绝二元按钮，不用 `--danger`**；跳过出口是小字次按钮「跳过（不回答）」（deny，模型收到拒绝），不喧宾夺主。已处理的提问降级为中性态「已选择：xxx」（`permission_resolved` 广播带回的 questionAnswers 落到视图）/「已跳过」，与闸门 resolved 风格一致。未决提问天然计入 pendingGates（按 `kind==="gate" && !decision` 计），「N 个闸门等待处理 ↑」贴条与滚动定位照常覆盖。

**打桩测试** `frontend/scripts/effective-ask-flow.test.mjs`（10 例，新增 `test:effective-ask` 并挂进根 `npm test` 聚合）：effectiveFor 取值/来源/null 纪律、applyConfigUpdated 吸收四字段且不改写 config.model、codex 广播不带 effective* 不被写入、normalizeQuestions 字段齐全与无效过滤、gateFromEvent 识别 interactionType（普通闸门不受影响）、单选替换/多选 toggle/allAnswered、key 逐字 = question 不用 header、多选逗号合并按选项顺序、resolved 广播 questionAnswers 落视图、resolvePermission 帧形状（questionAnswers 与 updatedInput 互斥、deny 不带答案）、SessionView/QuestionBlock 源码接线（提问路由、pendingGates 覆盖、跳过出口非 btn-danger、已选择/已跳过降级态）。

- [x] **1. claude 未覆盖时看到实际模型；首轮前后精度变化。** **接口侧实测**（隔离实例 `WORKBENCH_PORT=8797`，`tsx frontend/scripts/ask-e2e.mjs 8797`）：不传 config 的会话 B 建会话时 `config.model:null + effectiveModel:"opus" + source:"settings"`、`effectiveEffort:"high"/"settings"`（别名精度，显示「跟随 Claude 配置（opus）·设置」）；`config:{model:"haiku"}` 的会话 A 建会话时 `effectiveModel:"haiku"/source:"session"`，首轮 init 后 GET 实测升级为 `effectiveModel:"claude-haiku-4-5-20251001"/source:"init"`，且 `config.model` 仍为 `"haiku"` 不被改写。UI 渲染为代码复核（无头环境未启浏览器）。
- [x] **2. codex/kimi 显示未受影响。** **打桩实测 + 代码复核**：codex 的 config_updated 不带 effective*，session 字段保持缺省、`effectiveFor` 返回 null，控件仍只显示具体值或 followLabel，不追加、不显示成异常。
- [x] **3. 提问卡片打桩测试。** **实测**：`npm run test:effective-ask` 10 例全过——header/question/options/description 齐全、单选/多选分别处理、key 逐字 = question、多选逗号合并（`咸菜,煎蛋`）。
- [x] **4. 真实闭环实测。** **实测**（8797 隔离实例）：claude 会话（`config:{model:"haiku"}`）→ 发消息让它用 AskUserQuestion 提问早餐 → 收到 `interactionType:"ask_user_question"` 事件（问题「早餐吃什么？」、header「早餐选择」、选项 ZORP7/QUUX3）→ 前端真实代码路径（gateFromEvent → normalizeQuestions → toggleOption → buildQuestionAnswers）产出 `questionAnswers:{"早餐吃什么？":"ZORP7"}` 回传 → 模型回复「明白了！你选择了 **ZORP7**。」（包含所选 label），turn_completed 正常。完事 DELETE 自建的两个会话，`ss -tlnp` 找 pid kill，端口确认关闭。
- [x] **5. 拒绝出口存在但不喧宾夺主。** **代码复核**：跳过出口是 `.question-skip` 小字次按钮（中性 `--text-muted`，hover 才出下划线），与「提交回答」主按钮体量悬殊；提问卡片整树无 `btn-danger`（打桩源码断言覆盖）。
- [x] **6. 未决提问滚出视口有回到它的提示。** **代码复核**：pendingGates 按 `kind==="gate" && !item.decision` 计，提问卡片就是 gate 条目，「N 个闸门等待处理 ↑」贴条与点击滚动定位天然覆盖（gateRefs 两种卡片都注册）。
- [x] **7. `npm test`、`npm run build`、双 typecheck 全绿；新测试挂进聚合。** **实测**：`npm test`（check:theme「✅ 深色令牌两份一致（26 项）」+ mentions 29 例 + store 13 例 + pages 6 例 + resume 9 例 + effective-ask 10 例）退出码 0；`npm run build`（vite 8.2.2，退出码 0）；`npm run typecheck` 与 `npm run typecheck:frontend` 退出码均 0。

**这版提问交互仍会卡用户的点**（如实记录）：① 跳过即 deny，模型收到的是「用户拒绝了此操作」的拒绝语义，没有「稍后回答/换个问法」的中间态；② 选项只有模型给的那些，没有「自定义回答」输入框（Claude 协议层另有 Other 约定，当前未接）；③ 提交后卡片靠 `permission_resolved` 广播降级，WS 断开期间提交会静默失败（按钮停在「提交中…」，重连重取快照后恢复可操作）；④ 多问题卡片没有逐题进度指示，长问题列表要用户自己确认每题都选了。

### M17 建会话前自动快照接入（2026-09-02）

后端新增 `POST /api/snapshot/preflight` 与 `POST /api/sessions` 的可选 `snapshot` 入参；本轮是前端落地（后端由另一执行层并行开发，联调前按其接口契约写死形状）。

- **编排**（`snapshot.ts` 纯逻辑 `createWithSnapshotPreflight`，DOM-free）：提交建会话先 preflight，再按分支——`needed:false`（git 仓库）直连不传 snapshot；`needed && !exceeds && freeSpaceOk` 直连（后端静默快照）；`needed && (exceeds || !freeSpaceOk)` 弹确认框。**preflight 本身失败（网络/500/400）一律吞掉、console.warn 记录、不传 snapshot 照常建**——快照是保护措施，不能反过来卡住用户。确认框取消返回 false，表单回到原状态不建会话。
- **确认框**（`SnapshotConfirm.tsx`）：暖色闸门样式（`--gate-bg` 底 + 2px `var(--gate-border)` 硬边 + 直角，与闸门块同一语言，`--shadow-pop` 阴影），模态遮罩居中。内容：为什么弹框（超 500MB/20000 文件阈值、目标盘空间不足，逐条列出）、快照写入路径（mono）、`existing:true` 时明确「已有的旧快照会被覆盖刷新」。三出口：「仍然快照」（`btn-gate`）→ `snapshot:"auto"`；「跳过快照」→ `snapshot:"skip"`；「取消」（Esc/点遮罩）→ 不建会话，焦点回「创建并进入」。`freeSpaceOk:false` 时「仍然快照」禁用 + 弹窗内写明可见原因「目标盘空间不足，『仍然快照』会失败」（不只靠 title）。
- **键盘可达**：Esc 取消、Tab/Shift+Tab 在弹窗内循环（focus trap，与 SettingsMenu 同一实现纪律）、`role="dialog" aria-modal="true" aria-labelledby/aria-describedby`、打开时焦点落「仍然快照」（被禁用时落「跳过快照」）。
- **快照路径展示**：`SessionRecord` 新增可选 `snapshotPath`（字段缺失兼容：不渲染）；会话头 `session-sub` 摘要行尾部追加「· 快照 <路径>」，title 说明用途。
- **配色纪律**：未新增任何颜色令牌（遮罩为半透明中性黑，与 `--shadow-pop` 同族，不进令牌）；radius/shadow 只引用现有令牌；`check:theme` 不受影响。
- **打桩测试** `frontend/scripts/snapshot-flow.test.mjs`（11 例，新增 `test:snapshot` 并挂进根 `npm test` 聚合）：分支决策全覆盖；git 不弹框直连；小而够静默建；超阈值/空间不足弹框；三出口各自传对参数（auto/skip/取消不建）；preflight 三种失败形态均不阻断且留日志；preflight 请求形状（POST + `{cwd}`）与错误信封抛中文 msg；`createSession` 透传 snapshot（选了才带键）；组件接线源码断言（弹窗 ARIA/Esc/focus trap/禁用逻辑/existing 告知、会话头 `snapshotPath` 守卫渲染、表单只在用户选择后携带 snapshot）。

- [x] **91. git 目录不弹框直连建会话、不传 snapshot。** **打桩实测**（用例 3）：`needed:false` → create 收到 `undefined`、confirm 零调用；配合用例 10 断言请求体无 `snapshot` 键。
- [x] **92. 未超阈值且空间够 → 静默建会话。** **打桩实测**（用例 4）：不弹框、不带 snapshot（后端默认 auto 静默快照）。
- [x] **93. 超阈值或空间不足 → 弹确认框。** **打桩实测**（用例 1/5/7 决策 + 编排），弹窗内容与交互为**代码复核**（无头环境未启浏览器）。
- [x] **94. 三出口各自传对参数。** **打桩实测**（用例 5/6/7）：仍然快照 → `snapshot:"auto"`；跳过快照 → `snapshot:"skip"`；取消 → create 零调用、返回 false（表单回到原状态）。
- [x] **95. preflight 失败不阻断建会话。** **打桩实测**（用例 8）：网络错误/500/400 三种形态均照常建会话、不传 snapshot、confirm 零调用、`console.warn` 留记录。
- [x] **96. 空间不足时「仍然快照」禁用并写明原因。** **代码复核**（SnapshotConfirm：`disabled={!canSnapshot}` + `.snapshot-warn` 可见文案，打桩源码断言覆盖）；交互未在浏览器人工确认。
- [x] **97. 会话头展示快照路径，字段缺失不显示。** **代码复核**（SessionView：`session.snapshotPath && …` 守卫渲染，打桩源码断言覆盖）；后端联调（字段名以实际返回为准）未实测。
- [x] **98. 键盘可达与配色纪律。** **代码复核**：Esc/点遮罩取消、focus trap 与 SettingsMenu 同一实现、`aria-modal`；未新增颜色令牌、radius/shadow 引用现有令牌。视觉效果与键盘流未在浏览器人工确认。
- [x] **99. 构建与检查全绿。** **实测**：`npm test`（check:theme「✅ 深色令牌两份一致（26 项）」+ mentions 40 例 + store 17 例 + pages 6 例 + resume 11 例 + effective-ask 12 例 + history 6 例 + render-items 26 例 + snapshot 11 例）退出码 0；`npm run build`（vite 8.2.2，37 modules，退出码 0）；`npx tsc --noEmit`（根）与 `npm run typecheck:frontend` 退出码均 0。

**这版快照接入的边界**（如实记录）：① 只有新建会话表单走 preflight；「新建会话并续接」（dead/error 出口）与所有来源会话「导入并续接」两条 `store.create` 路径未接预检（续接语义下同 cwd 通常已有快照，且本轮需求只点新建流程）；② preflight 返回 400（cwd 无效）按失败处理照常建——建会话请求会带后端自己的错误消息，用户不会静默丢信息；③ 弹窗出现期间表单保持 busy（防重复提交），用户取消后需重新点「创建并进入」（会重新 preflight，结果可能已变）；④ 后端联调未做（并行业层开发中），`snapshotPath` 字段名按约定实现，缺失即不显示。

### M18 配置控件改为输入框底栏胶囊（2026-09-26）

用户反馈原先「标签 + 原生下拉 + 旁注小字」太占地方，要求参照 Claude Code VSCode 扩展的输入框：直接把当前值作为按钮，点开再选。
- 新组件 `components/ConfigMenu.tsx`：`ConfigPill`（胶囊 + 分组单选浮层，role=menu / menuitemradio，↑↓ 移动、Esc 关闭并还焦点、点外关闭）与 `ConfigPills`（模型 + 推理强度合成一个胶囊，如「✦ Opus 5.5 High」；审批模式单独一个靠右，图标按放权程度：盾 / 笔 / 清单 / 闪电）。
- 会话输入框：textarea 与底栏合成一个 `.composer-box`，底栏是胶囊 + 图标发送键；过渡文案 / 提示 / 错误挪到框上方的 `ConfigStatus`。原先常驻的重启旁注、来源小字、别名说明、禁用原因都收进浮层（组底 `.cfg-note`），文案与判定不变，源码断言照旧通过。
- 新建会话表单：去掉三个标签下拉，首条消息框底栏放同一套胶囊（浮层向下展开）；「跟随配置」在这里可选回。
- 胶囊显示值是 `config-view.ts` 的 `pillText`：会话覆盖 > 实际生效值（精确 id 按别名子串认回标签）> 后端 `default` > 「默认」，有单测。
- 用户刷新后确认外观「挺好的」，同日追加两项：
  - **推理强度滑块**：菜单里推理强度不再逐行列出，改成底部一行「推理强度（High）+ 横向滑块」（`ConfigMenu.tsx` 的 `StepSlider`，role=slider，点 / 拖 / ←→ / Home / End）。live 会话每次改都要重启 worker，所以拖动只动草稿、松手才提交，键盘连按停 600ms 再提交，浮层关闭时补交。跟随配置时滑钮画成虚的、落在实际生效值上；新建表单里有「默认」可选回跟随。
  - **prompt 缓存剩余时间**：claude 会话输入框底栏显示「🕐 56m」，过期显示「已过期」。逻辑在 `render-items.ts` 的 `promptCacheExpiry`：起点取最近一次 `usage_updated`（result，≈ 最后一次请求），TTL 取最近一次真写过缓存的 `cache_creation.ephemeral_1h / 5m` 分项，有单测；拿真实 transcript 核过是 1 小时。回合进行中不显示；codex / kimi 的报文里没有 TTL，不显示也不猜。
- 用户反馈两处问题，已修：
  - **缓存提示看不到**：两个活会话都还没完成过回合、没有 `usage_updated`，原先「判定不了就不显示」让整块消失。改为 claude 会话常显，没数据时显示「🕐 —」并在 title 说明。
  - **滑块拖动高频闪烁**：headless chromium 复现为单向拖动时档位 3→2→3 来回跳。根因是布局反馈环：标签「（high）/（xhigh）」宽度变 → 自适应宽度的菜单变宽变窄 → 靠右的滑块左右挪 → 同一指针位置换算出不同档位。修法：含滑块的菜单定宽且滑块行不换行（`.cfg-menu:has(.cfg-slider-row)`），并在按下时锁定滑块坐标框（`dragRect`），`pointercancel` 也收尾提交。复测 1280 与 390 宽下拖动序列均为 0→4→0 单调，整次拖动只提交一次。
- 验证：typecheck、build、`npm test` 全过；拖动行为用 playwright headless chromium 在活会话里实测（拦截 `set_config` 帧，不触发真实重启）。

### M19 终端面板（2026-09-26）

工作区级内置终端（PTY 在 server 进程里，接口以 `docs/terminal-panel-design.md` §9 为契约；后端由另一执行者并行实现，本轮前端按契约写死形状）。

- **入口**：左栏底部「终端」按钮（页面分区下方、齿轮上方，同一套 page-nav 分区语言，收起态只显图标），仅当 `meta.capabilities.terminal === true`（按请求入口由后端计算）时渲染；点击切换面板显示/隐藏。
- **布局**：`.main` 外套 `.workspace`（flex row），`.main` 内部规则一行未动；终端开启时右侧渲染 `.term-split`（6px 分隔条）+ `.term-panel`。分隔条 `role="separator"` + `aria-orientation="vertical"` + `aria-valuenow/min/max`，方向键每次 16px（← 变宽 / → 变窄），指针用 `setPointerCapture` + `touch-action:none`，拖动期间 `<body>` 加 `.resizing`（`user-select:none` + `cursor:col-resize`），双击复位默认宽度 480。宽度 px 存 localStorage（`workbench-term-width`，typeof 判定 + try/catch），挂载与 `window.resize` 时 clamp 到 `[320, 视口宽−480]`；clamp 是纯函数 `terminal.ts` 的 `clampPanelWidth`（视口过窄、上限<下限时按下限 320 收口，面板不消失）。
- **窄屏（≤720px）**：不做分栏，终端打开时 `.app.term-open` 隐藏左栏与 `.main`，面板铺满（内联宽度用 `!important` 压过，同 `.page-view` 纪律），标题条出现「‹ 返回」；终端下方一条快捷键栏（Esc/Tab/Ctrl-C/Ctrl-D/↑/↓/←/→，点按经 WS `input` 帧发对应控制序列），末尾「粘贴」键（手机上 xterm 的隐藏 textarea 拿不到长按粘贴菜单）：`navigator.clipboard.readText()` 读到后经 `term.paste()` 送入（bracketed paste 下末尾换行不会自动执行），读取被拒或不支持时退回 `prompt` 手动粘贴——2026-09-26 用户报告后补，已用无头浏览器手机视口验证两条路径，触屏键高 ≥44px（`pointer: coarse`），iOS 安全区沿用 `.app` 的 `env(safe-area-inset-*)` 让位。
- **终端本体**：`@xterm/xterm` + `@xterm/addon-fit`；可见时 fit，ResizeObserver 跟随尺寸变化 fit → 上行 `{type:"resize"}`（尺寸没变不发）。**隐藏只是 CSS display:none**：xterm 实例、WS 连接、服务端 PTY 全部保留，组件首次打开后常驻不卸载。
- **生命周期**：首次打开 `GET /api/terminals`，有未退出的 attach 第一个，没有就 `POST /api/terminals`（cwd 取当前所看会话的 cwd，没有会话取 `meta.defaultCwd`；cols/rows 取 `fitAddon.proposeDimensions()`）。标题条显示 cwd（等宽、过长省略 + title 全量）+「结束」（`POST /api/terminals/:id/kill`，标题条内就地二次确认，Esc 取消，与会话行删除同一纪律）+「隐藏」。收到 `exit` 帧后标题条显示「已退出（码 N）」并换成「新建终端」按钮。
- **连接**：单独一条 WS `/ws/terminal`（`buildTerminalWsUrl`：https 入口用 wss，与 store.ts 的 /ws 同一取法）；断线指数退避重连（1s 起封顶 15s，同全局 WS 纪律）；每次 open 后对当前终端重新 `attach`，服务端回 `attached` → 前端先 `term.reset()` 再写回放数据；`omitted > 0` 时面板顶部一行中性提示「已省略较早输出」；页面回前台（visibilitychange）时若连接已断立即重连。下行帧归约是纯函数 `reduceTermFrame`（attached/data/exit/error，其他 terminalId 的帧一律忽略）。
- **主题**：xterm 主题不硬编码颜色，运行时从 `--term-*` 令牌读计算样式（`getComputedStyle`），`MutationObserver` 监听 `<html data-theme>` + `matchMedia("(prefers-color-scheme: dark)")` 监听系统切换，三态主题即时跟随。`--term-*`（前景/背景/光标/选区 + ANSI 16 色）在 `:root` 与两处深色块定义，两处深色逐字一致由 `check:theme` 校验。配色三条裁决（终端内容区豁免不变量 / chrome 禁暖色 / ANSI 黄往橄榄偏）已写进 `styles.css` 顶部不变量注释。
- **a11y**：面板 `role="region" aria-label="终端"`；快捷键栏 `role="toolbar"`；图标/文字按钮均有 aria-label；分隔条可聚焦走全局 `:focus-visible` 描边；终端无动画，`prefers-reduced-motion` 纪律不受影响。

**打桩/纯逻辑测试** `frontend/scripts/terminal.test.mjs`（`npm run test:terminal`，16 例，已挂进根 `npm test` 聚合 `test:reconnect` 之后）：clamp 区间/上下限/视口过窄/坏输入/取整；快捷键八键控制序列逐字断言；WS URL http→ws、https→wss；帧归约（attached→reset+omitted、data 追加、attached 前的 data 忽略、重复 attach 重新 reset、exit 带码/缺码、未知 terminalId 全部忽略、error 归属、垃圾帧）。

- [x] **100. 构建与检查全绿。** 实测：`npm run typecheck:frontend` 退出码 0；`npm run build` 退出码 0（44 modules；xterm 进场后 bundle 超 500kB 触发 vite chunk 体积提示，仅警告未处理）；`npm run check:theme` 输出「✅ 深色令牌两份一致（46 项）」；`npm run test:terminal` 16 例全过；既有 9 套前端测试（mentions/store/pages/resume/effective-ask/history/render-items/snapshot/reconnect）全过。

**只能等后端就绪后真机验证的**（本轮均为代码复核，无头环境未起真实 PTY）：① 建终端/attach/回放/实时输出的完整链路（含 omitted 提示出现时机）；② resize 上行后全屏程序（vim/htop）重排；③ 断线重连后回放与重复 attach 的 reset 表现；④ kill 后 exit 帧到达与「已退出（码 N）」切换；⑤ 分隔条拖动/键盘/双击与宽度持久化的实际手感；⑥ 手机窄屏铺满、快捷键栏点按与安全区；⑦ 深浅色切换下 xterm 主题的即时跟随与 ANSI 黄实际观感；⑧ kill 成功但 WS 恰好断开时退出码依赖下次 attach/刷新才可见（契约内已知边界）。



### M20 工作台 × VSCode/CLI 会话互通（2026-09-27）

- Claude worker 以 `claude-vscode` 身份落盘。历史导入说明已更新：工作台新建的 Claude 会话可在 VSCode/CLI 的 resume 列表中出现；导入仍是对原生记录的就地续接。
- `external_messages_added` 被归一成 `external-history` 渲染条目，放在本轮 `user_message` 前；使用与「导入前的历史对话」相同的弱化底色、用户/助手文本样式，并明确说明没有工具调用。事件进入 transcript，快照和断线回放按 `seq` 还原。
- 角色名（2026-09-28）：外部续聊区块、导入历史区、历史页预览统一用 `format.ts` 的 `messageRoleLabel`——用户显示「我」，助手按会话 agent 显示 Claude Code / Codex / Kimi（取不到 agent 时回落「助手」）。
- **打桩测试**：`frontend/scripts/render-items.test.mjs` 覆盖新事件载荷归一、与前后文本分块及新用户消息的顺序。**代码复核**：`SessionView` 的事件分支和 `ExternalHistoryView` 的文案、样式复用。**待真机**：Claude 新建会话在 VSCode 与 CLI resume 列表可见；三家在别处续聊后回工作台发送、断线回放及异常提示；视觉与手机布局。

### M21 消息显示改版阶段 1：Markdown + 时间线 + 降噪（2026-09-28）

规划与裁决见 `docs/message-display-redesign.md` §3–§5（ROADMAP P1-5）。实现由 Codex 按工单完成（会话 `00000000-0000-4000-8000-000000000007`）。主会话验收时修了两处视觉问题：深色下代码块与页面底色几乎相同看不出边界，以及分隔线文字挪走后留下的缺口。

- **Markdown**：助手文字经 `components/MarkdownMessage.tsx`（`react-markdown` 10.1.0 + `remark-gfm` 4.0.1）渲染。`skipHtml` 不渲染原始 HTML，也不走 `innerHTML`；链接用 react-markdown 默认的 URL 过滤，并加 `target="_blank" rel="noopener noreferrer"`。段落用 `white-space: pre-line` 保留单换行（agent 常用单换行分行，Markdown 默认会把它折成空格）。代码块用编辑器底色加细边框，右上角有「复制」按钮（Clipboard API 不可用或被拒时显示「复制失败」），块内横滚；表格外包横滚容器。没有语法高亮（shiki 在阶段 3）。
- **用户消息**：描边圆角框，`@` 引用画成行内标签（`mentions.ts` 的 `mentionSegments`）。标签在第一个句读标点处截断并剥掉尾部标点，所以 `@a.ts，然后` 只画 `@a.ts`。这只影响显示，解析不受影响。
- **时间线**：同一轮的 text / thought / tool 挂在一条细竖线上，每项一个 7px 圆点（`render-items.ts` 给这三类条目加了 `turn` 字段）。圆点默认次级灰，工具成功或失败换色，进行中闪烁（`prefers-reduced-motion` 下关闭）。闸门卡片和提问卡片不上时间线。
- **降噪**：空思考只显示一行灰字「思考」，不可展开也不显示字数。「本轮结束」只在异常时出现，文案为「本轮异常结束：<原因>」，判定规则：claude 看 `subtype≠success` 或 `isError`；codex 看 `error` 非空或 `status≠completed`；kimi 看 `stopReason≠end_turn`。按现有 transcript 实测，正常轮次（claude 28、codex 7、kimi 20）都不显示，异常轮次（claude 3 个 `error_during_execution`、kimi 1 个 `cancelled`）都显示。「会话已创建」变淡。
- **版式**：流区限宽 820px 居中。外部续聊区、导入历史区、历史页预览复用 `HistoryMessageView`（用户框 + Markdown），来源说明移到区块顶部；底部分隔线只剩一条细线，保留它是因为 prepend 滚动补偿要用它当锚点。
- **流式性能**：`store.ts` 把 `agent_text_delta` / `thought_delta` 引起的通知按 `requestAnimationFrame` 合批，其他事件立即通知并取消挂起的帧。文本、思考、工具三类块都用 `React.memo`。
- **配色**：`styles.css` 顶部加了「消息显示配色裁决」；新令牌 `--msg-*` 在浅色一份、深色两份，`check:theme` 由 46 项增至 54 项。
- **包体积**：主 JS 从 290.82 kB 增至 448.10 kB（gzip 从 90.33 kB 增至 138.24 kB），增量来自 react-markdown/remark-gfm。
- **测试**：新增 `npm run test:markdown`（`frontend/scripts/markdown.test.mjs`），断言 `<script>`、`<img onerror>`、`javascript:` 链接渲染后都没有可执行内容，普通链接带 `rel`。`render-items.test.mjs` 新增正常结束、异常结束和旧事件三组断言；`resume-config-flow.test.mjs` 的两条源码断言改为核查共用的 `HistoryMessageView`；`mentions.test.mjs` 新增 @ 标签边界用例（共 41 例）。
- **评审**：Codex 只读评审（会话 `00000000-0000-4000-8000-000000000008`）结论为「修完再合并」，提了四条，核实后都已修复：单换行被折叠、@ 标签吞掉后文、复制失败没有反馈、「通用边界」里关于 `@a.ts，然后` 的过时说明。
- **截图验收**（playwright 注入合成三家会话，1280 / 390 × 深浅色共 12 张）：全部没有页面横向滚动、没有 `script`/`onerror`/`javascript:` 节点、没有页面错误。**待真机**：8790 与手机上的实际观感，以及长回复流式输出时的手感。

### M22 消息显示改版阶段 2：工具行人话化（2026-09-28）

规划见 `docs/message-display-redesign.md` §3「工具行」、§4 阶段 2。分工如下：
- 采样：Kimi，会话 `session_00000000-0000-4000-8000-000000000009`；
- 后端 kimi driver：Codex，会话 `00000000-0000-4000-8000-000000000010`；
- 前端：Kimi，会话 `session_00000000-0000-4000-8000-000000000011`；
- 主会话负责验收、截图和提交。

- **样本**：`frontend/scripts/fixtures/tool-events/{claude,codex,kimi}.ndjson` 取自 18790 临时实例上三家的真实会话。三家跑的是同一个 7 步任务：读、搜、列、改名、新建、失败命令、抓网页。临时路径统一换成 `/work/proj`。
  - claude：TodoWrite×9、Bash×3、ToolSearch×2，Read、Edit、Write、WebFetch 各 1；
  - codex：commandExecution×4、fileChange×2、webSearch×1；
  - kimi：Read、Grep、Glob、Edit、Write、Bash、FetchURL 各 1。
  - 这些数都是主会话重新数过的。
- **摘要器**：`frontend/src/tool-summary.ts` 是纯函数，`summarizeTool(agent, tool, cwd) → { verb, target, note, body }`。
  - body 有 command / diff / read / raw 四种。
  - kimi 按 ACP `kind` 优先分类，其次看短名，最后看人话标题，能处理完成事件不带名字的情况。
  - codex 命令会剥掉 `bash -lc` 外壳；fileChange 改了多个文件时，每块 diff 都标出所属路径。
  - Grep 的计数区分「N 处」和「N 个文件」，判断不了模式就不写。
  - 认不出的工具一律回落成「原名 + 原始入参与结果」，不再按入参形状猜类型。
  - 失败时折叠行显示错误首行，展开后能看到完整错误；读取失败时不显示行数。
- **ToolCard**：折叠态是一行「动词 + 对象 + 附注 + 状态」。
  - 同回合连续至少 3 个成功结束的 Read/Grep/Glob 默认合成摘要行，读取按文件路径去重并补总次数；点开恢复原逐行工具，实时流、历史及续聊回放共用此行为，展开状态仅留在组件内。
  - 附注和工具名都可以收缩、显示省略号，状态文字始终可见；工具全名放在 `title` 里。
  - 展开后：命令显示前 20 行输出，可点「显示全部」，附退出码和截断标记；编辑显示 `DiffView`；读取只给路径和行数；其他工具显示原始文本。
  - `ToolView` 新增 `baseToolName`、`rawInput`、`rawResult`、`toolKind`、`locations`、`terminalOutput` 等字段。kimi 完成事件不再用结果覆盖入参。
- **DiffView**：从闸门卡片里抽成共用组件 `components/DiffView.tsx`。闸门传入的是单段、无标题的 diff，生成的标签结构与原来逐字相同；浅色截图与阶段 1 逐像素一致。
- **后端契约**：见 `server/README.md`。kimi 的 `tool_call_completed` 多了 `terminalOutput`，内容是命令输出末尾最多 64 KiB，来自独立的尾部缓冲，所以超过 ACP 上限的长输出也能拿到最后一行。`terminal/release` 之后，这份输出在一个最多 64 条的表里留存。kimi 的工具事件还会透传 `kind` 和 `locations`。ACP `terminal/output` 原有的返回语义没变。
- **包体积**：主 JS 为 458.66 kB（gzip 141.48 kB），比 M21 多约 10 kB。
- **测试**：新增 `npm run test:tool-summary`，共 25 例。三家样本逐个工具核对 verb/target/note；另有合成用例覆盖 terminalOutput、仅凭 kind 分类、名字中途变化、未知工具回落、多文件 fileChange、失败诊断、Grep 口径、cwd 外路径。其中「读取失败不显示行数」做过红绿验证。后端新增 `server/kimi-tool-output.test.ts`。
- **评审**：Codex 只读评审（会话 `00000000-0000-4000-8000-000000000012`）两轮。第一轮提了 7 条重要问题、2 条次要问题，都由原执行者修复，第二轮逐条确认已修；第二轮又提了 2 条小问题，由主会话修复。
- **截图**：`frontend/scripts/msg-display-shots.mjs` 新增 `FIXTURES=1` 模式，直接回放上面的真实样本。真实样本和合成数据各 12 张，都没有页面横滚、没有 XSS 节点、没有页面错误。
- **待真机**：
  - 8790 上的实际观感。后端改动要 `wb restart` 才生效，重启前 kimi 命令不会显示输出。
  - codex 会话里 `raw_event`（「调试事件」）行偏多，来源是 `turn/diff/updated`、`hook/*`、`account/updated` 这类通知，不在本次范围，见 HANDOFF 待办。

### M23 Claude Remote Control 胶囊（2026-09-29）

- **实测**：18790 隔离实例创建空白 Claude 会话后，胶囊自动高亮且取得 `session_url`；页面点击关闭变灰，再点开启重新高亮；最终关闭后 snapshot 仍为灰态。未发任何对话消息。`npm test`、`npm run build` 通过。
- **实测截图**：`scratch/remote-control-20260929/composer-{1280,390}-{light,dark}.png`；四种尺寸主题都无页面横向溢出和页面错误。已连接胶囊蓝底白字，旁边 `↗` 在新标签页打开 `session_url`；按钮 title 也含 URL。
- **代码复核**：只有 Claude 显示；灰、连接中、重连中、关闭中、错误态由会话记录与 `remote_control_updated` 驱动，失败原因放 title。刷新和重连从 snapshot 对齐。收到未知 bridge state 不崩。worker 替换后按设置或此前开启状态恢复 RC。
- **远程消息识别（验收后返工）**：第一版在 RC 关闭时也会把对不上号的 user 文本当成远程消息，每轮 `result` 又会清空本机回显表，追加的消息可能重复显示。已改为：只在 connecting、connected、reconnecting 三种状态下识别；排除子代理和合成消息；回显表改为 FIFO，上限 20 条，不再随 `result` 清空。单测见 `server/claude-remote-control.test.ts`。
- **同批顺带改动**：Claude 的 Bash 工具行有 `description` 就显示它，命令留在展开区（`tool-summary.ts`；对应 M22 的「动词 + 对象」规则，Codex 和 Kimi 不受影响）。
- **待真机验证**：手机 claude.ai/code 发来的 user 消息在 Workbench 中的实际 stdout 形状、去重和续聊指纹；本次冒烟依要求没有发送消息。

### 通用边界

- `@token` 提取仍按空白切段，解析时整 token 优先，命中不了再回退到剥离候选：先逐级剥掉尾部标点（如 `@a.ts，`），再在中段句读标点处截断（如 `@a.ts，然后` 解析为 `a.ts`，见 `mentions.test.mjs`）。候选必须命中真实文件才采纳。用户消息里的 `@` 标签（M21）也用同一套句读边界截断显示。

- 未引入 UI 组件库、图标库、路由库：图标用 Unicode / 内联 SVG，路由用 hash（`#/session/<id>`、`#/page/<id>`、`#/history`）。
- 扩展页面（`pages/`）只在前端启动时取一次列表（server 同样只在启动时扫描）；iframe 直接嵌 manifest 的 `url`，server 不反代；目标站点带 `x-frame-options: DENY` 时浏览器端无法探测，自 M13 起由后端 health 接口的 `embeddable` 判定（false → 完全不渲染 iframe 的降级面板；null/无法确定 → iframe + 空白提示 + 常驻新标签页出口）。
- 未引入 `@vitejs/plugin-react`：esbuild automatic JSX 够用，dev 下 HMR 退化为整页刷新。
- 会话状态没有专属 WS 事件，左栏状态靠事件推断 + 2 秒防抖重拉列表对齐，可能有一拍延迟。
- 「允许并记住」按钮已移除（M2 返工 B3）：后端把 `updatedInput` 直接采信为工具入参（`updatedInput ?? pending.input`），没有承载 `permissionSuggestions` 的通道，前端把 suggestions[0] 当 updatedInput 回传会把用户批准的写文件入参替换成 setMode 对象。在后端有正规通道之前只提供「允许」「拒绝」；`permissionSuggestions` 的提取逻辑保留在 `render-items.ts` 备用。
- 每会话事件数组有 2000 条内存上限，超出丢弃最旧；快照接口永远返回全量 transcript，重进会话即恢复。


### M24 模型版本、终端字体与字号设置（2026-09-30）

- Claude 模型菜单优先读取 initialize 的 `displayName` 版本，兼容旧 `description`；Fable 按数字分段取最大版本，其他三档精确匹配别名，缺失时回退「（最新）」。跟随项保留会话有效配置展示，不用全局探测默认值替代。
- 等宽 UI 优先使用本地 Maple Mono NF CN，正文 UI 字体不变。终端打开后显式请求本地字体，完成或 1.5 秒超时后重新度量并 fit；不下载 webfont，不阻塞终端连接。
- 有终端能力时，Ctrl+` 开关终端；首次按需挂载，打开聚焦终端，收起尝试聚焦会话输入框。xterm 放行该组合，自动重复不反复切换。
- 设置 → 外观新增小／默认／大／特大（0.9／1／1.15／1.3），保存到 `workbench-font-scale`，首屏内联恢复。只对 `.sidebar` 和 `.main` 使用 zoom；终端为兄弟节点，字号单独按 13px × 系数更新并 fit。手机在会话视图点「会话列表」、在终端点「返回」后可进入列表底部设置。
- 字体竞态是防御性修复：源码此前没有字体就绪后的重新度量，但不能仅凭源码确认系统字体加载竞态或 Powerline 缺字的实际原因。浏览器字体选择、选区坐标、真机布局和焦点仍待实际验证；命令验收结果见 `.work-orders/2026-09-30-ui-prefs-report.md`。


### M25 原生历史工具时间线与最新页预览（2026-09-30）

- 三处历史共用 `HistoryTimeline`：用户框复用 UserBlockView，助手用 Markdown，工具用实时 ToolCard/summarizeTool，默认折叠且可展开；unknown 不显示成功/失败。仅使用现有配色令牌。
- 预览与导入历史共用 PagedHistory 和 `/messages`：首次读取最新 50 条，顶部持续加载更早，取消原 500 条上限；保留 prepend 滚动补偿和过期请求丢弃，空窗口仍可继续翻页。删除文件头 preview API、类型和专用解析代码。
- 外部续聊支持工具与旧文字事件混排，仍从第一条真实新用户消息开始；跳转优先非 dead，同类取最近活动时间（缺省用创建时间）。
- **实测**：`npm run typecheck`、`npm run build` 通过并更新 dist；以 `node --import tsx` 运行 history、native-conversation、history-flow、resume-config-flow、render-items 相关测试，覆盖三家工具配对、跨页 unknown、行内分页、限长、迟到刷盘、稳定指纹、512 KiB 事件上限、旧事件兼容和跳转优先级。
- **代码复核**：三处均复用实时工具摘要与折叠组件，原生历史只读，闸门和 driver 未改；Kimi wire 的 tool.call/tool.result 形状已只读抽样核对。
- **主会话验收后补的修正**：预览首屏没落在底部 → `PagedHistory` 加 `startAtEnd`（只在首页加载后滚到底一次，`HistoryView` 传）；390 宽出现横滚 → `.history-preview-pane` 加 `min-width: 0`；会话顶栏按钮换行 → `.session-head-actions` 不收缩、按钮 `nowrap`。
- **实测（主会话）**：完整 `npm test` 通过；本机 >1MB 的 Claude 会话在 1280 与 390 两个宽度下预览首屏为最后一轮，可一直翻到第一条用户消息，无横滚。
- **未做**：超长工具正文仍有截断，跨页工具结果不追加读取，思考块仍不显示；窄屏下 ToolCard 动词会被截成「运…」（改版前就有）。

### M26 「到 VSCode/终端继续」+ 空闲自动释放 worker（2026-09-30）

- **顶栏按钮**：会话头操作区新增「到 VSCode/终端继续」（三家都显示），点击调 `POST /api/sessions/:id/release`，成功后把 `resumeCommand` 复制到剪贴板（Clipboard API 失败退回 `window.prompt` 手动复制），结果在按钮旁短暂提示（成功灰字、失败错误色，复用现有令牌）。仅 `idle` 且有 `nativeSessionId` 的会话可点，其他状态的禁用原因写在 title。释放后输入框照常可用，发送时后端自动从磁盘续接。
- **事件渲染**：`worker_released` 归一成弱化系统行「已释放（空闲 N 分钟 / 手动）；下次发送时从磁盘续接」；空闲自动释放（无客户端动作）靠该事件把列表项对齐为已释放（`store.ts` 置 `released:true`、清 `processId`）。
- **设置**：设置菜单新增「会话 → 空闲自动释放」（关闭 / 15 / 30 / 60 / 120 分钟），读写 `/api/prefs`；服务端存了非档位值时补一个如实显示的选项。乐观更新，写失败回滚。
- **后端契约**：见 `server/README.md`「释放（release）worker」小节。释放后再发走与「别处续聊」同一条 `refreshBeforeSend` 路径（比对指纹 → 起新 worker 续接 → 需要时广播 `external_messages_added`），released 会话没有旧 worker 可停。
- **实测**：`npm run typecheck`、`npm run typecheck:frontend`、`npm test`、`npm run build` 全部通过。新增 `server/worker-release.test.ts`（假 driver 覆盖手动释放不标 dead、释放后按原原生 id 续接发送、释放期间外部新增先广播 `external_messages_added`、自动释放跳过 running/待处理闸门/RC 已连接/未到时间/N=0、`setConfig`/`setRemoteControl` 先拉起、续接失败保持 released 可重试、`resumeCommand` 引号转义）与 `server/prefs.test.ts`（校验边界、持久化往返、坏文件回落默认）；`render-items.test.mjs` 新增 `worker_released` 文案用例。
- **主会话验收后补的修正**：`release()` 先从 `workers` 删除、置 `released` 并清 `processId`，再 `await stop()`，避免 stop 期间的发送落到正在退出的 worker；服务重启后所有会话都是 dead，加载时清掉 `released`；released 会话的模型/权限/RC 胶囊保持可用（点了会先拉起 worker）。
- **实测（主会话，临时实例 18790 + scratch 会话）**：wb 发 → 释放 → 模拟 VSCode 宿主续聊 → wb 再发，走 released 路径并广播 `external_messages_added`；三轮往返 6 回合缓存无异常、会话链无分叉。
- **待真机**：8790 上实际释放一个 Codex 会话后在 CLI `codex resume` 解除单写者锁的体验；空闲自动释放的线上观察；按钮与提示的深浅色观感。
- **导入历史截止在导入时刻**（2026-09-30）：续接创建时服务端把「该原生消息文件当时的大小」编码成 cursor 存进 `resumedFrom.historyCursor`；`ResumedHistory` 把它作为 `PagedHistory` 的新可选参数 `initialCursor` 传给首页加载（`fetchInitialHistoryPage`），「导入前的历史对话」不再混入导入之后的轮次；翻更早的页照旧用返回的 `nextCursor`。cursor 失效（原生文件被截断/改写，服务端 400）时退回不带 cursor 的最新一页，不整块报错。历史页预览（`HistoryView`）不传 `initialCursor`，仍从最新一页开始；没有该字段的旧会话行为不变。实测（18790）：续接 scratch 会话后在 wb 再发一轮，「导入前」区块仍止于导入前最后一轮，新一轮只出现在实时流里；客户端请求体里伪造的 `historyCursor` 被服务端覆盖。

### M27 输入框「+」附件（手机传图 / 选电脑文件 / 粘贴拖入）（2026-09-30）

- **入口**：Composer 底栏最左「+」按钮（`.attach-btn`），会话 dead 或 driver `mentions:false` 时禁用。菜单两项：「照片 / 文件」触发隐藏 `<input type="file" multiple>`（不设 accept，iOS 才给 照片图库/拍照/选取文件 三选项）；「电脑上的文件」打开 `DirectoryBrowser` 的 `mode="file"`（目录照常进入、文件可点选、初始路径 = 会话 cwd，配套 `GET /api/fs/dirs?files=1`）。点外 / Esc 关闭。
- **上传**：`POST /api/uploads?sessionId&name`（原始字节，非 multipart）。`image/*` 且（>3.5 MB 或非 png/jpeg/gif/webp，如 HEIC）时前端先 `createImageBitmap` + canvas 缩到长边 ≤2048 转 JPEG 0.85 再传；解码失败原样上传（`attachments.ts` 的 `needsImageReencode` / `prepareImageForUpload`）。
- **附件条**：输入框上方 `.attach-bar`，图片显示缩略图（上传附件用 `URL.createObjectURL`，local 选电脑文件用文件名标签），每张卡 ✕ 移除；上传中显示「上传中…」，失败显示错误且不进发送帧。发送成功清空、失败保留（与草稿纪律一致）；文本与附件可只有其一。
- **粘贴 / 拖放**：textarea `onPaste` 剪贴板有文件时拦截上传（截图场景），`.composer-box` 拖放文件走同一上传流程。
- **发送帧**：ready 附件经 `attachmentMention` 转 `{type:"image",path,mimeType,name}`（mimeType 属 png/jpeg/gif/webp）或 `{type:"file",path,name}`，在 `store.sendComposerInput(sessionId, text, extraMentions)` 里与 @token 引用合并（按 path 去重、合计截到 20）；带附件时不走结构化 command 分支。
- **消息气泡**：`user_message` 事件的 `payload.mentions` 进 `UserBlock.mentions`（`render-items.ts` 容错解析），`UserBlockView` 在文本下方渲染附件区：image 缩略图走 `GET /api/uploads/file?path=`（`onError` 降级为文件名标签），file 显示 `name ?? basename`。历史回放 / snapshot 共用同一链路。
- **实测**：`npm run typecheck` / `npm run typecheck:frontend` / `npm test`（含新增 `test:attach` 7 例与 server 侧 19 个测试文件）/ `npm run build` 全部通过；18790 隔离实例真机冒烟：生成写着 `WB-IMG-7Q2K` 的 PNG 经 `/api/uploads` 上传后以 image mention 发给 Claude 与 Kimi，两家回复均恰含 `WB-IMG-7Q2K`（原始回复与记录见 `scratch/attach-smoke/` 与 `scratch/attach-report.md`）。
- **截图验收**（playwright，390px × 深浅色，`scratch/attach-*.png`）：「+」菜单打开、附件条一张图一个文件、已发送气泡含缩略图，六张均无页面横滚、无页面错误。
- **代码复核未实测**：Codex 的 `localImage` 形状只经 `codex app-server generate-json-schema`（0.159.2）核对 + 单测，本周期额度用尽未真跑；iOS 三选项与拖放手感待真机；图片压缩路径（HEIC→JPEG）在 node 测试里只覆盖判定逻辑，canvas 部分未跑。

### M28 设置菜单重启 Workbench（2026-10-01）

- **入口**：设置 → Workbench →「重启 Workbench」，手机沿用同一入口和同源请求。点击重新读取会话，按托盘口径计数 running 或有后台任务的会话，非零先二次确认；取消不发 POST。
- **恢复**：受访问控制保护的 `POST /api/restart` 返回 202 后由独立进程组重启当前实例。全屏 portal 遮罩显示「重启中」，既有 WS 观察到断开再恢复后撤掉；接口失败或 60 秒未恢复显示失败提示，可关闭，说明按当前实例环境执行 `wb restart` 再刷新。组件卸载清理订阅和计时器。
- **回归**：新增 `test:restart` 并追加到 `npm test`，覆盖会话计数去重、旧连接不误判成功、断线早于处理 202、超时、请求失败及取消清理。隔离实例实测与验收记录见 `.work-orders/2026-10-01-restart-button-report.md`。

### M29 wb 标志与滑动分段切换（2026-10-01）

- 侧栏左上角采用派单 mockup 的粗体等宽 `wb`、竖线与 `workbench`；收起时只显示 `wb`，保留刷新按钮及原有操作。
- 新增可复用 `Segmented`，仅接入主题（跟随系统／浅色／深色）与终端 bash／PowerShell。凹槽和浮起块使用现有中性令牌；单一绝对定位滑块按按钮 `offsetLeft`、宽高移动，180ms 平滑切换，减少动态偏好下关闭动画。布局变化会重新度量，触屏按钮至少 44px。
- 保留主题单选语义与方向键操作、终端 `aria-pressed` 与禁用条件；共用组件支持 Tab 和方向键。字号及其他设置组保持原有控件。
- **验证**：两项类型检查、构建与全部前端测试通过；完整 `npm test` 在后端通知测试绑定 loopback 端口时遇到沙箱 `EPERM`，未全过。指定 Chromium 启动亦被沙箱阻止，深浅色截图和浏览器交互检查未完成。详情及可重跑的浏览器检查脚本见 `.work-orders/2026-10-01-brand-segmented-report.md`。
