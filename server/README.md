# AIReins server（M1）

后端使用 Node 22、TypeScript 和 `tsx` 直跑，没有后端构建步骤。服务固定绑定回环地址 `127.0.0.1`，默认端口为 `8790`，带访问控制（见「## 访问控制」）；三家 CLI 版本在启动时实测并缓存。

## 启动

```bash
npm install
npm run build
npm run server
```

默认静态目录是仓库内的 `frontend/dist/`，构建后从 `/` 托管 SPA；该目录不入库。`install.sh` 安装/更新时构建并预压缩，`aireins` 启动前缺少 `frontend/dist/index.html` 时自动构建，构建失败退出。`npm run build` 保留旧 hash 资源，避免已打开页面加载失败；直接 `npm run server` 前须自行构建。开发时也可用 `WORKBENCH_STATIC_DIR` 指向另一份静态产物。`WORKBENCH_PORT` 可在并行开发或隔离验收时改端口，但不能改变回环绑定地址；生产默认仍为 `8790`。

持久化位置：

- 注册表：`~/.workbench/sessions.json`
- 统一事件 transcript：`~/.workbench/transcripts/<sessionId>.ndjson`
- 非 Git 工作目录的委派前快照：`~/.workbench/snapshots/<basename>-<pathHash>/`
- 各家 CLI 自有 transcript：由原生 CLI 管理；普通「移除」保留。用户明确确认「彻底删除」时，Codex 经正式 `codex delete --force <UUID>` 删除单个原生会话；Claude/Kimi 当前未开放此操作。

服务启动会把已释放或符合安全恢复条件的异常退出记录载入为 `idle + released`，下一次发送原地续接；包括原状态已被旧代码写成 `dead`、PID 已清空，但能通过系统启动时间证明旧 worker 全部消失的记录。不会接管旧进程。其余记录保持 `dead`，transcript 损坏优先为 `error`。新建续接也可传原生 `resumeSessionId`；Claude 使用 `--resume`，Codex 使用 `thread/resume`，Kimi 使用 `session/resume`。

### Claude Remote Control 契约（M23）

Claude 会话的列表、详情和 snapshot `session` 额外包含 `remoteControl:{status,sessionUrl?,reason?}`；状态为 `disconnected / connecting / connected / reconnecting / disconnecting / error`。`sessionUrl` 仅在已连接或重连中保留，`reason` 用于 title 提示。Codex、Kimi 没有此字段。状态变化写入统一 transcript、snapshot，并通过 WS `remote_control_updated` 广播同一状态对象；进程退出变为 `disconnected`。刷新和断线重连以 session/snapshot 对齐。

Claude 会话另有 `backgroundTasks:[{id,type,description}]`：来自 CLI 的 `system/background_tasks_changed`（每次增减发全量清单，任务结束清单变空；2026-09-30 用 2.1.284 实测），经 WS `background_tasks_updated`（payload `{tasks}`）广播；worker 启动、退出、释放时清空。非空时会话仍为 `idle`（可以照常发消息），但前端列表状态点显示为「正在工作」，且空闲自动释放与手动释放都拒绝（释放会杀掉后台任务）。

WS 上行 `{"type":"set_remote_control","sessionId":"...","enabled":true|false}`，成功收到常规 `ack`，失败收到带 `action:"set_remote_control"` 的常规 `error`；仅 Claude 活 worker 可用。driver 发送 `remote_control` 控制请求，15 秒未回复进入错误态。用户 `~/.claude/settings.json` 明确设 `remoteControlAtStartup:true` 时，新 worker 自动开启；project/local 设置明确 `false` 时禁止自动开启，读不到按关闭。已开启的会话因外部续聊或配置切换替换 worker 时自动恢复 RC，`session_url` 可变化。此功能不修改用户的 Claude 设置。

Claude stdout 的 `bridge_state`、控制应答驱动胶囊状态；未知 state 安全显示中间态。`--replay-user-messages` 的 user 文本只在 RC 为 `connecting / connected / reconnecting`、且不是本机回显、子代理、合成记录、CLI 注入包装或打断标记 `[Request interrupted by user…]` 时，才由 driver 发 `user_message`；RC 关闭时沿用原有行为，只处理其中的工具结果。本机回显以最多 20 条的先进先出列表匹配，`result` 不清空它。这样远端消息进入统一 transcript 和现有用户气泡，回合结束更新原生会话指纹，避免下次发送被误判为别处续聊。**手机发送消息的 stdout 形状及上述去重仍待真机验证**；本次无对话消息冒烟未覆盖它。`remote_control_work_secret` 重挂接不支持，收到会回复控制错误。

Claude 停止走 `control_request {subtype:"interrupt"}`（与 CLI/扩展按 Esc 相同，只打断当前回合，进程与会话保留）。CLI 随后以 `result {subtype:"error_during_execution", is_error:true}` 收尾；driver 记住本轮发过 interrupt，把这个非 success 的 result 标成 `turn_completed.interrupted:true` 并转 idle，不进 error，下一条消息照常续聊。

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

另外，静态资源响应带 `X-Frame-Options: DENY` 和 `Content-Security-Policy: frame-ancestors 'none'`，不允许别的网站嵌入 AIReins。

`POST /api/open-app-window` 接收 `{ target }`，沿用上述 Host/Origin 校验，且只接受本机监听入口；远程监听即使身份合法也返回 403。`target` 只允许 `policy.origins` 中的本机 WB/Vite 入口，不接受远程主机、账号密码、任意网站、控制字符或其他本机端口。仅 WSL 且找到 Windows Chrome 时可用：只读查找 Program Files、Program Files (x86) 和 LOCALAPPDATA 的 Chrome 安装目录；WSL 未继承 LOCALAPPDATA 时查看标准 Windows 用户目录。

启动使用 `execFile`，无 shell，唯一参数为 `--app=http://127.0.0.1:<本机端口>/#wb-goto=<编码目标>`，只等进程创建，不等 Chrome 退出。非法目标返回 400，不可用或启动失败返回 503；成功返回 `{ opened: true }`。`GET /api/meta.capabilities.appWindow` 按入口计算，远程恒为 false。前端只在本机初始化会话前恢复本机路径和会话路由。HTTP 测试设置 `WORKBENCH_NO_APP_WINDOW=1` 禁用启动器，合法请求也返回 503，避免真实启动 Chrome。

远程入口的规则：

- **Host**：必须是配置的 `origin` 主机名，或 `127.0.0.1:<port>`（Serve 转发可能改写 Host）。
- **身份**：必须带 Serve 注入的 `Tailscale-User-Login` 头，且登录名在 `allowedLogins` 中。
- **Origin**：写操作和 WS 握手必须带 Origin，且与配置的 `origin` 完全一致。

### 远程入口配置 `~/.workbench/remote.json`

没有文件时不开远程入口。文件无效时只记一条 `remote.json 无效，远程入口未开启` 日志，本机入口照常使用。更改配置后须重启 AIReins 才生效。

```json
{
  "port": 8792,
  "origin": "https://alice-desktop.example.ts.net",
  "allowedLogins": ["你的登录名@github"],
  "terminal": false
}
```

- `port`：1–65535，不能与本机端口相同，且须与 Serve 转发目标一致。
- `origin`：手机地址栏里的源；全小写，无路径、无结尾斜杠。
- `allowedLogins`：允许访问的 Tailscale 登录名。未知时可先填占位值，手机打开页面后，403 提示会显示实际登录名。
- `terminal`：可选布尔值。只有显式设为 `true` 才允许远程入口使用自由终端；缺省或类型不对均按 `false` 处理，类型错误会记日志。新安装自动生成 `terminal: false`，已有配置不覆盖；要开启远程终端，编辑此文件设为 `"terminal": true`，然后由用户执行 `aireins restart`。

Serve 会剥掉客户端自带的同名身份头，再注入真实身份。远程端口只绑定 `127.0.0.1`；DNS 重绑定网页的 Host 过不了检查。本机进程可伪造此头，但本来就能访问本机入口。

### 手机远程排错

| 现象 | 常见原因 | 处理 |
|---|---|---|
| 手机打不开，一直超时 | 手机 Tailscale 没连上；系统代理 TUN 抢了路由；电脑睡眠或关机了 | 看手机 Tailscale 的连接状态；TUN 模式要把 `100.64.0.0/10` 与 `*.ts.net` 设为直连；电脑那边远程开机 |
| 502 Bad Gateway | AIReins 没在跑；或 `remote.json` 没配、配错了，8792 没有监听 | 用 `aireins status` 看「远程」那一行；`aireins logs` 里搜 `remote` |
| 403「没有 Tailscale 身份」 | 没走 Serve，比如直连了 8792；或请求来自 Funnel、打了 tag 的设备 | 改用 `https://<机器域名>/` 访问 |
| 403「Tailscale 账号 X 未授权」 | X 不在 `allowedLogins` 里 | 把 X 加进 `remote.json`，然后 `aireins restart` |
| 403「Origin 不匹配」或「Host 不在远程白名单」 | `remote.json` 里的 `origin` 和地址栏不一致（大小写、结尾斜杠、机器改了名） | 改成地址栏里的 `https://<机器域名>`，不带结尾斜杠，然后 restart |
| 页面能打开，但一直「连接中」，圆点不变绿 | WS 握手被拒（日志里有 `websocket rejected`），或 Serve 没转发 WS | 按日志里的原因处理；如果是 Serve 的问题，记下现象报告给用户 |
| 电脑浏览器突然 403 | 用了白名单以外的地址访问，比如局域网 IP、自定义的 hosts 名 | 改用 `http://127.0.0.1:8790` 或 `http://localhost:8790` |
| 手机上改了后端却没变化 | 后端改动要 `aireins restart` 才生效（前端 `dist` 刷新即可） | 重启前先查 `/api/sessions` 有无活会话 |

## 闸门提醒

通知是可选功能，目前仅支持飞书，配置位于 `~/.workbench/notify.json`。配好后才开启：闸门挂起超过 `delaySeconds` 秒（默认 60）还没人处理，就发一条飞书提醒。两种发送方式二选一：`feishuWebhook` 走群里的自定义机器人；`larkUserId` 调本机 `lark-cli im +messages-send --as bot` 让应用机器人私聊该 open_id（租户关了自定义机器人时用，凭据由 lark-cli 管，要先 `lark-cli auth status` 看 bot 身份是 ready）。

- **限频**：同一会话 60 秒内最多发一条；冷却中到期的闸门顺延，冷却结束时仍未处理再发。
- **取消提醒**：收到 `permission_resolved`（已处理），或 `process_exited`（进程退出，闸门没法再操作）。
- **直达链接**：配了 `remote.json` 时，提醒带 `<origin>/#/session/<id>` 链接。
- **容错**：发送失败只记一条 `warn` 日志；`notify.json` 写错只记一条 `error` 日志；两种情况都不影响服务。

```json
{ "feishuWebhook": "https://open.feishu.cn/open-apis/bot/v2/hook/…", "delaySeconds": 60 }
{ "larkUserId": "ou_…", "delaySeconds": 60 }
```

webhook 地址就是密钥：文件权限设为 600，也不要写进日志或仓库。更改配置后须重启 AIReins 才生效。

## 平台能力

服务端 `platform.ts` 是平台策略的唯一入口，区分 `wsl`、原生 `linux`、`darwin`（其他系统为 `unsupported`，原生 Windows 不在支持范围）。WSL 通过 Linux 内核版本中的 `microsoft` 或 `/proc/sys/fs/binfmt_misc/WSLInterop` 判定，不依赖 `WSL_DISTRO_NAME`/`WSL_INTEROP`；发行版环境变量只用于生成 VS Code WSL 链接。测试向函数注入平台、存在性和 CLI 输出，不提供平台覆盖环境变量。

`GET /api/meta` 的 `data.platform` 返回上述值，`data.capabilities` 逐项声明当前入口的能力。缺字段时前端不显示对应入口；平台支持不代表可选命令已安装。

| 能力字段 | WSL2 | 原生 Linux | macOS 实验性 |
|---|---|---|---|
| `terminal` | 本机开；远程须显式开启，默认 bash | 同左，默认用户登录 shell | 同左，默认用户登录 shell（回退 zsh） |
| `windowsDirectoryPicker` | 本机且 PowerShell 7 存在 | false | false |
| `appWindow` | 本机且 Windows Chrome 存在 | false | false |
| `powerOff` | 可执行 `prefs.shutdownCommand` 配置后开启 | 同左 | 同左 |
| `windowsPaths` | true | false | false |
| `powershell` | Windows pwsh 7/PowerShell 存在 | false | false |
| `fileEdit` | true | true | false |
| `taildrop` | Tailscale CLI 可用 | 同左 | 同左 |
| `folderTaildrop` | Tailscale CLI 与 zip 可用 | 同左 | false |
| `windowsTray` | 本机 true，远程 false | false | false |
| `remoteGateway` | true（Windows 网关拓扑） | false（Serve 直连） | false（Serve 直连） |

能力是 UI 提示，服务端继续独立验证每个接口的权限与参数。关机不引入平台默认命令，仍按本机 prefs 显式配置（无参数排定约 60 秒后关机，`abort` 取消），公开默认关闭，WSL 已有配置不变。三家 CLI 会话、历史、文件浏览/预览、原生文件检索都使用现有 POSIX 路径；`rg` 为安装依赖。WSL 保留 `bash -l -i`；原生 Linux/macOS 的 shell 选择见「终端」，客户端不接受任意可执行路径。

Linux/WSL 文件读取和目录操作保持 `/proc` fd 锚定。macOS 文件预览/下载/普通文件发送在授权 realpath 上以 `NOFOLLOW|NONBLOCK` 打开，并在再次授权检查后比较路径与 fd 的 dev/ino；由于 Node 没有可用的 BSD openat 目录锚定 API，文件保存和目录打包按能力隐藏，后端也拒绝。不会用普通路径 rename/cwd 替换目录 fd 以降低原有安全保证。

Tailscale 优先 PATH；WSL 保留 Windows CLI 回退，macOS 回退 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`，原生 Linux 不探测或调用 `tailscale.exe`。Linux/WSL worker 继续保存内核 boot ID/start ticks；macOS 使用 `sysctl kern.bootsessionuuid/kern.boottime` 和 BSD `ps`。BSD 的秒级启动时间不用于判定存活 PID 复用：仅不同 boot UUID 或 PID 与所属组明确 ESRCH 才授予恢复资格，EPERM/未知状态保守阻止恢复。三平台 worker 都使用 POSIX detached 进程组。

原生 Linux/macOS 上 Tailscale 和 AIReins 位于同一主机：`tailscale serve --bg http://127.0.0.1:<remote.port>` 直接进入远程监听。安装器读取 Tailscale 状态并生成缺失的 `remote.json`（权限 600、`terminal:false`），已有或无效文件不覆盖。有有效配置且 Tailscale 已登录运行时，先读 `tailscale serve status --json`：没有 Serve 配置就自动执行上述命令并打印远程地址；HTTPS 根路径已指向同一目标就报告已配置，不改动；其他配置（含 TCP、前台 Serve、Services、Funnel）保留并打印现状和手动命令。权限失败不重试，提示用户自行执行 `sudo tailscale set --operator="$USER"` 后重跑 `bash install.sh`，脚本不执行 sudo。`--check` 全程只读。入口仍绑定 `127.0.0.1`，`remotePolicy` 的 Host、写操作/WS 的完整 Origin，以及 Serve 注入的 Tailscale 登录白名单检查不变。禁止 Funnel；本机伪造身份头不属于远程认证，因为本机进程本来拥有本机入口权限。

macOS 安装时若已安装 Homebrew、stdin/stdout 都是 TTY，缺失或版本不足的 Node（≥22.12）与缺失的 ripgrep 会合并询问一次 `[Y/n]`，确认后执行 `brew install` 并重新检测。拒绝、无 Homebrew、非 TTY 或 `--check` 时只打印手动提示；不自动安装 Homebrew。Linux/WSL 的 apt/NodeSource 修复仍只打印命令，需要 sudo 的操作由用户执行。

## REST

所有 REST 成功和错误都使用同一个信封；`request_id` 是 ULID，也会出现在同次请求的服务端 JSON 日志中。

```json
{"code":0,"msg":"success","data":{},"request_id":"01M0..."}
```

### 面向界面的文案与语言

数值 `code`、HTTP 状态及接口语义保持不变。REST 信封、会话 WS、终端 WS 的服务端自产文案保留原 `msg` / `message` / `reason` 等字段，另附可选 `i18n` 元数据；旧前端可忽略新字段，继续读取原文。

```json
{"code":40401,"msg":"会话不存在：abc","data":{},"request_id":"01M0...","i18n":{"msg":{"key":"server.message167","params":{"p0":"abc"}}}}
```

`i18n` 是所在对象的字段名到 `{key, params?, localizedParams?}` 的映射。`params` 保留动态值，`localizedParams` 可给嵌套的已知服务端错误或枚举值附同样的描述符；例如自动快照失败所带的底层错误仍可翻译，路径、会话 ID 和问题原文保持原值。`protocolLimitations` 字符串数组对应描述符数组，未知项为 `null`。前端按浏览器选择的 `zh-CN` / `en` 词典翻译；未知键或 CLI 原始错误回退到原文字段。服务端不记录客户端语言，也不改写持久化事件。

翻译元数据在 `server/i18n/messages.ts` 的统一输出边界生成，模板来自 `frontend/src/i18n/server.zh-CN.ts`，英文位于同目录 `server.en.ts`。历史事件补发、snapshot 与分页响应同样经过该边界，因此旧 transcript 中的已登记提示也可翻译。配置项名称、预置标签、内建命令描述、文件预览原因、页面健康提示及派单活动也采用这一约定。生成的「新会话」「无标题会话」占位标题由生成路径明确附元数据；用户标题、模型正文、问题/答案、工具输入输出、终端字节和第三方页面内容不翻译。日志保持原样。

`GET /api/fs/content` 是图片/PDF/下载直接加载的字节端点，浏览器查看器不会运行前端 JSON 解码器。前端为其 URL 添加 `lang=zh-CN|en`；失败时 `lang=en` 用同一错误描述符与词典生成英文 `msg`，仍保留 `code`、HTTP 状态和 `i18n`。不带参数、中文或其他值均保留兼容原文；成功的文件字节与 Range 行为不受语言影响。该参数只控制文案，不影响授权与路径验证。

新增服务端自产提示时，把模板与相同键的英文译文加入上述两套词典，动态部分使用 `{p0}` 等占位符；嵌套错误参数须同时登记在 `nestedParameterNames` 中。检查覆盖位置与保留中文原因见 `server/i18n/coverage.json`，协议验证见 `server/i18n.test.ts`。`npm run check:i18n` 包含覆盖守卫（`frontend/scripts/check-server-i18n.mjs`）：扫描 `server/` 非测试源码的中文字面量，每处必须命中 coverage.json 的已登记模板或带原因的例外；新增未登记文案、模板已删、行号漂移都会失败并提示如何修复。

接口：

- `POST /api/sessions`：创建会话，统一配置见下文
- `POST /api/snapshot/preflight`：建会话前检查 cwd 是否需要及能够自动快照
- `GET /api/fs/dirs?path=<绝对路径>&files=1`：只读列出一级子目录；省略 `path` 时使用 `$HOME`，可由 `prefs.json` 的 `directoryBrowserHome` 覆盖；带 `files=1` 时同层普通文件一并列出，并为文件/目录补充 `size` 和 `modifiedAt`（Unix 毫秒）。普通文件大小为字节，文件夹大小为 `null`，不递归累加；无法 stat 时字段为 `null`，保留可列出的名称。只对已收集的条目读取元数据，并发最多8个；文件夹/文件分别最多1000个，超限标记 `truncated`。不带 `files=1` 的目录选择模式保持原返回与读取范围。
- `POST /api/fs/pick-directory`：仅本机监听允许，WSL＋Windows PowerShell 7 可用时 `GET /api/meta` 返回 `capabilities.windowsDirectoryPicker:true`；远程始终为false且POST返回403。JSON `{path?:string}` 指定起点，Windows盘符与 `/mnt/<盘符>` 支持，Linux cwd/空值从 Windows 用户目录打开。通过固定 PowerShell 程序调用现代 WinForms `FolderBrowserDialog`，路径以环境变量传入，单实例，进程内120秒自动退出（后端130秒超时，前端135秒）。取消返回 `{path:null}`；选定盘符目录后映射并检查可浏览性，返回 `{path:"/mnt/c/..."}`；已有窗口409，输入/目录不合法400，调用失败/超时503。保留所有原有 Host/Origin 检查，不启动常驻 Windows 服务。
- `POST /api/fs/pick-file`：右侧文件面板的原生 Windows 浏览入口；与目录选择共享上述本机能力、起点、单窗口、取消及超时规则。调用 WinForms `OpenFileDialog`，`All files (*.*)|*.*` 显示所有扩展名，仅选一个既有文件；返回映射到 `/mnt/<盘符>/...` 并经 `stat` 确认为普通文件的路径。预览仍由工作文件接口独立检查授权根与 realpath，不因原生选择而放宽读取权限。
- `POST /api/uploads?sessionId=<id>&name=<文件名>`：上传附件，请求体为原始字节（非 multipart）；保存到 `~/.workbench/uploads/<sessionId>/`，返回 `{path,name,size,mimeType}` 同秒同名文件通过 `wx` 原子预留路径，再用该文件描述符写流；并发上传各自保留，失败只删除自己的半截文件。
- `GET /api/uploads/file?path=<绝对路径>`：读取上传目录内的文件字节（缩略图用）；只允许 `~/.workbench/uploads/` 之下
- `GET /api/sessions`
- `GET /api/sessions/:id`
- `GET /api/sessions/:id/snapshot`
- `GET /api/sessions/:id/events?beforeSeq=<firstSeq>`
- `GET /api/sessions/:id/commands`：当前活动会话的实时归一命令表
- `POST /api/sessions/:id/release`：释放会话 worker（见「三家 CLI 原生历史」末尾「释放」小节）
- `PATCH /api/sessions/:id`：侧栏会话组织字段。请求体只接受 `{pinned?: boolean, customTitle?: string, groupId?: string|null}`，逐字段校验类型，未知字段 400 / 40070；`customTitle` trim 后 ≤200 字符，空串删除该键（恢复自动标题，显示标题始终是 `customTitle` 优先，集中取标题在 `shared/session-title.ts`）；`groupId` 必须指向已存在分组或 `null`。会话不存在 404 / 40401。响应 `{session}`。组织变更不推进会话 seq、不更新 `lastActivityAt`、不广播 transcript 事件，也不写三家原生记录；`pinned/customTitle/groupId` 直接存 `sessions.json` 注册表条目，沿用现有原子写/延迟刷盘。

原生标题通过 driver metadata 的 `nativeTitle` 同步，折叠空白、最多200字符，非字符串、空串与重复通知忽略；注册表持久化，并复用 `session_organization_updated` 控制帧同步所有页面，不推进 seq 或活动时间。显示优先级为手动 `customTitle` → `nativeTitle` → 首条输入。原生标题晚于列表/快照请求到达时，客户端保留更新后的标题和较新的运行状态。Codex 读取新建/续接响应的 `thread.name` 并接收 `thread/name/updated.threadName`；Kimi 接收 `session_info_update.title`。Claude 接收人工标题通知，并按当前 cwd 和原生 UUID 精确定位 `.jsonl`，只读尾部最多256KiB的 `ai-title.aiTitle`；首轮结果后短期监听该文件的变化，75ms防抖，找到标题立即关闭，最多30秒，进程停止/退出也关闭，不轮询。超过监听窗口的标题留待下轮读取。Kimi ACP 未开放概括接口，其原生标题可能仍为首条输入。

AIReins 新建的 Codex 会话在首个 `item/completed.userMessage` 后、没有手动或原生标题时，复用 0.160.0 TUI 的自动标题流程，最多尝试一次。它在主会话现有 app-server 内另建 `ephemeral:true, threadSource:"thread_title"` 的只读线程，使用 TUI 原 prompt（整体≤960 UTF-8 bytes）、JSON schema 与标题归一化（≤36 Unicode 字符）。OpenAI provider + ChatGPT 登录 + 模型目录支持时用 `gpt-5.6-luna / low`，否则沿用当前模型和原生配置档位；这是额外的一次原生模型请求。禁用工具、MCP、plugins、hooks、skills 注入、环境访问和委派；辅助通知与审批请求不进入主 transcript、用量、状态、会话列表或派单树。生成全过程上限30秒，失败静默、不重试；取消/超时只中断辅助回合，再 unsubscribe（各最多1秒），晚到的辅助线程也立即 unsubscribe。手动改名取消生成，写回前再读主线程名称；已有名称不覆盖。写回仅通过拥有主线程的同一 app-server 的 `thread/name/set`，不另起 writer，不直接修改原生文件或全局配置。ephemeral 线程不物化到 `~/.codex/sessions`。源码出处与隔离验证见 `.work-orders/2026-10-05-codex-auto-title/REPORT.md`、`spikes/PROTOCOL-NOTES.md`。
- `GET /api/session-groups` → `{groups}`；`POST /api/session-groups` 请求体只接受 `{name}`（trim 后 1–200 字符）→ 201 `{group}`；`PATCH /api/session-groups/:id` 同样只接受 `{name}` → `{group}`；`DELETE /api/session-groups/:id` 先把成员会话的 `groupId` 清掉并写回注册表，再删分组 → `{groups}`。分组 `{id,name,createdAt}` 持久化在 `~/.workbench/session-groups.json`（与注册表同一 tmp+rename 原子写，分组单独一个文件：它跨会话引用，跟会话条目分开写）。分组不存在 404 / 40471。以上组织变更都会广播 WS 控制帧 `session_organization_updated {sessions, groups}`（无 seq、不受会话订阅过滤），其他已打开页面据此同步；启动清理 `pruneStorage` 保留 pinned 或有 groupId 的会话，用户主动整理的不因超龄被清。
- `GET /api/sessions/:id/info/:kind`：输入框「/」菜单的只读查看，仅 Claude 会话。kind 为 `mcp` / `hooks` / `permissions` / `context`，分别转发 control_request `mcp_status` / `get_hooks_listing` / `list_permission_rules` / `get_context_usage`；`plugins` 没有对应 control_request，与 VSCode 扩展同样在会话 cwd 下跑 `claude plugin list --json`，`data` 为 `{plugins:[{id,version,scope,enabled,projectEnabled,installPath,…}]}`，不需要 worker（dead 会话也可查）；其余`data` 是 CLI 的 response 原样（`context` 只保留 categories、totalTokens、maxTokens、percentage、model、autoCompactThreshold、isAutoCompactEnabled，原样约 50KB）。已释放会话按 `ensureWorker` 先拉起；dead、非 Claude、未知 kind 或 CLI 报错返回 400 / 40063，15 秒超时。返回结构见 `spikes/PROTOCOL-NOTES.md` §10。
- `GET /api/prefs` / `PUT /api/prefs`：服务端偏好，当前只有 `idleReleaseMinutes`（整数 0–1440 分钟，0 = 关闭空闲自动释放；校验失败 400）
- `GET /api/claude/settings` / `PUT /api/claude/settings`：读取或保存用户级 `{remoteControlAtStartup:boolean}`（400 / 40064）。只改 `~/.claude/settings.json` 的这一键，关闭写 `false`，按 2 空格缩进保留其他键与顺序；直接写文件跟随软链接，不替换链接。仅影响之后新启动的 worker（新建、续接、释放后发送），项目级 `false` 仍可覆盖关闭，不改变当前连接的 RC。
- `PUT /api/sessions/:id/plugins`：请求 `{id,enabled,scope?}`，仅 Claude；id 和 scope 必须匹配该 cwd 最近一次插件列表，scope 从列表取（缺失则不传）。通过 `execFile` 参数数组在会话 cwd 执行 `claude plugin enable|disable <id> --json [-s scope]`；返回 `{plugins,reloaded,reloadError?}`，重新运行列表刷新状态。已有 worker 依次发 `get_settings`、`reload_plugins` 并刷新斜杠命令；重载失败仍返回已保存状态及 `reloadError`。dead/released 会话不拉起 worker，`reloaded:false` 提示新会话或重新续接后生效。CLI 失败或参数非法为 400 / 40065，会话不存在为 404 / 40401；CLI 单次 15 秒、重载 30 秒，前端总请求上限 80 秒。协议证据见 §10。
- `POST /api/sessions/:id/mcp`：仅 Claude，请求 `{action:"toggle",serverName,enabled:boolean}`、`{action:"reconnect",serverName}`、`{action:"authenticate",serverName}` 或 `{action:"oauth_callback",serverName,callbackUrl}`。driver 先读 `mcp_status` 核对服务器名，再分别发 `mcp_toggle` / `mcp_reconnect` / `mcp_authenticate` / `mcp_oauth_callback_url`。回调仅接受带 code/error 参数的 HTTP(S) 完整 URL（≤16384 字符、无控制字符），OAuth state 与 token 交换交给 CLI 校验；不接受任意控制请求或自定义 redirectUri。不自动打开浏览器。
  - **成功与失败均读回** `mcp_status`，返回 `{mcpServers:[…],auth?,actionError?,refreshError?}`。CLI 可能已完成状态变更却返回错误（2.1.300 启用 HTTP MCP 实测为 `Server status: needs-auth`，随后的列表已为 needs-auth）；这类操作错误以 HTTP 200 的 `actionError` 与最新列表一起返回，前端显示错误但不保留旧 disabled 行。读回失败返回旧列表及 `refreshError`，控件暂停，必须刷新后再操作，不能把列表当成最新状态。
  - `authenticate` 返回的 `auth` 沿用 CLI `{authUrl?,requiresUserAction,callbackExpected,…}`；面板只提供 HTTP(S) 授权链接及手动复制，不自动打开。`callbackExpected:true` 时，远端设备可提交浏览器地址栏完整回调 URL；该请求成功只表示 CLI 已完成 token 交换，随后需「重连/刷新状态」更新当前 worker 的工具。旧 CLI 不支持或授权失败时，面板提供 `claude mcp login '<name>'`，用户在宿主同一 cwd 的终端完成授权，再回到当前会话启用（若关闭）、重连和刷新。真实凭据由 CLI 管理，AIReins 不存储授权链接/回调到会话或配置。
  - 开关只改变当前 worker，非持久配置；回复中允许操作，与扩展一致（实测见 §14）。已释放会话先续接；dead、非 Claude、启动中、有未决审批、重启中、名称不存在或参数非法为 400 / 40066，不存在为 404 / 40401。单次状态查询 15 秒、管理控制请求 30 秒，前端总上限 80 秒。协议证据见 `spikes/PROTOCOL-NOTES.md` §15。
- `GET /api/sessions/:id/info/:kind` 新增 `status` → `get_status`（`{sections:[{title,rows:[{label,value}]}]}`）；`usage` → `get_usage`（会话费用、订阅与额度）；`memory` / `instructions` → `get_memory_dialog`（files/folders/memories、自动记忆状态）；`skills` → `get_skills_dialog`；`sandbox` → `get_sandbox_dialog`；`export` → `export_conversation`（`{text,default_filename}`，纯文本，以 CLI 导出内容为准，不受前端事件窗口限制）；均为只读控制请求，错误沿用 400 / 40063。
- `output` 先 `initialize` 获取 `available_output_styles`，再 `get_settings` 刷新磁盘设置，返回 `{outputStyle,availableStyles,settingsFiles}`，两次请求各 15 秒、前端总上限 40 秒。仅返回样式字段，不暴露整个 settings（可能含环境变量）。
- `settings` 直接返回 `{settingsFiles:[{source,label,path,uri}]}`，无需 worker，dead 会话也可打开；三个范围为用户、项目、项目本地。用户路径尊重 `CLAUDE_CONFIG_DIR`，默认 `~/.claude/settings.json`。hooks/permissions/skills/sandbox/memory/output 查看也附带 `settingsFiles`；memory/instructions 的文件及目录行附带 `uri`。
- `uri` 仅为协议链接：WSL 返回 `vscode://vscode-remote/wsl+<distro>/<encoded-path>`，原生 Linux/macOS 返回 `vscode://file/<encoded-path>`；路径分段编码，非绝对路径或控制字符返回 null。后端不启动 VSCode，不写 settings；文件可以尚未创建。Hooks 等在编辑器保存后重新打开面板查看，某些配置需下次续接。插件/策略提供的 Hooks 仍按原来源展示，不伪装成用户 settings 中的条目。
- 新菜单只用于 Claude；Rewind 没有接入：虽然协议有 `rewind_files {user_message_id,dry_run}`，当前 worker 未启用 SDK 文件检查点且 AIReins 事件没有原生用户 UUID，实测 `canRewind:false,error:"File rewinding is not enabled."`，无法提供可信的文件/消息预览。扩展的会话回退另走宿主 fork + resume 截点，不能直接移植。调查表与冒烟证据为本地归档（`.work-orders/2026-10-01-slash-ext-report.md`、`scratch/slash-ext/`），未随仓库公开。
- `GET /api/sessions/:id/files?q=<关键词>&limit=<默认50>`：在会话 `cwd` 内检索可引用的普通文件
- `DELETE /api/sessions/:id`：停止 worker；删注册表条目，并删 AIReins 自己的副本（transcript、未被引用的附件）；三家原生记录不动。响应的 `transcriptsDeleted:true` 仅指 AIReins 副本，`workbenchTranscriptPreserved:false`、`nativeTranscriptPreserved:true` 如实报告；续接/检查中的移除返回 400 / 40063，IO 错误仍返回 500。
- `GET /api/history`：只读列出三家 CLI 自己保存的所有来源会话；没有用户消息的会话隐藏，`empty` 单独计数（分页为本页扫描计数），`skipped` 记录损坏/不可读候选。命中 delegate 元数据的条目附带 `dispatch:{runId,name}`，UUID 和 `session_...` 原样匹配；派单映射只读全部目录的 `run.json`/旧 `meta.json`，缓存 30 秒。
- `GET /api/history/:agent/:nativeSessionId/messages`：从最新消息向前分页读取完整原生历史
- `GET /api/meta`：server/CLI 实测版本、按请求入口计算的终端能力位、三 driver 能力位与配置 schema；`hostName` 为执行主机名称，优先用既有 `remote.json` 的 Tailscale 域名机器名，否则用 Node `hostname()`，供主机菜单显示「机器名（本机）」。新增字段需要后端重启，旧前端可忽略。
- `GET /api/tailscale/peers`：只读发现其他 Windows/Linux/macOS 电脑，沿用现有 Host/Origin 与远程 Tailscale 身份白名单，不增加豁免。`execFile` 不经 shell 调用 `tailscale status --json`（5 秒超时，输出最多 1 MiB），优先 PATH，WSL 未找到时回退 `/mnt/c/Program Files/Tailscale/tailscale.exe`。成功信封 `data:{peers:[{name,origin,online,os,ips}]}`，仅含前端可接受的 HTTPS MagicDNS 地址，排除自身、手机及非法域名，在线优先后按名字排序。未安装、未运行、超时或坏 JSON 都返回 HTTP 200、`code:0`、`data:{peers:[],reason:"可读原因"}`。发现不探测目标 AIReins 是否可用；后端重启后生效。
- `GET /api/tailscale/file-targets`：文件面板「发送到设备」的 Taildrop 目标。调用 `tailscale file cp --targets`（查找顺序与超时同上），成功信封 `data:{targets:[{name,ip,online,self}],reason?}`；`self` 仅远程入口按 Tailscale Serve 覆盖写入的 `X-Forwarded-For` 标出来访设备，本机入口恒为 false。排序为本机、在线、名称。CLI 不存在、未运行、超时都返回 `code:0`、空列表加 `reason`。
- `POST /api/tailscale/send`：JSON `{path,root,sessionId?,target}`，`target` 为上一接口返回的 IP。`path/root/sessionId` 沿用工作文件的授权根与 realpath 检查；普通文件以 fd 流式读取，文件夹先在临时目录 `zip -r -y` 打包为 `<名称>.zip`（符号链接存为链接，10 分钟超时，发送后删除临时目录）。发送前重新取 `--targets`，只接受列表内在线 IP，再不经 shell 执行 `tailscale file cp --name=<名称> - <ip>:` 由 stdin 喂内容，30 分钟超时；请求持续到发送结束。成功 `data:{sent:true,name}`。路径错误同文件接口（`status*100+90`，空文件夹 400/`40090`，打包失败 500/`50090`）；目标不在列表或取 `--targets` 失败 400/`40091`（消息为原因），离线 409/`40991`，CLI 启动失败或非零退出 502/`50291`（附 stderr 末行），读取待发送内容出错 500/`50091`。文件夹以 `O_DIRECTORY|O_NOFOLLOW` fd 锚定并复核 realpath，zip 在 `/proc/<pid>/fd/<fd>` 内打包 `.`，条目不带顶层目录。前端请求超时 45 分钟；客户端断开不会取消服务端已开始的发送。Taildrop CLI 本身不收目录（`directories not supported`），因此由服务端打包。
- `POST /api/restart`：无请求体，返回 HTTP 202，信封 `{code:0,msg:"accepted",data:{restarting:true},request_id}`；表示已接受，不表示重启已完成。沿用两个入口的 Host / Origin 校验，远程入口还须 Tailscale 身份白名单；不新增豁免。同一进程内重复请求仍回 202，只启动一次重启。
- `GET|POST|DELETE /api/power-off`：关机。信封 `data:{state:"idle"|"waiting"|"scheduled",busy,remainingMs?,error?}`，`busy` 为 running、starting 或带后台任务的会话数（比重启多算 starting）。POST 时无忙会话立即执行 `prefs.json` 中的 `shutdownCommand`（无参数排定 60 秒后关机），否则进入 `waiting`，每 5 秒检查一次，全部空闲后自动执行、不再确认；重复 POST 不重复执行。`scheduled` 且命令已落地时带 `remainingMs`（距关机的剩余毫秒，前端据此倒计时）；过了关机时刻 60 秒仍在运行，回到 `idle` 并带 `error`。DELETE 取消等待；已排定时以 `abort` 参数执行同一命令，Windows 报 1116（没有正在进行的关机）按取消成功处理。失败回到 `idle` 并带 `error`。等待状态只在内存，AIReins 重启即丢失。远程入口可用，沿用同样的 Host/Origin 与 Tailscale 身份白名单。
- `GET /api/pages`：启动时已注册的扩展页面列表
- `GET /api/pages/:id/health`：限时探测一个扩展页面的目标服务

### 斜杠菜单

Claude 菜单按扩展分成「上下文 / 模型 / 自定义 / 设置 / 支持」。插件改名「管理插件」并标注启用、停用与重载；MCP 标注开关、重连与连接状态，两者均在「自定义」中。MCP 和插件都使用 `role="switch"`；MCP 回复中可用，启动、待审批或会话结束时在开关旁解释禁用原因。Codex 菜单保持原样。

- `PUT /api/sessions/:id/thinking`：`{enabled:boolean}` → `{session}`。Claude 会话配置保存 `thinkingLevel:"off"|"default_on"`，默认 `default_on`；driver 发送 `set_max_thinking_tokens`，关闭为 0，开启为 31999 + `thinking_display:null`（与扩展默认预算一致，使用 AIReins 现有思考呈现）。请求成功才保存并广播 `config_updated`。已释放会话只保存，下一次续接生效；每次 worker 初始化（含重启、续接）重新下发。单次控制 15 秒，前端总上限 40 秒。不写用户 settings，不修改模型/effort。菜单开关点后保持展开，失败就地显示。
- `GET /api/sessions/:id/info/capabilities`：只返回 `{supportsFastMode:boolean}`，匹配 `initialize.models[]` 的 `value / resolvedModel`（兼容 `[1m]`）；配置跟随时使用 CLI init 或有效设置模型，未知模型/缺失能力字段为 false。Fast 只在字段为 true 时显示，通过现有用户消息链路发 `/fast`，不绕过 CLI 的账户额度检查。
- `POST /api/sessions/:id/tasks/stop`：`{taskId}` → `{stopped:true}`，只接受当前会话 `backgroundTasks` 中的任务，已有 live worker 发送 `stop_task {task_id}`。回复中可停止，前端先 `window.confirm`；成功只表示停止请求已接受，列表以 `background_tasks_changed` 的全量元数据为准，不提前删除任务。控制 15 秒，前端 20 秒；不拉起已释放 worker。
- `POST /api/sessions/:id/side-question`（Claude `/btw`、Codex `/side`）：`{question,history?:[{question,response}],sideId?}` → `{response:string|null,sideId?,synthetic?,error?,refusal_fallback?}`（`sideId` 仅 Codex 使用，Claude 不转发）。问题及每个历史字段为 1–20000 字符，历史最多 20 轮；Claude 只转发 `side_question`，不调用主消息发送接口，不写主线事件。面板在内存保存独立历史，synthetic/null 不加入历史。每会话最多一个在途侧问，关闭/取消/HTTP 断开取消（Claude 经 `control_cancel_request`，Codex 见下），迟到回复忽略；Claude 控制上限 60 秒、前端 80 秒。侧问/Thinking 在途时阻止配置切换与 worker 释放。以上三个写接口非法输入、非 Claude（侧问另允许 Codex）或 CLI 错误为 400 / 40069；不存在为 404 / 40401，均沿用已有访问控制。
  - Codex 侧聊：照 TUI `/side`（rust-v0.160.1 `tui/src/app/side.rs`）：无 history 时 `thread/fork {ephemeral:true, excludeTurns:true, approvalPolicy:"never"}`，开发者指令追加原生侧聊指令，`thread/inject_items` 注入边界提示，再在侧聊线程 `turn/start` 并取最后一条 agentMessage；回复带 `sideId`（侧聊线程 ID），面板续问带回；有 history 且 `sideId` 正是当前侧聊线程时复用该线程；否则（侧聊线程已因取消/出错丢弃，或另一窗口开了新侧聊）重新 fork 并把历史问答作为文字背景，不串线。取消与 `turn/start` 响应赛跑，已从 `turn/started` 得知回合 ID 即可立即 interrupt；fork / inject 等待期间取消立即返回，取消或超时后迟到的成功 fork 也会 unsubscribe。侧聊线程的通知不进主线、任何服务端请求（审批/提问）一律拒绝；取消/出错 interrupt + unsubscribe，正常结束的侧聊线程留到下次新开面板或 worker 停止才 unsubscribe（ephemeral 不落盘）。主线尚无首条消息时 fork 失败，提示先发一条消息。回合上限 300 秒。前端 320 秒。

2026-10-02 判定表（上一轮已接项目继续保留）：

| 扩展功能 | AIReins 判定 | 依据 / 边界 |
| --- | --- | --- |
| MCP 开关、重连、刷新 | 已接，回复中解锁 | 流式回复开始后 3 次控制请求均 success；只对当前 worker 生效 |
| 插件启停、重载 | 已接，入口可发现 | 「自定义 / 管理插件」，switch，操作后刷新 |
| Thinking | 本轮已接 | 默认开启、31999 预算、会话保存及初始化重发 |
| Fast | 本轮已接，按能力显示 | `models[].supportsFastMode === true`；发用户命令 `/fast` |
| 后台任务 /tasks | 本轮已接 | 实时清单、确认停止、task ID 白名单；真实任务停止待临时实例补验 |
| 侧问 /btw | 本轮已接 | stream-json 实测返回 `response:"4",synthetic:false`；独立历史、取消，不进主线 |
| Codex 侧聊 /side | 已接 | codex-cli 0.160.1 实测：侧聊读到主线上下文、续问复用同一 fork、主线零事件泄漏 |
| 状态、账户/用量、Memory、Instructions、Skills、Sandbox、输出样式、Hooks、设置文件、导出、帮助 | 保留已接 | 配置编辑仍走文件协议链接，导出以 CLI 文本为准 |
| Rewind、Bookmarks | 不接 | 本单排除；Rewind 缺文件检查点与消息 UUID |
| 插件安装/卸载/marketplace、MCP 添加/删除/OAuth | 不接 | 本单排除，避免扩大配置写入范围 |
| 反馈上传、Chrome、Design、账号/登出、内部条目 | 不接 | 本单明确排除 |
| switch-models-on-flag、Ultracode | 不接 | 实验 gate 控制，本单排除 |

协议与实测报文见 `spikes/PROTOCOL-NOTES.md` §14。运行时没有新增依赖。

### 重启当前实例

`POST /api/restart` 先完成 202 响应，再延迟 200ms 以 POSIX `detached`（新 session / process group）启动仓库的 `bin/aireins restart`。继承当前进程环境，明确传入当前监听的 `WORKBENCH_PORT`、`workbenchHome` 和 `WORKBENCH_NO_OPEN=1`；数据目录和日志路径按当前进程工作目录转为绝对路径；`WORKBENCH_LOG` 保留显式路径，未设置时落到当前 `WORKBENCH_HOME/server.log`。显式 `WORKBENCH_STATIC_DIR` 同样透传已解析的绝对路径，其他环境原样继承。因此远程入口发起重启也会停本实例的主监听端口，重新读取同一数据目录的远程配置，不弹浏览器。启动器与旧服务进程组分离；脚本的 SIGTERM 走既有 `shutdown()` 释放会话与终端，再启动服务加载新代码。`bin/aireins` 保留 WSL 的 setsid 启动，macOS 改用 nohup 与 BSD lsof/ps；重启仍只操作当前端口。

停服一开始，本机与远程入口均拒绝新的 WS 升级，新的 HTTP 请求返回 503 并带 `Connection: close`；已有 WS 发出关闭通知。两个监听保持到 worker 停完，保留 `aireins stop` 以主端口空出判断 worker 已停止的语义。随后并行关闭两个监听，主动断开残留 HTTP、普通 WS 与终端 WS 连接，显式退出 0；关闭失败退出 1，整个关闭流程超过 10 秒则记录错误并强制退出 1。

前端点按钮先重新拉取会话列表；`status === "running"` 或 `backgroundTasks` 非空的会话去重计数，非零时显示数量并二次确认。确认后全屏显示「重启中」，既有 WS 断线重连在观察到断开再恢复后解除遮罩。60 秒未恢复或接口失败时给出关闭提示和按当前实例环境执行 `aireins restart` 后刷新的说明。202 后启动失败记录服务端日志，客户端以恢复超时提示失败；断线重连不自动重发重启请求。

Kimi 配置探测仍通过 `session/new` 读取 configOptions。探测进程关闭后，仅定位本次返回的 sessionId：历史根取 `WORKBENCH_KIMI_HISTORY_DIR` 或 `~/.kimi-code/sessions`；只有一个匹配目录、`state.json.id` 相同且完整 `agents/main/wire.jsonl` 仅含 `metadata / permission.set_mode / profile.bind / runtime.set_binding` 时才删除，并清除 `.index-dirty` 中以该 ID 开头的普通标记文件。异常、身份不符、对话或未知记录均保留并记日志；既有空会话只隐藏，不批量删除。

`GET /api/fs/dirs` 的 `data` 为 `{path,parent,dirs:[{name,path}],truncated}`；带 `files=1` 时追加 `files:[{name,path}]`（同层普通文件，含指向文件的有效符号链接，同样最多 1000 项，目录或文件任一达到上限都会置 `truncated:true`）；`files` 只接受 `1`/`0`，其他值返回 HTTP 400、错误码 `40036`。路径先规范化；根目录 `/` 的 `parent` 为 `null`。不限制浏览根目录，包括 `/mnt/c/...`；目录选择模式不列 `.` 开头的条目，`files=1`（文件面板）照常列出，指向目录的有效符号链接会列出，断链和无权限条目跳过。子目录按名称排序，最多返回 1000 项，更多时 `truncated:true`。路径无效、不存在、不是目录或无权限读取时返回 HTTP 400、错误码 `40035`。

`GET /api/fs/file?path=<绝对路径>&root=<当前目录>&sessionId=<可选会话ID>&large=<可选 1>` 返回信封 `data:{path,name,size,kind,mimeType,text?,version?,editable,reason?,large?}`。`kind` 为 `text|markdown|csv|tsv|html|image|pdf|unsupported`；文本（包括未知扩展的有效文本）、Markdown、CSV/TSV、HTML 使用严格 UTF-8，可保留 BOM，最多 32 MiB；超过 4 MiB 且未带 `large=1` 时只返回 metadata 与 `large:true`（无文本/版本），前端提示后再带 `large=1` 读取，避免无意中渲染大文件。NUL/控制字符、无效 UTF-8（4–32 MiB 的文本在确认加载后才判定）、Office 或超过 32 MiB 的文件返回 `unsupported` 与原因，不返回文本/版本；图片、PDF 仅预览，最多 32 MiB。只读文本仍可预览，但 `editable:false`。

`root` 是当前浏览目录或会话 cwd，不能授予权限：授权根仅为 `$HOME`、WSL 上已存在的 `/mnt/<单字母盘符>` 目录、Claude Code 会话临时目录 `${CLAUDE_CODE_TMPDIR:-系统临时目录}/claude-<uid>`（macOS 默认为 `/tmp` 与 `/private/tmp` 下的同名目录；`SendUserFile` 发给用户的 scratchpad 文件在这里，仅当它是本用户所有、非软链且组和其他人无权限的目录时才授权）、已存在 `sessionId` 的服务端 cwd。路径支持 POSIX，WSL 另支持 `C:\\...`，拒绝相对路径、控制字符和 `..`。逻辑目标与真实目标都须位于 root；root 的真实路径也须位于对应授权根，内部符号链接可用，逃逸链接、目录/FIFO等非普通文件被拒绝。读取通过 `NOFOLLOW|NONBLOCK` fd 检查身份与真实路径；Linux/WSL 使用 `/proc/self/fd`，macOS 使用授权路径与 fd 的 dev/ino 复核（保存/目录发送关闭，见平台能力）。全部接口沿用现有 Host、远程登录白名单以及写操作 Origin 检查。

`POST /api/fs/file` JSON 为 `{path,root,sessionId?,version,text}`，显式保存上述可编辑文本，返回更新后的同一 metadata（含 `text/version`）。文本最多 32 MiB；前端用 `JSON.stringify` 编码，合法文本的转义至多两倍，请求体独立上限为 64 MiB + 64 KiB（其他客户端若用 `\uXXXX` 转义普通字符，可能在文本未达上限时即 413），并严格解码 UTF-8，其他 JSON 路由仍为 1 MiB。版本包含内容 hash 与文件身份/元数据；同一 inode 的保存串行执行，磁盘内容、身份、时间或权限变化返回 HTTP 409。写入同目录唯一 `wx` 临时文件、保留权限、fsync 后 rename；内部符号链接保留，更新其真实目标。失败只清理本次创建的临时文件，rename 前的失败保留原件。目录 fd 锚定临时与目标名称，并在 rename 前复核目标、根和父目录，减少路径置换竞态；外部程序未参与本进程锁，最后检查到 rename 之间仍存在无法由 Node 原生 API 原子消除的窗口，不能承诺与外部写者绝对无冲突。

`GET /api/fs/content?path=...&root=...&sessionId=...` 返回字节，最多 32 MiB，`download=1` 作为完整附件下载；不支持格式也可在此上限内下载。图片/PDF/HTML 默认 inline，其余作为 octet-stream 附件；响应 `no-store`、`nosniff`。HTML、SVG和下载响应带 `CSP: sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:`，不执行脚本，也不加载相对图片/CSS。PDF inline 支持单一 `bytes=start-end`、`bytes=start-` 或 `bytes=-suffix` Range，有效返回 206/Content-Range，无效返回 416/`bytes */size`；下载忽略 Range。文件接口错误分别返回 HTTP 400/403/404/409/413/415，错误码为 `status*100+90`；JSON格式/请求体超限沿用 `40000/41300`。真实设备的 PDF 嵌入能力由浏览器决定，前端保留下载回退。

`POST /api/uploads` 的查询参数 `sessionId` 必须是已存在的会话（否则 404/`40401`），`name` 必须非空（否则 400/`40070`）。请求体是附件原始字节；服务端只按查询参数里的文件名存盘：取 basename、替换路径分隔符与控制字符、去掉首尾部点和空白、限长 120 字符，保存为 `~/.workbench/uploads/<sessionId>/<YYYYMMDD-HHMMSS>-<清洗名>`（同秒同名追加 `-1` 等序号；目录 0700、文件 0600）。单文件上限 25 MB，超限返回 413/`41301` 且不留半截文件。成功返回 `data` 为 `{path,name,size,mimeType}`，`mimeType` 仅按扩展名判断（png/jpg/jpeg/gif/webp/heic/pdf/office 等常见扩展，未知为 `application/octet-stream`）。

`GET /api/uploads/file` 不是信封接口，直接返回文件字节；`path` 经 `realpath` 后必须落在 `~/.workbench/uploads/` 之内且是普通文件（`..` 与指向目录外的符号链接一律拒绝），否则 404/`40450`。响应带 `content-type`（按扩展名）与 `cache-control: private, max-age=3600`。

建会话时，三家统一使用 `config.model / config.effort / config.permissionMode`：

```json
{
  "agent": "claude",
  "cwd": "/home/user/projects/workbench",
  "snapshot": "auto",
  "config": {
    "model": "haiku",
    "effort": "low",
    "permissionMode": "manual"
  },
  "initialMessage": "只回复 OK"
}
```

`CreateSessionInput.snapshot` 可省略，取值为 `"auto" | "skip"`，默认 `"skip"`（2026-10-01 起；此前默认 `"auto"`，续接入口未传该字段会对大目录误报快照失败）。`auto` 会在
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

`riskyMode` 在 Claude 的 `bypassPermissions / dontAsk`、Codex 的 `full-access / 旧 never`、Kimi 的 `yolo` 下为 `true`。这是每会话标记，不存在全局 yolo 开关。

### 派单只读接口

`delegate` 是可选的外部派单工具，AIReins 不要求安装它。实现在 `server/dispatches.ts`，路由在 `server/index.ts`。默认读取 `~/.cache/delegate`，可用
`WB_DELEGATE_DIR` 覆盖。约定每项工单置于 `YYYYMMDD-HHMMSS-<执行端>-<名称>/`，包含 `run.json`（兼容旧 `meta.json`）及可选日志；目录缺失时仍独立显示已注册会话的原生子代理，不报错。两秒共享扫描缓存，不启动或控制派单进程，不写入数据源。
三个接口均走现有 `/api` 访问控制和 `{code,msg,data,request_id}` 信封：

- `GET /api/dispatches?limit=50` → `data: {dispatches: Dispatch[]}`。有效目录名按字符串倒序；
  默认 50 条，上限 200，正数小数向下取整，非法值或小于 1 回退到 50。delegate 根目录不存在或不可读取时不返回工单；已注册会话的原生子代理独立读取。
  除 delegate 记录外，还返回 Claude Code 原生子代理记录（`tool=claude`）：候选父会话 = 注册表里的 Claude 会话（cwd + nativeSessionId）∪ delegate 记录里 `parent.agent=claude` 的 sessionId，只读这些父会话目录下的 `subagents/agent-<id>.jsonl` 与同名 `.meta.json`，不枚举无关项目。默认根目录 `~/.claude/projects`，可用 `WORKBENCH_CLAUDE_PROJECTS_DIR` 覆盖。实际模型取自 assistant `message.model`，类型/任务名取自 meta，生命周期按最终回复与写入新鲜度判定；路径/mtime/size 指纹加两秒共享扫描缓存，头尾读取各限 1 MiB。三家原生子代理进入流程图和父会话徽标，标记 `native:true`，只读展示，不打开 delegate 历史、详情或日志。独立 Codex 会话也按注册表原生 ID 发现子线程（包括 Luna），沿真实 `parentThreadId` 递归并防环。Kimi 只枚举工作空间根目录名，再读指定注册会话的 `state.json` 与其中列出的 `agents/<id>/wire.jsonl`；头尾各限 64 KiB，拒绝符号链接，按文件指纹缓存并重新判断新鲜度。未关联的记录不猜测父会话。
- `GET /api/dispatches/<runId>` → `data: DispatchDetail`。
- `GET /api/dispatches/<runId>/log?stream=stdout&offset=0` → `data: DispatchLog`。
  `stream` 缺省为 `stdout`，仅允许 `stdout` / `stderr`；`offset` 为非负安全整数，单位为字节。
  参数无效返回 HTTP 400 / `40000`；派单不存在、ID 非法或路径逃逸返回 HTTP 404 / `40400`。

```ts
interface Dispatch {
  runId: string; tool: string; name: string;
  cwd: string | null; model: string | null; effort: string | null;
  status: "running" | "lost" | "OK" | "TOOL_FAIL" | "ACCEPT_FAIL" | "TIMEOUT" | "unknown";
  startedAt: string | null; endedAt: string | null;
  elapsedS: number | null; exit: number | null; files: number | null;
  session: string | null;
  parent: {agent: string; sessionId: string | null; entrypoint: string | null; model: string | null; title?: string | null; runId?: string} | null;
  promptHead: string | null;
  native?: boolean; // 原生子代理，只读展示
  subagents?: Array<{
    threadId: string; nickname: string; role: string | null; depth: number; parentThreadId: string;
    status: "running" | "finished" | "unknown";
    startedAt: string | null; lastActivityAt: string; activity?: string;
  }>;
}
interface DispatchDetail extends Dispatch {
  prompt: string | null; promptTruncated: boolean;
  summary: string | null; final: string | null; accept: string | null;
}
interface DispatchLog {
  text: string; nextOffset: number; size: number; eof: boolean; reset?: true;
}
```

`runId` / `tool` 从目录名取，`name` 优先用元数据中的原始名称（目录后缀可能经过清洗）。
新目录优先读取 schema 1 的 `run.json`；缺失时兼容旧 `meta.json`。`elapsed_s` 映射为
`elapsedS`，其他缺失字段为 `null`。`startedAt` 缺失时按服务端本地时区解释目录中的日期与时间，
返回 ISO 时间。运行中尚未记录的 `elapsedS` 为 `null`，客户端可由 `startedAt` 计算已跑时长。
`running` 且无 `endedAt` 时用 `process.kill(pid, 0)` 判活，`ESRCH` 转为 `lost`，
`EPERM` 仍视为存活；PID 无效或其他判活错误为 `unknown`。空目录、损坏 JSON、不支持的 schema、
超过 64KB 的元数据或不可读取的文件只让该条状态变成 `unknown`，不会中断列表。
Codex 的 `session` 缺失时，从 `stderr.log` 前 8KB 的 `session id: <uuid>` 行补齐。

`promptHead` 取 `prompt.txt` 首个非空行，去掉首尾空白，按 Unicode 字符截到 160 字符。
详情的 `prompt` 最多读取 64KB，超限置 `promptTruncated:true`，不输出边界上残缺的 UTF-8 字符；
`summary` 是 `summary.txt` 全文，`final` 是 `last.txt` 尾部最多 8KB，`accept` 是
`accept.log` 尾部最多 4KB，缺失或不可读取时为 `null`。

日志显式指定 `offset` 时，从该字节起最多读取 64KB，仅返回截至最后一个 `\n` 的内容，
末尾半行保留到下次。客户端使用返回的 `nextOffset` 续读；手工偏移若落在 UTF-8 字符内部，
跳过开头的残缺字符。省略 `offset` 时读取尾部最多 16KB，丢弃开头的残行，从完整行首返回。
`size` 是本次打开文件后的大小快照，`eof` 表示 `nextOffset >= size`，因此尾部有半行时为
`false`，即使派单已经结束。`offset > size` 时从 0 重读并追加 `reset:true`；日志尚未生成时
返回空文本、零大小和 `eof:true`。没有换行的末行不会被返回；单行超过 64KB 时，遵守本次
读取上限会使显式偏移无法推进，客户端可改用尾读查看后续完整行。

仅接受匹配 `^\d{8}-\d{6}-(codex|kimi|copilot)-` 且不含 `/`、`\`、`..` 的 ID。
目录经 `realpath` 校验必须是根目录的直接子目录，逃逸的符号链接拒绝；固定数据文件也拒绝
符号链接和非普通文件。客户端不能指定文件路径。这里只提供 GET，不提供停单、重派或续接接口。

## 终端

用户自由终端属于工作区，与会话和 Kimi ACP 的 `terminal/create` 完全隔离。它在 server 进程内存中保存，断开 WebSocket 或隐藏面板不会结束 PTY；server 重启会结束全部 PTY。`GET /api/meta` 的 `data.capabilities.terminal` 按请求入口返回：本机入口为 `true`，远程入口仅在 `remote.json` 显式配置 `"terminal": true` 时为 `true`。关闭时以下 REST 均返回 HTTP 403，`/ws/terminal` 拒绝升级。两个监听都只绑定 `127.0.0.1`；远程访问须经 Tailscale Serve，并通过既有 Host、Origin 和 Tailscale 身份检查。自由终端直接运行用户 shell，不经过 agent 审批闸门。

REST 沿用 `{code,msg,data,request_id}` 信封：

- `GET /api/terminals` → `data: {terminals: TerminalInfo[]}`。
- `POST /api/terminals`，body `{cwd?: string, shell?: "bash"|"powershell", cols: number, rows: number}` → `data: TerminalInfo`。`cwd` 缺省或不存在时回退到 server 的 `defaultCwd`；shell 是白名单（不收路径），缺省及旧客户端的 `"bash"` 都表示本机 Unix 缺省 shell。WSL 固定 `bash -l -i`；原生 Linux/macOS 取服务进程 `$SHELL`，须绝对路径、可执行且列在 `/etc/shells`（文件不存在时仅检查前两项；读取失败不放行）。无效时 macOS 先退到可执行的 `/bin/zsh`，再退 `bash`；Linux 退 `bash`。zsh/bash 参数为 `-l -i`，其他 shell 保守只传 `-l`。powershell 仅 WSL 可用，cwd 只在 `/mnt/<盘符>` 下沿用，否则进 Windows 用户目录；继承 server 环境。`cols` 限 1–500，`rows` 限 1–300，均须为整数。
- `POST /api/terminals/:id/kill` → `data: {ok: true}`。只结束进程，不删除文件；退出记录保留到 server 重启。

`TerminalInfo = {id:string, cwd:string, kind:"bash"|"powershell", shell:string, cols:number, rows:number, createdAt:string, exited:boolean, exitCode:number|null}`。`shell` 是实际启动的程序；`GET /api/meta.data.terminalShell` 是缺省 Unix shell 的文件名（如 `zsh`）。前端标签取 `TerminalInfo.shell` 文件名，滑块随当前实际 shell 显示，新建提示取 meta 的缺省名；WSL 保留 bash / PowerShell。旧后端省略 meta 字段时回退 bash。

`/ws/terminal` 是独立的 JSON 文本帧通道，一个连接可订阅多个终端。上行 `{type:"attach",terminalId}` 后，服务端依次发送 `{type:"attached",terminalId,omitted}`、`{type:"data",terminalId,data}`（当前全部回放），随后推送实时 `{type:"data",terminalId,data}`。重复 attach 同一 id 会重新回放。**回放帧会剥掉 OSC 4/10/11/12 颜色查询与 CSI DA 与 DSR/CPR（5n/6n/?6n）询问序列**（`stripReplayQueries`）：查询无视觉效果，但重放时 xterm 会重新应答，应答字节进 PTY 输入被 shell 回显成垃圾；实时推送不剥。PTY 输出 CPR 询问（`ESC[6n`）时若没有任何订阅者，服务端代答 `ESC[1;1R`：WSL 拉起的 Windows 程序（ConPTY）启动即询问并阻塞到收到应答，远程高延迟下 attach 晚于这一刻、回放又剥掉询问，PowerShell 会永远空白；有订阅者时仍由前端 xterm 应答。每终端只保留最近 256KB 输出，`omitted` 为此前丢弃的字节数。上行还支持 `{type:"input",terminalId,data}` 和 `{type:"resize",terminalId,cols,rows}`。进程退出发送 `{type:"exit",terminalId,exitCode}`；未知 id、已退出或参数无效发送 `{type:"error",terminalId?,message}`。连接断开仅解除订阅，不结束 PTY。

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

`GET /api/meta` 的 `data.drivers.<agent>.options` 是前端配置控件的唯一事实源。每项结构为 `{id,name,values,default,mutable,mutableVia?}`；`default` 可以是 `null`，对应 values 中“跟随 … 配置”的标签；`mutable:false` 表示只能建会话时设置。`mutableVia:"control"` 表示优先通过控制协议热切换；`mutableVia:"restart"` 表示需要重启底层 worker。来源如下：

- Claude：CLI 启动 flag 与 stream-json control protocol；审批模式原生活改。模型和推理强度为 `mutable:true, mutableVia:"control"`。空闲且无待审批闸门时，模型发送 `set_model {model}`，推理强度发送 `apply_flag_settings {settings:{effortLevel}}`；success 后即时更新配置、有效值及前端。错误或 15 秒超时回落到原重启路径；释放的会话只保存新配置，下次拉起带入 `--model / --effort`。
- Codex：模型选项来自 `model/list`；默认 model/effort 来自 `config/read(cwd)` 返回的有效合并配置，而不是模型内建默认。创建或续接线程后，再以 `thread/start` / `thread/resume` 返回的实际 `model / reasoningEffort` 和 `approvalPolicy + approvalsReviewer + sandbox` 更新 session；权限模式是三者的组合，不能只用 `approvalPolicy` 回填。若旧版 app-server 无法提供 `config/read`，schema 的 model/effort 默认值为 `null`，不会猜值。effort 可选覆盖仍限定为 `minimal / low / medium / high / xhigh`；三项活修改在下一次 `turn/start` 生效。
- Kimi：三项和值全部从一次真实 `session/new` 返回的 `configOptions` 转换，不在 AIReins 手抄；新建会话的权限默认值由 AIReins 指定为 `auto`（Auto），模型与推理强度默认值沿用原生返回；三项均通过 `session/set_config_option` 活改。

Codex 与 Kimi 的元数据探针失败时，对应 driver 返回 `options:[]` 和 `error`。Claude 启动时后台发一次不含用户消息的 stream-json `initialize` 控制请求，从应答的 `response.models` 中提取模型描述开头的名字与版本号，仅更新 `fable / opus / sonnet / haiku` 的显示标签；每个 Claude worker 的 initialize 应答也会刷新这些标签。`value` 和“跟随 Claude 配置”标签不变。探针失败或某条描述缺失时，该项保留静态“（最新）”标签，不妨碍建会话。

每个 driver 还在 `/api/meta` 暴露 `commands / mentions` 两个布尔能力位。本机协议实测后的能力矩阵是：Claude `true / true`、Codex `true / true`、Kimi `true / true`。前端必须以能力位决定是否展示功能；尤其不能把 Codex 的普通文本 `/compact` 冒充为原生斜杠命令。

Claude 的模型或推理强度不显式覆盖时，schema 默认值、`config` 和兼容字段 `model / effort` 的初始值均为 `null`，标签为“跟随 Claude 配置”。创建每个 worker 时，服务端只读并依次合并 `~/.claude/settings.json`、`<cwd>/.claude/settings.json`、`<cwd>/.claude/settings.local.json`，后层同名字符串覆盖前层；模型读取 `model`，推理强度读取 `effortLevel`。每个文件独立容错：缺失、无权限、坏 JSON、非对象或该项不是非空字符串时忽略该层的该项并保留上一层；三层都没有可用值才报告 `null`。合并 settings 时不启动 Claude 查询配置，不要求预热，也不在 `~/.claude`、`~/.codex` 或 `~/.kimi-code` 写缓存文件。

Claude 在首轮 `system/init` 报出实际模型后，兼容字段 `model` 和 `effectiveModel` 都更新为完整模型名，`effectiveModelSource` 变为 `init`，并广播一条 `config_updated`。若未来 init 回报 effort，同样提升 effort；当前 Claude Code 2.1.238 的 init 不回报有效 effort，因此兼容字段 `effort` 保持 `null`，`effectiveEffort` 则继续使用 settings 合并值及 `settings` 来源，不会猜测精确模型侧 effort。审批模式缺省由 driver 明确传 `auto`（2026-09-30 起，此前为 `manual`），用户选 `manual` 时 init 回报的协议值 `default` 会归一为 `manual`。

Codex 权限菜单已按当前官方三个常用预设更新（2026-10-01；本机 0.159.3 原生 `thread/start` 无模型请求实测通过）：

| 菜单 | AIReins `permissionMode` | `approvalPolicy` | `approvalsReviewer` | 沙盒 |
| --- | --- | --- | --- | --- |
| Ask for approval | `on-request` | `on-request` | `user` | `workspace-write` |
| Approve for me（新建缺省） | `auto-review` | `on-request` | `auto_review` | `workspace-write` |
| Full access | `full-access` | `never` | `user` | `danger-full-access` |

每次 `thread/start` / `thread/resume` 都显式传三项；每次 `turn/start` 同时传 `approvalPolicy / approvalsReviewer / sandboxPolicy`。因此切回人工审批会同时撤销自动审核和完全访问。前两项的沙盒禁止网络，额外权限分别交给用户与 Codex 审核；Full access 的 `sandboxPolicy` 为 `{type:"dangerFullAccess"}`，并沿用高权限提示。自动审核由原生 Codex 执行，AIReins 不自行批准请求，也不改全局配置。

旧会话续接仍接受原来保存的 `untrusted` 和 `never`，但菜单不再提供这两个旧值。旧 `never` 保留 `workspace-write` 沙盒，绝不自动升级为 Full access；旧值在前端作为当前值显示，可切换到新预设。新会话不得显式选择旧值。官方的 `Custom (config.toml)` 属于自定义权限组合，本菜单仅提供上述三个常用预设。协议回归在 `server/codex-permissions.test.ts`；运行 `node --import tsx server/codex-permissions.test.ts`。

2026-10-03 起，新建表单显式提交 Codex `auto-review`、Kimi `auto`，刷新已构建的前端即可使用。服务端缺省也同步调整；旧会话保留已保存档位，无保存档位的旧会话续接仍用 Codex `on-request`、Kimi `default`。

`GET /api/sessions/:id/snapshot` 不带 `tail=1` 时，`data` 仍为 `{session, seq, events}`，返回全量统一事件（包括现有验证脚本的用法）。`?tail=1` 返回 `{session, seq, events, hasMore, firstSeq}`，`events` 只含最近一段；`seq` 始终为整个会话的当前游标，不能改成分页首尾游标。`session.snapshotState` 携带由全量事件计算的 `latestUsage`、`commands`、`configSwitching`、`promptCacheTtlMs` 和 `promptCacheUsageAt`，`session.title` 也由完整会话确定；未产生的用量和切换态字段可省略，缓存未知时为 `null`。

`GET /api/sessions/:id/events?beforeSeq=<上一响应的 firstSeq>` 返回 `{events, hasMore, firstSeq}`，所有事件均满足 `seq < beforeSeq`。`beforeSeq` 必须为正安全整数，且在会话内必须对应可安全分页的用户回合起点，否则返回 400；小于等于第一条事件的 seq 返回空页，大于最后 seq 按完整前缀分页。空页为 `{events:[], hasMore:false, firstSeq:0}`。`hasMore=false` 后停止请求。

分页阈值在 `server/event-pages.ts`：`EVENT_PAGE_MAX_TURNS = 30`，`EVENT_PAGE_MAX_JSON_BYTES = 1.5 * 1024 * 1024`（事件数组未压缩 JSON 的 UTF-8 字节数）。从末尾向前尽量累计完整回合，至少保留最后一个不可拆分段；只有 `user_message` 且 `steer !== true` 可作回合起点，首条用户消息之前的事件归第一段。切点不得穿过工具 started→最后 updated/completed 或审批 request→resolved 的区间，尚未完成的工具/闸门区间延伸至末尾；完成后再次更新工具也追溯原起点，`process_exited` 不截断工具区间。没有安全切点、单回合过大或跨回合配对形成超阈值不可拆段时，整段返回。分段 prepend 后统一重建渲染项，以保持工具配对和分组结果与全量一致。

长会话分页按需缓存 seq→字节偏移、安全切点、字节/回合前缀和派生状态，正文仅按分页偏移读取。启动全量恢复不预建分页缓存；索引按保守估算设 16MiB 总预算并执行 LRU，闲置项优先淘汰，释放 worker 时移除索引，超预算单项不常驻。追加增量更新；文件 stat 指纹变化时先重判健康和残尾边界，读取前后指纹一致才缓存；全量健康重判同步失效旧版本索引，写后确认 inode、预期大小、新增字节与读取期间版本一致才增量推进缓存。tail 快照的分页与派生状态共用一次索引读取，超预算单项也只扫描一次。返回数据隔离于缓存，工具迟到更新仍会撤销穿过工具生命周期的旧切点。同 tick 的首次 transcript 追加同步执行，其余合批写入；所有读取、释放、移除和正常退出前刷出待写批次。延迟批次写失败记录日志，并将对应会话标为 error、transcript 在当前进程内锁为只读；后续 driver 回调不再写入，读取不会解除保护，重启后按实际字节执行原有恢复校验。回归见 `server/long-session.test.ts`、`server/long-session-review.test.ts`，基准见 `frontend/scripts/long-session-bench.mjs`。

单会话客户端可在快照后连接 `/ws?sessionId=<id>&afterSeq=<seq>`；当前前端使用全局 `/ws`，以 `replay` 消息传各已加载会话的 `afterSeq`（详见性能接口契约）。连接期间产生的缺口由每会话 1,000 条 ring buffer 补发；超出 ring 时服务端发送 `resync_required`，客户端重新取 `tail=1` 快照。历史分页不会改变重连的 `seq`。

## 三家 CLI 原生历史

`GET /api/history` 直接只读扫描以下事实源，不创建索引文件，也不会写入这些目录：

- Claude：`~/.claude/projects/**/*.jsonl`
- Codex：`~/.codex/sessions/**/rollout-*.jsonl`
- Kimi：`~/.kimi-code/sessions/**/state.json`；标题缺失时只读同会话的 `agents/main/wire.jsonl` 头部

查询参数：

- `agent` 可省略，或为 `claude / codex / kimi`。
- `q` 可省略，对归一后的 `title` 和 `cwd` 做大小写不敏感的子串匹配，最长 500 字符。
- `cwd` 可省略，最长 4096 字符，不允许 NUL；去掉末尾 `/`（根目录 `/` 保留），按大小写敏感的路径段前缀匹配本目录和子目录。例如 `/a/b/` 命中 `/a/b`、`/a/b/c`，不命中 `/a/bc`。与 `q`、`agent` 同时在服务端分页消费循环内筛选。
- `limit` 默认 50，范围 1–200。
- `cursor` 是服务端返回的不透明分页位置；翻页时必须原样带回，并继续使用相同的 `agent`、`q`、`cwd`。

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
  truncated: boolean;          // 发现/消费的 3 秒阶段预算或 20,000 个候选硬上限被触发
  skipped: number;             // 本页遇到的坏/空/不可读/缺关键元数据候选数
  discovered: number;          // 本次发现的候选文件总数
  durationMs: number;
}
```

结果先按原生事实文件 mtime 倒序排列，再分页。目录发现和候选消费分别使用 3 秒预算，避免发现耗尽预算后无法处理已发现候选。服务端只枚举候选和读取最多 512 KiB 的文件头；默认页拿满后停止解析。解析结果保存在进程内存中，以“路径 + mtime + size”（Kimi 另含 wire 指纹）失效，不需要预热，也不会在三家目录或 `~/.workbench/` 生成缓存文件。坏 JSON 行、正在追加产生的尾部半行、空文件和权限错误不会使整个接口 500；不能形成含 `nativeSessionId + cwd` 的会话才计入 `skipped`。测试可用 `WORKBENCH_CLAUDE_HISTORY_DIR / WORKBENCH_CODEX_HISTORY_DIR / WORKBENCH_KIMI_HISTORY_DIR` 指向隔离夹具，生产默认不需要设置。

标题提取不会把注入包装当成人类输入：Claude 跳过 `isMeta`、sidechain、`local-command-caveat / local-command-stdout / system-reminder / task-notification / ide_selection / ide_opened_file`；斜杠命令包装只提取真正的 `command-args`，无参数时退化为 `command-name`。Codex 跳过 role 非 user 的记录，以及 `recommended_plugins / AGENTS.md instructions / environment_context / skills / permissions / apps / plugins / multi_agent_mode` 等注入块。Kimi 优先使用有效的原生 `state.title`，否则从第一条非 `system-reminder` 的 `turn.prompt` 取标题。

`source` 表示原生会话的可识别创建来源，而不是当前读取者。Claude 老会话首个 `entrypoint:"sdk-cli"` 仍为 `workbench`；新 worker 默认不设 `CLAUDE_CODE_ENTRYPOINT`，可在本机 `prefs.json` 设置 `claudeCodeEntrypoint: "claude-vscode"`；两种入口身份的新建会话都靠 `~/.workbench/sessions.json` 中未带 `resumedFrom` 的注册表记录判为 `workbench`，其他已知 CLI/VSCode 入口会话为 `interactive`，缺少入口身份时为 `unknown`。Codex 的 `originator` 以 `workbench` 开头为 `workbench`，其他已知 originator 为 `interactive`；Kimi 的多代落盘格式没有稳定的客户端来源字段，也用未带 `resumedFrom` 的注册表记录回退为 `workbench`，其余为 `unknown`。导入的 VSCode/Kimi 原生会话保留原来源。


完整历史使用 `GET /api/history/:agent/:nativeSessionId/messages?limit=<默认50>&cursor=<可选>`。`limit` 范围 1–200；不传 cursor 时读取最新一页，带回服务端给出的不透明 `nextCursor` 可继续向更早消息翻页。每页内部仍按时间正序返回，前端可直接 prepend 到现有消息列表。单次最多倒读 4 MiB 原生 NDJSON，不会为了取一页全文解析巨大 transcript，也不会在三家原生目录或 AIReins 目录写索引、缓存或修复文件。

成功响应的 `data` 为：

```ts
interface HistoryMessagesPage {
  session: HistorySession;
  messages: Array<
    | { role: "user" | "assistant" | "thought"; text: string; timestamp: string | null }
    | { role: "tool"; timestamp: string | null; tool: {
        id: string; name: string; input: unknown; result?: string; rawResult?: unknown;
        status: "ok" | "error" | "unknown";
      } }
  >;
  nextCursor?: string;
  hasMore: boolean;
  truncated: boolean;        // 当前页受条数或 4 MiB 窗口限制
  durationMs: number;
}
```

Claude 跳过 meta/sidechain，按 assistant 内容块顺序输出文字与 `tool_use`，按 `tool_use_id` 回填 `tool_result` 和有界 `toolUseResult`；Task/Agent 工具本身保留。Codex 保留 event_msg 文字优先、response_item.message 回退，另按 `call_id` 配对 function/custom tool call 与 output：exec_command/shell_command/shell 映射 commandExecution，标准 apply_patch 映射 fileChange，其余保留原名和原始输入。Kimi 的 main wire 使用 `tool.call/tool.result` 的 toolCallId 配对，保留原名、args 与 output。

思考以 `role:"thought"` 进入数组（2026-10-01）：Claude 取 `thinking` 块（Opus 等多数块只存签名、正文为空，空的跳过），Codex 取 `response_item.reasoning` 的 `summary[].text`（段间 `\n\n`；实测近期文件 summary 全空、只有加密正文，所以 Codex 历史通常没有思考），Kimi 取 `content.part` 的 `think`。相邻思考与相邻助手文字一样按同一规则合并；`external_messages_added` 的 messages 同样可能含 thought。

工具 input、result、rawResult 各自序列化后最多约 4000 字符，超出带 `[truncated]`；超长结构化对象回落成有截断标记的文本。Codex `exec` 的字符串 input 例外：完整保留 JS，仍受单页 4 MiB 原生读取窗口约束，字段形状不变；前端据此提取 `tools.exec_command` 和直接字符串参数的 `tools.apply_patch` 等调用，否则截断会破坏字符串/括号闭合，使长命令和 patch 无法摘要。多调用展开按源码顺序列出，保留 patch、原始 JS 与结果；未知工具保留名字，不支持的语法回落原显示。result / rawResult 的约 4000 字符上限继续生效。缺结果或无法确认状态时为 unknown，前端不伪造成功或失败。limit 计入工具；不透明 cursor 支持同一 JSONL 行内的多个块，不漏块。只在当前读取窗口配对，较早页的调用若结果落在更新页，返回 unknown，不扩大窗口。历史页预览和导入历史共用 `/messages`，默认最新 50 条，向前翻页可一直到开头；旧文件头 preview 路由已移除。ID 校验和事实源候选查找保持不变。

历史列表本身严格只读；用户选择后，就地续接仍复用现有 `POST /api/sessions`，直接把列表项的 `nativeSessionId` 传为 `resumeSessionId`：

```json
{
  "agent": "claude",
  "cwd": "/home/user/projects/workbench",
  "resumeSessionId": "00000000-0000-4000-8000-000000000040"
}
```

这里没有 fork 语义：Claude 用 `--resume`，Codex 用 `thread/resume`，Kimi 用 `session/resume`。续接后，AIReins 中的新回合会由原生 CLI 追写进用户选择的真实会话；Claude worker 默认使用 CLI 自身入口身份；本机可选 `claudeCodeEntrypoint: "claude-vscode"`，保持 VSCode 入口身份。来源仍按创建注册表判定，导入不改原来源。仅做 initialize 的 Claude 模型标签探针不发送用户消息、不产生会话，仍清除该环境变量。

空闲会话发消息前，服务端只读原生记录的末尾最多 4 MiB，比较最后一条归一化用户/助手/工具调用消息的身份：Claude 用 `uuid`，Codex/Kimi 用追加文件的字节偏移与该行 SHA-256；标题、摘要、token 等元数据变化不触发。指纹之后若只有助手或工具消息，视为本端上一轮在 `turn_completed` 之后才刷盘：静默推进指纹，不重启、不发事件。只有出现新的用户消息才判为外部续聊；第一条新用户消息之前的助手和工具消息不进入事件。此时先停旧 worker、起新进程并以同一原生 ID 续接，再发送消息。Codex app-server 的 `thread/resume` 和 Kimi ACP 的 `session/resume` 都在新进程里执行，避免复用旧进程内存中的线程/会话。取不到原生 ID、文件或对话指纹时记录 warn 并照常发送；正在运行的回合不检测。重新续接失败会广播 `session_error`（`source:"external_resume"`），拒绝本轮发送，不回退到旧 worker。尾部窗口装不下全部外部消息时，事件只带读到的最新消息，并标 `truncated:true`。

`external_messages_added` 的 payload 为 `{nativeSessionId:string, messages:HistoryMessage[], truncated:boolean}`，HistoryMessage 与 `/messages` 相同；旧的纯文字事件仍兼容。payload 的 UTF-8 JSON 总上限为 512 KiB：先从最早的工具正文开始省略并标 `[truncated]`，仍超限则省略最早消息，单条超长文字最后截短，均设置 `truncated:true`。事件自包含，仍原样写入 AIReins transcript 并广播，顺序在本轮 `user_message` 之前，原生文件以后改写不影响回放。工具结果不是用户消息；Claude 指纹仍取最后一条归一化消息所在行的 uuid，纯结果追加不改变调用行指纹。原生目录始终只读。

### 释放（release）worker

`POST /api/sessions/:id/release` 把会话的 worker 停掉但保留会话：状态保持 `idle`，记录新增持久化字段 `released:true`，`processId` 置空，广播 `worker_released`（payload `{reason:"manual"|"idle"|"shutdown", resumeCommand, idleMinutes?}`，写进统一 transcript）。成功响应的 `data` 为 `{session, resumeCommand, vscodeUri: string | null}`。Claude 链接为 `vscode://anthropic.claude-code/open?session=<编码后的 nativeSessionId>`；Codex/Kimi 链接为 `vscode://vscode-remote/wsl+<WSL_DISTRO_NAME><cwd>`，发行版名及路径各段分别 URL 编码（`=` → `%3D`、空格 → `%20`），WSL 无 `WSL_DISTRO_NAME` 时为 null；原生 Linux/macOS 为 `vscode://file<encoded-cwd>`。链接由浏览器在释放成功后导航，服务端不启动任何 Windows 程序。释放前提：会话 `idle`、没有进行中的回合或待处理闸门、不在重启/检查中、已有 `nativeSessionId`；不满足时手动释放返回 400 可读错误，自动释放直接跳过。worker 先从内存表删除再停止，因此 `exited` 回调不会把会话标成 `dead`；Claude 会话同时把 `remoteControl` 置为 `disconnected` 并广播 `remote_control_updated`。

`resumeCommand` 是带 cwd 的原生续接命令，cwd 做 shell 单引号转义：Claude `cd '<cwd>' && claude --resume <id>`，Codex `cd '<cwd>' && codex resume <id>`，Kimi `cd '<cwd>' && kimi -S <id>`。

已释放会话再发消息时走与「别处续聊」完全相同的续接路径（`refreshBeforeSend`）：比对原生指纹、起新进程以同一原生 ID 续接、有外部新增时先广播 `external_messages_added`，成功后清除 `released`；区别只是没有旧 worker 可停。`set_config`、`set_remote_control` 等需要 worker 的 WS 操作经 `ensureWorker` 先按同一路径拉起再执行；`interrupt` / `permission_resolved` 对已释放会话直接报「worker 已释放」。续接失败广播 `session_error`（`source:"external_resume"`），保持 `released` 与 `idle`，不标 `dead`，下次发送可重试。 同一会话的原生检查/恢复共用一个在途 Promise；并发发送与需要 worker 的菜单操作不会重复创建续接进程。失败清除在途任务，后续调用可重试；菜单操作会等待恢复完成后再取 worker。

退出释放：server 收到 SIGTERM/SIGINT（`aireins stop`/`aireins restart`、托盘退出）时，先停掉全部 worker（停服期间不再起新 worker），再把停止成功、有 `nativeSessionId`、没有待处理闸门、且原生存档已落盘（Claude 须发过消息或是导入续接）的会话按释放处理（`reason:"shutdown"`，不检查 idle，进行中的回合随进程中断），其余标 `dead`。正常释放记录仍按 `released:true` + `nativeSessionId` 恢复为 `idle`+`released`，下次发送原地续接。最近已同步的原生指纹随注册表以内部字段 `releasedMark` 保存，释放及异常退出恢复共用 `nativeMarks`、`promptedSessions` 与续接路径；连续重启且未发送也保留指纹，停服期间的外部续聊在首次发送时照常补成 `external_messages_added`。

异常退出恢复（2026-10-03）：没有标记 `released`、有 `nativeSessionId` 的记录，须同时满足 AIReins transcript 没有坏行或不完整尾行、当前 worker 生命周期没有 `process_exited` 或终止错误、没有未决审批、原生存档可续接、且旧 worker 已确认消失，才恢复为 `idle`+`released`。原状态为 `idle/running/starting` 时按 PID/身份检查；旧代码已写成 `dead`、PID 已清空时，允许用 Linux/WSL `/proc/stat` 的 `btime` 或 macOS `sysctl kern.boottime` 证明重启：启动时间必须严格晚于注册表 `lastActivityAt` 及全部 transcript 事件时间的最大值。boot 时间、活动时间缺失或不可信、空 transcript、同次启动均不恢复；不按文件 mtime 或服务器重启时间推断关机。运行中的回合视为已中断，不重发原消息。

生命周期终止证据按事件顺序判定：`session_created` 或 `config_updated.workerRestarted:true` 开始新 worker 生命周期；普通配置、回合完成及 `worker_released` 不清除之前的退出证据。`process_exited` 及非明确 `severity:"warning", nonBlocking:true` 的 `session_error` 保守阻止恢复。CLI 自己崩溃退出依然 `dead`；即使随后机器重启也不复活。旧审批虽已失效，仍和 shutdown 一样保持 `dead`。原状态 `error` 不授予新增恢复资格，transcript 错误仍优先显示 `error`。

存档定位复用 `NativeConversationReader`：Claude 须实际落盘且含用户/助手记录（首条消息前只有 session_id 不算）；Codex 须有 ID 匹配的 rollout/session_meta；Kimi 须有可读 wire 和 ID、cwd 相符的 state。原生只作有界头部检查，不扫描整份大存档。

worker 的 `processId` 原本就持久化；新启动的 POSIX worker 使用独立进程组，并保存内部 `processIdentity:{bootId,startTime,processGroupId?}`，用于识别 PID 复用及 launcher 退出后尚存的子进程。不同 boot 可证明旧进程树已消失；同 boot 必须确认 PID 及已记录的独立组均不存在，同 boot PID 已复用时还须确认旧组消失。旧记录只有 PID 时须 `process.kill(pid,0)` 明确返回 ESRCH；未取得上述系统重启证据时，活着的 PID、权限错误、缺失 PID 或损坏身份字段均不授予恢复资格。只检查，不接管或终止旧进程。载入后 `processId` 清空，Claude RC 状态为 `disconnected`，发送续接时按既有配置重新启动。

空闲自动释放：服务端每分钟扫一次，对 `idle`、未释放、`now - lastActivityAt ≥ idleReleaseMinutes` 且满足上述前提的会话执行释放；**开着 Remote Control（connected/connecting/reconnecting）的 Claude 会话跳过**（开 RC 就是要手机能随时找到它，释放会断开）。阈值存 `~/.workbench/prefs.json`（`{"idleReleaseMinutes":30}`，缺省 30，0 = 关闭，文件缺失或无效按默认值），经 `GET/PUT /api/prefs` 读写，PUT 立即生效无需重启。

本机专用行为统一放在 `${workbenchHome}/prefs.json`（默认 `~/.workbench/prefs.json`，由 `WORKBENCH_HOME` 覆盖），不写入仓库，也无需额外启动环境变量；托盘和 `aireins start` 读取同一份配置。UI 的 PUT 仅更新空闲释放阈值并保留以下字段；这些字段不在 UI 暴露。修改后重启后端生效。

- `shutdownCommand`：可执行文件的绝对路径，公开默认不设。无参数应排定约 60 秒后关机，`abort` 应取消；AIReins 不经 shell 执行。未配置、文件缺失或不可执行时，`GET /api/meta` 的 `capabilities.powerOff` 为 `false`，设置隐藏关机入口，关机 API 返回 503。
- `claudeCodeEntrypoint`：可选值 `"claude-vscode"`；公开默认不设，交给 Claude CLI 自身默认。Worker 统一带 `WORKBENCH_WORKER=1`，不传旧 `CC_FORK_GUARD`；会按发送前刷新原生记录的机制续接。
- `directoryBrowserHome`：目录浏览器「主目录」的绝对路径，公开默认 `$HOME`。

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

`resumedFrom.historyCursor` 为可选字段：带 `resumeSessionId` 创建时，服务端在 `manager.create` 之前用 `HistoryIndex.endCursor` 记下截止 cursor（偏移量 = 当时原生消息文件的大小，Kimi 取 `agents/main/wire.jsonl`；编码与 `/messages` 的 `nextCursor` 完全一致），写入 `resumedFrom` 并随注册表持久化。会话页的「导入前的历史对话」首页带上它，拿到的就是导入时刻之前的最新一页，导入之后的轮次不再混入该区块。计算失败（会话或文件不存在等）只记 warn 日志、照常创建且不带该字段；它是服务端内部字段，客户端请求体里的 `historyCursor` 一律被覆盖。旧会话没有该字段，历史区仍从最新一页开始。cursor 失效（原生文件被截断/改写，`/messages` 返回 400「消息 cursor 已失效」等）时前端退回不带 cursor 的最新一页，不整块报错。

## `pages/` 扩展页面

`GET /api/links` 返回 `data: {links: [{name, url, icon?, group?}]}`，与 `/api/pages` 共用请求前置的访问控制。每次请求现读并合并两处：仓库 `pages/links.json`（随 git 同步的共享菜单）在前，用户目录 `${workbenchHome}/pages/links.json`（默认 `~/.workbench/pages/links.json`，本机追加）在后，同一 `url` 以本机条目原位覆盖；改文件后刷新页面或重新打开「直达」即可生效；新增接口本身需重启 AIReins。任一处文件缺失按该处为空；坏 JSON、非法顶层按该处为空并 warn（另一处照常返回），非法条目逐条跳过并 warn，不导致接口 500。`name`、`url` 为必填非空字符串，`icon`、`group` 为可选非空字符串，`icon` 可以是 emoji、`agent:claude` / `agent:codex` / `agent:kimi`（复用界面内置的三家品牌图标），或以 `<svg` 开头的内联 SVG（前端按 HTML 渲染，品牌标识可用 `<image href="data:image/png;base64,…">` 内嵌位图）；支持 http/https 和 `vscode://`、`obsidian://` 等显式 URL scheme，拒绝 `javascript:`、`data:`、`vbscript:`、`file:`、`blob:`、`filesystem:`、`about:` 和含控制字符或未编码空格的 URL。根目录文件不参与 `scanPages` 的子目录扫描。

```json
{"links":[{"name":"示例网站","url":"https://example.com","icon":"🌐","group":"参考"}]}
```

用户目录 `${workbenchHome}/pages`（默认 `~/.workbench/pages`）的每个直接子目录代表一个页面，子目录内必须有 `manifest.json`。server 仅在启动时扫描一次；增删或修改 manifest 后需重启，不做热插拔、沙箱或版本管理。单个 manifest 缺失、JSON 语法错误、字段无效或 `id` 重复时，该页面会被跳过并记录一条 warn 日志，不影响 server 启动。

`bash install.sh --with-ai-usage` 在确认本机 ai-usage 的 `/api/summary` 响应形状后，生成缺失的 `${WORKBENCH_HOME:-$HOME/.workbench}/pages/ai-usage/manifest.json`（回环地址、`proxy: true`、`maxWidth: "33%"`），已有文件一律保留；安装器在冒烟启动前完成接入，AIReins 已运行时只提示择时 `aireins restart`，重启会中断所有会话。

例如在 `~/.workbench/pages/example/manifest.json` 放入下列配置；仓库不附带个人页面。`WORKBENCH_HOME` 可覆盖整个用户数据目录，代码调用仍可显式传入扫描根目录。

```json
{"id":"example","name":"示例页面","icon":"🌐","type":"iframe","url":"https://example.com"}
```

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

`GET /api/pages` 的 `data` 为 `{pages: IframePageManifest[]}`，字段就是上述已校验的 manifest 字段。例如页面 `ai-usage` 默认指向 `http://127.0.0.1:8788`，也可用其配置端口。它可通过用户级 systemd 常驻运行；服务未启动时整页不可达，所需网络连接不可用时页面本身仍可能可达，但部分数据卡片会报错。因此健康接口只判断目标服务是否响应，不能判断数据是否完整。

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

`proxy: true` 的页面经 AIReins 自己的源访问，手机经 Tailscale 也能用（直连 `127.0.0.1` 在手机上指的是手机自己）。

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

事件最小集为 `session_created / config_update_started / external_messages_added / user_message / agent_text_delta / thought_delta / tool_call_started / tool_call_updated / tool_call_completed / permission_request / permission_resolved / commands_updated / config_updated / usage_updated / turn_completed / session_error / process_exited / worker_released`；另有容错用 `raw_event`。每个 session 的持久事件独立计数，`seq` 单调递增。临时事件不推进该游标。

Kimi 的 `tool_call_started / tool_call_updated / tool_call_completed` 在 ACP 更新含 `kind`（字符串）或 `locations`（`{path, line?}` 数组）时，分别原样透传为 payload 的同名字段；缺失时不添加。Kimi 命令工具的完成事件若 `content` 含 `{type:"terminal", terminalId}` 且终端仍在运行或已释放，会额外包含 `terminalOutput: {terminalId, output, truncated, exitCode, signal}`。事件另行收集真正的输出末尾，`output` 最多保留末尾 64 KiB（按 UTF-8 字节并在字符边界截取）；发生过截断，包括 ACP 终端原收集上限造成的截断，`truncated` 为 `true`。ACP `terminal/output` 仍按其 `outputByteLimit` 返回输出开头，语义不变。尚未退出时事件返回已收集部分，`exitCode` 为 `null`；无退出信号时 `signal` 为 `null`。多个 terminal content 只取第一个；找不到终端则不添加 `terminalOutput`。已释放终端最多保留最近 64 个，每条仅存事件尾部与退出状态，随会话结束清空。以上新增字段只有 Kimi driver 提供，Claude、Codex 的工具事件契约不变。

上行至少支持：

```json
{"type":"user_message","sessionId":"...","clientRequestId":"msg-01","text":"只回复 OK"}
{"type":"user_message","sessionId":"...","command":{"name":"compact","arguments":"可选参数"}}
{"type":"user_message","sessionId":"...","text":"概括引用内容","mentions":[{"type":"file","path":"server/README.md"}]}
{"type":"user_message","sessionId":"...","text":"图片里写的是什么？","mentions":[{"type":"image","path":"/home/u/.workbench/uploads/<sessionId>/20260930-130337-photo.png","mimeType":"image/png"}]}
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

Claude 的 model/effort 切换优先热切换：模型走 `set_model`，effort 走 `apply_flag_settings`，控制回应 success 后广播 `config_updated`，含 `mutableVia:"control"`、`workerRestarted:false`、`effectiveFrom:"immediate"` 与四个 `effective*` 字段。`model:null` 使用 CLI 的会话默认模型语义；`effort:null` 尝试清除 flag 覆盖，若 CLI 拒绝则回落到不带 `--effort` 的重启路径。显式覆盖的有效值来源为 `session`；清除覆盖时按 cwd settings 恢复展示，后续 `system/init` 的实际值仍可用 `source:"init"` 校准。释放后变更不启动进程，事件为 `next_turn`，下一次拉起使用新配置。

控制请求报错或超时才沿用重启路径：先广播 `config_update_started`（`mutableVia:"restart"`、旧/新配置及 native ID），再停止 worker；首条消息前直接重建，发过消息或导入历史时用 `--resume` 同一原生 ID。成功广播 `config_updated`（`workerRestarted:true`）；失败恢复旧配置/有效值/来源并发 `session_error`。回合进行中、starting 或有待审批闸门时拒绝模型/effort 切换；切换期间发送、释放、移除等操作保持互斥。热切换无需原生 ID，重启回落的续接仍需原生 ID。审批仍遵循 Claude 原生权限模式，重启仍带 `--permission-mode` 和 `--permission-prompt-tool stdio`。Codex/Kimi 的切换路径不变。

## 文件检索

`GET /api/sessions/:id/files?q=<关键词>&limit=<数量>` 返回按相对路径字典序排列的普通文件：

```json
{"files":["server/README.md","server/index.ts","server/types.ts"]}
```

`q` 默认为空字符串，匹配相对路径中的大小写不敏感子串；`limit` 默认 50，范围为 1–200。枚举本身限时 3 秒、输出缓冲上限 8 MiB，达到结果上限或总时限即停止文件校验，避免大仓库无限遍历。Git 工作树使用 `git ls-files --cached --others --exclude-standard`，非 Git cwd 回退到 `rg --files`；两条路径都尊重 `.gitignore`，并额外硬排除任意层级的 `.git` 与 `node_modules`。

安全边界以会话 `cwd` 的真实路径为准：任何 `..` 路径段、NUL、cwd 外的 POSIX 绝对路径以及 Windows/UNC 绝对路径都会以 HTTP 400 拒绝；cwd 内绝对路径会先归一为相对查询。候选文件先做词法 containment，再 `realpath` 后做第二次 containment；普通文件和指向 cwd 内普通文件的符号链接可返回，断链、目录、特殊文件及目标逃出 cwd 的符号链接全部跳过。

## 斜杠命令与 `@` 引用

`GET /api/sessions/:id/files?q=&limit=60` 为输入框提供 cwd 内相对文件路径；空查询列出文件，输入名称按路径子串匹配（不区分大小写）。Git 目录使用 `git ls-files` 并遵守 Git 忽略规则；其他目录使用 `rg --files --hidden`。服务 PATH 没有 `rg` 时，从 PATH 中 Codex 启动器的真实安装目录寻找 standalone 自带的 `../codex-path/rg`，沿软链接跟随版本升级。两者均不可用时明确报错；不修改系统 PATH、不安装工具。两种枚举都排除 `.git`、`node_modules` 和逃出 cwd 的符号链接。

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

`name` 不含开头的 `/`；发送时既可用上面的结构化 `command`，也仍可把原生命令作为普通 `text` 交给支持命令的 driver。结构化命令和 `text` 不能同时出现，Claude/Kimi 可附 `mentions`；Codex 命令不能附文本或附件。Claude/Kimi 命令复用普通 prompt 通道；Codex 命令走下节列出的专用 RPC；由命令触发的工具调用仍遵循所选会话权限模式；Kimi 的 `session/request_permission` 原样转发，`terminal/create / fs/write_text_file` 不追加审批。

命令表按会话保存于内存，并通过 `commands_updated` 实时广播完整新表：

- Claude 启动时发送 stream-json `control_request {subtype:"initialize"}`，把 `response.commands[]` 的 `name / description / argumentHint` 归一；收到 `system/commands_changed` 后重新查询。首次控制查询失败时，首轮 `system/init.slash_commands` 可提供只有名称的后备表。
- Kimi 每次收到 ACP `session/update` 的 `available_commands_update.availableCommands` 都覆盖当前表，不把初始更新当成一次性快照。
- Codex 0.159.3：由 AIReins 按已核实的 app-server 方法提供 8 项客户端命令（见下节），不冒充 TUI 命令枚举。

`mentions` 接受两类条目：`{"type":"file","path","name"?}` 和 `{"type":"image","path","mimeType","name"?}`。`path` 可为会话 `cwd` 的相对路径或绝对路径，必须是已存在的普通文件；单条消息最多 20 个。`image` 额外要求 `mimeType` 属于 `image/png|jpeg|gif/webp`（否则 400/`40024`）且文件 ≤ 10 MB（否则发送前报错）。三家翻译如下：

- Claude：`file` 读取 UTF-8 文件，发为 user content 中的 `document` block：`{type:"document",source:{type:"text",media_type:"text/plain",data},title}`；`image` 读取文件字节，发为 `{type:"image",source:{type:"base64",media_type,data}}`。
- Codex：`file` 在 `turn/start.input` 同时发送带 UTF-8 字节范围的 `text_elements` 文本项和 `{type:"mention",name,path}`；文本中的 `@` 名称使用相对会话 `cwd` 的真实路径，避免只给 basename 后让 agent 猜位置。`image` 发为 `{type:"localImage",path}`（0.159.2 schema 核对见 `spikes/PROTOCOL-NOTES.md` §9），不占 `text_elements`。
- Kimi：`file` 使用 ACP embedded resource：`{type:"resource",resource:{uri:"file://...",mimeType:"text/plain",text}}`；`image` 发为 `{type:"image",mimeType,data}`（base64）。

Claude 与 Kimi 需要把 `file` 内容嵌入 prompt：不超过 1 MiB 的 UTF-8 文本照上述嵌入；**不满足条件（PDF、docx、xlsx、大文件等二进制或超 1 MiB）不再报错**，改为在用户文本末尾追加一行 `[附件] <绝对路径>（二进制或超过 1 MiB，未嵌入，请用工具读取）`，由 agent 自行用工具读取。Codex 的 `file` 引用本来只传路径，行为不变。任何 driver 的 `mentions:false` 仍会明确拒绝引用，不会把引用静默降级为普通文本。

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
- Kimi Code CLI 2.1.1：ACP initialize 已声明 `clientCapabilities.elicitation.form`，`elicitation/create` 可原样覆盖多题与多选；回包为 `{action:"accept",content:{q0:"选项",q1:["选项A","选项B"]}}`，跳过/取消分别为 `decline`/`cancel`。`session/request_permission` 用于原生审批；`terminal/create`、`fs/write_text_file` 执行已获 CLI 放行的请求，不再追加 AIReins 审批（2026-10-03 调整）。

`decision` 可为 `allow / deny / always`，也可附 `updatedInput`。Claude 的 `request_id` 原样保留并回填，`permissionSuggestions` 透传；Codex 按 server request 的 JSON-RPC `id` 应答；Kimi 每次 `terminal/create` 和 `fs/write_text_file` 都会额外产生不可绕过的最终审批事件。

三家工具审批均遵循输入窗所选权限模式。Kimi 在新建、续接和切换时通过 `session/set_config_option` 实际设置 mode；新建未选择时明确设置 `auto`；无保存档位的旧会话续接仍设置 `default`，不继承机器的 yolo。AIReins 转发 CLI 发来的 `session/request_permission` 并回传允许/拒绝；已获 CLI 放行的 `terminal/create`、`fs/write_text_file` 直接执行，不重复审批。Codex 按 `approvalPolicy + approvalsReviewer + sandbox` 完整传递模式：`on-request` 为人工审批，`auto-review` 为自动审查，`full-access` 为无审批且移除工作区沙箱。原生 CLI 或托管环境的限制与交互提问仍保留。

## curl + Node 22 WebSocket 演示

先创建会话：

```bash
curl --silent --show-error --request POST http://127.0.0.1:8790/api/sessions \
  --header 'content-type: application/json' \
  --data '{"agent":"kimi","cwd":"/home/user/projects/workbench/server/test-sandbox","config":{"model":"kimi-code/k3","effort":"high","permissionMode":"default"}}'
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
- [x] **3. 重启不接管旧进程（2026-08-21 的旧行为）。** 记录三个 worker PID `105 / 225 / 224` 后终止 server；`ps -p 105,224,225` 无输出。当时重启后三个会话全为 `dead`、没有 `processId`；2026-10-03 起符合上述安全条件的异常退出记录改为 `idle`+`released`，仍不接管旧进程。
- [x] **4. transcript + snapshot/seq 恢复。** `verify-snapshot.mjs` 对三份全量 snapshot 与磁盘 NDJSON 逐事件比较通过；Claude 以 snapshot `seq=20` 建立 WS，收到的首条增量为 `seq=21`，该轮结束于 `seq=25`。
- [x] **5. curl 全流程与 Node WS（10-01 前的旧行为）。** `curl` 已实测 `/api/meta`、会话创建/列表/详情/snapshot/DELETE/错误信封；`ws-demo.mjs` 使用 Node 22 内置 `WebSocket` 完成发消息、两类审批回传和 turn 收尾。DELETE 当时实测停止 worker、移除注册表条目，并保留 AIReins transcript；代码没有调用任何原生 transcript 删除 API。
- [x] **6. TypeScript。** `npx tsc --noEmit` 退出码 0。
- [x] **7. 三家自定义 config 真正生效。** Claude `01J00000000000000000000044` 用 `haiku / low / manual` 启动，首轮 session 被 `system/init` 更新为实际模型 `claude-haiku-4-5-20251001`，回复 `CLAUDE_CONFIG_FINAL_OK`；Codex `01J00000000000000000000045` 的原生 rollout `turn_context` 为 `gpt-5.4-mini / low / on-request`，回复 `CODEX_CONFIG_FINAL_OK`；Kimi `01J00000000000000000000046` 的 `session/new` 后配置为 `kimi-code/k3-256k / low / yolo`，并标记 `riskyMode:true`。
- [x] **8. meta schema 来自预期事实源。** 隔离实例的 `GET /api/meta` 返回三家各 3 项；Codex 模型实时来自 `model/list`，有效默认值来自 `config/read(cwd)`；Kimi 的 source 为 `Kimi ACP session/new.configOptions`，模型列表包含本机 Kimi 当时实际报告的 4 项，而不是后端静态常量。
- [x] **9. 活修改与不可改拒绝。** Kimi 经 WS 一次改为 `kimi-code/k3 / high / plan`，收到 `config_updated` 后再收到 ack；Claude `acceptEdits → manual` 两次均即时成功，且 `manual` 已正确映射到控制协议的 `default`。尝试活改 Claude model 收到 `claude.model 只能在建会话时设置`。Codex 活改为 `gpt-5.4 / medium / never` 后，事件标记 `effectiveFrom:"next_turn"`，下一轮原生 `turn_context` 三项逐一吻合。
- [x] **10. 历史验证：yolo 不能绕过最终闸门（已于 2026-10-03 改为遵循原生模式）。** Kimi 会话在 `yolo` 下请求 Shell 写入 `config-yolo-gate-final-1787317200.txt`，AIReins 仍发出 `gate:"terminal/create", finalGate:true`；拒绝后 turn 正常收尾，`existsSync` 实测目标文件为 `false`。
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

派单列表与详情的 `parent.model`：Claude 父会话按 `parent.sessionId` 定位 `~/.claude/projects/*/<sessionId>.jsonl`，最多只读尾部 1 MiB，取最后一条完整可解析 assistant 消息的 `message.model`；缺失、不可读或尾部窗口没有模型时返回 null，其他 agent 同样为 null。命中与空结果缓存 30 秒，同会话并发复用，最多 256 项。前端工作台会话匹配成功时优先使用该会话的有效模型。

#### 派单详情与近 7 天历史（P1-14 第二版）

以下接口均沿用 `/api` 的访问控制，只读；不控制进程、不续接、不清理派单目录。

- `GET /api/dispatches/history?offset=0` → `{dispatches:Dispatch[],total:number,nextOffset:number|null}`。
  每页 20 条，按结束时间倒序（同时间以 runId 倒序）；覆盖结束时间在请求时刻前 7 天内的非 running 单。
  旧目录缺 `endedAt` 时，用 `startedAt + elapsedS` 推导；没有可确认结束时间的单不列入历史。
  扫描不受普通列表的 200 条上限影响；非负整数 offset 无效时返回 400 / `40000`。
- `GET /api/dispatches?parent=<会话ID>&agent=claude|codex|kimi` → `{dispatches:Dispatch[]}`。
  按执行端和工作台/原生会话 ID 精确匹配，返回该父会话直接或间接派出的 running 工单和原生子代理，不受普通列表条数上限限制；省略 agent 时兼容三家，非法 agent 返回 400。
  parent 仅接受 1–128 位字母、数字、下划线或连字符；无效返回 400 / `40000`。
- `GET /api/dispatches/<runId>/messages?cursor=<上次cursor>` →
  `{source:"native"|"stdout",agent?:"codex"|"kimi",messages:HistoryMessage[],replaceFrom:number,cursor:string|null,truncated:boolean}`。
  先经 `NativeConversationReader` 限定原生根目录、校验会话 ID 和真实文件路径，再复用
  `history.ts` 的 `parseHistoryMessages` / `mergeHistoryMessages`；读取末尾最多 4 MiB、最多 400 条消息，
  并沿用 `boundExternalMessages` 的 512 KiB 正文限制。前端复用 `HistoryTimeline`、`StreamItems` 和工具摘要。
  客户端用 `已有消息.slice(0,replaceFrom).concat(messages)` 更新，工具结果会替换原调用；没有变化返回空 messages。
  cursor 为消息快照 SHA-256，不是路径；服务端最多保留 32 个派单快照，缓存失效或未知 cursor 自动从 0 替换。
  拿不到会话、原生文件不可读或 Copilot 无现有解析器时返回 source=stdout，客户端改用既有 `/log` 尾读与字节增量接口。
  runId/目录校验与已有详情、日志一致，非法 ID、目录穿越、目录符号链接逃逸返回 404 / `40400`。
- `DispatchDetail` 追加 `acceptResult:string|null`、`resume:string|null`、`credits:number|null`。
  ACCEPT / RESUME 取 summary 行；resume 也兼容 run.json 的字符串字段；Copilot credits 优先取
  `usage.json.totalNanoAiu / 1e9`，没有时读 summary STATUS 行。所有派单附件仍使用固定文件名与禁止符号链接的读取。

前端详情路由 `#/dispatches/<runId>`，多单跳转 `#/dispatches?runs=<ID1>,<ID2>` 并高亮目标卡片。
流程图仍为 30 分钟窗口；近 7 天历史是独立只读视图。详情每 3 秒轮询，运行时每秒走时，
隐藏页面暂停；结束后再刷新一次以等待原生记录刷盘。历史每 15 秒刷新已加载页，不新增 WS 通道或依赖。


## Codex 命令与 skills（2026-10-01，CLI 0.159.3）

能力依据：本机 `codex app-server generate-json-schema --out <目录>`；官方 [app-server](https://learn.chatgpt.com/docs/app-server) 的 Skills 与 Compaction 章节。旧版探针与验收记录是历史结果，当前能力以下表及本节为准。

| AIReins 命令 | app-server 方法 | 行为 |
|---|---|---|
| `/status` | `thread/read {threadId,includeTurns:false}` | 线程元数据与当前 AIReins 会话配置；不读取全量对话 |
| `/model` | `model/list {limit:100,includeHidden:false,cursor?}` | 只读模型列表；切换沿用底栏模型菜单，在下次 turn/start 生效 |
| `/mcp` | `mcpServerStatus/list {threadId,limit:100,cursor?}` | 当前线程连接、认证、工具数量与发现错误；分页读全，无启停/登录入口 |
| `/skills` | `skills/list {cwds:[cwd],forceReload:true}` | 仅返回当前 cwd 的 enabled skills 和读取错误 |
| `/compact` | `thread/compact/start {threadId}` | 空闲时接受异步压缩；RPC ack 不代表完成，进度走现有 turn/item 事件 |
| `/review [要求]` | `review/start {threadId,delivery:"inline",target}` | 留空为 uncommittedChanges，有参数为 custom.instructions；结果在当前对话 |
| `/new` | 新 AIReins 会话 → `thread/start` | 同 cwd、当前会话配置，新建 native id，保留旧会话 |
| `/interrupt` | `turn/interrupt {threadId,turnId}` | 只打断正在运行的执行，以 turn/completed 为准 |

`GET /api/sessions/:id/commands` 和 `commands_updated` 返回上述客户端命令表；Codex `commands:true`。前端 `/` 面板和底栏 `/` 菜单使用同一表，不显示 Claude 专属能力。前端调用 `POST /api/sessions/:id/codex/command {name,arguments?}` 并在原有查看弹窗样式中显示结果/错误；无任意 RPC 透传。未知名称、非 review 参数、过长参数或忙碌/待审批时执行 compact/review/new 均拒绝；400/40067，缺失 session 为 404/40401。WS `user_message.command` 同样走该白名单，结果为 raw_event（前端交互优先 HTTP）。`GET /info/status|model|mcp|skills` 对 Codex 开放；其他查看项拒绝。

Codex 输入框 `$` 在光标 token 处打开名称+描述面板，支持过滤、上下键、Enter/Tab 插入、Esc 关闭；IME 组合期间不触发。选中插入 `$name `，文本保留，后端按真实 `skills/list` 的启用清单附加 `{type:"skill",name,path}` 到 `turn/start.input`；不接受客户端提供 skill 文件路径、不读取/嵌入 skill 内容、不写 skills 配置。重复提及去重，同名不同文件报错而不猜路径；禁用 skill 不主动附加。列表来源覆盖用户、仓库与系统的实际发现结果；读取错误在面板提示并可在 `/skills` 查看。

不接 `/init`、undo/revert、`/diff`、`/prompts:<name>`、thread/shellCommand 或 MCP 配置改写：写文件/不可逆、无直接对应方法、TUI 本地能力，或超出本单可逆能力范围。详情与真实报文见 `spikes/PROTOCOL-NOTES.md` §12（工单报告为本地归档，未随仓库公开）。生效需要后端重启（本单不执行 aireins restart）；前端重新 build 后由静态文件服务读取。


### 性能接口契约（P0 / P1）

- `GET /api/sessions` 的每个列表项增加 `title: string` 与 `pendingGateCount: number`。标题优先取手动标题、原生标题，再取首条 `user_message.payload.text`；空白压成单空格，保留完整文本，界面按可用宽度截短；首条为空或尚无消息时为“新会话”。前后端共用 `shared/session-title.ts`。审批数来自内存未决闸门集合；dead 会话固定为 0。新的 `user_message` 事件还带顶层 `title`，使用相同优先级，用于未加载会话的实时标题（包括首条为空的情况）。
- 前端启动只取当前打开会话的 snapshot；未加载会话的标题和跨会话审批徽标以列表字段及 WS 实时事件维护，重连重新取列表校准。已加载会话在全局 `/ws` 上发送 `{type:"replay", sessionId, afterSeq}`，服务端补发 ring 内 `seq > afterSeq` 的持久事件，再发送 `{type:"replay_complete", sessionId, currentSeq}`；超出 ring 则发送 `resync_required`，客户端取 snapshot。旧 `/ws?sessionId=...&afterSeq=...` 连接补发仍可使用。
- 首连与重连对齐期间的实时帧先缓存，补发完成后排序去重。snapshot 在途期间也缓存事件，落地后只追加大于 snapshot seq 的持久事件；普通 seq 缺口复用在途请求。仅显式强制刷新、`resync_required` 或 WS 重连可作废在途 snapshot。
- Claude 只含 `toolCallId`、`partialInput` 的 `tool_call_updated` 标为顶层 `ephemeral:true`，`seq` 取当前持久游标，不写 transcript、不进 ring；仅 WS 实时发送，同一调用常规最多每 100ms 一次（保留最新值）。工具完成、最终 `inputComplete` 参数、审批、回合结束或错误前强制推出待发更新，该边界推出不受 100ms 限制。前端只更新实时卡片参数，跳过缺口检测且不推进游标。最终参数事件仍持久化；临时状态不支持回放或崩溃恢复。Codex/Kimi 更新保持原契约；旧 Claude transcript 在本轮启动恢复前按下面规则清理。
- `commands_updated` 对规范化命令表按内容去重；服务启动以 transcript 最后一条命令表为比较基线，实际内容变化仍持久化并广播。
- `npm run build` 为 `frontend/dist/assets/` 的 JS/CSS 生成旁路 `.gz`。静态请求接受 gzip（且 q 非 0）并有对应文件时返回 gzip，带 `Content-Encoding: gzip` 和 `Vary: accept-encoding`；否则返回原文件，现有缓存策略不变。
- 流式事件只标记会话登记表脏，最多每秒集中保存一次；创建、移除、释放、配置、状态变化及 shutdown 立即保存并刷出未写内容。transcript 仍逐条保存持久事件，恢复时以其末尾 seq 为准；未变化的 Claude 原生 session ID 元数据不触发重复保存。


### 性能第二轮接口与恢复契约（2026-10-01）

- 启动恢复前，仅清理登记为 Claude 的 `.ndjson` 副本：结构为 `type:"tool_call_updated"`、payload 自有 `partialInput` 且 `inputComplete !== true` 的遗留行。Codex/Kimi 整份保留，末尾有效行始终保留，不重编 seq。分块读取；只有有可删行的文件才写临时文件，保留权限并 fsync 后 rename。每次记录 files / rewrittenFiles / removedLines / removedBytes 汇总，第二次无变化不重写。
- `getEventsAfter` 的待补发区间必须从 `afterSeq+1` 连续到当前 seq，否则 `requiresSnapshot:true` 且 `events:[]`；WS 发送 `resync_required`。snapshot 采用服务端 seq，允许事件有空号，未决审批照原事件重建。前端缺口处理不变。
- 派单列表、详情、parent 与历史共享按 root 缓存的扫描（完成后 2 秒 TTL、并发复用同一 Promise）；详情附件仍按需读取，元数据最长约 2 秒延迟。历史多页并发刷新共用扫描。会话派单链接在 backgroundCount>0 或有链接时 3 秒刷新，否则 30 秒；重新可见立即查询。隐藏页停止列表/详情秒级时钟与链接定时器。
- 大 JSON 响应与静态资源共享 gzip 接受判定，显式 `q=0` 不压缩；动态响应保留大小阈值、level 1、响应头及信封。gzip 使用异步 zlib，整个进程压缩并发为 1，失败不阻塞后续队列。transcript 读取与 JSON 处理仍同步。
- 历史消息引用和派生条目按数组引用缓存，历史组件与 Markdown memo；新增历史、工具结果替换采用新数组，Focus view 更新过滤结果。文字、思考、tool_call_updated 与 raw_event 按帧合并通知，事件仍逐条应用且保留 seq；完成、审批、错误立即通知。


### Codex 派单子 agent（2026-10-01）

- 列表、parent 列表、历史和详情共用第二轮性能改的 2 秒扫描缓存。Codex 派单追加 `subagents`（无子 agent 为 `[]`），其他执行端不追加。`Dispatch.session` 对应父 rollout 的 `session_meta.payload.id`；子 rollout 的 `payload.id` 是 `threadId`，不能用可能继承父 ID 的 `payload.session_id`。
- 从 `payload.parent_thread_id` 或 `source.subagent.thread_spawn.parent_thread_id` 建关系，昵称/角色也支持两种位置。按父线程递归；`depth` 是相对本派单的深度，`parentThreadId` 保留真实直接父线程。循环、无关线程不挂入树。
- 原生目录只读。默认 `~/.codex/sessions`，夹具复用 `WORKBENCH_CODEX_HISTORY_DIR`。仅枚举派单 `startedAt` 的本地/UTC 日期前后一天目录；目录名时区与元数据时区跨午夜可能不同，不递归扫描全历史。跨多日之后才创建的子线程超出本契约扫描窗口。
- 每文件只解析首行 `session_meta`（上限 64 KiB）及最后 64 KiB，跳过窗口首残行、尾部未换行记录、坏行和非普通/软链文件。文件解析结果（含空结果）按路径 + mtime + size 缓存，最多 4096 项；缓存命中仍重新判断新鲜度，无磁盘缓存写入。
- 真实 0.159.2 样本 `rollout-2026-10-01T01-30-52-00000000-0000-4000-8000-000000000061.jsonl`：Carver 的父线程是 `00000000-0000-4000-8000-000000000062`，事件为 `task_started → item_completed/token_count → task_complete`。`item_completed` 只是条目完成，不能判回合结束。
- 顺序处理尾部事件：`task_complete` 判 `finished`；兼容 `turn_aborted`（已停）和 assistant `final_answer`/`final`。更晚的 `task_started`/用户消息/推理/工具调用恢复活跃。只有活跃证据且 mtime 在 5 分钟内才判 `running`；无生命周期证据或活跃文件陈旧判 `unknown`，不能由 mtime 推断完成。长工具无写入可能暂时为未知；回合完成不表示线程永久关闭。
- `startedAt` 取元数据时间；`lastActivityAt` 取最后完整记录时间，缺失时用 mtime。`activity` 取最新助手动态或工具名，压缩空白并截 160 字符，前端只在运行态显示一行。子卡沿用 Codex 色与 SVG `.flow`，每层间距 84px（宽面板 130px），每行最多四个，超过后换行，子卡上限 150px、窄面板按剩余宽度收缩。没有子 agent 时维持原来两层。
- 夹具回归：`server/dispatch-subagents.test.ts`；前端有/无子 agent、递归/状态/换行契约：`frontend/scripts/dispatch-flow.test.mjs`。浏览器的 440px 面板和 390px 手机截图由主会话验证。

### 运行中插话与新建/移除时延（2026-10-01）
插话的实测证据见 `spikes/PROTOCOL-NOTES.md`；原始抓包与工单报告为本地归档，未随仓库公开。

**插话**
- 会话运行中发送普通文本或附件，即为插话：`user_message.payload.steer=true`。空闲时发送仍走原通道，不带 `steer` 字段。
- 三家的插话方式：
  - **Claude**：沿用 stream-json 的默认 priority，CLI 会在当前回合的下一个工具间隙注入消息。
  - **Codex**：用 `turn/steer{threadId,expectedTurnId,input}`。不得附带新回合配置，也不得回退到 `turn/start`。
  - **Kimi**：不支持在当前回合内插话（运行中再发 `session/prompt` 会返回 `-32600 turn.agent_busy`）。插话消息进入 worker 的先进先出队列，事件带 `queued=true`，等原 `session/prompt` 响应后再按顺序发出；队列期间会话保持 running。
- Kimi 队列只存在内存里，重启后不恢复。停止、进程退出或 RPC 失败时，剩余消息全部取消，并产生 `source=steer_queue` 的 `session_error`。
- 有待审批闸门时，普通发送和插话一律拒绝：不调用 CLI，也不写 `user_message`。
- CLI 拒绝插话，或当前回合已经结束时，错误返回给调用方，原回合状态不变，也不自动开新回合，用户可以重发。

**新建与移除**
- `POST /api/sessions` 建好会话记录、发出 `session_created`（`status:"starting"`）后立即返回，CLI 的启动和握手在后台进行。启动失败时广播 `session_error{source:"startup"}`，状态改为 `error`。
- 带 `initialMessage` 时，这条消息在后台等启动完成后再发出，失败时广播 `session_error{source:"initial_message"}`。
- 启动期间收到的发送请求，会等启动完成再发；启动失败时，把错误返回给发送方。
- `DELETE /api/sessions/<id>` 立即删除会话、返回 `dead`，进程在后台停止（Claude 不响应 stdin 关闭，原来要等满 2 秒）。停止之后到达的回调，因为找不到会话而被忽略。
- 启动期间被移除或遇到关停时，后台启动的收尾（成功或失败）都不再改动会话。续接会话的原生对话指纹在返回前取，新会话的指纹在启动后取。
- 关停（shutdown）会等移除时在后台停止的进程。`worker.stop()` 关闭 stdin 后等 1 秒发 SIGTERM，再等 1 秒仍未退出就发 SIGKILL。
- 测试：`server/create-remove-latency.test.ts`、`server/steer.test.ts`。

## AIReins 存储统计与清理接口

两个接口使用现有 `{code,msg,data,request_id}` 信封和统一 access 策略；统计不读取磁盘会话登记表，而以 `SessionManager` 当前内存记录判断归属。

`GET /api/storage` 返回以下 `data`：

```ts
{
  totalBytes: number;
  categories: {
    transcripts: { bytes: number; files: number; sessions: number };
    uploads: { bytes: number; files: number; sessions: number };
    logs: { bytes: number; files: number; sessions: number };
    other: { bytes: number; files: number; sessions: number };
  };
  cleanable: {
    bytes: number;
    rotatedLogs: { bytes: number; files: number };
    orphans: { bytes: number; files: number; uploadDirs: number };
    ended: { bytes: number; files: number; sessions: number };
  };
}
```

统计递归遍历 `WORKBENCH_HOME`（默认 `~/.workbench`），按文件逻辑长度计字节，不计目录元数据与文件系统分配块。符号链接仅计链接自身长度和一个文件，不跟随目标；清理不会把链接当成日志副本或孤儿 transcript / uploads 目录。分类分别为 `transcripts/`、`uploads/`、顶层 `server.log*`、其余全部。`sessions` 在 transcripts 中计顶层 `<id>.ndjson` 数，在 uploads 中计顶层真实目录数；logs/other 固定为 0。空目录没有字节或文件数，但孤儿 uploads 仍计目录数。

默认 `cleanable.bytes` = 日志副本 + 孤儿的字节。日志副本仅为顶层普通文件 `server.log.*`，正在写的 `server.log` 保留。孤儿沿用 `pruneStorage` 的路径规则：顶层 `transcripts/<id>.ndjson` 和 `uploads/<id>/`，对应 id 不在内存会话中；属于内存记录的 transcript 路径同样保留。附件沿用 `removeUploadDirs` 的规则：任一保留会话 transcript 提及该 uploads 目录的完整路径时保留整个目录。

`ended` 是额外可清理的会话数量、文件数和字节，不与默认项重复计算。仅 status 为 `dead`、没有真实未决审批闸门、没有续接操作的会话计入；其估计扣除仍被保留会话引用的附件，并包含结束会话移除后才成为孤儿的附件。

`POST /api/storage/clean` 必须提供 JSON `{ "includeEnded": boolean }`；缺失或类型错误返回 HTTP 400 / code `40080`，非法 JSON 沿用 `40000`，access 拒绝沿用 HTTP 403 / code `40300`。`false` 只删除日志副本及孤儿；`true` 额外逐个重新检查结束状态并调用现有 `manager.remove(id)`，然后再按相同规则清理新产生的孤儿。运行中、idle、starting、error、有审批闸门及正在续接的会话均保留。CLI 原生记录和其他分类文件保留。

成功返回 HTTP 200，`data` 为 `{ freedBytes, removed: { rotatedLogs, orphanFiles, orphanUploadDirs, endedSessions }, storage }`。计数为实际删除的日志文件、孤儿文件、孤儿附件目录及结束会话数；`freedBytes` 累加本次删除文件的逻辑长度，不把登记表重写或其他文件增长算作释放量；`storage` 是清理后的最新 GET 结构。并发清理串行执行；预估和执行之间状态可能变化，以实际结果为准。IO 错误沿用 HTTP 500 / code `50000`，已完成的删除不回滚。前端成功后调用现有会话列表刷新；已移除会话的 CLI 原生记录仍可从「所有来源会话」续接。

覆盖测试：`server/storage.test.ts`，由 `npm test` 的 `server/*.test.ts` 测试入口自动执行；所有 fixture 使用临时 `WORKBENCH_HOME`。

### 三家独立会话的派单关系（2026-10-03）

- 图按主运行时分棵，Claude Code、Codex 和 Kimi 均可作为派单人；同运行时多个主会话在同一棵树逐行列标题，顺序为 Claude、Codex、Kimi。跨工具任务通过 `parent.runId` 或执行端 + 原生 `parent.sessionId` 连到实际父节点。原生子代理与外部工单可出现在同一条链中。
- 三家 worker 带当前会话的 `WORKBENCH_PARENT_AGENT / WORKBENCH_PARENT_SESSION_ID`；Kimi ACP 的命令执行入口改用原生 session ID。agent-env 的 `delegate` 优先识别最近工单，再识别当前 AIReins 会话及该执行端原生 ID，避免把继承的上游环境误当父会话。Codex 的嵌套工单同时记录 run ID 与当前线程 ID，使 Luna 派单连回 Luna。
- 不回填旧工单的未知父会话，不从 cwd、模型或任务名猜测关系；旧记录已有父 ID 时仍可显示。没有 delegate 元数据的任意外部 CLI 调用，需要调用方另行提供明确关系。
- 验证入口：`server/dispatches-multi-runtime.test.ts`、`server/dispatch-parent-env.test.ts`、`frontend/scripts/dispatch-flow.test.mjs`。

### delegate Claude 执行端与独立 CLI 根（2026-10-03）

- 目录正则支持 `YYYYMMDD-HHMMSS-claude-<name>`，与 Codex/Kimi/Copilot 共用 run.json、列表、详情、日志、近 7 天历史和原生消息接口。`session` 使用 delegate 预设的 Claude UUID；执行端模型/effort 原样返回。
- Codex/Kimi 父会话可只存在于 delegate 元数据；可选 `parent.title` 按原生 ID 定向定位已有历史文件，复用 `history.ts` 的标题解析，缺失返回 null。结果与空结果缓存 30 秒，不调用历史全量递归扫描。前端找不到标题时显示短 ID。
- Claude 执行端自身的 `session` 纳入原生子代理候选，其子代理附带 `parent.runId` 指向该派单，继续归属外层 Codex/Kimi 主树。既有 Claude 主会话子代理扫描规则保持。
- 回归：`server/dispatches-claude-runtime.test.ts` 使用伪造 run 目录和真实 Codex 父 ID，核对三棵主树、Claude 派单/子代理归属、标题、详情、消息与历史。持久机械冒烟夹具在 `.work-orders/2026-10-03-delegate-claude-runtime-trees/smoke/`。
- server 改动尚未提交，需用户执行 `aireins restart` 后生效；当前服务未重启。Claude 真调用、续接与桌面/手机真机布局待用户确认。

## 单会话彻底删除（2026-10-05）

`DELETE /api/sessions/:id/permanent` 必须提交 JSON `{ "confirmNativeSessionId": "原生会话 UUID" }`。专用路径防止新前端向旧后端请求时退化成普通移除；原 DELETE 路径带 `permanent` 查询参数返回400。缺失/不匹配的确认、未知/不支持的原生身份返回400/40064；忙碌/并发/同原生历史有其他AIReins引用返回400/40063；目标不存在404/40401。

只接受空闲或已结束、无后台任务/审批/续接的Codex/Kimi会话；校验原生ID、历史目录与文件身份，阻止并发操作和同ID续接，等待worker停止并确认退出，Codex再调用 `codex delete --force <UUID>`（30秒超时，无shell插值）。Kimi通过独立短生命周期ACP进程初始化，核验 `agentCapabilities.sessionCapabilities.delete`，调用 `session/delete`（20秒超时）；遵循 `KIMI_CODE_HOME`，历史读取根目录不一致时拒绝操作。正式CLI负责原生历史及索引，服务端确认Codex原生文件或Kimi整个会话目录已不存在后才移除AIReins记录与独占附件；共用附件沿用引用保护。返回 `nativeTranscriptPreserved:false`。原生失败保留AIReins记录，Claude不提供菜单入口，后端明确拒绝，不调用项目purge或工作树rm；Kimi能力缺失或RPC失败保留AIReins记录。

隔离CLI、HTTP及UI证据见 `.work-orders/2026-10-05-permanent-session-delete/REPORT.md`。真实CLI隔离测试不涉及用户历史；生产后端尚未重启。

## Tibo / Codex 重置提醒

本机 `prefs.json` 的 `codexResetWatch` 为布尔值，默认 `false`；可在设置菜单开启。关闭时不请求外部服务、不显示未读提醒，不修改三家 CLI 的全局配置。开启后仅轮询 AIHOT 的公开近 7 天接口 `https://aihot.news/api/v1/codex-resets/recent`，固定每 10 分钟一次，超时 15 秒，使用 ETag / `If-None-Match`；304 保留现有快照并刷新最后成功时间。不访问受完整历史限流的 `/api/v1/codex-resets`。429 / 5xx 优先采用 `Retry-After`（秒数或 HTTP 日期，至少间隔 10 分钟），缺失/无效时指数退避，最长 1 小时；其他失败也退避。请求、JSON、持久化和通知失败只记不含响应正文的 warn，不阻断服务。`schemaVersion !== 1` 时跳过该响应。

首次成功只建立基线。后续仅 `kind=event_update` 且 `action=announce|confirm` 的帖子触发提醒，按 activity id 去重，同帖关联多个事件仍只提醒一次；`related`、`amend` 不提醒。已被本轮全部关联事件的确认取代的 announce，以及超过 24 小时或发布时间缺失/非法的活动，只记 seen，不弹窗、不推送。中文正文优先取关联事件同 id 的 post，再取 activity 的 `text` / `fullText`；无中文时仅使用事件标题和原帖链接，不自动翻译。已配置 `notify.json` 时复用现有飞书或 lark-cli 发送器，文字保持 `[AIReins]` 前缀，附原帖及 AIHOT 来源链接；不使用审批通知的延迟/冷却规则。

本机 `~/.workbench/codex-resets.json`（随 `WORKBENCH_HOME`）用 `.tmp` + rename 原子写、权限 `0600`，保存基线、seen/ack、ETag、最后成功时间、故障起点及精简快照。seen/ack 各最多 2000 个 id、事件最多 100 条、活动最多 1000 条、未读最多 100 条；恢复时再次容错校验。重启保留卡片、未读和去重状态，关闭功能也保留本地数据。

同现有 `/api/*` 的访问控制：

- `GET /api/codex-resets`：`{enabled,lastSuccessAt,stale,monitor,pending,recent,alerts}`。`pending` 是 `status=announced` 的事件，`recent` 按更新时间取最近 5 条；`alerts` 最新优先，包含活动及关联 `events`。`stale` 表示 AIHOT monitor 非 healthy、outage 非空或本机连续失败超过 1 小时。关闭时 `pending` / `alerts` 为空。
- `POST /api/codex-resets/ack {id}`：幂等标记已读。新的快照/提醒、ack 或开关变化通过全局 WS 控制帧 `{type:"codex_resets_updated",data:状态快照}` 同步所有页面；前端连接/重连也拉取一次。任一端 ack 后其他端同步关闭该提醒。

UI 在额度页 iframe 上方显示 AIReins 自己的重置信息卡；数据仅供提醒，额度数值仍由原有 AI-Usage 提供。每个展示位置保留「数据来源 AIHOT」链接到 <https://aihot.news/codex-reset>。此公开 API 限个人非商业使用，须保留来源信息。
