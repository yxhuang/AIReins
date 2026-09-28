# M0：三家 CLI 协议 spike 与报文抓取

## P1-1：结构化提问协议复核（2026-09-26）

本次复核使用 `codex-cli 0.157.1` 的 `codex app-server generate-json-schema --out /tmp/codex-schema-0157` 产物，以及本机 `~/.kimi-code/bin/kimi` 2.1.1 ELF 内嵌的 ACP SDK 与 `interaction-bridge` 实现。以下为 schema/本机实现事实；尚未做真实模型触发提问的冒烟验证。

### Codex 0.157.1

`ServerRequest.json` 仍含 `item/tool/requestUserInput`。`ToolRequestUserInputParams.json` 要求 `threadId`、`turnId`、`itemId`、`isBlocking`、`questions`；每题要求 `id`、`header`、`question`，可有 `options: [{label,description}] | null`、`isOther`（默认 false）、`isSecret`（默认 false）。`autoResolutionMs` 已标废弃。`ToolRequestUserInputResponse.json` 要求 `{answers:{[questionId]:{answers:string[]}}}`。无原生 `multiSelect`，无 accept/decline/cancel 枚举；空 `answers` 对象是 Workbench 的跳过约定，需真机确认 agent 对跳过的呈现。

与 0.148.0 旧记录相比：请求/应答方法和按 id 回写仍成立；新增或明确了 blocking、secret、other、废弃的自动解决字段，Workbench driver 已接入。因现有前端只能渲染有选项的题，`options:null` 和 `isSecret:true` 会安全跳过。

### Kimi Code CLI 2.1.1

ACP initialize 的客户端能力字段为 `clientCapabilities: { elicitation: { form: {} } }`。本机实现只检查 `clientCapabilities.elicitation.form` 是否存在，再对 AskUserQuestion 调用 `elicitation/create`。form 请求含 `sessionId`、`toolCallId`、`mode:"form"`、`message`（问题文本逐行连接）及 `requestedSchema:{type:"object",properties,required}`。原生桥接把第 i 题映为 `q{i}`：单选 `{type:"string",oneOf:[{const,title,description}]}`，多选 `{type:"array",minItems:1,items:{anyOf:[{const,title,description}]}}`。ACP SDK 还允许普通 string、boolean、number、enum 等扁平属性类型；本工单只把有可选项的 string/array 映入现有 QuestionBlock。

回应为 `{action:"accept",content:{q0:"选项",q1:["选项A","选项B"]}}`，明确拒绝为 `{action:"decline"}`，关闭/取消为 `{action:"cancel"}`。Kimi 桥接对非 accept、无 content、无匹配选项均按「用户未回答」处理；对多选按原选项顺序拼成逗号加空格的工具答案。桥接源码明确说「其他」自由文本没有等价 form 字段；提交不在枚举里的内容会被过滤，所以 driver 必须拒绝并提示。

与 0.38.0 旧记录相比：老版结论中 form 客户端可拿到多题/多选依然成立；本次确认了 2.1.1 的精确 capability 字段、schema 映射和三种 action，Workbench 已声明 form 能力并接入。普通审批与最终执行闸门不变。

实测日期：2026-08-21；工作目录：`/home/user/dev/workbench`。

版本：Node `v22.23.1`、Claude Code `2.1.238`、Codex CLI `0.148.0`、Kimi Code CLI `0.38.0`。三份 capture 都采用同一 NDJSON 信封：

```json
{"dir":"in|out","t":1787301167715,"raw":{"原始协议对象":"凭证字段在落盘前打码"}}
```

`in` 表示 CLI → spike，`out` 表示 spike → CLI；无法解析为 JSON 的行在 `raw` 中保留为字符串。capture 采用追加写，既包含最终成功运行，也保留了协议探索中的失败运行，便于复盘分岔。

最终成功运行的定位信息：

| CLI | 会话/线程 ID | 原生会话落盘路径 |
| --- | --- | --- |
| Claude | `00000000-0000-4000-8000-000000000065` | `/home/user/.claude/projects/-home-user-dev-workbench/00000000-0000-4000-8000-000000000065.jsonl` |
| Codex | `00000000-0000-4000-8000-000000000066` | `/home/user/.codex/sessions/2026/08/21/rollout-2026-08-21T16-32-27-00000000-0000-4000-8000-000000000066.jsonl` |
| Kimi | `session_00000000-0000-4000-8000-000000000070` | `/home/user/.kimi-code/sessions/wd_workbench_0123456789ab/session_00000000-0000-4000-8000-000000000070/` |

## 1. Claude stream-json

### 启动命令与输入

脚本实际从复制出的子进程环境中执行 `delete env.CLAUDE_CODE_ENTRYPOINT`，等价命令为：

```bash
env -u CLAUDE_CODE_ENTRYPOINT claude --print \
  --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --replay-user-messages \
  --permission-mode manual --permission-prompt-tool stdio \
  --model claude-haiku-4-5-20251001
```

发送一行一个对象：

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"只回复 OK"}]}}
```

第一轮结束后发送第二个同形 `user` 对象，要求只在 `spikes/sandbox/claude-approved.txt` 写入本次运行唯一内容。唯一内容是为了让重复执行时仍发生真实 Edit/Write，而不是模型发现旧文件已经满足要求后跳过工具。

### 事件全集

capture 中 CLI → client 的顶层类型：

- `system/init`、`system/status`、`system/hook_started`、`system/hook_response`、`system/thinking_tokens`、`system/permission_denied`
- `user`、`assistant`、`rate_limit_event`
- `stream_event/message_start`、`content_block_start`、`content_block_delta`、`content_block_stop`、`message_delta`、`message_stop`
- `control_request`、回放的 `control_response`、`result/success`

client → CLI：`user`、`control_response`。

最终一轮计数为 `turns=2`、`approvals=1`、`replayed=5`、`partials=83`。`--include-partial-messages` 使 `stream_event` 与最终完整 `assistant`/`result` 并存；`--replay-user-messages` 会把输入的 `user` 回显到 stdout，并且也会回显 client 发出的 `control_response`。driver 不能把这些回显当成新的用户输入或新的审批。

### control_request / control_response 的确切形状

这是一次首次创建文件时抓到的完整真实样本（capture 中仍保留）：

```json
{
  "type": "control_request",
  "request_id": "00000000-0000-4000-8000-000000000067",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "Write",
    "display_name": "Write",
    "input": {
      "file_path": "/home/user/dev/workbench/spikes/sandbox/claude-approved.txt",
      "content": "CLAUDE_APPROVED"
    },
    "description": "spikes/sandbox/claude-approved.txt",
    "permission_suggestions": [
      {"type":"setMode","mode":"acceptEdits","destination":"session"}
    ],
    "tool_use_id": "toolu_01JHZ8UsqzJtFcxhDd8McDDL"
  }
}
```

批准必须把外层 `request_id` 复制到 `response.request_id`，允许载荷位于第二层 `response.response`：

```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "00000000-0000-4000-8000-000000000067",
    "response": {
      "behavior": "allow",
      "updatedInput": {
        "file_path": "/home/user/dev/workbench/spikes/sandbox/claude-approved.txt",
        "content": "CLAUDE_APPROVED"
      }
    }
  }
}
```

最终复跑因文件已存在而使用 `tool_name:"Edit"`，但信封完全相同；`request.input`/`updatedInput` 变为 `file_path`、`old_string`、`new_string`、`replace_all`。

关键启动参数结论：只用 `--permission-mode manual` 时没有发 `control_request`，工具最终进入 `system/permission_denied`；加入 **`--permission-prompt-tool stdio`** 后才把 `can_use_tool` 引到 stdout，以上批准闭环成功且文件真实落盘。`system/init.permissionMode` 将 `manual` 归一显示为 `default`。

### 会话身份：与 PROMPT.md §4.3 冲突，以实测为准

任务书预期删除 `CLAUDE_CODE_ENTRYPOINT` 可让会话按普通 CLI 身份落盘；实测否定了这个假设。最终 session jsonl 的早期记录为：

```json
{"type":"attachment","userType":"external","entrypoint":"sdk-cli","cwd":"/home/user/dev/workbench","sessionId":"00000000-0000-4000-8000-000000000065","version":"2.1.238"}
{"type":"user","permissionMode":"default","promptSource":"sdk","userType":"external","entrypoint":"sdk-cli","sessionId":"00000000-0000-4000-8000-000000000065"}
```

早期行没有 `source` 字段。主会话另做了两组独立对照：

- `env -u CLAUDE_CODE_ENTRYPOINT claude --print --model haiku "只回复 OK"`
- `CLAUDE_CODE_ENTRYPOINT=cli claude --print --model haiku "只回复 OK"`

两组均落盘为 `entrypoint:"sdk-cli"`、`userType:"external"`。因此结论是：**`--print` 模式硬编码为 sdk-cli 身份，与 `CLAUDE_CODE_ENTRYPOINT` 环境变量无关**；连裸 `--print` 都如此，不是 `stream-json` 参数造成。脚本仍按硬要求显式删除该变量，但 M1 不能依赖它改变会话身份。

**2026-09-27 补充（修正上述结论）**：Claude Code 2.1.281 的 `isHiddenFromSessionPicker` 会把首条 `entrypoint` 为 `sdk-cli / sdk-ts / sdk-py` 的会话从 `claude --resume` 与 VSCode 扩展历史列表隐藏。实测在 `-p` 下设置 `CLAUDE_CODE_ENTRYPOINT=claude-vscode` 后落盘身份原样保留，会话出现在 `claude --resume`；不设置时仍为 `sdk-cli`、不出现；设置 `cli` 则被 CLI 改回 `sdk-cli`。官方 VSCode 扩展也以 `claude-vscode` 身份和 stream-json 控制协议驱动 CLI。`claude -p --resume <id>` 沿用同一 ID 并追加同一 jsonl。旧结论对当时测试的未设置变量和 `cli` 两组成立，但“与环境变量无关”的推断不成立；Workbench worker 现在明确设置 `claude-vscode`。

### usage/token 样本

```json
{
  "type":"result",
  "session_id":"00000000-0000-4000-8000-000000000065",
  "usage":{
    "input_tokens":34,
    "cache_creation_input_tokens":1214,
    "cache_read_input_tokens":140603,
    "output_tokens":661,
    "output_tokens_details":{"thinking_tokens":345},
    "service_tier":"standard"
  },
  "modelUsage":{
    "claude-haiku-4-5-20251001":{
      "inputTokens":44,"outputTokens":906,"cacheReadInputTokens":175252,
      "cacheCreationInputTokens":1214,"costUSD":0.0245272,
      "contextWindow":200000,"maxOutputTokens":32000,
      "canonicalModel":"claude-haiku-4-5","provider":"firstParty"
    }
  }
}
```

## 2. Codex app-server

### 启动、握手与回合

实际启动：

```bash
codex app-server --stdio
```

`--stdio` 等价于当前默认的 `--listen stdio://`。握手与主流程：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"workbench-spike","title":"Workbench M0","version":"0.0.0"},"capabilities":null}}
{"jsonrpc":"2.0","method":"initialized","params":{}}
{"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"/home/user/dev/workbench","approvalPolicy":"untrusted","sandbox":"workspace-write","ephemeral":false}}
{"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":"00000000-0000-4000-8000-000000000066","input":[{"type":"text","text":"…","text_elements":[]}],"approvalPolicy":"untrusted","sandboxPolicy":{"type":"workspaceWrite","writableRoots":[],"networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false}}}
```

当前服务接受 client 带 `jsonrpc:"2.0"` 的对象，但其返回/通知实际省略 `jsonrpc`；driver 应宽容两种信封。`initialize` 只能调用一次，随后发送无 id 的 `initialized` 通知。

### 实测方法/事件全量清单（收发双向）

client → app-server 请求/通知：

- `initialize`
- `initialized`
- `thread/start`
- `turn/start`
- `thread/resume`
- `thread/unsubscribe`
- 对 server request 的同 id response（无 `method`）

app-server → client 请求/通知：

- `remoteControl/status/changed`
- `thread/started`、`thread/status/changed`、`thread/tokenUsage/updated`、`thread/goal/cleared`
- `mcpServer/startupStatus/updated`
- `turn/started`、`turn/completed`
- `item/started`、`item/completed`、`item/agentMessage/delta`
- `item/commandExecution/requestApproval`
- `serverRequest/resolved`
- `account/rateLimits/updated`

此外，对每个带 id 的 client 请求均收到相同 id 的 result。PROMPT.md §4.1 使用的是旧 API 名；0.148.0 实际为 `thread/start` / `turn/start` 等，不是 `newConversation` / `newTurn` 一类旧名。

### 审批：旧名与当前真实报文

本次 shell 实际请求不是 `execCommandApproval`，而是：

```json
{
  "method":"item/commandExecution/requestApproval",
  "id":0,
  "params":{
    "threadId":"00000000-0000-4000-8000-000000000066",
    "turnId":"00000000-0000-4000-8000-000000000068",
    "itemId":"exec-00000000-0000-4000-8000-000000000069",
    "startedAtMs":1787301156726,
    "environmentId":"local",
    "command":"/bin/bash -lc \"printf 'CODEX_APPROVED\\\\n' > spikes/sandbox/codex-approved.txt\"",
    "cwd":"/home/user/dev/workbench",
    "commandActions":[{"type":"unknown","command":"printf 'CODEX_APPROVED\\n' > spikes/sandbox/codex-approved.txt"}],
    "proposedExecpolicyAmendment":["/bin/bash","-lc","printf 'CODEX_APPROVED\\n' > spikes/sandbox/codex-approved.txt"],
    "availableDecisions":[
      "accept",
      {"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["/bin/bash","-lc","printf 'CODEX_APPROVED\\n' > spikes/sandbox/codex-approved.txt"]}},
      "cancel"
    ]
  }
}
```

应答复用 server request 的数值 `id`，格式是：

```json
{"jsonrpc":"2.0","id":0,"result":{"decision":"accept"}}
```

旧名映射：

| PROMPT.md 旧名 | 0.148.0 当前名 | 请求 id / 应答 |
| --- | --- | --- |
| `execCommandApproval` | `item/commandExecution/requestApproval` | server 给数值 id；同 id 返回 `{decision:"accept"}` |
| `applyPatchApproval` | `item/fileChange/requestApproval` | 同上；本 shell 用例未触发此请求 |

本机只读参考的已安装 `codex-acp` 还声明 `item/permissions/requestApproval`。`item/fileChange/requestApproval` 未在本次 capture 里人为凑样本；其当前方法名与 `{decision:"accept"}` 结果形状来自 0.148 协议客户端定义，已明确区别于实抓样本。

### 会话、续接与 source/originator

续接现有会话的真实请求：

```json
{"jsonrpc":"2.0","id":4,"method":"thread/resume","params":{"threadId":"00000000-0000-4000-8000-000000000066","cwd":"/home/user/dev/workbench"}}
```

完成后用：

```json
{"jsonrpc":"2.0","id":5,"method":"thread/unsubscribe","params":{"threadId":"00000000-0000-4000-8000-000000000066"}}
```

`thread/start` 返回的 `thread.path` 即 rollout 路径，并返回 `source:"vscode"`。rollout 首行实值：

```json
{"type":"session_meta","payload":{"id":"00000000-0000-4000-8000-000000000066","cwd":"/home/user/dev/workbench","originator":"workbench-spike","cli_version":"0.148.0","source":"vscode"}}
```

调查结论：`source:"vscode"` **不是从当前 VSCODE 环境变量继承，也不由 `initialize.clientInfo` 决定**。当前 `codex app-server` 这个 umbrella 子命令把 session source 固定成 `VSCode`；`codex app-server --help` 没有 `--session-source`，也没有可用的环境变量或 initialize 字段覆盖它。单独构建/安装的 `codex-app-server` 二进制入口有 `--session-source`，但本机 PATH 没有该独立命令，且不属于本项目要求的原生 `codex app-server` 调用面。

可控的标识是：

- `initialize.clientInfo.name:"workbench-spike"` → rollout `originator:"workbench-spike"`；
- `thread/start.serviceName` 可作为可选 metrics tag，但不改 `source`。

因此 M1 应用 `originator`（以及需要时的 `serviceName`）标记 workbench 会话，并接受 `source:"vscode"`。依据包括 [Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server)、[上游 source 问题与代码定位](https://github.com/openai/codex/issues/23442) 以及本机 0.148.0 help/rollout 对照。

### usage/token 样本

```json
{
  "method":"thread/tokenUsage/updated",
  "params":{
    "threadId":"00000000-0000-4000-8000-000000000066",
    "turnId":"00000000-0000-4000-8000-000000000068",
    "tokenUsage":{
      "total":{"totalTokens":52136,"inputTokens":51981,"cachedInputTokens":36352,"cacheWriteInputTokens":0,"outputTokens":155,"reasoningOutputTokens":77},
      "last":{"totalTokens":26099,"inputTokens":26094,"cachedInputTokens":25344,"cacheWriteInputTokens":0,"outputTokens":5,"reasoningOutputTokens":0},
      "modelContextWindow":258400
    }
  },
  "emittedAtMs":1787301157426
}
```

## 3. Kimi ACP

### 启动与 initialize 能力集

实际启动：

```bash
/home/user/.local/bin/kimi acp
```

握手请求：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":true},"clientInfo":{"name":"workbench-spike","title":"Workbench M0","version":"0.0.0"}}}
```

0.38.0 返回的关键能力集：

```json
{
  "protocolVersion":1,
  "agentCapabilities":{
    "loadSession":true,
    "promptCapabilities":{"image":true,"audio":false,"embeddedContext":true},
    "sessionCapabilities":{"list":{},"resume":{},"close":{},"delete":{},"fork":{},"additionalDirectories":{}},
    "mcpCapabilities":{"http":true,"sse":true},
    "auth":{"logout":{}}
  },
  "agentInfo":{"name":"Kimi Code CLI","version":"0.38.0"}
}
```

`session/new` 实发参数只有 `{"cwd":"/home/user/dev/workbench","mcpServers":[]}`，没有 permission/approval 字段。返回把模式放在 `configOptions[id=mode]` 和 `modes` 中：`default`（Manual approvals）、`plan`（Read-only）、`auto`（Auto-approve safe operations）、`yolo`（Auto-approve everything）。切换使用：

```json
{"jsonrpc":"2.0","id":30,"method":"session/set_mode","params":{"sessionId":"session_00000000-0000-4000-8000-000000000070","modeId":"default"}}
```

### 实测方法/更新全量清单（收发双向）

client → Kimi 请求：

- `initialize`
- `session/list`
- `session/new`
- `session/set_mode`
- `session/prompt`
- `session/close`
- 对 Kimi 请求的同 id result/error

Kimi → client 请求/通知：

- `session/request_permission`
- `terminal/create`、`terminal/output`、`terminal/wait_for_exit`、`terminal/release`
- `fs/read_text_file`、`fs/write_text_file`
- `session/update`

实抓到的 `session/update.params.update.sessionUpdate` 全集：`available_commands_update`、`config_option_update`、`current_mode_update`、`session_info_update`、`agent_thought_chunk`、`agent_message_chunk`、`tool_call`、`tool_call_update`、`usage_update`。

initialize 宣告及 Kimi 0.38.0 内置 ACP v1 schema 给出的生命周期方法/参数形状如下（`_meta` 均可选）：

| 能力 | 实际方法 | params 形状 | 本 spike 状态 |
| --- | --- | --- | --- |
| `loadSession:true` | `session/load` | `{sessionId,cwd,mcpServers,additionalDirectories?}` | 方法/形状确认，未调用 |
| `sessionCapabilities.list` | `session/list` | `{cwd:string|null,cursor:string|null}` | 已调用并收到 `{sessions,nextCursor}` |
| `resume` | `session/resume` | `{sessionId,cwd,mcpServers?,additionalDirectories?}` | 方法/形状确认，未调用 |
| `close` | `session/close` | `{sessionId}` | 已调用成功 |
| `delete` | `session/delete` | `{sessionId}` | 未调用；删除铁律禁止 |
| `fork` | `session/fork` | `{sessionId,cwd,mcpServers?,additionalDirectories?}` | 0.38.0 标为 unstable；未额外创建会话 |

`session/load` 会把历史消息以 `session/update` 重放；`session/resume` 只续接而不返回旧消息，这是两者的语义差异。`fork` 成功结果至少含新 `sessionId`，并可带 `modes` / `models` / `configOptions`。标准方法与 schema 可交叉核对 [ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json)。

### 标准权限请求与 terminal/create 的真实闭环

显式 `session/set_mode(default)` 后，K3 对 Shell 先发：

```json
{
  "jsonrpc":"2.0",
  "id":0,
  "method":"session/request_permission",
  "params":{
    "sessionId":"session_00000000-0000-4000-8000-000000000070",
    "options":[
      {"optionId":"approve_once","name":"Approve once","kind":"allow_once"},
      {"optionId":"approve_always","name":"Approve for this session","kind":"allow_always"},
      {"optionId":"reject","name":"Reject","kind":"reject_once"}
    ],
    "toolCall":{
      "toolCallId":"0:tool_HohDJLevUcZbPwyko2Q6ZsJd",
      "title":"Bash",
      "content":[{"type":"content","content":{"type":"text","text":"Requesting approval to Running: printf 'KIMI_APPROVED\\n' > spikes/sandbox/kimi-app…"}}]
    }
  }
}
```

批准应答：

```json
{"jsonrpc":"2.0","id":0,"result":{"outcome":{"outcome":"selected","optionId":"approve_once"}}}
```

随后 Kimi 才向 client 请求真正执行命令：

```json
{
  "jsonrpc":"2.0",
  "id":1,
  "method":"terminal/create",
  "params":{
    "sessionId":"session_00000000-0000-4000-8000-000000000070",
    "command":"/bin/bash",
    "args":["-c","cd '/home/user/dev/workbench' && printf 'KIMI_APPROVED\\n' > spikes/sandbox/kimi-approved.txt"],
    "env":[
      {"name":"NO_COLOR","value":"1"},
      {"name":"TERM","value":"dumb"},
      {"name":"GIT_TERMINAL_PROMPT","value":"0"},
      {"name":"SHELL","value":"/bin/bash"}
    ],
    "cwd":"/home/user/dev/workbench",
    "outputByteLimit":4194304
  }
}
```

client 返回 `{"jsonrpc":"2.0","id":1,"result":{"terminalId":"m0-1787301167715"}}`，再处理同一 terminalId 的 `terminal/wait_for_exit` / `terminal/output` / `terminal/release`。spike 白名单明确接受这次抓到的真实包装：`command:"/bin/bash"`、`args:["-c","cd '<root>' && <命令>"]`；不能只接受 `-lc`。

### Kimi 0.38.0 到底何时发 session/request_permission

定向实验结论：

| client 能力 / mode | 标准权限请求 | 后续执行路径 | 结果 |
| --- | --- | --- | --- |
| 声明 fs、**不声明 terminal**，未显式 set_mode | 0 次 | Shell 先报 `ACP terminal capability is unavailable`，随后尝试 `fs/write_text_file` | 没有 shell 执行；该探索轮超时退出 |
| 声明 terminal，`session/new` 虽返回 currentModeId=default，但**不显式 set_mode** | 0 次 | 直接 `terminal/create` | 证明只看 new 返回的默认值不够 |
| 声明 terminal，显式 `session/set_mode(default)` | 1 次 | 批准后 `terminal/create` | 两次成功复现，最终文件落盘 |
| 声明 terminal，显式 `session/set_mode(auto)` | 0 次 | 直接 `terminal/create` | 成功，文件落盘 |
| 声明 terminal，显式 `session/set_mode(plan)` | 0 次 | 不执行 shell，读取 Kimi 自己的 plan 文件 | 当时 spike 尚未处理该 `fs/read_text_file`，180s 超时；此后补了安全只读处理，但遵守三轮上限未再跑 |

所以原先可能的结论“ACP 下 shell 根本不经 `session/request_permission`”过强。确切结论是：

1. **显式 default 模式会发标准 `session/request_permission`；auto 会绕过它直接请求 `terminal/create`。**
2. `session/new` 的 params 没有 permission/approval 字段；模式通过 `session/set_mode` 控制，而且 0.38.0 存在“返回 default 但未显式 set_mode 时仍直达 terminal/create”的实测差异。
3. **Workbench 的真正安全边界必须在 client 提供的 `terminal/create`（以及 `fs/write_text_file`）处再做一次审批/白名单拦截，绝不能只等待 `session/request_permission`。** 否则 auto、未显式激活 default 或 agent 的能力回退路径都会绕过 UI 审批。

### ⚠️ 病因补充（主会话 2026-08-21 事后查明）

上表「不显式 set_mode 就直奔 terminal/create」**不是 kimi 的怪癖，是本机配置**：
`~/.kimi-code/config.toml` 第 1 行 `default_permission_mode = "yolo"`。
ACP 会话继承该默认值，因此不显式 `session/set_mode` 就没有标准权限请求。

这让结论 3 的分量变得更重，而不是更轻：

- 在**这台机器上**，workbench 若不显式 set_mode 且不拦 `terminal/create`，
  开出来的 kimi 会话就是**全自动执行、UI 永远弹不出审批卡片**。
- 因此 M1 的 kimi driver 有两条硬性要求：
  1. 每个会话建好后**显式** `session/set_mode`，绝不读 `session/new` 的返回值就算数；
  2. `terminal/create` 与 `fs/write_text_file` 作为**不可绕过的最终闸门**再拦一道。

参照笔记见 `docs/kimi-web-reference.md`。

### usage/token 样本

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session_00000000-0000-4000-8000-000000000070","update":{"sessionUpdate":"usage_update","used":25417,"size":1048576}}}
```

Kimi 这里不是 input/output 分项，而是上下文已用量 `used` 与总容量 `size`。

## 4. M1 driver 层必须注意的三件事

1. **审批路由按真实协议分层。** Claude 关联 `control_request.request_id`；Codex 关联 JSON-RPC server request 的 `id`；Kimi 既处理 `session/request_permission`，又必须把 `terminal/create`/`fs.write_text_file` 当成不可绕过的最终执行闸门。
2. **事件流必须幂等、宽容并按会话/回合关联。** Claude 会回放 user/control_response 且 partial 与最终消息并存；Codex 实际省略 `jsonrpc` 并混入无 turn 的状态事件；Kimi 的 prompt result 只表示 turn 收尾，细节全在多型 `session/update` 中。
3. **会话身份与续接不能套用任务书旧假设。** Claude `--print` 默认落盘 `sdk-cli`，但 2026-09-27 实测 `CLAUDE_CODE_ENTRYPOINT=claude-vscode` 可原样保留并进入 resume 列表（见上文补充）；Codex 当前 source 固定 `vscode`、应用标识应读写 `originator`；续接分别使用 Claude session id、Codex `thread/resume`、Kimi `session/load` 或 `session/resume`，两种 Kimi 续接语义不同。

## 5. 踩坑记录

- Claude：缺 `--permission-prompt-tool stdio` 时不会把审批请求交给协议 client；重复写相同内容时模型可能跳过工具，因此脚本使用每轮唯一内容。
- Claude：`--permission-mode manual` 在 init 中显示为 `default`；不要依显示值误判启动参数未生效。
- Codex：PROMPT.md §4.1 的方法名已经过时；approval 是 server → client 的 JSON-RPC request，不能当通知处理。
- Codex：`source:"vscode"` 看似来自当前 VS Code 环境，实际上是 umbrella app-server 入口固定值。
- Kimi：真实 shell 形状是 `/bin/bash -c "cd '<root>' && …"`，不是预想的 `-lc`。
- Kimi：是否声明 terminal 能力会改变 agent 的工具路径；声明 fs 可能触发 `fs/write_text_file` 回退。
- Kimi：`default` 需要显式 `session/set_mode` 才稳定出现标准权限请求；即便如此，执行端仍须二次拦截 terminal/fs 请求。
- 所有脚本都有 180 秒超时、stderr 独立收集和非零失败；探索性超时均留下诊断与完整 capture，没有挂死后台进程。

## 6. 验收自查

- [x] 1. `npm run spike:claude`：最终退出码 0；两轮 prompt、83 个 partial、1 次审批、靶文件内容校验成功。
- [x] 1. `npm run spike:codex`：最终退出码 0；initialize → thread/start → turn/start → command approval → completed → thread/resume → unsubscribe 全闭环。
- [x] 1. `npm run spike:kimi`：最终退出码 0；initialize → list/new/set_mode/prompt → request_permission → terminal 全生命周期 → close 全闭环。
- [x] 2. `spikes/captures/claude.ndjson` 非空，含真实 `control_request` 与 `control_response`。
- [x] 2. `spikes/captures/codex.ndjson` 非空，含真实 `item/commandExecution/requestApproval` 与同 id `{decision:"accept"}`。
- [x] 2. `spikes/captures/kimi.ndjson` 非空，含真实 `session/request_permission` 与同 id selected outcome；另含 `terminal/create` 执行闸门及应答。
- [x] 3. 本文记录三家确切命令、握手、全量实测事件/方法、真实审批样本、会话 id/路径、续接、usage 和踩坑。
- [x] 4. Claude 的关键字段形状已在“control_request / control_response 的确切形状”中用完整真实样本钉死。
- [x] 5. 三家 usage/token 字段均贴出真实 capture 样本。
- [x] 通用实现：Node 22 + 仓库内 tsx/TypeScript；逐行解析、非 JSON 容错、双向逐行 capture、stderr 分离、180s 超时均已实现。
- [x] 安全范围：agent 文件写入只落在 `spikes/sandbox/`；未改 PROMPT.md，未改三个 CLI 配置/软链，未用 npm 全局安装、sudo、浏览器、Windows 程序或删除操作；capture 凭证字段在写入前打码。

## 7. kimi 2.1.1 工具调用字段（2026-09-28 抓包）

来源：`spikes/kimi-tools-capture.ts` → `spikes/captures/kimi-tools.ndjson`。七步工具任务（读/搜/列/改/写/跑命令/抓取），沙箱 cwd，权限一律自动批准。结论：**`kind` / `locations` / `rawInput` 确实存在**，但出现时机分阶段。

**初始 `tool_call`**：只有短名 title + kind + 空 content，**无 locations、无 rawInput**：

```json
{"sessionUpdate":"tool_call","toolCallId":"0:tool_HXOB…","title":"Read","kind":"read","status":"pending","content":[{"type":"content","content":{"type":"text","text":""}}]}
```

**`tool_call_update` 流式阶段**：`content` 的 text 是入参 JSON 的增量（如 `{"path":"`）；进入 `in_progress` 时有一条同时带人话 title、kind 和完整 `rawInput`：

```json
{"sessionUpdate":"tool_call_update","toolCallId":"0:tool_HXOB…","status":"in_progress","title":"Reading a.ts","kind":"read","rawInput":{"path":"a.ts"},"content":[{"type":"content","content":{"type":"text","text":"{\"path\":\"a.ts\"}"}}]}
```

**完成态**：`status` 为 `completed` / `failed`，`content` 文本换成结果，另带 `rawOutput`（Bash 例外，见下）。

实测 kind 值：`read`（Read/Grep/Glob）、`edit`（Edit/Write）、`execute`（Bash）、`other`（FetchURL）。search/fetch/think 等 ACP 枚举值未出现——搜索与列目录都归 `read`，抓取归 `other`。

| 工具 | 初始 title → 人话 title | kind | rawInput（实测一例） | locations |
|---|---|---|---|---|
| 读 Read | `Read` → `Reading a.ts` | read | `{"path":"a.ts"}` | 文件的绝对路径 |
| 搜索 Grep | `Grep` → `Searching for 'TODO' in <目录绝对路径>` | read | `{"pattern":"TODO","output_mode":"content"}` | 目录的绝对路径 |
| 列目录 Glob | `Glob` → `Searching **/*.ts` | read | `{"pattern":"**/*.ts"}` | 目录的绝对路径 |
| 编辑 Edit | `Edit` → `Editing a.ts` | edit | `{"path":"a.ts","old_string":"function foo() {}","new_string":"function bar() {}"}` | 文件的绝对路径 |
| 写入 Write | `Write` → `Writing b.txt` | edit | `{"path":"b.txt","content":"hello"}` | 文件的绝对路径 |
| 命令 Bash | `Bash` → `Running: ls -la && false` | execute | `{"command":"ls -la && false"}` | 全程无 locations |
| 抓取 FetchURL | `FetchURL` → `Fetching: https://example.com` | other | `{"url":"https://example.com"}` | 全程无 locations |

完成态 content / rawOutput 一例（截短）：

- Read：`rawOutput` 是带行号的内容 `"1\tfunction foo() {}\n2\t// TODO: fix"`，content 同文本。
- Grep：`"a.ts:2:// TODO: fix\nnotes.md:3:- TODO: 补上说明"`。
- Glob：`"a.ts\nsub/c.ts"`。
- Edit：`"Replaced 1 occurrence in a.ts"`（纯结论文本，无 diff）。
- Write：`"Wrote 5 bytes to b.txt"`。
- FetchURL：页面正文文本（开头带「引用此页」提示句）。

**terminal 类 content（Bash）**：完成态 content 只有终端引用，**没有输出文本、没有 rawOutput**；输出只能经 `terminal/output` 另取（印证 HANDOFF「阶段 2 的两个坑」第一条）。`status` 反映退出码：`ls -la && false` 完成态为 `"failed"`。

```json
{"sessionUpdate":"tool_call_update","toolCallId":"0:tool_9VNP…","status":"failed","content":[{"type":"terminal","terminalId":"tools-1790607026567-0"}]}
```

未出现：多条目 locations（每个工具至多一条）、edit 的 diff 型 content、`kind` 的其他取值。本次 7 类工具全部出现，无「未出现」项。
