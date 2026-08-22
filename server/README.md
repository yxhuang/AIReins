# Workbench server（M1）

后端使用 Node 22、TypeScript 和 `tsx` 直跑，没有后端构建步骤。服务固定绑定回环地址 `127.0.0.1`，默认端口为 `8790`，不做鉴权；三家 CLI 版本在启动时实测并缓存。

## 启动

```bash
npm install
npm run server
```

默认静态目录是仓库内的 `frontend/dist/`；M2 构建完成后会自动从 `/` 托管 SPA。开发时也可用 `WORKBENCH_STATIC_DIR` 指向另一份静态产物。`WORKBENCH_PORT` 可在并行开发或隔离验收时改端口，但不能改变回环绑定地址；生产默认仍为 `8790`。

持久化位置：

- 注册表：`~/.workbench/sessions.json`
- 统一事件 transcript：`~/.workbench/transcripts/<sessionId>.ndjson`
- 各家 CLI 自有 transcript：完全由原生 CLI 管理；Workbench 从不删除

服务启动会把注册表中的旧会话统一标记为 `dead`，不会接管或自动续接旧进程。需要续接时，新建会话可传原生 `resumeSessionId`；Claude 使用 `--resume`，Codex 使用 `thread/resume`，Kimi 使用 `session/resume`。

## REST

所有 REST 成功和错误都使用同一个信封；`request_id` 是 ULID，也会出现在同次请求的服务端 JSON 日志中。

```json
{"code":0,"msg":"success","data":{},"request_id":"01M0..."}
```

接口：

- `POST /api/sessions`：创建会话，统一配置见下文
- `GET /api/sessions`
- `GET /api/sessions/:id`
- `GET /api/sessions/:id/snapshot`
- `GET /api/sessions/:id/commands`：当前活动会话的实时归一命令表
- `GET /api/sessions/:id/files?q=<关键词>&limit=<默认50>`：在会话 `cwd` 内检索可引用的普通文件
- `DELETE /api/sessions/:id`：停止 worker 并移除注册表条目；不删除 Workbench 或原生 CLI transcript
- `GET /api/history`：只读列出三家 CLI 自己保存的历史会话
- `GET /api/history/:agent/:nativeSessionId`：有界读取会话头部，返回导入前预览
- `GET /api/meta`：server/CLI 实测版本、全局能力、三 driver 能力位与配置 schema
- `GET /api/pages`：启动时已注册的扩展页面列表
- `GET /api/pages/:id/health`：限时探测一个扩展页面的目标服务

建会话时，三家统一使用 `config.model / config.effort / config.permissionMode`：

```json
{
  "agent": "claude",
  "cwd": "/home/user/dev/workbench",
  "config": {
    "model": "haiku",
    "effort": "low",
    "permissionMode": "manual"
  },
  "initialMessage": "只回复 OK"
}
```

三项都可省略，也可在建会话时传 `null` 表示“不覆盖、跟随 CLI 有效配置”。不传 `config` 时沿用各 driver 原有默认行为。旧字段 `model` 与 `kimiMode` 暂时兼容，分别等价于 `config.model` 与 Kimi 的 `config.permissionMode`；新调用不要再使用旧字段。WS `set_config` 对 schema 中同时满足 `mutable:true` 且 `values` 含 `null` 的选项接受 `null`，用于清除已经生效的会话级覆盖；事件与 session 随即报告从 driver 事实源得到的真正有效值，而不是继续显示 `null` 或旧覆盖值。

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

`riskyMode` 在 Claude 的 `bypassPermissions / dontAsk`、Codex 的 `never`、Kimi 的 `yolo` 下为 `true`。这是每会话标记，不存在全局 yolo 开关。

`GET /api/meta` 的 `data.drivers.<agent>.options` 是前端配置控件的唯一事实源。每项结构为 `{id,name,values,default,mutable}`；`default` 可以是 `null`，对应 values 中“跟随 … 配置”的标签；`mutable:false` 表示只能建会话时设置。来源如下：

- Claude：CLI 启动 flag 与 stream-json control protocol；模型和推理强度不可活改，审批模式可活改。
- Codex：模型选项来自 `model/list`；默认 model/effort 来自 `config/read(cwd)` 返回的有效合并配置，而不是模型内建默认。创建或续接线程后，再以 `thread/start` / `thread/resume` 返回的实际 `model / reasoningEffort / approvalPolicy` 更新 session。若旧版 app-server 无法提供 `config/read`，schema 的 model/effort 默认值为 `null`，不会猜值。effort 可选覆盖仍限定为 `minimal / low / medium / high / xhigh`；三项活修改在下一次 `turn/start` 生效。
- Kimi：三项和值全部从一次真实 `session/new` 返回的 `configOptions` 转换，不在 Workbench 手抄；三项均通过 `session/set_config_option` 活改。

元数据探针失败时，对应 driver 返回 `options:[]` 和 `error`，不会以可能过期的硬编码值冒充实时结果。

每个 driver 还在 `/api/meta` 暴露 `commands / mentions` 两个布尔能力位。本机协议实测后的能力矩阵是：Claude `true / true`、Codex `false / true`、Kimi `true / true`。前端必须以能力位决定是否展示功能；尤其不能把 Codex 的普通文本 `/compact` 冒充为原生斜杠命令。

Claude 的模型或推理强度不显式覆盖时，schema 默认值和初始 session 值均为 `null`，标签为“跟随 Claude 配置”。Claude 在首轮 `system/init` 报出实际模型后，session 的 `model` 会更新为完整模型名；若未来 init 回报 effort，也会同步更新。当前 Claude Code 2.1.238 的 init 不回报有效 effort，因此 session 的 effort 保持 `null`，不会猜值。审批模式由 driver 明确传 `manual`，init 回报的协议值 `default` 会归一为 `manual`。

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

`source` 表示原生会话的可识别创建来源，而不是当前读取者。Claude 首个 `entrypoint:"sdk-cli"` 为 `workbench`，普通 CLI/VS Code 入口为 `interactive`；Codex 的 `originator` 以 `workbench` 开头为 `workbench`，其他已知 originator 为 `interactive`；Kimi 的多代落盘格式没有稳定的客户端来源字段，只能用仍在 `~/.workbench/sessions.json` 的原生 ID 作 `workbench` 回退，其余诚实返回 `unknown`。

`GET /api/history/:agent/:nativeSessionId` 值得保留：前端可在把原生 ID 交给创建接口前展示“导入前看一眼”。它返回 `{session, messages, truncated}`，`messages` 最多 8 条，只读文件头部最多 2 MiB；Kimi wire 缺失时仍返回 session 元数据、空 messages 和 `truncated:true`。ID 只接受 1–128 位字母、数字、下划线和连字符，后端先在对应事实源中解析匹配候选，不会把 URL 片段直接拼成任意文件路径。

历史列表本身严格只读；用户选择后，就地续接仍复用现有 `POST /api/sessions`，直接把列表项的 `nativeSessionId` 传为 `resumeSessionId`：

```json
{
  "agent": "claude",
  "cwd": "/home/user/dev/workbench",
  "resumeSessionId": "00000000-0000-4000-8000-000000000040"
}
```

这里没有 fork 语义：Claude 用 `--resume`，Codex 用 `thread/resume`，Kimi 用 `session/resume`。代价也必须由前端明确提示：续接后，Workbench 中的新回合会由原生 CLI 追写进用户选择的真实会话；其中 Claude 的 Workbench 回合以 `sdk-cli` 身份落盘。若用户不希望改变原会话，应取消续接，而不是调用本接口后期待自动分叉。

## `pages/` 扩展页面

仓库根目录的 `pages/` 每个直接子目录代表一个页面，子目录内必须有 `manifest.json`。server 仅在启动时扫描一次；增删或修改 manifest 后需重启，不做热插拔、沙箱或版本管理。单个 manifest 缺失、JSON 语法错误、字段无效或 `id` 重复时，该页面会被跳过并记录一条 warn 日志，不影响 server 启动。

本轮唯一支持的字段形状如下；没有额外的嵌套配置：

```ts
interface IframePageManifest {
  id: string;           // 唯一；小写字母、数字、连字符，前端入口约定为 /pages/<id>
  name: string;         // 中文显示名
  icon: string;         // emoji 或以 <svg...>...</svg> 表示的内联 SVG 字符串
  type: "iframe";       // 本轮只支持 iframe
  url: string;          // iframe 直接加载的 http/https 地址；server 不代理
  healthCheck?: string; // 可选 http/https 探测地址；省略时探测 url
  description?: string; // 可选的页面说明或降级提示背景
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

只要收到 HTTP 响应（包括非 2xx），`reachable` 就为 `true`，因为该检查只回答“服务在不在”；HTTP 状态仍通过 `status` 和 `reason` 原样提供。iframe 始终由前端直接加载 manifest 的 `url`，server 不提供反向代理。

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

事件最小集为 `session_created / user_message / agent_text_delta / thought_delta / tool_call_started / tool_call_updated / tool_call_completed / permission_request / permission_resolved / commands_updated / config_updated / usage_updated / turn_completed / session_error / process_exited`；另有容错用 `raw_event`。每个 session 独立计数，`seq` 单调递增。

上行至少支持：

```json
{"type":"user_message","sessionId":"...","clientRequestId":"msg-01","text":"只回复 OK"}
{"type":"user_message","sessionId":"...","command":{"name":"compact","arguments":"可选参数"}}
{"type":"user_message","sessionId":"...","text":"概括引用内容","mentions":[{"type":"file","path":"server/README.md"}]}
{"type":"permission_resolved","sessionId":"...","requestId":"...","decision":"allow"}
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

Codex 的首次 `config_updated.effectiveFrom` 为 `next_turn`，Claude 与 Kimi 为 `immediate`。Codex 下一次 `turn/start` 接受该配置后还会广播第二个 `config_updated`：`effectiveFrom:"current_turn"` 表示已经在该轮生效，`effectiveConfig` 是该轮确认生效的完整配置，`appliedFields` 是本次由“待生效”转为“已生效”的字段，另带原生 `turnId`。清除 Codex model/effort 覆盖时，下一次 `turn/start` 显式发送对应的 `null` 来清除 app-server 的 sticky override；报告值则回到 `config/read(cwd)` 得到的有效默认值。

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

协议诊断均来自真实进程（2026-08-21）：

- Claude Code 2.1.238：完整 `system/init` 含 102 个 `slash_commands`；控制请求 `initialize` 返回 102 个带描述和参数提示的 `commands`，包括用户 skills/plugins。直接发送 `/compact` 产生 `system {status:"compacting"}` 与 `compact_result`；未公布的 `/help` 则明确回复不可用。原始 `@server/test-sandbox/mention-fixture.txt` 文本会由 CLI 展开，显式 `document` block 也被模型正确读到。
- Codex CLI 0.148.0：对 `listPrompts / customPrompts / slashCommands / commands/list / prompts/list` 等实际请求全部返回未知方法；`skills/list` 可返回 skills，但它们是独立的 `skill` input，不是斜杠命令表。发送文本 `/compact` 只得到模型文本回复，没有压缩协议事件。生成的 v2 schema 与真实 `turn/start` 均确认 `text_elements` 只是文本中特殊元素的 UI 字节范围，文件载体是单独的 `mention {name,path}` input。
- Kimi Code CLI 0.38.0：`initialize.agentCapabilities.promptCapabilities.embeddedContext` 为 `true`；实测命令更新为 51 条，含 `/compact` 参数提示与 `/skill:*`，并用 `session/prompt` 成功执行 `/help`。实际 embedded resource 文件返回了文件内的唯一标记。

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
