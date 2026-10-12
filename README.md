# Workbench

**A personal AI workbench that runs on your own computer.** Drive Claude Code, Codex and Kimi Code from a browser, on the desktop or on your phone over [Tailscale](https://tailscale.com), and browse that computer's folders, files and terminal while you do it.

English | [简体中文](README.zh-CN.md)

> Status: early (v0.1). Built and used daily by one person on Windows + WSL2. Native Linux is supported with required Ubuntu CI checks; macOS is experimental with CI-only coverage; see [Platform support](#platform-support).

## Why

The official remote options for coding agents give you a window into **one agent session**. Workbench gives you **the whole computer**, from any browser on your private network:

- Start, resume and switch between Claude Code, Codex and Kimi sessions side by side.
- Browse any directory (including Windows drives under `/mnt/c`, not just git repos), preview and edit files in your home folder, Windows drives and session folders, open a terminal.
- Send files between your phone and computer with Taildrop.
- Keep everything interoperable with the native CLIs and the VS Code extension: sessions started in Workbench can be resumed there, and the other way round.

It is deliberately small: one Node process plus a web page. No relay server, no account, no telemetry, no desktop app to keep open. It is built for one person working with their own agents, not for running a fleet of agents in parallel worktrees.

The interface supports English and Simplified Chinese; choose a language under Settings → Appearance.

## Features

**Sessions**
- Claude Code (stream-json), Codex (`codex app-server`) and Kimi Code (ACP), each driven through its official CLI and your existing login.
- Approve or deny tool calls and answer agent questions from any device; pending approvals across all sessions are surfaced in one place.
- Native history browser: search, filter by folder, and resume any past session from the three CLIs.
- Per-session model, reasoning effort and permission mode; slash commands, skills and `@` file mentions with completion.
- Context-usage ring, interrupt and steer mid-turn, side questions.
- Pin, group and rename sessions; sessions are titled automatically.

**The computer**
- File panel: browse any readable directory with Git status and tabs. Inside your home folder, Windows drives and the session's folder, preview Markdown, code, images and PDF, and edit UTF-8 text files up to 1 MiB in place.
- Multi-tab terminal (on the remote entry only when you enable it).
- Taildrop: send a file or folder (zipped) from the file panel to your online Taildrop devices.
- Dispatch view: see sub-agent and delegated runs as a parent/child tree.

**Remote and multi-computer**
- Phone layout installable as a home-screen web app.
- Remote access through Tailscale Serve, restricted to an allowlist of Tailscale logins. See [SECURITY.md](SECURITY.md).
- Discover the other computers on your tailnet and switch between their Workbenches from one menu.
- On Windows: a tray icon and a Start-menu shortcut that open Workbench as an app window.

## How it compares

| | Workbench | Orca | Claude Code Remote Control | Codex Remote |
|---|---|---|---|---|
| What you control remotely | The whole computer: sessions, any folder, files, terminal | Workspaces/worktrees, agent sessions, terminal, git | One Claude Code session | Codex tasks on a host |
| Agents | Claude Code, Codex, Kimi | Many CLIs in a PTY | Claude Code | Codex |
| Network path | Your tailnet only, no relay | Orca relay (account) by default; LAN or Tailscale optional | Anthropic relay | OpenAI relay |
| Phone client | Web app | iOS / Android apps (beta) | Claude app | ChatGPT app |
| Runs as | One Node process + browser | Desktop app (must stay open) | Your terminal (must stay open) | Desktop app |
| Best for | One person using one computer from anywhere | Running many agents in parallel worktrees | Quick check-ins on one session | Codex users in the ChatGPT app |

If you want to run a team of agents in parallel worktrees, use [Orca](https://github.com/stablyai/orca). If you want to use your whole computer from your phone, use Workbench.

<!-- Comparison facts collected 2026-10-12; re-check before each release. -->

## Platform support

| Platform | Status |
|---|---|
| Windows 11 + WSL2 (Ubuntu) | Supported: installer, tray, app window, remote gateway |
| Native Linux | Supported; required Ubuntu CI checks |
| macOS | Experimental; CI only, no maintainer hardware |
| Native Windows (no WSL) | Not planned for now |

## Install (Windows + WSL2)

Requirements:

| Dependency | Notes |
|---|---|
| Node.js ≥ 22.12 with npm | Required |
| `ss` (iproute2), `rg` (ripgrep) | Required |
| `zip` | For sending folders with Taildrop |
| `curl`, `python3` | Optional, for full `wb status` output |
| Claude Code, Codex or Kimi Code CLI | At least one, installed and logged in |
| Google Chrome on Windows | For the app window |
| Tailscale on Windows | Optional, for remote access |

```bash
git clone <repository-url> workbench && cd workbench && bash install.sh
```

`install.sh` checks dependencies, installs npm packages, builds the frontend, installs the `wb` command, the Windows tray icon and a Start-menu shortcut, and runs a smoke test. Run it again after `git pull` to update. `bash install.sh --check` only reports status and changes nothing.

Pin "Workbench" from the Start menu to the taskbar yourself; Windows offers no reliable way to do it programmatically.

Daily use:

```bash
wb            # start in the background and open it in your default Windows browser
wb status     # also: wb stop | wb restart | wb logs
```

Workbench listens on `http://127.0.0.1:8790` (change with `WORKBENCH_PORT`). The tray icon and Start-menu shortcut open it as a Chrome app window.

## Install (native Linux / experimental macOS)

Use the same `git clone` and `bash install.sh` commands. Native Linux needs Node ≥ 22.12, npm, `ss` (iproute2) and `rg`; macOS uses `lsof` instead of `ss` and needs `rg` (for example, `brew install ripgrep`). `wb` opens `xdg-open` on Linux or `open` on macOS. Headless hosts can set `WORKBENCH_NO_OPEN=1`. No Windows tray, gateway, app window, directory picker or PowerShell is installed or offered on these platforms. Linux systemd deployment is optional; see [host setup](docs/host-connections.md).

WSL2 is the maintainer's daily platform. Ubuntu CI is a required gate; macOS CI may fail while experimental. The maintainer has no Mac, so macOS is tested only in CI. macOS supports file browsing and preview, but file editing and folder Taildrop remain disabled until secure directory-fd operations are available. Ordinary file Taildrop is supported. Please report macOS results in an issue.

## Remote access from your phone

When Tailscale is installed and logged in on Windows, `install.sh` sets up remote access:

1. It writes `~/.workbench/remote.json` (only if missing) with your MagicDNS HTTPS address and your Tailscale login. The remote terminal is **off** by default.
2. It installs a small Windows gateway plus `tailscale serve`, after one UAC prompt.

On native Linux and macOS, install and log in to Tailscale **on the same machine as Workbench**. The installer only creates a missing `remote.json` with `terminal: false` and prints the command for you to run; it never changes Tailscale Serve configuration:

```bash
tailscale serve --bg http://127.0.0.1:8793
```

Use the port printed by the installer if your existing configuration differs. On macOS the app CLI at `/Applications/Tailscale.app/Contents/MacOS/Tailscale` is a fallback when `tailscale` is absent from PATH. Serve forwards directly to the remote loopback listener; no Windows gateway is needed. Host/Origin checks and the Tailscale login allowlist are identical on all platforms. Remote terminal access requires an explicit `terminal: true` opt-in.

Open `https://<your-computer>.<tailnet>.ts.net/` on your phone and add it to the home screen. Details and troubleshooting: [deploy/windows/REMOTE.md](deploy/windows/REMOTE.md). If your browser uses a system proxy, add `*.ts.net` to its bypass list.

## Configuration

Workbench keeps its data in `~/.workbench`. `WORKBENCH_HOME` moves the server's data directory and the native POSIX remote installer's config directory. WSL installation, `wb` logs and snapshots retain their existing paths. It does not change the three CLIs' global settings, except the Claude Remote Control default when you toggle it in Workbench.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `WORKBENCH_PORT` | `8790` | Local port (always bound to `127.0.0.1`) |
| `WORKBENCH_HOME` | `~/.workbench` | Server data directory |
| `WORKBENCH_LOG` | `~/.workbench/server.log` | Log file written by `wb` |
| `WORKBENCH_STATIC_DIR` | `frontend/dist` | Serve another frontend build |

Machine-specific options go in `~/.workbench/prefs.json`. They are not shown in the UI; restart Workbench after editing:

```json
{
  "shutdownCommand": "/home/you/.local/bin/my-shutdown",
  "claudeCodeEntrypoint": "claude-vscode",
  "directoryBrowserHome": "/home/you/projects"
}
```

| Key | Effect |
|---|---|
| `shutdownCommand` | Absolute path of a command that schedules a shutdown (about 60 s) when run without arguments and cancels it with `abort`. When set, a Shut down item appears in Settings. |
| `claudeCodeEntrypoint` | Set to `"claude-vscode"` to start Claude sessions with the VS Code extension's entrypoint identity. |
| `directoryBrowserHome` | Where the directory browser's Home button goes. Defaults to `$HOME`. |

Remote access is configured in `~/.workbench/remote.json`; see [server/README.md](server/README.md#访问控制).

## Optional integrations

- **delegate**: the dispatch view also shows runs written by an external `delegate` tool to `~/.cache/delegate`. Without it, the view shows native sub-agents only.
- **Notifications**: Feishu (Lark) webhook via `~/.workbench/notify.json`. More channels are planned.
- **Pages**: small extension pages and launcher links in `~/.workbench/pages/`. See [server/README.md](server/README.md).

## Development

```bash
npm install
npm run server        # backend on :8790, serves frontend/dist
npm run dev           # Vite on :5173, proxies to the backend
npm run build         # build + precompress frontend/dist
npm test              # frontend + backend regression tests
npm run typecheck && npm run typecheck:frontend
```

Design notes and API contracts live in [server/README.md](server/README.md), [frontend/README.md](frontend/README.md) and [spikes/PROTOCOL-NOTES.md](spikes/PROTOCOL-NOTES.md) (currently in Chinese). See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request, and [AGENTS.md](AGENTS.md) if you work with a coding agent.

## Security

Anyone who can reach Workbench has the power of your user account on that computer. Keep it on loopback and your tailnet; never expose it with Funnel or port forwarding. Read [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## License

The code is released under the [MIT License](LICENSE). The project name and logo and the third-party brand icons are not covered by it; see [NOTICE](NOTICE) for details and for what this repository does not include.
