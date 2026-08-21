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
- `DELETE /api/sessions/:id`：停止 worker 并移除注册表条目；不删除 Workbench 或原生 CLI transcript
- `GET /api/meta`：server/CLI 实测版本、全局能力、三 driver 能力位与配置 schema

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

三项都可省略。不传 `config` 时沿用各 driver 原有默认行为。旧字段 `model` 与 `kimiMode` 暂时兼容，分别等价于 `config.model` 与 Kimi 的 `config.permissionMode`；新调用不要再使用旧字段。

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

`GET /api/meta` 的 `data.drivers.<agent>.options` 是前端配置控件的唯一事实源。每项结构为 `{id,name,values,default,mutable}`；`mutable:false` 表示只能建会话时设置。来源如下：

- Claude：CLI 启动 flag 与 stream-json control protocol；模型和推理强度不可活改，审批模式可活改。
- Codex：模型选项在启动探针的 `model/list` 中动态读取；effort 按 Workbench 当前支持的 `minimal / low / medium / high / xhigh` 暴露。模型、推理强度和审批模式都在下一次 `turn/start` 生效。
- Kimi：三项和值全部从一次真实 `session/new` 返回的 `configOptions` 转换，不在 Workbench 手抄；三项均通过 `session/set_config_option` 活改。

元数据探针失败时，对应 driver 返回 `options:[]` 和 `error`，不会以可能过期的硬编码值冒充实时结果。

Claude 的模型或推理强度使用 CLI 自身默认值时，以空字符串 `""` 表示；schema 中对应标签为“CLI 默认”。Claude 在首轮 `system/init` 报出实际模型后，session 的 `model` 会更新为完整模型名。当前 CLI 不回报默认 effort 的展开值，因此该字段继续保留 `""`，不会猜一个可能受本机配置影响的值。

`snapshot` 的 `data` 为 `{session, seq, events}`。`events` 是重建会话视图所需的全量统一事件；客户端完成快照后连接 `/ws?sessionId=<id>&afterSeq=<seq>`。连接期间产生的缺口由每会话 1,000 条 ring buffer 补发；超出 ring 时服务端发送 `resync_required`，客户端重新取快照。

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

事件最小集为 `session_created / user_message / agent_text_delta / thought_delta / tool_call_started / tool_call_updated / tool_call_completed / permission_request / permission_resolved / config_updated / usage_updated / turn_completed / session_error / process_exited`；另有容错用 `raw_event`。每个 session 独立计数，`seq` 单调递增。

上行至少支持：

```json
{"type":"user_message","sessionId":"...","text":"只回复 OK"}
{"type":"permission_resolved","sessionId":"...","requestId":"...","decision":"allow"}
{"type":"set_config","sessionId":"...","config":{"permissionMode":"plan"}}
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

随后向请求方返回 `{"type":"ack","action":"set_config",...}`。不可改字段、未知值或没有活动 worker 时返回 WS `error`，不会假装成功。Codex 的 `effectiveFrom` 为 `next_turn`，Claude 与 Kimi 为 `immediate`。

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
- [x] **8. meta schema 来自预期事实源。** 隔离实例的 `GET /api/meta` 返回三家各 3 项；Codex 模型实时来自 `model/list`，Kimi 的 source 为 `Kimi ACP session/new.configOptions`，模型列表包含本机 Kimi 当时实际报告的 4 项，而不是后端静态常量。
- [x] **9. 活修改与不可改拒绝。** Kimi 经 WS 一次改为 `kimi-code/k3 / high / plan`，收到 `config_updated` 后再收到 ack；Claude `acceptEdits → manual` 两次均即时成功，且 `manual` 已正确映射到控制协议的 `default`。尝试活改 Claude model 收到 `claude.model 只能在建会话时设置`。Codex 活改为 `gpt-5.4 / medium / never` 后，事件标记 `effectiveFrom:"next_turn"`，下一轮原生 `turn_context` 三项逐一吻合。
- [x] **10. yolo 不能绕过最终闸门。** Kimi 会话在 `yolo` 下请求 Shell 写入 `config-yolo-gate-final-1787317200.txt`，Workbench 仍发出 `gate:"terminal/create", finalGate:true`；拒绝后 turn 正常收尾，`existsSync` 实测目标文件为 `false`。
- [x] **11. 不传 config 回归。** Claude `01J00000000000000000000047`、Codex `01J00000000000000000000048`、Kimi `01J00000000000000000000049` 均不传 config 建会话并完成一轮；分别回复 `CLAUDE_DEFAULT_FINAL_OK / CODEX_DEFAULT_FINAL_OK / KIMI_DEFAULT_FINAL_OK`，模式保持 `manual / untrusted / default`，均为 `riskyMode:false`。

验收产生的 agent 测试文件仅位于 `server/test-sandbox/`，该目录内容已被 Git 忽略。
