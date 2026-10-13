# AIReins

**一个运行在你自己电脑上的个人 AI 工作台。** 在桌面或手机上通过 [Tailscale](https://tailscale.com) 从浏览器驱动 Claude Code、Codex 和 Kimi Code，同时还能浏览这台电脑的目录、文件和终端。

[English](README.md) | 简体中文

> 状态：早期版本（v0.1）。由一个人在 Windows + WSL2 上日常构建和使用。原生 Linux 支持并设 Ubuntu CI 必过门禁；macOS 为实验性，仅以 CI 覆盖；见[平台支持](#平台支持)。

## 为什么

各家编码代理的官方远程方案只给你一扇看进**单个代理会话**的窗户。AIReins 给你的是**整台电脑**，可在你私有网络的任何浏览器上使用：

- 并排启动、恢复和切换 Claude Code、Codex 与 Kimi 会话。
- 浏览任意目录（包括 `/mnt/c` 下的 Windows 盘符，不限于 git 仓库），在家目录、Windows 盘符和会话目录中预览和编辑文件，打开终端。
- 用 Taildrop 在手机和电脑之间传文件。
- 与原生 CLI 和 VS Code 扩展保持互通：在 AIReins 中开启的会话可以在那里恢复，反过来也一样。

它刻意保持小巧：一个 Node 进程加一个网页。没有中继服务器，没有账号，没有遥测，也没有需要一直开着的桌面应用。它是为一个人与自己的代理协作而设计的，不是为在并行 worktree 中跑一队代理。

界面支持简体中文和英文，可在「设置 → 外观」中选择语言。

## 功能

**会话**
- Claude Code（stream-json）、Codex（`codex app-server`）和 Kimi Code（ACP），各自通过官方 CLI 和你已有的登录驱动。
- 从任何设备批准或拒绝工具调用、回答代理提问；所有会话中待处理的审批集中呈现在一处。
- 原生历史浏览器：搜索、按目录过滤，恢复三家 CLI 的任意历史会话。
- 按会话设置模型、推理档位和权限模式；支持斜杠命令、skills 和带补全的 `@` 文件提及。
- 上下文用量环、打断与运行中插话、侧问。
- 置顶、分组和重命名会话；会话标题自动生成。

**电脑本身**
- 文件面板：带 Git 状态和标签页，浏览任意可读目录。在家目录、Windows 盘符和会话目录内，可预览 Markdown、代码、图片和 PDF，并就地编辑不超过 1 MiB 的 UTF-8 文本文件。
- 多标签终端（远程入口上需在配置中开启后才可用）。
- Taildrop：从文件面板把文件或文件夹（打包成 zip）发送到你在线的 Taildrop 设备。
- 派单视图：以父/子树的形式查看子代理和被委派的运行。

**远程与多台电脑**
- 手机版布局可添加到主屏幕，像应用一样使用。
- 通过 Tailscale Serve 提供远程访问，仅限 Tailscale 登录白名单。见 [SECURITY.md](SECURITY.md)。
- 发现你 tailnet 上的其他电脑，从一个菜单在它们的 AIReins 之间切换。
- 在 Windows 上：托盘图标和开始菜单快捷方式，以应用窗口形式打开 AIReins。

## 横向对比

| | AIReins | Orca | Claude Code Remote Control | Codex Remote |
|---|---|---|---|---|
| 远程控制的对象 | 整台电脑：会话、任意目录、文件、终端 | 工作区/worktree、代理会话、终端、git | 单个 Claude Code 会话 | 一台主机上的 Codex 任务 |
| 代理 | Claude Code、Codex、Kimi | 一个 PTY 中的多种 CLI | Claude Code | Codex |
| 网络路径 | 仅你的 tailnet，无中继 | 默认走 Orca 中继（账号）；可选局域网或 Tailscale | Anthropic 中继 | OpenAI 中继 |
| 手机客户端 | Web 应用 | iOS / Android 应用（beta） | Claude 应用 | ChatGPT 应用 |
| 运行形态 | 一个 Node 进程 + 浏览器 | 桌面应用（必须保持打开） | 你的终端（必须保持打开） | 桌面应用 |
| 适合 | 一个人从任何地方用自己的一台电脑 | 在并行 worktree 中跑多个代理 | 快速查看单个会话 | 在 ChatGPT 应用中的 Codex 用户 |

如果你想在并行 worktree 中跑一队代理，用 [Orca](https://github.com/stablyai/orca)。如果你想在手机上用整台电脑，用 AIReins。

<!-- Comparison facts collected 2026-10-12; re-check before each release. -->

## 平台支持

| 平台 | 状态 |
|---|---|
| Windows 11 + WSL2 (Ubuntu) | 支持：安装器、托盘、应用窗口、远程网关 |
| 原生 Linux | 支持；Ubuntu CI 为必过门禁 |
| macOS | 实验性；仅 CI 覆盖，作者无实机 |
| 原生 Windows（无 WSL） | 暂无计划 |

## 安装（Windows + WSL2）

依赖要求：

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 22.12（含 npm） | 必需 |
| `ss`（iproute2）、`rg`（ripgrep） | 必需 |
| `zip` | 用 Taildrop 发送文件夹时需要 |
| `curl`、`python3` | 可选，用于完整的 `aireins status` 输出 |
| Claude Code、Codex 或 Kimi Code CLI | 至少一个，已安装并登录 |
| Windows 上的 Google Chrome | 用于应用窗口 |
| Windows 上的 Tailscale | 可选，用于远程访问 |

```bash
git clone https://github.com/yxhuang/AIReins.git && cd AIReins && bash install.sh
```

`install.sh` 会检查依赖、安装 npm 包、构建前端、安装 `aireins` 命令、Windows 托盘图标和开始菜单快捷方式，并跑一次冒烟测试。`git pull` 后再运行一次即可更新。`bash install.sh --check` 只报告状态，不做任何改动。

请自行从开始菜单把 "AIReins" 固定到任务栏；Windows 没有可靠的编程方式来做到这一点。

日常使用：

```bash
aireins            # 后台启动并在默认 Windows 浏览器中打开
aireins status     # 还有：aireins stop | aireins restart | aireins logs
```

AIReins 监听 `http://127.0.0.1:8790`（可用 `WORKBENCH_PORT` 修改）。托盘图标和开始菜单快捷方式会以 Chrome 应用窗口打开它。

## 安装（原生 Linux / macOS 实验性）

使用相同的 clone 和 `bash install.sh` 命令。原生 Linux 需要 Node ≥ 22.12、npm、`ss`（iproute2）与 `rg`；macOS 用 `lsof` 查询端口，还需 `rg`（例如 `brew install ripgrep`）。`aireins` 在 Linux 调用 `xdg-open`，macOS 调用 `open`；无桌面环境可设 `WORKBENCH_NO_OPEN=1`。这些平台不安装 Windows 托盘或网关，界面隐藏 Chrome App 窗口、Windows 选择窗口、盘符转换和 PowerShell。Linux 的 systemd 部署是可选项，见[主机设置](docs/host-connections.md)。

WSL2 是作者日常使用的主力平台。Ubuntu CI 为必过门禁，macOS CI 允许实验性失败；作者没有 Mac，macOS 只在 CI 中测试。macOS 支持文件浏览与预览，安全目录 fd 操作未实现前隐藏文件编辑与文件夹 Taildrop；普通文件 Taildrop 可用。欢迎 macOS 用户在 issue 反馈。

## 从手机远程访问

当 Windows 上已安装并登录 Tailscale 时，`install.sh` 会配置远程访问：

1. 写入 `~/.workbench/remote.json`（仅当不存在时），其中包含你的 MagicDNS HTTPS 地址和 Tailscale 登录名。远程终端默认**关闭**。
2. 在一次 UAC 提示之后，安装一个小型 Windows 网关和 `tailscale serve`。

原生 Linux/macOS 的 Tailscale 与 AIReins 必须在同一台机器。安装器仅生成缺失的 `remote.json`（`terminal: false`）并打印命令，不修改 Tailscale 配置；请自行执行：

```bash
tailscale serve --bg http://127.0.0.1:8793
```

已有配置端口不同时用安装器打印的端口。macOS 的 PATH 找不到 CLI 时回退 `/Applications/Tailscale.app/Contents/MacOS/Tailscale`。Serve 直接指向远程 loopback 监听，不需要 Windows 网关；Host/Origin 与 Tailscale 身份白名单的严格检查三平台完全相同。远程终端仍需显式 `terminal: true`。

在手机上打开 `https://<your-computer>.<tailnet>.ts.net/`，添加到主屏幕。细节与故障排查见 [deploy/windows/REMOTE.md](deploy/windows/REMOTE.md)。如果你的浏览器使用系统代理，请把 `*.ts.net` 加入绕过列表。

## 配置

AIReins 把数据保存在 `~/.workbench`。`WORKBENCH_HOME` 可以移动服务器数据目录和原生 POSIX 远程安装器的配置目录；WSL 安装、`aireins` 日志和快照保留原有路径。它不会改变三家 CLI 的全局设置，唯一的例外是你在 AIReins 中切换的 Claude Remote Control 默认值。

环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `WORKBENCH_PORT` | `8790` | 本地端口（始终绑定 `127.0.0.1`） |
| `WORKBENCH_HOME` | `~/.workbench` | 服务器数据目录 |
| `WORKBENCH_LOG` | `~/.workbench/server.log` | `aireins` 写入的日志文件 |
| `WORKBENCH_STATIC_DIR` | `frontend/dist` | 改用另一份前端构建产物 |

机器相关的选项放在 `~/.workbench/prefs.json` 中。它们不显示在界面上；编辑后需要重启 AIReins：

```json
{
  "shutdownCommand": "/home/you/.local/bin/my-shutdown",
  "claudeCodeEntrypoint": "claude-vscode",
  "directoryBrowserHome": "/home/you/projects"
}
```

| 键 | 作用 |
|---|---|
| `shutdownCommand` | 一条命令的绝对路径：不带参数运行时调度一次关机（约 60 秒），带 `abort` 取消。设置后，设置菜单中会出现关机项。 |
| `claudeCodeEntrypoint` | 设为 `"claude-vscode"` 可让 Claude 会话以 VS Code 扩展的入口身份启动。 |
| `directoryBrowserHome` | 目录浏览器「主目录」按钮跳转的位置。默认为 `$HOME`。 |

远程访问在 `~/.workbench/remote.json` 中配置；见 [server/README.md](server/README.md#访问控制)。

## 可选集成

- **delegate**：派单视图还会显示外部 `delegate` 工具写入 `~/.cache/delegate` 的运行。没有它时，视图只显示原生子代理。
- **通知**：通过 `~/.workbench/notify.json` 配置飞书（Lark）webhook。计划支持更多渠道。
- **Pages**：放在 `~/.workbench/pages/` 下的小型扩展页面和启动器链接。见 [server/README.md](server/README.md)。

## 开发

```bash
npm install
npm run server        # 后端 :8790，服务 frontend/dist
npm run dev           # Vite :5173，代理到后端
npm run build         # 构建并预压缩 frontend/dist
npm test              # 前端 + 后端回归测试
npm run typecheck && npm run typecheck:frontend
```

设计说明和 API 契约见 [server/README.md](server/README.md)、[frontend/README.md](frontend/README.md) 和 [spikes/PROTOCOL-NOTES.md](spikes/PROTOCOL-NOTES.md)（目前为中文）。提交 pull request 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；如果你和编码代理一起工作，请阅读 [AGENTS.md](AGENTS.md)。

## 安全

任何能访问到 AIReins 的人都拥有你在该电脑上用户账号的全部权限。让它只留在 loopback 和你的 tailnet 内；绝不要用 Funnel 或端口转发把它暴露出去。威胁模型和漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 许可证

代码使用 [MIT 许可证](LICENSE)。项目名称和 Logo、第三方品牌图标不在许可范围内；详情及本仓库不包含的内容见 [NOTICE](NOTICE)。
