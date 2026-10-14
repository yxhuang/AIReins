# 本机与远程 AIReins

每台电脑独立运行 AIReins 和所在 WSL/原生 Linux/macOS 的 Agent。点击左上角 **标志｜本机/远程机器名** 整体按钮，菜单收窄为300px，选择「机器名（本机）」或已保存的 Tailscale 机器；按钮使用 AR 标志（R 由缰绳摆成），使用描边、高光、轻投影和按压反馈，去掉小箭头。窗口标题按界面语言输出：中文 `AIReins · 本机` / `AIReins · 远程 <机器名>`，英文 `AIReins · Local` / `AIReins · Remote <机器名>`，待处理闸门计数前缀（中文 `(n) 个闸门待处理 · `、英文 `(n) pending approval(s) · `）仍保留。Windows 托盘按标题认窗口时同时识别中文、英文新格式与旧格式（`workbench` 整标题、`… · workbench` 结尾）。通过 Tailscale 地址访问，即使是这台机器自身，也按远程入口显示。

## 另一台电脑安装

在该电脑的 WSL2、原生 Linux 或 macOS 中 clone 本仓库并运行 `bash install.sh`；依赖要求见 [README 平台支持](../README.zh-CN.md#平台支持)。WSL2 是日常主力，原生 Linux 有必过的 Ubuntu CI；macOS 为实验性、仅 CI 覆盖，作者没有实机，欢迎在 issue 反馈。CI 首次执行需公开仓库启用，本次不声称 Actions 已通过。

| 平台 | 依赖与浏览器 | 桌面集成 | 远程入口 |
|---|---|---|---|
| WSL2 | Node ≥ 22.12、npm、ss、rg；wslview/explorer.exe | Windows 托盘、快捷方式、Chrome App 窗口 | Windows Tailscale + 网关，沿用原安装流程 |
| 原生 Linux | Node ≥ 22.12、npm、ss、rg；xdg-open | 默认浏览器；systemd 为可选部署 | 同机 Tailscale Serve 直连远程 loopback |
| macOS 实验性 | Node ≥ 22.12、npm、lsof、rg；open | 默认浏览器，无托盘/网关 | 同机 Tailscale Serve 直连远程 loopback |

`aireins` 安装到 `~/.local/bin`；macOS 通常需将其加入 `~/.zshrc` 的 PATH。WSL 下仍安装 Windows 托盘与快捷方式，任务栏固定需手动操作。WSL 的 Windows Tailscale 已登录时生成缺失 `~/.workbench/remote.json`（MagicDNS origin、登录白名单、8793、权限 600、`terminal:false`）；已有配置不覆盖，登录任务缺失仍按原流程经 UAC 安装网关/Serve。Windows 登录启动参考 [REMOTE.md](../deploy/windows/REMOTE.md)。

原生 Linux/macOS 上须在同一台主机安装并登录 Tailscale。安装器读取 `tailscale status --json`，生成缺失的 `${WORKBENCH_HOME:-~/.workbench}/remote.json`，保留已有或无效文件。有有效配置且 Tailscale 已登录运行时，再读 `tailscale serve status --json`：未配置任何 Serve 就自动启用并打印远程地址；HTTPS 根路径已指向相同目标就报告已配置，不改动；已有其他 Serve（含 TCP、前台模式、Services、Funnel）时不覆盖，打印现状与下面的手动命令：

```bash
tailscale serve --bg http://127.0.0.1:8793
```

端口按 remote.json/安装器打印值替换。Serve 读取或启用因权限失败时，提示用户自行运行 `sudo tailscale set --operator="$USER"` 后重跑 `bash install.sh`；脚本不执行 sudo，也不重试失败命令。macOS PATH 未找到 CLI 时回退 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`；命令打印该实际路径。没有网关，Serve 直接转发本机远程监听，仍只绑定 loopback，完整 Host/Origin、Tailscale 登录白名单和禁止 Funnel 的安全边界不变。

macOS 缺失/版本不足的 Node 与缺失的 ripgrep：若已有 Homebrew 且 stdin/stdout 都是 TTY，安装器合并询问一次 `[Y/n]`，确认后 `brew install` 并重新体检；无 Homebrew、非 TTY、拒绝或 `--check` 时保留手动提示。Linux/WSL 的 apt/NodeSource 命令仍须用户自行执行。安装器不安装或登录三家 CLI/Tailscale，不自动改 PATH 或启用 systemd。

`git pull` 后重跑即可更新；`bash install.sh --check` 只读体检，不安装或写配置。新配置遇到正在运行的 AIReins 时只提示择时 `aireins restart`，不自动重启。远程终端新配置默认关闭，要启用须显式 `terminal:true`；已有 true 保留。CLI 登录/配置和工作目录属于目标机器，不由 clone 复制。系统代理须绕过 `*.ts.net`。

`deploy/systemd/` 是 Linux/WSL 的可选无人值守入口，非安装器必需项，macOS 不使用 systemd。macOS 的文件编辑及文件夹 Taildrop 暂隐藏以保留目录 fd 安全保证；预览/下载及普通文件发送可用。

## 双向连接

1. 两台电脑各自准备可访问的 Tailscale AIReins HTTPS 地址。WSL 新电脑可由 `bash install.sh` 自动配置；其他环境参考 [后端远程入口配置](../server/README.md#远程入口配置-workbenchremotejson)。Serve、身份白名单与 Host/Origin 校验继续生效，每台电脑使用自己的入口。Windows 登录后按需启动参考 [REMOTE.md](../deploy/windows/REMOTE.md)。
2. 在每台电脑的本机 AIReins 中，点击左上角 AR 标志品牌按钮，从「Tailscale 上的其他电脑」选择对方，即可保存地址并切换；↗ 则保存并在独立窗口打开（Chrome App 窗口内打开的新窗口与 AIReins 在任务栏归为一组；中键仍开浏览器标签页）。每次打开菜单只发现一次，列出同一 tailnet 中尚未保存的 Windows/Linux/macOS 电脑，在线优先；离线电脑置灰并标「离线」，仍可点击。「管理主机…」（设置 → 主机 → 主机与连接也会打开同一菜单）可手动添加：支持完整地址（例如 `https://other-pc.tailxxxx.ts.net`）、裸 MagicDNS 名（可带末尾 `/` 或 `.`）、Tailscale IPv4/IPv6 和机器名。裸 MagicDNS 直接补全 HTTPS；IP 或机器名在点击添加时查询 Tailscale 设备，机器名不区分大小写，可匹配设备名称或 MagicDNS 首段。补全成功会显示「已补全为 …」；找不到时提示原因且不保存，多台同名时提示改用 IP 或完整地址，避免添加错电脑。最终保存的地址仍只接受完整 HTTPS MagicDNS origin，不带路径、查询、fragment、账号密码或自定义端口，最多保存 16 台。
3. 点击品牌按钮选择目标，当前页面整页跳到目标 AIReins；每行的 ↗ 在普通浏览器中另开标签页，在 AIReins App 窗口中左键另开 popup 窗口，同时查看两台电脑。中键及修饰键沿用浏览器默认行为。
4. 从本机 AIReins 进入远程时，带上发起浏览器的本机返回入口，远程菜单可选「本机」返回。直接在手机或独立浏览器打开远程地址时，没有本机返回入口。

本机机器名来自后端 `/api/meta.hostName`，优先使用该主机远程配置里的 Tailscale 名称，否则使用实际系统 hostname。该后端变更需重启后加载；旧后端未提供名字时暂显示「本机」。来源名字随连接上下文带到远程，防止把目标主机的名字写成来源本机。

主机列表按浏览器及 origin 保存在 `localStorage`，不写仓库或三家 CLI 配置。切换时仅通过 URL fragment 传递经过校验的主机地址和返回入口，在加载会话前消费并移除；不携带会话、草稿、文件或凭证。合并优先保留目标源已有地址，最多保存16台；超额传入地址不会覆盖已有条目，并弹出未保存提示。列表已满时直接打开另一台主机，该主机仍显示为当前菜单项，但明确标为暂未保存。浏览器禁止存储时保留本页状态并显示保存失败提示，刷新后的持久性不保证。

切换后，会话、历史、文件、工作目录、权限和终端都属于目标机器。切换不迁移任务，也不发送中断、释放或重启命令；正常运行的后台任务继续在原主机上执行。文件正在保存时阻止当前页面切换；未发送输入（包括新建会话的首条消息）/附件确认后才能切走，未保存文件沿用浏览器离页确认。新窗口打开保留原页面；主机菜单的上下方向键同时覆盖当前页切换和新窗口操作。

发现仅表示设备在 Tailscale 上登记，不代表安装或运行了 AIReins；不做跨源探测。后端只读运行 `tailscale status --json`，优先 PATH 中的 `tailscale`，WSL 未找到时使用 Windows 安装路径；命令超时约 5 秒且输出有上限，未安装、未运行或读取失败时不显示发现列表。目标电脑需要开机、联网、允许访问且 AIReins 可用；Tailscale 本身不唤醒停止的 WSL。连接失败停留在目标地址的错误页面，浏览器后退可以返回来源，不自动改为本机执行。远程终端和原生 Windows 文件选择沿用目标已有能力配置。

## 手机主屏 App

iOS 主屏 App 只在添加时的源内全屏，跳到另一台电脑的地址会被系统套上 Safari 顶栏和底栏。所以每台电脑各添加一个主屏图标（Safari 打开该电脑的 `https://…ts.net` → 分享 → 添加到主屏幕），从对应图标进入；两个图标各自独立，不依赖另一台开机。在手机主屏 App 里点选其他主机或 ↗ 时不跳转，只在菜单里提示改用那台电脑的图标及其地址（`HostSwitcher.tsx` 的 `homeScreenHint`，判定为 standalone 且为手机/平板）。

## Chrome 标签页与 AIReins 窗口互转

AIReins App 窗口的主机菜单底部显示「在 Chrome 中打开」（其他浏览器显示「在浏览器中打开」），将当前主机和会话作为普通标签页打开，原 AIReins 窗口保留。

普通桌面标签页在本机 `/api/meta.capabilities.appWindow` 为 true 时显示「在 AIReins 窗口中打开」。点击后，本机后端用 Windows Chrome 的 `--app=http://127.0.0.1:<本机端口>/#wb-goto=<目标>` 打开窗口，再尝试关闭当前标签页。浏览器拒绝关闭时保留标签页，不显示关闭错误。目标的路径、查询及会话 hash 会在加载会话前还原；localhost 和开发入口的路径还原到 App 的 127.0.0.1 origin，保证启动 host 和根路径与托盘一致。

「在 AIReins 窗口中打开」只显示在本机普通桌面标签页；远程页、手机、非 WSL 或未找到 Windows Chrome 时不显示。后端启动目标只接受本机 AIReins 入口；主机切换仍只携带原有连接上下文，不传递 App 能力位或页面路由。

打开失败时标签页保留并提示原因；文件正在保存时阻止互转，未发送输入或附件需确认，未保存文件沿用浏览器离页确认。后端代码需要用户择时重启才生效。

自动测试使用假 launcher，不真实运行 Chrome；真实 Windows Chrome 启动、window.close 和任务栏归组仍需实机验收。

## 验收边界

自动回归覆盖地址校验、名称/标题、往返上下文、目标主机地址合并、手机直接访问与存储不可用。Linux Chromium 的桌面夹具已走到跨源往返、新标签、草稿/文件保护，完整夹具因目录及设置存储的模拟数据问题两次中断后暂停；补齐 mock 后保留脚本等待明确续接。真实两机/Tailscale、Windows Chrome App 窗口与手机 PWA 的跨域打开行为仍须实际验收。
