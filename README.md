# Workbench

面向 Claude Code、Codex CLI 与 Kimi Code CLI 的本地工作台：一个跑在 WSL 里的 Node 进程，浏览器就是界面，直接驱动三家原生 CLI，多会话并行，危险操作要过审批闸门。

- 现状、待办与接手须知（新会话先读）：[`HANDOFF.md`](HANDOFF.md)
- 后端设计、接口和实测记录：[`server/README.md`](server/README.md)

## 新电脑安装

在 WSL Ubuntu 中准备以下依赖：

| 依赖 | 要求 |
| --- | --- |
| Node.js（含 npm） | ≥ 22，必需 |
| iproute2 / `ss` | 必需，用于识别服务端口 |
| `python3`、`curl` | 可选，`wb status` 使用；冒烟测试可用 Node fetch |
| Claude / Codex / Kimi CLI | 至少一家已安装并登录；安装时缺失会提示 |
| Windows Google Chrome | 工作台应用窗口使用 `chrome --app` |
| WSL interop | 需可调用 `powershell.exe`，否则跳过 Windows 安装 |
| Windows Tailscale | 远程入口需已安装并登录，`BackendState` 为 `Running`；缺失不阻断本机安装 |

```bash
git clone https://github.com/yxhuang/workbench.git && cd workbench && bash install.sh
```

脚本检查依赖、安装 npm 依赖和 `wb` / `workbench` 命令、安装 Windows 托盘与快捷方式，并做冒烟测试；已有服务保持运行。WSL 下检测到已登录运行的 Windows Tailscale 时，还会自动配置远程入口：

1. `~/.workbench/remote.json` 不存在时，以本机 MagicDNS HTTPS 地址和本机 Tailscale 用户生成配置（`port: 8793`、`terminal: true`、权限 `600`），打印 origin；已有文件只校验、打印 origin，绝不覆盖。
2. `Workbench Remote Gateway` 登录任务不存在时，弹出一次 UAC，在拥有该 WSL 发行版的 Windows 账户下允许安装；Windows PowerShell 5.1 安装网关及 Tailscale Serve。已有任务打印状态并跳过。拒绝 UAC 或失败会继续本机安装并打印可复制的管理员 PowerShell 手动命令。
3. 新配置生成时，若 WB 已运行，提示「运行 wb restart 使远程入口生效」，由你选择时机执行；未运行则沿用冒烟测试的临时启动、验证、停止流程，之后由桌面 WB 或远程请求启动服务。

远程终端默认开启；如需关闭把 `terminal` 改为 `false` 后 `wb restart`（旧配置缺该字段时终端关闭）。非 WSL、未安装或未登录 Tailscale 时提示跳过，登录后重跑即可。`git pull` 后重跑 `bash install.sh` 即更新；`bash install.sh --check` 只读体检依赖及远程三项状态（remote.json / Serve / 计划任务），不生成文件、不安装、不弹 UAC、不启动或停止 WB。

最后在开始菜单（或桌面）找到“Workbench 工作台” → 右键 → 固定到任务栏；Windows 不提供可靠的程序化固定接口。已有固定项会一并更新，无需重固定。CLI 和 Tailscale 本身的安装、登录仍需自行完成；远程网关说明及人工验收见 [REMOTE.md](deploy/windows/REMOTE.md)。代理客户端 等系统代理须把 `*.ts.net` 加入绕过，否则浏览器可能报 `ERR_TUNNEL_CONNECTION_FAILED`。

日常启动：

```bash
wb                     # 后台启动并在浏览器打开（= bin/workbench）；另有 stop / restart / status / logs
npm run server         # 或者在前台直接跑
```

服务默认只监听 `127.0.0.1:8790`，端口可用 `WORKBENCH_PORT` 改。
