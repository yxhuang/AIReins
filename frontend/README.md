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
    store.ts            全局状态 + WS 连接恢复（见下）
    useStore.ts         useSyncExternalStore 订阅 hook
    App.tsx             布局骨架、hash 路由、错误提示条
    components/
      Sidebar.tsx       会话列表（身份色脊 / 状态点 / 闸门徽标）+ 新建会话表单
      SessionView.tsx   会话头（usage 分家渲染 / 中断）+ 事件流 + 输入框 + 未决闸门贴条
      StreamItems.tsx   用户消息 / 文本块 / 思考折叠块 / 工具卡片 / 闸门块 / 系统行
    styles.css          设计令牌（深浅两套）与全部样式
```

### 状态模型

单一 `Store`（`src/store.ts`），React 通过 `useSyncExternalStore` 订阅 `version` 计数：

- `sessions`：`GET /api/sessions` 初始加载；任何 WS 事件都本地刷新该会话的 `lastActivityAt` 并推断状态（`user_message`→running、`process_exited`→dead 等），另有 2 秒防抖的列表重拉对齐权威状态；
- `data: Map<sessionId, {events, seq, pendingGates, latestUsage}>`：进入会话时先 `GET /api/sessions/:id/snapshot` 拿全量 events + seq；`pendingGates` = permission_request − permission_resolved（按 requestId 匹配），既驱动闸门块状态也驱动左栏徽标；
- 启动时为列表里每个会话取一次快照——后端没有标题字段，左栏标题用该会话第一条 `user_message` 派生（没有则用 cwd 末段 + 短 id），快照同时给出各会话的未决闸门数。

### 连接与恢复

- 一条**全局 WS**（`/ws`，不带 `sessionId`）收全部会话事件——服务端只在 client 指定了 sessionId 时才过滤，这是跨会话徽标的基础；
- 当前会话的增量事件仅在 `seq > snapshotSeq` 时追加；发现缺口（`seq > data.seq + 1`）直接重取快照；
- 断线指数退避重连（1s 起、封顶 15s），重连成功后重拉会话列表并对当前会话重取快照；收到 `resync_required` 也对对应会话重取快照；
- 上行（user_message / permission_resolved / interrupt）走同一条 WS，失败帧（`type:"error"`）进入右上角错误提示条。

### 闸门块（签名元素）

流内块级元素，暖色边框 + 暖色浅底 + 直角（其余卡片 8px 圆角）。三家 payload 在 `render-items.ts` 的 `gateFromEvent` 统一提取：命令（kimi terminal/create、claude Bash、codex params.command）等宽全文默认展开；文件写入内容可折叠；兜底「完整入参」JSON。「允许并记住」仅在 `permissionSuggestions` 非空时出现（decision=`always`，第一条 suggestion 作为 `updatedInput` 原样回传）。`permission_resolved` 广播到达后闸门降级为中性样式，显示「已允许 / 已拒绝 / 已允许（记住）」。未决闸门滚出视口时，输入框上方贴暖色细条「N 个闸门等待处理 ↑」，点击滚动定位到第一个。

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

## 已知取舍

- 未引入 UI 组件库、图标库、路由库：图标用 Unicode，路由用 hash（`#/session/<id>`）。
- 未引入 `@vitejs/plugin-react`：esbuild automatic JSX 够用，dev 下 HMR 退化为整页刷新。
- 会话状态没有专属 WS 事件，左栏状态靠事件推断 + 2 秒防抖重拉列表对齐，可能有一拍延迟。
