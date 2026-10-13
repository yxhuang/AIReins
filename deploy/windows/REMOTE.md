# 手机访问时启动 WSL 和 AIReins

实现路径：手机 → Windows Tailscale Serve → Windows `127.0.0.1:8794` 入口 → WSL 中的 AIReins `127.0.0.1:8793`。Windows 入口在**登录 Windows 后**由计划任务隐藏运行，只有授权 HTTP 请求到达后才启动 WSL 和 AIReins 服务（不开桌面窗口）。开机登录后不用点 AIReins，手机直接打开原网址即可。

只做登录后的场景：系统代理客户端靠 `HKCU\...\Run` 在登录后才自启，未登录时 WSL 没有代理，CLI 连不上模型。所以不存 Windows 密码、不开 Tailscale 无人值守。

**当前状态（2026-10-03）：已安装并实测通过（重启登录后不点 AIReins，手机请求 10 秒内拉起 WSL+AIReins）。首次安装曾因 5.1 下 param 默认值里 `$PSScriptRoot` 为空失败，已修。待验：开机自动登录后停在锁屏、不解锁时手机能否直接用。**

## 一次性安装

新电脑先安装并登录 Windows Tailscale，在 WSL 仓库内运行 `bash install.sh` 即可自动配置：

- 仅 WSL 且 Windows Tailscale `status --json` 的 `BackendState` 为 `Running` 时，生成缺失的 `~/.workbench/remote.json`。origin 为本机 `Self.DNSName` 去末尾点后的 HTTPS `*.ts.net` 地址，白名单只含 `User[String(Self.UserID)].LoginName`；默认 `port: 8793`、`terminal: false`，权限 `600`。已有配置只校验、打印 origin，绝不覆盖；无有效 DNSName 或用户映射时提示跳过。
- `Workbench Remote Gateway` 任务不存在时，从 WSL 弹出一次 UAC，用 `Start-Process -Verb RunAs -Wait` 运行 Windows PowerShell 5.1 安装器，UNC 路径使用 `\\wsl.localhost\<distro>\...`，自动传入 `WSL_DISTRO_NAME`、`USER` 与 `HOME`。请使用拥有该 WSL 发行版的 Windows 账户允许提权；已有任务仅打印状态并跳过。
- UAC 拒绝或安装失败不阻断其余安装，打印包含实际发行版、Linux 用户、HOME 与仓库路径的手动命令。非 WSL、无 Tailscale 或未登录时跳过，登录后可重跑。
- 新配置若遇到正在运行的 AIReins，提示「运行 aireins restart 使远程入口生效」；不自动重启。未运行则沿用现有冒烟启动、验证、停止流程，后续由桌面 AIReins 或远程请求启动。远程终端默认关闭；如需允许白名单内账号远程使用本机 shell，将 `~/.workbench/remote.json` 的 `terminal` 显式改为 `true` 后运行 `aireins restart`。已有开启配置保持原样。

`bash install.sh --check` 只读体检 remote.json、Serve HTTPS `/` 是否指向 `127.0.0.1:8794`、登录任务及状态，不写文件、不提权、不触发 AIReins 启停。重跑安装不会覆盖 remote.json 或重新安装已有任务；已有任务但 Serve 不匹配时须根据体检提示人工处理。

系统代理须把 `*.ts.net` 加入绕过，否则浏览器可能报 `ERR_TUNNEL_CONNECTION_FAILED`。

需要手动安装时，在拥有发行版的 Windows 账户下，以管理员身份打开 **Windows PowerShell 5.1**，执行（下面的发行版、用户、HOME 与仓库路径须改成实际值；自动安装失败时优先复制安装脚本打印的命令）：

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\ubuntu\home\user\projects\workbench\deploy\windows\install-remote-gateway.ps1" -Distro ubuntu -LinuxUser user -LinuxHome /home/user
```

安装器执行以下步骤：

- 核对当前账户拥有发行版、现有 `remote.json`、端口和 Tailscale Serve 目标。全新电脑无 Serve Web/根路径时可安装，回滚记录 `previousTarget: null`；已有非 AIReins 根路径或已开启 Funnel 时仍拒绝更改。
- 在 `%LOCALAPPDATA%\workbench\remote-gateway\` 保存运行代码和配置副本，备份旧文件和 Serve 配置。
- 写 `launcher.vbs`（同托盘，经 wscript 隐藏运行 PowerShell 并等待），创建 `Workbench Remote Gateway` 登录任务：当前账户登录时触发、`Interactive` 登录类型、普通运行权限、不存密码。任务失败时最多重试三次，禁止重复实例。
- 启动 Windows 入口，仅将原 HTTPS `/` 的后端改成 `http://127.0.0.1:8794`，并读回验证。手机网址不变。

安装时从 WSL UNC 路径读取源文件可能启动 WSL；安装完成后的登录任务全部读取 Windows 本地文件，不依赖 WSL 已运行。现有 8792 socket 和桌面托盘无需更改。修改 Linux `remote.json` 中的身份白名单、源或端口后，Windows 配置副本也须对应更新。

## 行为和验收

入口仅监听 loopback；授权仍使用 Tailscale Serve 注入的账号和现有白名单。HTTP/WS 的 Host、Origin 与身份头继续原样传给 AIReins。原始 TCP 探测、不完整请求和未授权请求不会启动 WSL。

同一批手机请求只启动一次 WSL。冷启动超过八秒时返回等待页，每五秒自动重试；后台启动不因这次 HTTP 连接结束而取消。启动失败时显示错误页并设置三十秒重试间隔；不反复自动启动。WebSocket 和请求正文按字节转发。

先执行模拟测试（不启动 WSL、Chrome 或 Tailscale，不改系统设置）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\ubuntu\home\user\projects\workbench\deploy\windows\tests\remote-gateway.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "\\wsl.localhost\ubuntu\home\user\projects\workbench\deploy\windows\tests\install-remote-gateway.ps1"
```

第二条命令只模拟安装器 Serve 预检与回滚快照，覆盖空配置、空 Web、无根路径、原 AIReins 目标、拒绝其他代理及 Funnel；临时快照目录打印出来供检查，不改系统设置。WSL 内还可运行 `node deploy/windows/tests/install-remote.test.mjs`，用伪造 JSON、临时 HOME 和命令替身验证自动配置及 install.sh 集成，绝不调用真实 Windows 程序或 AIReins 服务。

网关测试覆盖启动时无后台探测、身份及 Origin 拒绝、八连接并发冷启动、请求正文、等待页、失败间隔、WebSocket 升级与二进制双向转发。通过模拟测试仍须实际验收：安装后重启电脑并登录 Windows，不点 AIReins，从已连接 Tailscale 的手机打开原网址，再验证对话与 WebSocket 重连；之后在电脑上点 AIReins，应直接打开窗口、不重复起服务。不要为了测试而由安装器自动重启或注销电脑。

运行日志：`%LOCALAPPDATA%\workbench\remote-gateway\remote-gateway.log`。电脑需已开机、已登录并联网；此入口不负责唤醒关机或休眠的电脑，也不覆盖 Windows 更新重启后停在登录界面的情况（那时用 RDP/UU 远程进桌面登录一次即可）。

## 停用与恢复

在 Windows 任务计划程序中停止并禁用 `Workbench Remote Gateway`，只停止本次入口，不关闭其他 WSL 进程或现有托盘。安装器打印的 `backup-*\rollback.json` 记录原代理目标，可据此在管理员 PowerShell 恢复：

```powershell
# 把地址替换为 rollback.json 的 previousTarget；本机现有目标预计为 8792，安装器会核对。
& "$env:ProgramFiles\Tailscale\tailscale.exe" serve --bg --yes --https=443 --set-path=/ http://127.0.0.1:8792
```

若原来没有 HTTPS `/`，按备份核实后用 `tailscale serve --https=443 --set-path=/ off` 撤去本次新增的根路径。不要使用 `tailscale serve reset`，它会同时清空其他代理配置。删除任务或运行文件另行列清单确认，不作为停用的自动步骤。

官方依据：[Serve 开机恢复](https://tailscale.com/docs/reference/tailscale-cli/serve)、[Windows 计划任务运行账户](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)。
