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
    render-items.ts     统一事件 → 渲染条目（文本合并、工具聚合、闸门提取）
    mentions.ts         @ 引用纯文本 token 提取 / 光标处触发判定（无 DOM 依赖，可单测）
    store.ts            全局状态 + WS 连接恢复（见下）
    useStore.ts         useSyncExternalStore 订阅 hook
    App.tsx             布局骨架、hash 路由、错误提示条
    components/
      Sidebar.tsx       会话列表（身份色脊 / 状态点 / 闸门徽标 / 危险模式「!」标记 / 行右删除入口 ×：hover/focus 显现、Tab 可达，点击后就地变行内二次确认）+ 新建会话表单（含三个配置下拉；cwd 三级预填回退 + 空 cwd 可见禁用原因）+ 底部设置入口
      SettingsMenu.tsx  设置齿轮 + 锚定浮层（分组/条目结构，60vh 限高滚动 + focus trap）；主题三选一写 <html data-theme>、localStorage 持久化（读写均 try/catch）
      SessionView.tsx   会话头（usage 分家渲染 / 配置只读摘要 / 中断）+ 危险模式警示条 + 事件流 + 输入框（配置控件行在输入框正上方；行首 / 命令面板、@ 文件引用面板与待附加预览条、结构化 command 上行、codex 降级说明；dead 会话「新建会话并续接」出口）+ 未决闸门贴条
      StreamItems.tsx   用户消息 / 文本块 / 思考折叠块 / 工具卡片 / 闸门块 / 系统行
    styles.css          设计令牌（深浅两套）与全部样式
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

## 验收自查

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

## 已知取舍

- `@token` 严格按空白切段：句末紧跟标点（如 `@a.ts，`）会把标点并入 token 导致「未找到，不会附加」，需要用户在引用后敲空格。

- 未引入 UI 组件库、图标库、路由库：图标用 Unicode，路由用 hash（`#/session/<id>`）。
- 未引入 `@vitejs/plugin-react`：esbuild automatic JSX 够用，dev 下 HMR 退化为整页刷新。
- 会话状态没有专属 WS 事件，左栏状态靠事件推断 + 2 秒防抖重拉列表对齐，可能有一拍延迟。
- 「允许并记住」按钮已移除（M2 返工 B3）：后端把 `updatedInput` 直接采信为工具入参（`updatedInput ?? pending.input`），没有承载 `permissionSuggestions` 的通道，前端把 suggestions[0] 当 updatedInput 回传会把用户批准的写文件入参替换成 setMode 对象。在后端有正规通道之前只提供「允许」「拒绝」；`permissionSuggestions` 的提取逻辑保留在 `render-items.ts` 备用。
- 每会话事件数组有 2000 条内存上限，超出丢弃最旧；快照接口永远返回全量 transcript，重进会话即恢复。
