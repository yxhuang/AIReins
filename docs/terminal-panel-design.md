# 工作台内置终端 · 设计方案

目标：在工作台里随时可用一个真实终端，与主会话窗口左右并排（VSCode 式），
默认隐藏、按钮唤出，中间分隔条可鼠标拖动调整水平占比。

---

## 1. 布局

现有结构（`styles.css:139`、`App.tsx`）：

```
.app (flex row)
  .sidebar   264px / 收起 52px
  .main      flex:1，内部 flex-direction:column
```

**改动最小的插法**：给 `.main` 外面套一层 `.workspace`，`.main` 内部规则一行不动。

```
.app (flex row)
  .sidebar
  .workspace (flex row, flex:1 1 auto, min-width:0)      ← 新增
    .main        (flex:1 1 auto, min-width:0)            ← 内部完全不变
    .term-split  (flex:0 0 6px)                          ← 新增，仅终端开启时渲染
    .term-panel  (flex:0 0 <width>px, min-width:0)       ← 新增
```

终端关闭时 `.term-split` 与 `.term-panel` 都不渲染，`.main` 自然占满——
不需要任何 `width:100%` 之类的补偿规则。

### 分隔条

- `role="separator"` + `aria-orientation="vertical"` + `aria-valuenow`，
  **方向键可调**（每次 16px）——本仓库刚补过一轮 a11y，别在新组件上开倒车。
- 指针交互用 `setPointerCapture`，`touch-action: none`；
  拖动期间给 `<body>` 加 `.resizing`（`user-select:none` + `cursor:col-resize`），
  否则拖动会和文本选中打架。
- **双击复位**到默认宽度。
- 宽度存 px 到 localStorage（读写 `typeof` 判定 + try/catch，照本仓库现有纪律），
  挂载时和 `window.resize` 时都要 clamp 到 `[320, 视口宽 - 480]`，
  否则换个窗口尺寸会出现主区被挤没的死状态。

### 开关按钮

放**左栏底部**，与「页面」「设置」并列。理由：终端是工作区级设施，
放这里在会话视图、历史视图、页面视图下都在；放会话头则只有会话视图有。
左栏收起态保留图标。

---

## 2. 终端的归属与生命周期（关键决策）

**推荐：工作区级，不绑会话。**

- 切换会话**不能**杀终端——你在里面跑着 `npm run dev`，点一下别的会话就没了，不可接受。
- 隐藏面板 = CSS 隐藏，PTY 继续跑，输出继续进服务端缓冲区。与 VSCode 一致。
- 新建终端时 cwd 默认取**当前所看会话**的 cwd（没有会话时取 `meta.defaultCwd`）。
  归属是全局的，但初始 cwd 跟随上下文——这是最省事又符合直觉的组合。

### 刷新页面后怎么办

PTY 活在 server 进程里，前端刷新不该杀它。按 terminalId 重新 attach，
服务端回放一段 scrollback。

服务端每终端保留**最近 256KB** 输出，超出丢弃最旧并计数，
前端顶部提示一行「已省略较早输出」——**直接复用 `MAX_EVENTS` / `dropped` 那套现成纪律**，
不要发明第二种截断语义。

---

## 3. 后端

### PTY 选型

| | `node-pty` | `script -qfc` |
|---|---|---|
| 依赖 | 原生模块，可能要 node-gyp + 编译工具链 | 零依赖（util-linux 自带） |
| resize | 完整支持 | **改不了 TIOCSWINSZ，没法优雅 resize** |
| 定位 | xterm.js 生态原配 | 可用，但是 trick |

**推荐 `node-pty`。** 这个面板的整个卖点就是可拖动改宽度，而 resize 失效意味着
一拖动全屏程序（vim/htop）排版就烂——恰好砸在核心交互上。

代价要认：本项目运行时依赖目前**只有 `ws` 一个**，加原生模块是实打实的纪律让步。
动手前先验一次目标 Node 版本有没有预编译产物，别等做到一半才发现要装工具链。

### 通道

**一条专用 WS `/ws/terminal`，按 terminalId 多路复用**（不要每终端一条 socket——
现有的指数退避重连逻辑只写了一份，N 条 socket 就要维护 N 份状态机）。

- 下行 `{type:"data", terminalId, chunk}`：用**二进制帧**，别 base64（省 33% 体积）
- 上行 `{type:"input"|"resize", terminalId, ...}`
- 生命周期走 REST：`POST /api/terminals`（建，返回 id）、`GET /api/terminals`（列）、
  `POST /api/terminals/:id/kill`

> 注：kill 终端是**结束进程**，不是删文件，与「`server/` 全目录不许出现文件删除调用」
> 那条不变量不冲突。但别把它做成 `DELETE` 动词，免得日后有人望文生义。

---

## 4. ⚠️ 配色不变量的正面冲突

`styles.css` 开头写着：

> 闸门专用色 = 琥珀金…**全站仅审批相关元素可用**
> 新增任何颜色前先问：它会不会被误读成「有闸门在等我」

而终端必然要渲染 **ANSI 16 色**，其中 yellow / bright-yellow 天生就在琥珀金附近。
一条 `npm WARN` 就是一片黄——**用户会条件反射以为有闸门在等他**。
这是本方案唯一会侵蚀产品核心规则的地方，必须显式裁决。

**建议裁决（三条一起）**：

1. **终端内容区豁免**，视同外来内容——本仓库已有先例：PageView 的 iframe 渲染的是
   用户自己 manifest 里的任意页面，同样不受配色不变量约束。
   不变量管的是**工作台自己的 chrome**，不是第三方程序的输出。
2. **终端 chrome 严格禁暖色**：面板边框、标签条、开关按钮、分隔条一律中性/冷色。
   看到暖色仍然只可能意味着"有闸门"。
3. **ANSI 黄主动避让**：调色板里的 yellow 往橄榄/赭石方向偏，明确拉开与琥珀金的距离，
   而不是直接抄默认主题。

裁决结论要**写进 `styles.css` 顶部那段不变量注释**——这个项目一直有把决策落纸的纪律，
别让它变成只存在于某次对话里的口头约定。

另外 xterm 主题必须跟随三态主题（浅/深/跟随系统），
`check:theme` 那套守卫要相应扩展到终端调色板，否则深色下必然出现不可读组合。

---

## 5. ⚠️ 与审批闸门的边界

工作台的整个产品立场是**最终审批闸门**：kimi 的 `terminal/create` 无论上游放没放行都要拦
（`server/drivers/kimi.ts:272`）。现在同一块屏幕上要多出一个**无审批的自由终端**。

这本身可以接受——**闸门防的是 agent，不是你本人**——但有两条必须守住：

1. **两套注册表物理隔离。** ACP 的 `terminal/create` 与用户终端**绝不能共用**
   同一个 terminal 注册表或同一套 id 空间。共用则 agent 可以拿到用户终端的 id
   并向它写入，等于绕过闸门拿到一个已授权的 shell。这是本方案最硬的安全约束。
2. **UI 上不许混淆。** 终端输出永远不进事件流；面板 chrome 与会话卡片视觉上明确分区，
   别让未来的你误以为终端里敲的东西也过闸门。

---

## 6. 与网络暴露的乘积效应

当前服务端 `HOST = "127.0.0.1"` 硬编码且**零鉴权**（`server/index.ts:24`）。

- 现状暴露到 tailnet 的风险：别人能替你**批准 agent 命令**。
- 加了自由终端之后：别人能**直接在你机器上敲任意命令**。

零鉴权 + 自由终端 + 网络可达 = 开放的远程 shell。

**结论：这两件事任意一件单独做都还好，一起做而不加鉴权就危险。**
要么先做鉴权再做终端，要么终端做了就暂时别碰网络暴露。

---

## 7. 分期

**M1（核心，先跑起来）**
单个终端、无标签页、PTY + WS + 分隔条 + 开关 + 宽度持久化 + 主题跟随。

**M2（可用性）** ✅ 2026-10-03 已全部落地
多终端标签页（见 §9 末补充）、cwd 跟随当前会话、刷新后按 id 重连并回放 scrollback。

**M3（暂不做）**
搜索、选中即复制、链接识别。

M1 就能满足「随时可以使用 terminal」。M2 之前刷新页面会断连，M1 阶段可接受。

---

## 8. 需要拍板的四件事

1. **`node-pty` 这个原生依赖收不收？**（推荐收；不收就得接受 resize 残废）
2. **终端归属**：工作区级（推荐）还是每会话一个？
3. **ANSI 黄**：按上面三条裁决走，还是你有别的想法？
4. **鉴权**：这轮一起做，还是先不做、同时明确暂缓网络暴露？

---

## 9. 定案（2026-09-26 用户拍板）与接口契约

§8 四件事的结论：

1. **PTY 用预编译版 `@lydell/node-pty`**（固定 `1.2.0-beta.15`，同 node-pty API，自带 linux-x64 二进制）。本机没有 C++ 工具链，官方 node-pty 装不上；主会话已实测 spawn、`resize` 后 `stty size` 从 24×80 变 40×120。依赖已由主会话装好，前后端执行端都不改 `package.json` 的依赖。
2. **工作区级**：终端不绑会话，切会话不杀；新建时 cwd 取当前所看会话的 cwd，没有会话取 `meta.defaultCwd`。
3. **ANSI 黄按 §4 三条**：终端内容区豁免配色不变量；终端 chrome 禁暖色；调色板的 yellow / bright-yellow 往橄榄 / 赭石偏，拉开与琥珀金的距离。结论写进 `styles.css` 顶部不变量注释。
4. **鉴权已由 `server/access.ts` 解决**（本机 Host/Origin 白名单、远程 Tailscale 身份白名单）。**手机远程入口也开放终端**，但须 `~/.workbench/remote.json` 显式 `"terminal": true` 才开（缺省关）；该文件由用户自己改。

范围：本轮做 §7 的 **M1 + 刷新 / 断线后按 id 重连并回放 scrollback**（手机锁屏重连是常态，没它不可用）。搜索等 M3 项留到以后。

### 接口契约（前后端都以此为准）

能力位：`GET /api/meta` 的 `capabilities.terminal: boolean`，**按请求入口计算**：本机入口恒 true；远程入口 = `remote.json` 的 `terminal === true`。为 false 时前端不显示终端入口，后端对下面所有终端接口返回 403。

REST（沿用现有 `{code, msg, data}` 包装）：

- `GET /api/terminals` → `data: { terminals: TerminalInfo[] }`
- `POST /api/terminals`，body `{ cwd?: string, shell?: "bash" | "powershell", cols: number, rows: number }` → `data: TerminalInfo`。cwd 缺省或不存在时用 server 的 defaultCwd；可选 `shell: "bash" | "powershell"`（白名单，不收路径；缺省和旧客户端 `"bash"` 均表示本机 Unix 缺省 shell，选择规则见本节「平台兼容」）。powershell 的 cwd 只在 `/mnt/<盘符>` 下才沿用，否则用 Windows 用户目录（从 WSL 追加的 Windows PATH 里取 `/mnt/c/Users/<名>`，取不到用 `/mnt/c`）；powershell 优先 `/mnt/c/Program Files/PowerShell/7/pwsh.exe`，其次 PATH 中 `/mnt/` 目录里的 `pwsh.exe`（Store 版启动别名），都没有则 Windows PowerShell 5.1，参数 `-NoLogo`。`TerminalInfo` 带 `kind`。
- `POST /api/terminals/:id/kill` → `data: { ok: true }`。结束进程，不是删文件；不用 DELETE 动词。

`TerminalInfo = { id: string, cwd: string, kind: "bash" | "powershell", shell: string, cols: number, rows: number, createdAt: string, exited: boolean, exitCode: number | null }`

`shell` 为实际启动的程序；`GET /api/meta` 的 `data.terminalShell: string` 给出本机 Unix 缺省 shell 的文件名（如 `zsh`），旧后端省略时前端回退 bash。标签用 `TerminalInfo.shell` 文件名；滑块取当前 Unix 终端实际名字，无当前 Unix 终端时取 meta；新建提示取 meta（PowerShell 仍固定显示 PowerShell）。

WS `/ws/terminal`（与 `/ws` 同一套 Host / Origin / Tailscale 身份检查；能力位为 false 时拒绝升级），全部 JSON 文本帧（PTY 输出本就是 UTF-8 字符串，不再做二进制分帧，偏离 §3 原建议，换实现简单）：

- 上行 `{type:"attach", terminalId}`：服务端先回 `{type:"attached", terminalId, omitted}`（`omitted` = scrollback 因 256KB 上限丢掉的字节数，>0 时前端顶部提示「已省略较早输出」），再发一条 `{type:"data", terminalId, data}` 装当前全部 scrollback（回放帧会剥掉 OSC 4/10/11/12 颜色查询与 CSI DA 与 DSR/CPR（5n/6n/?6n）询问序列，见 `stripReplayQueries`——重放会让 xterm 重新应答、应答字节被 shell 当输入回显成垃圾；实时推送不剥），之后实时推送。同一连接可 attach 多个；重复 attach 同一 id 视为重新回放（前端先 `reset()` 再写）。上行 `{type:"detach", terminalId}` 解除该连接对它的订阅（PTY 与 scrollback 保留），前端切换 shell 时对切走的终端发送。
- 上行 `{type:"input", terminalId, data}`、`{type:"resize", terminalId, cols, rows}`。
- 下行 `{type:"data", terminalId, data}`、`{type:"exit", terminalId, exitCode}`、`{type:"error", terminalId?, message}`（未知 id、已退出等）。
- 服务端每终端保留最近 256KB 输出；进程退出后记录保留（`exited: true`），直到 server 重启；已退出且无人附着的记录最多保留最近 8 个，更早的连同回放 Buffer 淘汰（运行中或仍有人附着的不淘汰）。server 重启 = 全部终端结束，这是已知行为。

安全硬约束（§5）：用户终端注册表与 kimi ACP `terminal/create` **物理隔离**，独立模块、独立 id 空间，agent 侧代码不得 import 它；终端输出永远不进会话事件流。

### 多终端标签页（2026-10-03 补，M2 最后一项）

- 标签条列出注册表全部未退出终端，外加当前激活的已退出终端（看输出与退出码）；同种 shell 多个时按注册表顺序全体编号（bash 1 / bash 2）；已退出标签切走后从条上消失。
- 中间栏与右侧栏各按需挂载一个 xterm 实例，隐藏后保持挂载；标签可在栏内排序，也可与文件标签一起跨栏拖放。接收范围覆盖整栏，HTML/PDF 内容区也可落下；标签左右半边分别插入前后，会话标签固定在主区首位。每栏切标签或跨栏移动 = detach 旧订阅 + attach 原终端 id，屏幕先 reset 再写回放（沿用 §9 重复 attach 语义），不重建 PTY；两栏可同时显示不同终端。主区的全局顶栏承载标签和会话面板开关，终端移入主区后只显示自身 shell/进程工具栏，不重复渲染标签条。排序与位置只保存在当前页面，后台终端和 scrollback 不受影响。
- 激活终端 id 存 localStorage `workbench-term-active`（按设备）；刷新/重进面板优先重连它，已退出或不存在回落第一个未退出终端，都没有新建本机缺省 shell。
- 标题栏保留原 `Segmented.term-shells` Unix shell / PowerShell 滑块，Unix 一侧显示实际名字（如 zsh；WSL 仍 bash），value 跟随激活标签的 kind。点另一侧优先切到本面板内最近激活过的该 kind 存活终端；没有激活记录则选注册表第一个该 kind 存活终端；都没有才新建，cwd 规则与「＋」一致。
- 「＋」像 Chrome 一样紧跟最后一个标签（标签列表按内容定宽，标签用 `width:128px`，放不下时收缩到 72px 并横向滚动，「＋」始终可见），一键新建当前激活标签同 kind 的终端；没有激活标签时新建本机缺省 shell。cwd 仍优先跟随当前所看会话，否则用默认 cwd；不弹 shell 菜单。
- 最大化 / 还原按钮靠标签条右端（`margin-left:auto`），与「＋」图标均为 22px。文件面板标签行同样布局，右端是「隐藏文件」开关。最大化仅铺满 `.workspace`（主会话 + 终端区域），保留左侧栏；主会话保持挂载，终端重新 fit 并同步 PTY 尺寸，还原沿用之前的分栏宽度。最大化时点击会话或任一主区文件/终端标签会先还原，再显示目标；`Alt+0` 同样还原并回会话。窄屏已铺满，不显示此按钮。
- Bash / PowerShell 均支持 `Ctrl+V`、`Ctrl+Shift+V`（Mac 为 `Cmd+V`）：绕过 xterm 键盘控制序列，交给浏览器原生 paste 事件与 xterm 粘贴处理。终端内容区右键直接粘贴，移动端保留快捷键栏的「粘贴」按钮；右键 / 按钮读剪贴板被拒绝或不可用时弹出输入框，手动粘贴后确认。粘贴沿用 xterm 的换行归一与 bracketed paste。
- 标签默认宽度为 128px，可继续收缩，触控标签仍保留 116px 最小宽度和 44px 点击目标。最大化按钮在窄屏及无悬停的触控设备上隐藏，覆盖手机横屏。
- 手机终端内容区单指上滑累计 48px 后隐藏第一行标题栏，标签行保留；下滑只有在 xterm 输出视口已到顶部（`viewportY === 0`）时才累计，继续下拉 48px 后显示标题栏。横向手势、多指手势和点击忽略，不拦截 xterm 滚动；每次手势重新累计，重新打开、切换标签、显示结束确认或切换窄屏状态时恢复标题栏。
- 每个标签右侧「×」：存活终端复用标题栏的行内二次确认，非激活标签先切到它再确认；只有点击「确认结束」才调用 kill。标题栏「结束」与标签「×」确认后的行为相同：kill 接口成功即关闭标签，不等待 WS exit 帧、不显示「已结束」或退出码；请求期间也不闪现退出提示，失败保留标签并显示错误。关闭后切到最近的存活邻居（同距离右侧优先）；唯一标签关闭则清空激活态，标签区仅留「＋」，不自动新建。自行 `exit` 等非确认结束仍保留当前退出标签及输出/退出码，其「×」直接关闭。上述两条关闭路径共用 detach、相邻选择、清空及本地激活 id 更新。注册表接口不变。
- 标签为等宽可收缩的 Chrome 圆角与反向圆弧脚，带 shell 图标、标题省略与相邻分隔线；配色同 Chrome：标签栏凹槽比下方内容区更深（深色混黑、浅色混字色），激活标签取下方内容区底色连成一体（终端为终端底色，主区文件/终端为标题栏 `--surface`，会话为 `--bg`）；标签区独立横向滚动。激活标签「×」常显，其他标签悬停或键盘聚焦时显示。窄屏点击区域至少 44px，cwd 让位，滑块保留。

### 平台兼容（2026-10-12，§9 契约补充）

WSL2 的缺省 shell 保留 `bash -l -i`，不跟 `$SHELL`。原生 Linux 与 macOS（实验性）取服务进程 `$SHELL`，须为绝对路径、可执行且列在 `/etc/shells`；仅当文件不存在时省略名单检查，读取失败不放行。无效时 macOS 先退到可执行 `/bin/zsh`，再退 `bash`；Linux 退 `bash`。zsh/bash 用 `-l -i`，其他 shell 保守只传 `-l`。只有 `/api/meta.capabilities.powershell:true` 才显示 PowerShell 选择；Windows pwsh/PowerShell 路径仅 WSL 可解析，其他平台即便有同名 `/mnt` 目录也拒绝这个 shell 种类。客户端仍只能传白名单种类，旧 `shell:"bash"` 继续可用。远程终端仍由 `terminal` 能力与 remote.json 显式开启控制，所有 Host/Origin、Tailscale 身份检查及终端隔离不变。
