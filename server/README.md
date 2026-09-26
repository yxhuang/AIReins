# Workbench server（M1）

后端使用 Node 22、TypeScript 和 `tsx` 直跑，没有后端构建步骤。服务固定绑定回环地址 `127.0.0.1`，默认端口为 `8790`，带访问控制（见「## 访问控制」）；三家 CLI 版本在启动时实测并缓存。

## 启动

```bash
npm install
npm run server
```

默认静态目录是仓库内的 `frontend/dist/`；M2 构建完成后会自动从 `/` 托管 SPA。开发时也可用 `WORKBENCH_STATIC_DIR` 指向另一份静态产物。`WORKBENCH_PORT` 可在并行开发或隔离验收时改端口，但不能改变回环绑定地址；生产默认仍为 `8790`。

持久化位置：

- 注册表：`~/.workbench/sessions.json`
- 统一事件 transcript：`~/.workbench/transcripts/<sessionId>.ndjson`
- 非 Git 工作目录的委派前快照：`~/.workbench/snapshots/<basename>-<pathHash>/`
- 各家 CLI 自有 transcript：完全由原生 CLI 管理；Workbench 从不删除

服务启动会把注册表中的旧会话统一标记为 `dead`，不会接管或自动续接旧进程。需要续接时，新建会话可传原生 `resumeSessionId`；Claude 使用 `--resume`，Codex 使用 `thread/resume`，Kimi 使用 `session/resume`。

## 访问控制

`server/access.ts` 按请求从哪个监听进来，套用不同的策略。

被拒绝时：

- HTTP 请求返回 `403`：`code` 为 `40300`，`msg` 是拒绝原因。
- WS 握手直接返回 `403` 并断开。
- 两种情况都会记一条日志：`request failed` 或 `websocket rejected`。

| 入口 | 给谁用 | 规则 |
|---|---|---|
| `127.0.0.1:8790`（可用 `WORKBENCH_PORT` 改） | 电脑浏览器、Vite 开发服务器（5173）、本机的 curl 和脚本 | 见下 |
| `127.0.0.1:<remote.json 的 port>`（默认不开） | `tailscale serve` 转发的手机请求 | 见下 |

本机入口的规则：

- **Host**：必须是 `127.0.0.1` 或 `localhost`，端口为本端口或 5173。用来挡 DNS 重绑定。
- **Origin**：写操作（GET、HEAD 以外）和 WS 握手如果带了 Origin，必须是上面四个地址对应的 `http://` 源。用来挡跨站伪造和 WS 劫持。
- **不带 Origin 的请求放行**：这类请求来自本机进程。

另外，静态资源响应带 `X-Frame-Options: DENY` 和 `Content-Security-Policy: frame-ancestors 'none'`，不允许别的网站嵌入 workbench。

远程入口的规则：

- **Host**：必须是配置的 `origin` 主机名，或 `127.0.0.1:<port>`（Serve 转发可能改写 Host）。
- **身份**：必须带 Serve 注入的 `Tailscale-User-Login` 头，且登录名在 `allowedLogins` 中。
- **Origin**：写操作和 WS 握手必须带 Origin，且与配置的 `origin` 完全一致。

### 远程入口配置 `~/.workbench/remote.json`

没有文件时不开远程入口。文件无效时只记一条 `remote.json 无效，远程入口未开启` 日志，本机入口照常使用。更改配置后须重启 workbench 才生效。

```json
{
  "port": 8792,
  "origin": "https://my-desktop.tailxxxx.ts.net",
  "allowedLogins": ["你的登录名@github"],
  "terminal": false
}
```

- `port`：1–65535，不能与本机端口相同，且须与 Serve 转发目标一致。
- `origin`：手机地址栏里的源；全小写，无路径、无结尾斜杠。
- `allowedLogins`：允许访问的 Tailscale 登录名。未知时可先填占位值，手机打开页面后，403 提示会显示实际登录名。
- `terminal`：可选布尔值。只有显式设为 `true` 才允许远程入口使用自由终端；缺省或类型不对均按 `false` 处理，类型错误会记日志。

Serve 会剥掉客户端自带的同名身份头，再注入真实身份。远程端口只绑定 `127.0.0.1`；DNS 重绑定网页的 Host 过不了检查。本机进程可伪造此头，但本来就能访问本机入口。

### 手机远程排错

| 现象 | 常见原因 | 处理 |
|---|---|---|
| 手机打不开，一直超时 | 手机 Tailscale 没连上；代理客户端 TUN 抢了路由；电脑睡眠或关机了 | 看手机 Tailscale 的连接状态；TUN 模式要把 `100.64.0.0/10` 与 `*.ts.net` 设为直连；电脑那边远程开机 |
| 502 Bad Gateway | workbench 没在跑；或 `remote.json` 没配、配错了，8792 没有监听 | 用 `workbench status` 看「远程」那一行；`workbench logs` 里搜 `remote` |
| 403「没有 Tailscale 身份」 | 没走 Serve，比如直连了 8792；或请求来自 Funnel、打了 tag 的设备 | 改用 `https://<机器域名>/` 访问 |
| 403「Tailscale 账号 X 未授权」 | X 不在 `allowedLogins` 里 | 把 X 加进 `remote.json`，然后 `workbench restart` |
| 403「Origin 不匹配」或「Host 不在远程白名单」 | `remote.json` 里的 `origin` 和地址栏不一致（大小写、结尾斜杠、机器改了名） | 改成地址栏里的 `https://<机器域名>`，不带结尾斜杠，然后 restart |
| 页面能打开，但一直「连接中」，圆点不变绿 | WS 握手被拒（日志里有 `websocket rejected`），或 Serve 没转发 WS | 按日志里的原因处理；如果是 Serve 的问题，记下现象报告给用户 |
| 电脑浏览器突然 403 | 用了白名单以外的地址访问，比如局域网 IP、自定义的 hosts 名 | 改用 `http://127.0.0.1:8790` 或 `http://localhost:8790` |
| 手机上改了后端却没变化 | 后端改动要 `workbench restart` 才生效（前端 `dist` 刷新即可） | 重启前先查 `/api/sessions` 有无活会话 |

## 闸门提醒

配了 `~/.workbench/notify.json` 才开启：闸门挂起超过 `delaySeconds` 秒（默认 60）还没人处理，就发一条飞书提醒。两种发送方式二选一：`feishuWebhook` 走群里的自定义机器人；`larkUserId` 调本机 `lark-cli im +messages-send --as bot` 让应用机器人私聊该 open_id（租户关了自定义机器人时用，凭据由 lark-cli 管，要先 `lark-cli auth status` 看 bot 身份是 ready）。

- **限频**：同一会话 60 秒内最多发一条；冷却中到期的闸门顺延，冷却结束时仍未处理再发。
- **取消提醒**：收到 `permission_resolved`（已处理），或 `process_exited`（进程退出，闸门没法再操作）。
- **直达链接**：配了 `remote.json` 时，提醒带 `<origin>/#/session/<id>` 链接。
- **容错**：发送失败只记一条 `warn` 日志；`notify.json` 写错只记一条 `error` 日志；两种情况都不影响服务。

```json
{ "feishuWebhook": "https://open.feishu.cn/open-apis/bot/v2/hook/…", "delaySeconds": 60 }
{ "larkUserId": "ou_…", "delaySeconds": 60 }
```

webhook 地址就是密钥：文件权限设为 600，也不要写进日志或仓库。更改配置后须重启 workbench 才生效。

## REST

所有 REST 成功和错误都使用同一个信封；`request_id` 是 ULID，也会出现在同次请求的服务端 JSON 日志中。

```json
{"code":0,"msg":"success","data":{},"request_id":"01M0..."}
```

接口：

- `POST /api/sessions`：创建会话，统一配置见下文
- `POST /api/snapshot/preflight`：建会话前检查 cwd 是否需要及能够自动快照
- `GET /api/fs/dirs?path=<绝对路径>`：只读列出一级子目录；省略 `path` 时使用 `~/dev`（不存在则 `$HOME`）
- `GET /api/sessions`
- `GET /api/sessions/:id`
- `GET /api/sessions/:id/snapshot`
- `GET /api/sessions/:id/commands`：当前活动会话的实时归一命令表
- `GET /api/sessions/:id/files?q=<关键词>&limit=<默认50>`：在会话 `cwd` 内检索可引用的普通文件
- `DELETE /api/sessions/:id`：停止 worker 并移除注册表条目；不删除 Workbench 或原生 CLI transcript
- `GET /api/history`：只读列出三家 CLI 自己保存的历史会话
- `GET /api/history/:agent/:nativeSessionId`：有界读取会话头部，返回导入前预览
- `GET /api/history/:agent/:nativeSessionId/messages`：从最新消息向前分页读取完整原生历史
- `GET /api/meta`：server/CLI 实测版本、全局能力、三 driver 能力位与配置 schema
- `GET /api/pages`：启动时已注册的扩展页面列表
- `GET /api/pages/:id/health`：限时探测一个扩展页面的目标服务

`GET /api/fs/dirs` 的 `data` 为 `{path,parent,dirs:[{name,path}],truncated}`。路径先规范化；根目录 `/` 的 `parent` 为 `null`。不限制浏览根目录，包括 `/mnt/c/...`；隐藏目录不列出，指向目录的有效符号链接会列出，断链和无权限条目跳过。子目录按名称排序，最多返回 1000 项，更多时 `truncated:true`。路径无效、不存在、不是目录或无权限读取时返回 HTTP 400、错误码 `40035`。

建会话时，三家统一使用 `config.model / config.effort / config.permissionMode`：

```json
{
  "agent": "claude",
  "cwd": "/home/user/dev/workbench",
  "snapshot": "auto",
  "config": {
    "model": "haiku",
    "effort": "low",
    "permissionMode": "manual"
  },
  "initialMessage": "只回复 OK"
}
```

`CreateSessionInput.snapshot` 可省略，取值为 `"auto" | "skip"`，默认 `"auto"`。`auto` 会在
driver 启动前检查 cwd：位于 Git 仓库（包括仓库子目录）时跳过；非 Git 目录在阈值和空间
检查通过后先刷新全量快照。快照成功时，创建响应、会话列表、会话详情和会话 snapshot 中的
`session` 都可包含 `snapshotPath: string`。快照失败不会阻断会话创建；server 记录 warn 日志，
并发送 `session_error` 事件，其中 `source:"snapshot"`、`severity:"warning"`、
`nonBlocking:true`。

三项都可省略，也可在建会话时传 `null` 表示“不覆盖、跟随 CLI 有效配置”。不传 `config` 时沿用各 driver 原有默认行为。旧字段 `model` 与 `kimiMode` 暂时兼容，分别等价于 `config.model` 与 Kimi 的 `config.permissionMode`；新调用不要再使用旧字段。WS `set_config` 对 schema 中同时满足 `mutable:true` 且 `values` 含 `null` 的选项接受 `null`，用于清除已经生效的会话级覆盖。`config` 始终是判断会话级覆盖是否存在的事实源；Claude 的继承值另见下述 `effective*` 字段。

`GET /api/sessions`、会话详情和 snapshot 中的 `session` 都包含当前配置：

```json
{
  "model": "kimi-code/k3",
  "effort": "high",
  "permissionMode": "default",
  "config": {
    "model": "kimi-code/k3",
    "effort": "high",
    "permissionMode": "default"
  },
  "riskyMode": false
}
```

Claude 额外固定返回四个字段；未显式覆盖时的初始形状如下：

```json
{
  "model": null,
  "effort": null,
  "effectiveModel": "opus",
  "effectiveEffort": "high",
  "effectiveModelSource": "settings",
  "effectiveEffortSource": "settings",
  "config": {
    "model": null,
    "effort": null,
    "permissionMode": "manual"
  }
}
```

`config.model / config.effort` 只表示会话级覆盖，`null` 不改写；前端据此区分“覆盖”与“继承”。`effectiveModel / effectiveEffort` 是当前能确认的实际值，拿不到就是 `null`。对应 source 为：`session`（会话显式覆盖）、`settings`（分层 settings 合并）或 `init`（Claude `system/init` 的运行时回报）；值为 `null` 时 source 也为 `null`。兼容字段 `model / effort` 保留既有语义：首轮前是覆盖值或 `null`，init 报出某项后更新为该项的运行时精确值。显式覆盖始终保留在 `config` 中，不会被 settings 或 init 改写。

`riskyMode` 在 Claude 的 `bypassPermissions / dontAsk`、Codex 的 `never`、Kimi 的 `yolo` 下为 `true`。这是每会话标记，不存在全局 yolo 开关。

## 终端

用户自由终端属于工作区，与会话和 Kimi ACP 的 `terminal/create` 完全隔离。它在 server 进程内存中保存，断开 WebSocket 或隐藏面板不会结束 PTY；server 重启会结束全部 PTY。`GET /api/meta` 的 `data.capabilities.terminal` 按请求入口返回：本机入口为 `true`，远程入口仅在 `remote.json` 显式配置 `"terminal": true` 时为 `true`。关闭时以下 REST 均返回 HTTP 403，`/ws/terminal` 拒绝升级。两个监听都只绑定 `127.0.0.1`；远程访问须经 Tailscale Serve，并通过既有 Host、Origin 和 Tailscale 身份检查。自由终端直接运行用户 shell，不经过 agent 审批闸门。

REST 沿用 `{code,msg,data,request_id}` 信封：

- `GET /api/terminals` → `data: {terminals: TerminalInfo[]}`。
- `POST /api/terminals`，body `{cwd?: string, cols: number, rows: number}` → `data: TerminalInfo`。`cwd` 缺省或不存在时回退到 server 的 `defaultCwd`；shell 取 `$SHELL`，缺省 `bash`，以登录交互模式启动，继承 server 环境。`cols` 限 1–500，`rows` 限 1–300，均须为整数。
- `POST /api/terminals/:id/kill` → `data: {ok: true}`。只结束进程，不删除文件；退出记录保留到 server 重启。

`TerminalInfo = {id:string, cwd:string, shell:string, cols:number, rows:number, createdAt:string, exited:boolean, exitCode:number|null}`。

`/ws/terminal` 是独立的 JSON 文本帧通道，一个连接可订阅多个终端。上行 `{type:"attach",terminalId}` 后，服务端依次发送 `{type:"attached",terminalId,omitted}`、`{type:"data",terminalId,data}`（当前全部回放），随后推送实时 `{type:"data",terminalId,data}`。重复 attach 同一 id 会重新回放。每终端只保留最近 256KB 输出，`omitted` 为此前丢弃的字节数。上行还支持 `{type:"input",terminalId,data}` 和 `{type:"resize",terminalId,cols,rows}`。进程退出发送 `{type:"exit",terminalId,exitCode}`；未知 id、已退出或参数无效发送 `{type:"error",terminalId?,message}`。连接断开仅解除订阅，不结束 PTY。

## 委派前自动快照

`POST /api/snapshot/preflight` 的请求体严格使用 cwd：

```json
{"cwd":"/absolute/non-git/workdir"}
```

成功响应的 `data` 固定为：

```ts
interface SnapshotPreflightResult {
  isGit: boolean;              // cwd 是否位于 Git 仓库内
  needed: boolean;             // 等价于 !isGit
  exceeds: boolean;            // 是否超过 500 MiB 或 20,000 个文件
  existing: boolean;           // 是否已有该 cwd 的旧快照
  freeSpaceOk: boolean;        // 目标盘可用空间是否至少为待复制量的 1.1 倍
  snapshotPath: string | null; // Git cwd 为 null，否则为稳定的绝对快照路径
}
```

cwd 必须是存在的绝对目录；相对路径、不存在路径和普通文件均返回 HTTP 400。Git cwd 直接返回
`needed:false`，同时 `exceeds / existing / freeSpaceOk` 都为 `false`、`snapshotPath:null`，不会扫描
目录或查询目标盘空间。

`snapshot.ts` 是自动快照的唯一实现位置。它按文件累加大小和数量，超过
`500 * 1024 * 1024` 字节或 20,000 个文件后立即停止扫描；因为此时完整待复制量未知，
`exceeds:true` 时 `freeSpaceOk:false`，自动快照也会在复制前以超阈值错误退出。slug 使用可读的
cwd basename 加绝对路径 SHA-256 短前缀，同一路径稳定、同名但不同路径不会共用目标。

刷新采用全量复制，明确不使用硬链接：先写 `<slug>.tmp/`，再把现有快照暂存为
`<slug>.old/`、将 tmp rename 到正式路径，成功后清理 old；第二次 rename 失败会先把 old
恢复到正式路径，因此中途失败不破坏旧快照。同一 cwd 的进程内并发调用复用同一个进行中
Promise。复制前先检查目标文件系统可用空间至少为扫描量的 1.1 倍。

文件删除权限只为这一功能收窄：`server/` 中仅 `snapshot.ts` 可以调用文件删除，且实际调用
只用于清理 `~/.workbench/snapshots/` 根目录下由模块创建的直属 tmp/old 目录。每次删除前都要
同时做词法直属关系和 `realpath` 包含关系校验，并拒绝快照根本身、`../` 穿越、符号链接逃逸
及非真实目录。当前不提供自动恢复，也没有任何覆盖用户 cwd 的代码；`snapshotPath` 只供界面
展示，恢复由用户自行复制。

`GET /api/meta` 的 `data.drivers.<agent>.options` 是前端配置控件的唯一事实源。每项结构为 `{id,name,values,default,mutable,mutableVia?}`；`default` 可以是 `null`，对应 values 中“跟随 … 配置”的标签；`mutable:false` 表示只能建会话时设置。`mutableVia:"restart"` 表示界面上允许修改，但代价是停止并重启底层 worker。来源如下：

- Claude：CLI 启动 flag 与 stream-json control protocol；审批模式原生活改。模型和推理强度的 schema 为 `mutable:true, mutableVia:"restart"`。首条消息前切换会直接启动新 worker；发过消息或从历史续接的会话在空闲且已有 `nativeSessionId` 时通过“停止 worker → `--resume` 同一原生会话 → 带新 `--model / --effort` 重启”。
- Codex：模型选项来自 `model/list`；默认 model/effort 来自 `config/read(cwd)` 返回的有效合并配置，而不是模型内建默认。创建或续接线程后，再以 `thread/start` / `thread/resume` 返回的实际 `model / reasoningEffort / approvalPolicy` 更新 session。若旧版 app-server 无法提供 `config/read`，schema 的 model/effort 默认值为 `null`，不会猜值。effort 可选覆盖仍限定为 `minimal / low / medium / high / xhigh`；三项活修改在下一次 `turn/start` 生效。
- Kimi：三项和值全部从一次真实 `session/new` 返回的 `configOptions` 转换，不在 Workbench 手抄；三项均通过 `session/set_config_option` 活改。

Codex 与 Kimi 的元数据探针失败时，对应 driver 返回 `options:[]` 和 `error`。Claude 启动时后台发一次不含用户消息的 stream-json `initialize` 控制请求，从应答的 `response.models` 中提取模型描述开头的名字与版本号，仅更新 `fable / opus / sonnet / haiku` 的显示标签；每个 Claude worker 的 initialize 应答也会刷新这些标签。`value` 和“跟随 Claude 配置”标签不变。探针失败或某条描述缺失时，该项保留静态“（最新）”标签，不妨碍建会话。

每个 driver 还在 `/api/meta` 暴露 `commands / mentions` 两个布尔能力位。本机协议实测后的能力矩阵是：Claude `true / true`、Codex `false / true`、Kimi `true / true`。前端必须以能力位决定是否展示功能；尤其不能把 Codex 的普通文本 `/compact` 冒充为原生斜杠命令。

Claude 的模型或推理强度不显式覆盖时，schema 默认值、`config` 和兼容字段 `model / effort` 的初始值均为 `null`，标签为“跟随 Claude 配置”。创建每个 worker 时，服务端只读并依次合并 `~/.claude/settings.json`、`<cwd>/.claude/settings.json`、`<cwd>/.claude/settings.local.json`，后层同名字符串覆盖前层；模型读取 `model`，推理强度读取 `effortLevel`。每个文件独立容错：缺失、无权限、坏 JSON、非对象或该项不是非空字符串时忽略该层的该项并保留上一层；三层都没有可用值才报告 `null`。合并 settings 时不启动 Claude 查询配置，不要求预热，也不在 `~/.claude`、`~/.codex` 或 `~/.kimi-code` 写缓存文件。

Claude 在首轮 `system/init` 报出实际模型后，兼容字段 `model` 和 `effectiveModel` 都更新为完整模型名，`effectiveModelSource` 变为 `init`，并广播一条 `config_updated`。若未来 init 回报 effort，同样提升 effort；当前 Claude Code 2.1.238 的 init 不回报有效 effort，因此兼容字段 `effort` 保持 `null`，`effectiveEffort` 则继续使用 settings 合并值及 `settings` 来源，不会猜测精确模型侧 effort。审批模式由 driver 明确传 `manual`，init 回报的协议值 `default` 会归一为 `manual`。

Codex 0.148.0 的 `approvalPolicy` 实测只接受 `untrusted / on-request / never`（另支持结构化 `granular`，不属于当前三档 UI）。`on-failure` 请求会被 app-server 以 `unknown variant` 拒绝，因此 schema 不暴露该值。

`snapshot` 的 `data` 为 `{session, seq, events}`。`events` 是重建会话视图所需的全量统一事件；客户端完成快照后连接 `/ws?sessionId=<id>&afterSeq=<seq>`。连接期间产生的缺口由每会话 1,000 条 ring buffer 补发；超出 ring 时服务端发送 `resync_required`，客户端重新取快照。

## 三家 CLI 原生历史

`GET /api/history` 直接只读扫描以下事实源，不创建索引文件，也不会写入这些目录：

- Claude：`~/.claude/projects/**/*.jsonl`
- Codex：`~/.codex/sessions/**/rollout-*.jsonl`
- Kimi：`~/.kimi-code/sessions/**/state.json`；标题缺失时只读同会话的 `agents/main/wire.jsonl` 头部

查询参数：

- `agent` 可省略，或为 `claude / codex / kimi`。
- `q` 可省略，对归一后的 `title` 和 `cwd` 做大小写不敏感的子串匹配，最长 500 字符。
- `limit` 默认 50，范围 1–200。
- `cursor` 是服务端返回的不透明分页位置；翻页时必须原样带回，并继续使用相同的 `agent`、`q`。

成功响应的 `data` 形状如下。`messageCount` 只有在原生头部能廉价取得时才会出现；当前三家都不为这个可选字段全文读取 transcript。

```ts
interface HistoryListData {
  sessions: Array<{
    agent: "claude" | "codex" | "kimi";
    nativeSessionId: string;
    cwd: string;
    title: string;             // 第一条真实用户输入，折叠空白后最多 160 字符
    lastActivityAt: string;    // 原生事实文件 mtime，ISO 8601
    messageCount?: number;
    source: "interactive" | "workbench" | "unknown";
    filePath: string;
  }>;
  nextCursor?: string;
  truncated: boolean;          // 3 秒总预算或 20,000 个候选硬上限被触发
  skipped: number;             // 本页遇到的坏/空/不可读/缺关键元数据候选数
  discovered: number;          // 本次发现的候选文件总数
  durationMs: number;
}
```

结果先按原生事实文件 mtime 倒序排列，再分页。服务端只枚举候选和读取最多 512 KiB 的文件头；默认页拿满后停止解析。解析结果保存在进程内存中，以“路径 + mtime + size”（Kimi 另含 wire 指纹）失效，不需要预热，也不会在三家目录或 `~/.workbench/` 生成缓存文件。坏 JSON 行、正在追加产生的尾部半行、空文件和权限错误不会使整个接口 500；不能形成含 `nativeSessionId + cwd` 的会话才计入 `skipped`。测试可用 `WORKBENCH_CLAUDE_HISTORY_DIR / WORKBENCH_CODEX_HISTORY_DIR / WORKBENCH_KIMI_HISTORY_DIR` 指向隔离夹具，生产默认不需要设置。

标题提取不会把注入包装当成人类输入：Claude 跳过 `isMeta`、sidechain、`local-command-caveat / local-command-stdout / system-reminder / task-notification / ide_selection / ide_opened_file`；斜杠命令包装只提取真正的 `command-args`，无参数时退化为 `command-name`。Codex 跳过 role 非 user 的记录，以及 `recommended_plugins / AGENTS.md instructions / environment_context / skills / permissions / apps / plugins / multi_agent_mode` 等注入块。Kimi 优先使用有效的原生 `state.title`，否则从第一条非 `system-reminder` 的 `turn.prompt` 取标题。

`source` 表示原生会话的可识别创建来源，而不是当前读取者。Claude 老会话首个 `entrypoint:"sdk-cli"` 仍为 `workbench`；新 worker 明确设置 `CLAUDE_CODE_ENTRYPOINT=claude-vscode`，其新建会话靠 `~/.workbench/sessions.json` 中未带 `resumedFrom` 的注册表记录判为 `workbench`，其他 `claude-vscode` 会话为 `interactive`。Codex 的 `originator` 以 `workbench` 开头为 `workbench`，其他已知 originator 为 `interactive`；Kimi 的多代落盘格式没有稳定的客户端来源字段，也用未带 `resumedFrom` 的注册表记录回退为 `workbench`，其余为 `unknown`。导入的 VSCode/Kimi 原生会话保留原来源。

`GET /api/history/:agent/:nativeSessionId` 值得保留：前端可在把原生 ID 交给创建接口前展示“导入前看一眼”。它返回 `{session, messages, truncated}`，`messages` 最多 8 条，只读文件头部最多 2 MiB；Kimi wire 缺失时仍返回 session 元数据、空 messages 和 `truncated:true`。ID 只接受 1–128 位字母、数字、下划线和连字符，后端先在对应事实源中解析匹配候选，不会把 URL 片段直接拼成任意文件路径。

完整历史使用 `GET /api/history/:agent/:nativeSessionId/messages?limit=<默认50>&cursor=<可选>`。`limit` 范围 1–200；不传 cursor 时读取最新一页，带回服务端给出的不透明 `nextCursor` 可继续向更早消息翻页。每页内部仍按时间正序返回，前端可直接 prepend 到现有消息列表。单次最多倒读 4 MiB 原生 NDJSON，不会为了取一页全文解析巨大 transcript，也不会在三家原生目录或 Workbench 目录写索引、缓存或修复文件。

成功响应的 `data` 为：

```ts
interface HistoryMessagesPage {
  session: HistorySession;
  messages: Array<{
    role: "user" | "assistant";
    text: string;
    timestamp: string | null; // 原生记录缺失时间时为 null
  }>;
  nextCursor?: string;
  hasMore: boolean;
  truncated: boolean;        // 当前页受条数或 4 MiB 窗口限制
  durationMs: number;
}
```

Claude 从非 meta/sidechain 的 `user` 和含文本块的 `assistant` 记录归一；Codex 优先读干净的 `event_msg.user_message / agent_message`，旧 transcript 缺少这些记录时回退到 `response_item.message`；Kimi 读取 `turn.prompt` 与 `context.append_loop_event/content.part(text)`。思考、工具调用及工具结果当前不进入消息数组，避免为它们引入跨文件、全量或高成本解析。

历史列表本身严格只读；用户选择后，就地续接仍复用现有 `POST /api/sessions`，直接把列表项的 `nativeSessionId` 传为 `resumeSessionId`：

```json
{
  "agent": "claude",
  "cwd": "/home/user/dev/workbench",
  "resumeSessionId": "00000000-0000-4000-8000-000000000040"
}
```

这里没有 fork 语义：Claude 用 `--resume`，Codex 用 `thread/resume`，Kimi 用 `session/resume`。续接后，Workbench 中的新回合会由原生 CLI 追写进用户选择的真实会话；Claude worker 以 `claude-vscode` 身份落盘，工作台新建会话因此可进入 VSCode/CLI 的 resume 列表。仅做 initialize 的 Claude 模型标签探针不发送用户消息、不产生会话，仍清除该环境变量。

空闲会话发消息前，服务端只读原生记录的末尾最多 4 MiB，比较最后一条归一化用户/助手消息的身份：Claude 用 `uuid`，Codex/Kimi 用追加文件的字节偏移与该行 SHA-256；标题、摘要、token 等元数据变化不触发。指纹之后若只有助手消息，视为本端上一轮在 `turn_completed` 之后才刷盘：静默推进指纹，不重启、不发事件。只有出现新的用户消息才判为外部续聊；第一条新用户消息之前的助手消息不进入事件。此时先停旧 worker、起新进程并以同一原生 ID 续接，再发送消息。Codex app-server 的 `thread/resume` 和 Kimi ACP 的 `session/resume` 都在新进程里执行，避免复用旧进程内存中的线程/会话。取不到原生 ID、文件或对话指纹时记录 warn 并照常发送；正在运行的回合不检测。重新续接失败会广播 `session_error`（`source:"external_resume"`），拒绝本轮发送，不回退到旧 worker。尾部窗口装不下全部外部消息时，事件只带读到的最新文本，并标 `truncated:true`。

新增 `external_messages_added` 事件：`payload` 为 `{nativeSessionId:string, messages:Array<{role:"user"|"assistant",text:string,timestamp:string|null}>, truncated:boolean}`。消息使用历史接口的三家归一化规则，只包含用户和助手文本。它写入 Workbench transcript 并通过同一事件流广播，顺序在新一轮 `user_message` 之前；断线后的快照回放也包含它。原生目录仍只由各家 CLI 自己写入，server 的检查代码只读。

使用 `resumeSessionId` 成功建出的 session 会同时包含：

```json
{
  "nativeSessionId": "00000000-0000-4000-8000-000000000040",
  "resumedFrom": {
    "agent": "claude",
    "nativeSessionId": "00000000-0000-4000-8000-000000000040"
  }
}
```

`resumedFrom.messageCount` 为可选字段；当前创建路径不为统计它而全文扫描 transcript，因此默认省略。

## `pages/` 扩展页面

仓库根目录的 `pages/` 每个直接子目录代表一个页面，子目录内必须有 `manifest.json`。server 仅在启动时扫描一次；增删或修改 manifest 后需重启，不做热插拔、沙箱或版本管理。单个 manifest 缺失、JSON 语法错误、字段无效或 `id` 重复时，该页面会被跳过并记录一条 warn 日志，不影响 server 启动。

本轮唯一支持的字段形状如下；没有额外的嵌套配置：

```ts
interface IframePageManifest {
  id: string;           // 唯一；小写字母、数字、连字符，前端入口约定为 /pages/<id>
  name: string;         // 中文显示名
  icon: string;         // emoji 或以 <svg...>...</svg> 表示的内联 SVG 字符串
  type: "iframe";       // 本轮只支持 iframe
  url: string;          // 目标 http/https 地址；proxy 为 true 时只允许本机回环的 http
  healthCheck?: string; // 可选 http/https 探测地址；省略时探测 url
  description?: string; // 可选的页面说明或降级提示背景
  maxWidth?: string;    // 可选内容区最大宽度（简单 CSS 长度）；手机单栏下前端忽略它
  proxy?: boolean;      // true：iframe 改走 /pages/<id>/ 反向代理（见下文）
}
```

`GET /api/pages` 的 `data` 为 `{pages: IframePageManifest[]}`，字段就是上述已校验的 manifest 字段。例如首个页面 `ai-usage` 指向 `http://127.0.0.1:8788`。它不是常驻服务：未按需启动时整页不可达；未开启 代理客户端 时页面本身仍可能可达，但部分数据卡片会报错。因此健康接口只判断目标服务是否响应，不能判断数据是否完整。

`GET /api/pages/:id/health` 最多等待 2 秒，`data` 形状为：

```ts
interface PageHealth {
  id: string;
  reachable: boolean;
  reason: string;       // 如 "HTTP 200"、"连接被拒绝"、"超过 2000 ms 未响应"
  status?: number;      // 收到 HTTP 响应时存在
  durationMs: number;
}
```

只要收到 HTTP 响应（包括非 2xx），`reachable` 就为 `true`，因为该检查只回答“服务在不在”；HTTP 状态仍通过 `status` 和 `reason` 原样提供。`proxy` 未开启时，iframe 由前端直接加载 manifest 的 `url`。

### 反向代理 `/pages/<id>/*`（2026-09-26）

> 安全提示（2026-09-26 终端上线后）：被代理页面与工作台同源，能调用 `/api/terminals` 与 `/ws/terminal`，等于拿到本机 shell。只给完全信任的本机服务开 `proxy: true`。

`proxy: true` 的页面经 workbench 自己的源访问，手机经 Tailscale 也能用（直连 `127.0.0.1` 在手机上指的是手机自己）。

- `GET /pages/<id>` → 302 到 `/pages/<id>/`；`/pages/<id>/<rest>?<query>` 转发到 `url` 下的 `<rest>?<query>`，方法、请求体、响应状态与响应头原样透传（去掉 hop-by-hop 头），上游 30 秒超时。
- 未开启代理或不存在的 id → 404 / `40410`；上游不可达 → 502 / `50200`。
- **访问控制照常**：请求先过 `checkAccess`（本机或远程策略），不另开入口。
- **头改写**：Host 改成目标 host；请求带 Origin 时改成目标自己的 origin（此时 Origin 已由 `checkAccess` 确认来自工作台页面），让 ai-usage 的写操作来源校验通过——这一改写经用户 2026-09-26 明确授权。请求不带 Origin 时不补，目标按自身规则 fail-closed。`tailscale-*`、`x-forwarded-*`、Cookie、Referer 不下传。
- 被代理的页面与工作台同源，其脚本能调工作台 API；只给自己信任的本机服务开 `proxy`。
- 目标前端必须全用相对路径（ai-usage 已改）。健康检查对代理页面把 CSP 的 `'self'` / `X-Frame-Options: SAMEORIGIN` 判为可嵌入。

## WebSocket

下行统一事件都有：

```json
{
  "type":"permission_request",
  "sessionId":"01M0...",
  "agentId":"main",
  "seq":14,
  "timestamp":"2026-08-21T09:20:40.667Z",
  "payload":{}
}
```

事件最小集为 `session_created / config_update_started / external_messages_added / user_message / agent_text_delta / thought_delta / tool_call_started / tool_call_updated / tool_call_completed / permission_request / permission_resolved / commands_updated / config_updated / usage_updated / turn_completed / session_error / process_exited`；另有容错用 `raw_event`。每个 session 独立计数，`seq` 单调递增。

上行至少支持：

```json
{"type":"user_message","sessionId":"...","clientRequestId":"msg-01","text":"只回复 OK"}
{"type":"user_message","sessionId":"...","command":{"name":"compact","arguments":"可选参数"}}
{"type":"user_message","sessionId":"...","text":"概括引用内容","mentions":[{"type":"file","path":"server/README.md"}]}
{"type":"permission_resolved","sessionId":"...","requestId":"...","decision":"allow"}
{"type":"permission_resolved","sessionId":"...","requestId":"...","decision":"allow","questionAnswers":{"早餐吃粥还是吃面？":"吃面"}}
{"type":"set_config","sessionId":"...","clientRequestId":"cfg-01","config":{"permissionMode":"plan"}}
{"type":"set_config","sessionId":"...","clientRequestId":"cfg-02","config":{"effort":null}}
{"type":"interrupt","sessionId":"..."}
```

`set_config` 可一次提交一个或多个字段，但只能使用该会话 driver schema 中 `mutable:true` 的选项和值。成功时先广播统一事件：

```json
{
  "type": "config_updated",
  "payload": {
    "config": {"model":"kimi-code/k3","effort":"high","permissionMode":"plan"},
    "model": "kimi-code/k3",
    "effort": "high",
    "permissionMode": "plan",
    "riskyMode": false,
    "effectiveFrom": "immediate"
  }
}
```

每条可解析的 WS 上行都可带字符串 `clientRequestId`。随后返回的 `ack` 或 `error` 会同时原样回显 `clientRequestId`、`action` 与 `sessionId`，因此同一会话内的并发请求不需要靠 pending 顺序猜测归因。不可改字段、未知值或没有活动 worker 时返回 WS `error`，不会假装成功。

Claude 的 `config_updated`（包括首轮 init 精度提升）还会带完整有效值与来源，例如：

```json
{
  "type": "config_updated",
  "payload": {
    "config": {"model":null,"effort":null,"permissionMode":"manual"},
    "model": "claude-opus-5",
    "effort": null,
    "effectiveModel": "claude-opus-5",
    "effectiveEffort": "high",
    "effectiveModelSource": "init",
    "effectiveEffortSource": "settings",
    "effectiveFrom": "current_turn",
    "reportedBy": "system/init"
  }
}
```

Codex 的首次 `config_updated.effectiveFrom` 为 `next_turn`，Claude 与 Kimi 为 `immediate`。Codex 下一次 `turn/start` 接受该配置后还会广播第二个 `config_updated`：`effectiveFrom:"current_turn"` 表示已经在该轮生效，`effectiveConfig` 是该轮确认生效的完整配置，`appliedFields` 是本次由“待生效”转为“已生效”的字段，另带原生 `turnId`。清除 Codex model/effort 覆盖时，下一次 `turn/start` 显式发送对应的 `null` 来清除 app-server 的 sticky override；报告值则回到 `config/read(cwd)` 得到的有效默认值。

Claude 的 model/effort 切换先广播 `config_update_started`，其 payload 含 `message:"正在切换模型…"`、`mutableVia:"restart"`、旧/新配置与 native ID；新 worker 的初始化 control request 成功后再广播 `config_updated`，并带 `mutableVia:"restart"`、`workerRestarted:true` 以及四个 `effective*` 字段。显式字符串覆盖的初始 source 是 `session`；清除为 `null` 时立即重新按该 session 的 cwd 合并 settings。下一轮 init 若给出更精确运行时值，随后再以 `source:"init"` 广播 `current_turn` 更新。同一个 Workbench session 不变，事件 `seq` 继续递增，原生会话仍是同一 ID。若续接 worker 初始化失败，会进入 `session_error`，并恢复切换前的覆盖值、有效值和来源，不会假装切换完成。若当前状态为 `running`，明确拒绝并返回“当前回合尚未结束，请等待或中断后再切换”，不会停止 worker；若首轮前尚无 `nativeSessionId`，也会明确拒绝。重启参数始终重新带上 `--permission-mode` 与 `--permission-prompt-tool stdio`，因此审批 control_request 边界不会因换模型丢失。Codex/Kimi 继续使用既有原生活改路径，不经过重启。

## 文件检索

`GET /api/sessions/:id/files?q=<关键词>&limit=<数量>` 返回按相对路径字典序排列的普通文件：

```json
{"files":["server/README.md","server/index.ts","server/types.ts"]}
```

`q` 默认为空字符串，匹配相对路径中的大小写不敏感子串；`limit` 默认 50，范围为 1–200。枚举本身限时 3 秒、输出缓冲上限 8 MiB，达到结果上限或总时限即停止文件校验，避免大仓库无限遍历。Git 工作树使用 `git ls-files --cached --others --exclude-standard`，非 Git cwd 回退到 `rg --files`；两条路径都尊重 `.gitignore`，并额外硬排除任意层级的 `.git` 与 `node_modules`。

安全边界以会话 `cwd` 的真实路径为准：任何 `..` 路径段、NUL、cwd 外的 POSIX 绝对路径以及 Windows/UNC 绝对路径都会以 HTTP 400 拒绝；cwd 内绝对路径会先归一为相对查询。候选文件先做词法 containment，再 `realpath` 后做第二次 containment；普通文件和指向 cwd 内普通文件的符号链接可返回，断链、目录、特殊文件及目标逃出 cwd 的符号链接全部跳过。

## 斜杠命令与 `@` 引用

`GET /api/sessions/:id/commands` 返回：

```json
{
  "commands": [
    {
      "name": "compact",
      "description": "Compact the conversation context",
      "argHint": "<optional custom summarization instructions>",
      "source": "kimi"
    }
  ]
}
```

`name` 不含开头的 `/`；发送时既可用上面的结构化 `command`，也仍可把原生命令作为普通 `text` 交给支持命令的 driver。结构化命令和 `text` 不能同时出现，但可附 `mentions`。命令始终复用普通 prompt 通道，没有单独的执行快车道；由命令触发的工具调用仍走既有审批流程，Kimi 的 `terminal/create / fs/write_text_file` 最终闸门照常生效。

命令表按会话保存于内存，并通过 `commands_updated` 实时广播完整新表：

- Claude 启动时发送 stream-json `control_request {subtype:"initialize"}`，把 `response.commands[]` 的 `name / description / argumentHint` 归一；收到 `system/commands_changed` 后重新查询。首次控制查询失败时，首轮 `system/init.slash_commands` 可提供只有名称的后备表。
- Kimi 每次收到 ACP `session/update` 的 `available_commands_update.availableCommands` 都覆盖当前表，不把初始更新当成一次性快照。
- Codex app-server 没有可枚举的斜杠命令协议，始终返回空数组；结构化命令会明确报错。

`mentions` 当前只接受已存在的普通文件，`path` 可为会话 `cwd` 的相对路径或绝对路径，单条消息最多 20 个。三家翻译如下：

- Claude：读取 UTF-8 文件，发为 user content 中的 `document` block：`{type:"document",source:{type:"text",media_type:"text/plain",data},title}`。
- Codex：在 `turn/start.input` 同时发送带 UTF-8 字节范围的 `text_elements` 文本项和 `{type:"mention",name,path}`；文本中的 `@` 名称使用相对会话 `cwd` 的真实路径，避免只给 basename 后让 agent 猜位置。
- Kimi：使用 ACP embedded resource：`{type:"resource",resource:{uri:"file://...",mimeType:"text/plain",text}}`。

Claude 与 Kimi 需要把内容嵌入 prompt，因此只接受不超过 1 MiB 的 UTF-8 文本；不满足条件会在发送前明确报错。任何 driver 的 `mentions:false` 也会明确拒绝引用，不会把引用静默降级为普通文本。

Claude 的 `AskUserQuestion` 仍通过原 `permission_request` 审批闸门下行，但事件会额外带上：

```json
{
  "interactionType": "ask_user_question",
  "questionProtocol": "claude_updated_input_answers_v1",
  "questions": [{
    "question": "早餐吃粥还是吃面？",
    "header": "早餐选择",
    "options": [
      {"label":"吃粥","description":"温和清淡，容易消化"},
      {"label":"吃面","description":"饱腹有劲，顶饿"}
    ],
    "multiSelect": false
  }]
}
```

前端选择后发送 `questionAnswers: {"完整问题文本":"答案"}`；key 必须逐字使用 `question`，不能使用 `header`。多选答案由现有前端按选项顺序合并为逗号分隔的一个字符串；`questionAnswers` 与原始 `updatedInput` 不能同时发送。三家都通过原 `permission_request` / `permission_resolved` 通道，driver 逐题校验并转换：Claude 合成 `updatedInput.answers`，Codex 转为以原生 question `id` 为键的 `{answers:[字符串]}`，Kimi 转为以 form 属性键为键的 `content`（多选为字符串数组）。`deny` 是跳过：Codex 回 `{answers:{}}`，Kimi 回 `{action:"decline"}`；会话主动取消/停止时 Kimi 回 `{action:"cancel"}`。进程已经退出时无法再向它发送响应，driver 清理本地挂起项，前端以 `process_exited` 将卡片标为失效。

Codex 0.157.1 没有多选字段，统一事件的 `multiSelect` 固定为 `false`；`isOther:false` 时后端拒绝自由文本。Kimi 2.1.1 的内置 AskUserQuestion → ACP form 桥接支持多题及多选，却明确不支持「其他」自由文本，后端会拒绝该输入，避免 agent 将它当作空答案。两家事件均带 `otherSupported` 和 `protocolLimitations` 提示；Codex 的每题对象也带 `otherSupported`，用于混合题组。**前端仍总是显示「其他」按钮**，尚需前端读取每题的 `otherSupported:false` 并隐藏按钮，才能避免用户选到协议不支持的路径；本工单不改 `frontend/**`。Codex 无选项/秘密提问及 Kimi 非选项或非 form 字段无法用现有 QuestionBlock 表达，后端会自动跳过/取消并发诊断事件；若要显示文本输入或秘密输入，需要前端另加对应控件。

协议诊断来自真实进程（2026-08-21、2026-08-23）：

- Claude Code 2.1.238：完整 `system/init` 含 102 个 `slash_commands`；控制请求 `initialize` 返回 102 个带描述和参数提示的 `commands`，包括用户 skills/plugins。直接发送 `/compact` 产生 `system {status:"compacting"}` 与 `compact_result`；未公布的 `/help` 则明确回复不可用。原始 `@server/test-sandbox/mention-fixture.txt` 文本会由 CLI 展开，显式 `document` block 也被模型正确读到。
- Codex CLI 0.148.0：对 `listPrompts / customPrompts / slashCommands / commands/list / prompts/list` 等实际请求全部返回未知方法；`skills/list` 可返回 skills，但它们是独立的 `skill` input，不是斜杠命令表。发送文本 `/compact` 只得到模型文本回复，没有压缩协议事件。生成的 v2 schema 与真实 `turn/start` 均确认 `text_elements` 只是文本中特殊元素的 UI 字节范围，文件载体是单独的 `mention {name,path}` input。
- Kimi Code CLI 0.38.0：`initialize.agentCapabilities.promptCapabilities.embeddedContext` 为 `true`；实测命令更新为 51 条，含 `/compact` 参数提示与 `/skill:*`，并用 `session/prompt` 成功执行 `/help`。实际 embedded resource 文件返回了文件内的唯一标记。

针对结构化提问的补充诊断（2026-08-23）：

- Claude Code 2.1.238：`control_response` 的 `allow` 只接受并使用 `updatedInput`；在其中加入 `answers: {"完整问题文本":"答案"}` 后，`AskUserQuestion` 返回正常工具结果并让模型继续。额外塞入 `result / toolResult / content / message` 不会成为工具结果。`deny.message` 会原样成为 `is_error:true` 的工具结果，可作降级，但会同时留下拒绝语义。无答案放行后再发一条明确关联的 user message 也能继续，但会多出一个用户回合。
- Codex CLI 0.157.1：已接入 app-server `item/tool/requestUserInput`，按原生 question `id` 回写 `{answers:{id:{answers:[text]}}}`。schema 新增 `isBlocking`、`isSecret` 等字段；无原生多选和显式取消 action，跳过以空 `answers` 对象表示。
- Kimi Code CLI 2.1.1：ACP initialize 已声明 `clientCapabilities.elicitation.form`，`elicitation/create` 可原样覆盖多题与多选；回包为 `{action:"accept",content:{q0:"选项",q1:["选项A","选项B"]}}`，跳过/取消分别为 `decline`/`cancel`。`session/request_permission` 仍用于普通审批；`terminal/create`、`fs/write_text_file` 最终闸门继续拦截。

`decision` 可为 `allow / deny / always`，也可附 `updatedInput`。Claude 的 `request_id` 原样保留并回填，`permissionSuggestions` 透传；Codex 按 server request 的 JSON-RPC `id` 应答；Kimi 每次 `terminal/create` 和 `fs/write_text_file` 都会额外产生不可绕过的最终审批事件。

Kimi 即使显式选择 `yolo`，真正执行 `terminal/create` 或 `fs/write_text_file` 前仍会再次等待 UI 放行。因此模式只影响 agent 是否主动请求标准审批，不能绕过 Workbench 作为执行端的最终闸门；本机全局默认是 yolo 也同样不能绕过。

## curl + Node 22 WebSocket 演示

先创建会话：

```bash
curl --silent --show-error --request POST http://127.0.0.1:8790/api/sessions \
  --header 'content-type: application/json' \
  --data '{"agent":"kimi","cwd":"/home/user/dev/workbench/server/test-sandbox","config":{"model":"kimi-code/k3","effort":"high","permissionMode":"default"}}'
```

从响应复制 `data.session.id`，再用 Node 22 内置 WebSocket 客户端拉快照、接增量并自动批准演示请求（不需要 `websocat`）：

```bash
node server/scripts/ws-demo.mjs '<sessionId>' \
  --message "使用 Shell 在当前目录写入一个测试文件，完成后只回复 OK。" \
  --auto-allow --until-complete
```

校验 snapshot、落盘 NDJSON 与 seq 完全一致：

```bash
node server/scripts/verify-snapshot.mjs '<sessionId>'
```

再发一轮只读消息，验证 WS 从快照 seq 之后续传：

```bash
node server/scripts/verify-snapshot.mjs '<sessionId>' --probe-message "只回复 SNAPSHOT_INCREMENTAL_OK"
```

## 验收自查

实测日期：2026-08-21；Node `v22.23.1`，Claude Code `2.1.238`，Codex CLI `0.148.0`，Kimi Code CLI `0.38.0`。

- [x] **1. 三家并行且不串线。** 同一 server 中同时保持 Claude `01J00000000000000000000041`、Codex `01J00000000000000000000042`、Kimi `01J00000000000000000000043` 三个 worker。三份 snapshot/NDJSON 分别为 25、10、90 条；验证脚本确认每条 `sessionId`、`agentId` 正确且各自 `seq` 从 1 连续递增。
- [x] **2. 三家真实审批闭环。** Claude 收到 `control_request`，透传 `permissionSuggestions` 后写入 `claude-m1-1787304100.txt`；Codex 收到带数值 `id` 的 `item/commandExecution/requestApproval` 后写入 `codex-m1-1787304200.txt`；Kimi 先收到标准 `session/request_permission`，随后再次收到 `gate:"terminal/create", finalGate:true`，第二次批准后才写入 `kimi-m1-1787304200.txt`。三个文件内容均逐字校验成功。
- [x] **3. 重启不接管旧进程。** 记录三个 worker PID `105 / 225 / 224` 后终止 server；`ps -p 105,224,225` 无输出。重启后三个会话仍在列表中，状态全为 `dead`，且没有 `processId`。
- [x] **4. transcript + snapshot/seq 恢复。** `verify-snapshot.mjs` 对三份全量 snapshot 与磁盘 NDJSON 逐事件比较通过；Claude 以 snapshot `seq=20` 建立 WS，收到的首条增量为 `seq=21`，该轮结束于 `seq=25`。
- [x] **5. curl 全流程与 Node WS。** `curl` 已实测 `/api/meta`、会话创建/列表/详情/snapshot/DELETE/错误信封；`ws-demo.mjs` 使用 Node 22 内置 `WebSocket` 完成发消息、两类审批回传和 turn 收尾。DELETE 实测停止 worker、移除注册表条目，并保留 Workbench transcript；代码没有调用任何原生 transcript 删除 API。
- [x] **6. TypeScript。** `npx tsc --noEmit` 退出码 0。
- [x] **7. 三家自定义 config 真正生效。** Claude `01J00000000000000000000044` 用 `haiku / low / manual` 启动，首轮 session 被 `system/init` 更新为实际模型 `claude-haiku-4-5-20251001`，回复 `CLAUDE_CONFIG_FINAL_OK`；Codex `01J00000000000000000000045` 的原生 rollout `turn_context` 为 `gpt-5.4-mini / low / on-request`，回复 `CODEX_CONFIG_FINAL_OK`；Kimi `01J00000000000000000000046` 的 `session/new` 后配置为 `kimi-code/k3-256k / low / yolo`，并标记 `riskyMode:true`。
- [x] **8. meta schema 来自预期事实源。** 隔离实例的 `GET /api/meta` 返回三家各 3 项；Codex 模型实时来自 `model/list`，有效默认值来自 `config/read(cwd)`；Kimi 的 source 为 `Kimi ACP session/new.configOptions`，模型列表包含本机 Kimi 当时实际报告的 4 项，而不是后端静态常量。
- [x] **9. 活修改与不可改拒绝。** Kimi 经 WS 一次改为 `kimi-code/k3 / high / plan`，收到 `config_updated` 后再收到 ack；Claude `acceptEdits → manual` 两次均即时成功，且 `manual` 已正确映射到控制协议的 `default`。尝试活改 Claude model 收到 `claude.model 只能在建会话时设置`。Codex 活改为 `gpt-5.4 / medium / never` 后，事件标记 `effectiveFrom:"next_turn"`，下一轮原生 `turn_context` 三项逐一吻合。
- [x] **10. yolo 不能绕过最终闸门。** Kimi 会话在 `yolo` 下请求 Shell 写入 `config-yolo-gate-final-1787317200.txt`，Workbench 仍发出 `gate:"terminal/create", finalGate:true`；拒绝后 turn 正常收尾，`existsSync` 实测目标文件为 `false`。
- [x] **11. 不传 config 回归。** Claude `01J00000000000000000000047`、Codex `01J00000000000000000000048`、Kimi `01J00000000000000000000049` 均不传 config 建会话并完成一轮；分别回复 `CLAUDE_DEFAULT_FINAL_OK / CODEX_DEFAULT_FINAL_OK / KIMI_DEFAULT_FINAL_OK`，模式保持 `manual / untrusted / default`，均为 `riskyMode:false`。
- [x] **12. 有效默认 effort 与 rollout 对齐。** 本机 Codex `config/read` 返回 `gpt-5.6-sol / xhigh`。不传 config 的会话 `01J00000000000000000000050` 在 schema、创建响应、snapshot 中均报告 `xhigh`，原生 rollout `00000000-0000-4000-8000-000000000051` 的 `effort` 与 `collaboration_mode.settings.reasoning_effort` 也均为 `xhigh`。显式传 `effort:low` 的会话 `01J00000000000000000000052` 报告 `low`，原生 rollout `00000000-0000-4000-8000-000000000053` 同样为 `low`。
- [x] **13. Claude/Kimi 默认值复核。** Claude `01J00000000000000000000054` 初始 model/effort 为 `null/null`，首轮 init 后 model 更新为实际 `claude-opus-5`，init 没有 effort 字段，故 effort 继续诚实保留 `null`；permissionMode 为 driver 强制的 `manual`。Kimi `01J00000000000000000000055` 的 `session/new.configOptions` 与 session 均为 `kimi-code/k3 / high / default`，且仍无条件实际设置 `default`，没有回落到机器 yolo。
- [x] **14. 命令枚举与发送。** 新 Kimi 会话 `01J00000000000000000000056` 的 commands API 返回 51 条，`compact.argHint` 与原始 ACP 更新一致；WS 结构化发送 `help` 后，agent 返回以 `Available commands:` 开头的原生命令表。Claude 会话 `01J00000000000000000000057` 返回 102 条，含 `compact` 和用户自定义 doctor/skill 命令。Codex 会话返回 `[]`，且结构化 `compact` 被后端以“不支持斜杠命令”拒绝。
- [x] **15. 三家文件引用。** 同一个真实文件 `server/test-sandbox/mention-fixture.txt` 分别经 Claude `document`、Codex `mention`、Kimi ACP `resource` 发入；三者都实际读出 `WORKBENCH_MENTION_FIXTURE_7F3A9C21`。Codex 使用相对路径标记后首个只读命令就直接读取正确文件，不再搜索 basename。
- [x] **16. 新能力位与类型检查。** 隔离实例 `/api/meta` 返回 Claude `commands:true, mentions:true`、Codex `false,true`、Kimi `true,true`；`npm run typecheck` 退出码 0。
- [x] **17. WS 并发归因与 null 清除。** Codex 会话 `01J00000000000000000000058` 并发发送合法 `effort:low` 与非法 effort，ack/error 分别原样回显 `cfg-valid-low / cfg-invalid` 且 `action` 都是 `set_config`。随后 `effort:null` 的事件立即从覆盖值回报为 `config/read(cwd)` 的 `xhigh`；下一轮确认事件为 `effectiveFrom:"current_turn"`，原生 rollout 的同一 turn `00000000-0000-4000-8000-000000000059` 也确认为 `gpt-5.6-sol / xhigh`。
- [x] **18. Codex 实际生效回执。** 同一会话活改为 `gpt-5.4 / low` 后先收到 `next_turn`，下一轮收到带 `appliedFields:["model","effort"]`、`effectiveConfig` 和原生 `turnId` 的 `current_turn` 事件；原生 turn `00000000-0000-4000-8000-000000000060` 的 `turn_context` 与 `collaboration_mode.settings` 均逐项为 `gpt-5.4 / low`。
- [x] **19. 文件检索与逃逸边界。** 隔离实例 `q=server&limit=10` 返回 10 条有序相对路径；空查询返回 60 条且无 `.git / node_modules`；已被 `.gitignore` 命中的 `mention-fixture.txt` 返回空数组。实际请求 `q=../../../etc/passwd` 返回 HTTP 400/code `40020`；模块实测还拒绝 cwd 外 POSIX/Windows 绝对路径，允许指向 cwd 内普通文件的符号链接，并跳过指向 `/etc/passwd` 的逃逸链接。
- [x] **20. 本轮范围与类型检查。** `npm run typecheck` 与 `git diff --check` 均退出码 0；Kimi 启动时无条件 `applyConfigOption("permissionMode", requestedConfig.permissionMode ?? "default")` 及三类审批/最终闸门代码均未修改。

验收产生的 agent 测试文件仅位于 `server/test-sandbox/`，该目录内容已被 Git 忽略。
