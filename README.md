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

```bash
git clone https://github.com/yxhuang/workbench.git && cd workbench && bash install.sh
```

脚本检查依赖、安装 npm 依赖和 `wb` / `workbench` 命令、安装 Windows 托盘与快捷方式，并做冒烟测试；已有服务保持运行。`git pull` 后重跑 `bash install.sh` 即更新，`bash install.sh --check` 只体检。

最后在开始菜单（或桌面）找到“Workbench 工作台” → 右键 → 固定到任务栏；Windows 不提供可靠的程序化固定接口。已有固定项会一并更新，无需重固定。CLI 安装、登录与 Tailscale 远程入口配置不在脚本范围，远程入口见 [REMOTE.md](deploy/windows/REMOTE.md)。

日常启动：

```bash
wb                     # 后台启动并在浏览器打开（= bin/workbench）；另有 stop / restart / status / logs
npm run server         # 或者在前台直接跑
```

服务默认只监听 `127.0.0.1:8790`，端口可用 `WORKBENCH_PORT` 改。
