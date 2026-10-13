<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-en-dark.png">
    <img src="docs/assets/banner-en-light.png" alt="AIReins: Let the agents run. Keep the reins. Claude Code, Codex and Kimi Code converge through AR on an Approve button on your phone" width="100%">
  </picture>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-1F1E1D?style=flat-square" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Node.js-%E2%89%A5%2022.12-1F1E1D?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js ≥ 22.12">
  <img src="https://img.shields.io/badge/WSL2%20%C2%B7%20Linux-supported-1F1E1D?style=flat-square" alt="WSL2 · Linux supported">
  <img src="https://img.shields.io/badge/macOS-experimental-8a8580?style=flat-square" alt="macOS experimental">
  <img src="https://img.shields.io/badge/Claude%20Code%20%C2%B7%20Codex%20%C2%B7%20Kimi-official%20CLIs-1F1E1D?style=flat-square" alt="Claude Code · Codex · Kimi: official CLIs">
</p>

<p align="center">
  <b>Use your whole computer from your phone. Let three AI agents do the work; you set the direction.</b><br>
  One Node process and a web page, on your own private network.
</p>

<p align="center">
  <b>English</b> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#remote-access-from-your-phone">Phone access</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#security">Security</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<br>

## What it is

AIReins is an AI workbench that runs on your own computer. It drives Claude Code, Codex and Kimi Code through their official CLIs and your existing logins. You open sessions, approve tool calls, browse files and use a terminal from a browser on your desktop or phone, and reach the computer from anywhere over [Tailscale](https://tailscale.com).

Official remote options usually give you a window into one session. AIReins gives you the whole computer: any folder (including Windows drives under `/mnt/c`, not just git repos), file preview and editing, a terminal, sending with Taildrop, and the native history of all three CLIs.

## Why "Reins"

Agents keep getting more capable. They read code, edit files, run commands and work through long task lists on their own. I still don't want to hand over the wheel entirely: what is worth doing, when a task is finished, which command may run and which conclusion doesn't hold up are judgments that belong to a person.

So everything in AIReins serves one idea: **let the agents run, and keep the reins in your hand.**

- **Decide from anywhere.** Approve or deny tool calls and answer the agents' questions from your phone. Everything waiting on you, across all sessions, is collected in one place.
- **Pull them back mid-run.** Interrupt with one tap; with Claude Code and Codex you can also steer a running turn or ask a side question (Kimi queues messages until the current turn ends), instead of waiting for the run to finish and redoing it.
- **See what they are doing.** Context usage and every tool call in plain view, with sub-agents and delegated runs laid out as a parent/child tree.
- **Use all three together.** Let one agent lead and hand work to another (with an external delegation tool, see [Optional integrations](#optional-integrations)) and follow the whole dispatch tree on your phone. You decide which agent suits which job; no single vendor locks you in.
- **Keep everything yours.** No vendor relay, no account, no telemetry. Sessions are the CLIs' own native history, so you can resume them from the command line or VS Code as usual.

## Before you start

- **I built this for myself.** I use it every day on Windows + WSL2, and much of its code was written inside it, together with these three agents. It is not a polished general-purpose product and it has rough edges. Issues are welcome; I may be slow to reply, and I apologise in advance.
- **Platforms.** Windows + WSL2 is the main platform. Native Linux is supported with required Ubuntu CI checks. macOS is experimental: I have no Mac, so it is tested only in CI. macOS reports are very welcome.
- **It grants access to the whole computer.** Anyone who can reach AIReins has the power of your user account on that machine. It therefore listens on loopback only, remote access goes only through Tailscale, and only the logins you allow get in. Please read [Security](#security) first.
- **It is not an agent farm.** To run a team of agents in parallel worktrees, [Orca](https://github.com/stablyai/orca) is a better fit. To use your whole computer from your phone and steer the agents yourself, use AIReins.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/how-en-dark.png">
  <img src="docs/assets/how-en-light.png" alt="Six steps: open, your tailnet, one process, official CLIs, whole computer, your call" width="100%">
</picture>

A browser on the same computer connects to `127.0.0.1` directly. Other devices join your tailnet first, then Tailscale Serve forwards them to AIReins' remote entry, which checks Host/Origin and admits only allowlisted Tailscale logins. AIReins is a single Node process listening on loopback only. It drives the three CLIs through their official protocols: Claude Code's stream-json, Codex's `codex app-server` and Kimi Code's ACP. Sessions are written to each CLI's own history; AIReins is just another way in. Protocol details are in [spikes/PROTOCOL-NOTES.md](spikes/PROTOCOL-NOTES.md).

## What you get

| | |
|---|---|
| **Three agents** | Claude Code, Codex and Kimi Code side by side; per-session model, reasoning effort and permission mode; slash commands, skills and `@` file mentions with completion; automatic titles, pinning, groups and renaming |
| **Approvals and questions** | Approve or deny tool calls and answer agent questions from any device; everything pending across sessions in one place |
| **Control mid-run** | Context-usage ring; interrupt; Claude Code and Codex also let you steer a running turn and ask side questions, while Kimi queues messages until the current turn ends |
| **Native history** | Search and filter the three CLIs' native history by folder and resume sessions; sessions started in AIReins resume in the CLIs and the VS Code extension, and the other way round (a Codex thread allows one writer at a time, so release it in AIReins before resuming elsewhere) |
| **Dispatch tree** | Sub-agents and delegated runs as a parent/child tree, on desktop and phone |
| **The whole computer** | File panel for any readable folder, with Git status and tabs; inside your home folder, Windows drives and the session folder, preview Markdown, code, images and PDF and edit UTF-8 text up to 1 MiB in place; multi-tab terminal (off on the remote entry until you enable it) |
| **Phone and Taildrop** | Phone layout installable as a home-screen app; send files or folders (zipped) to your online Taildrop devices |
| **Several computers** | Lists the other computers on your tailnet; add one with a click and switch between their AIReins instances from one menu |
| **On Windows** | Tray icon and Start-menu shortcut that open AIReins in its own app window |
| **English and Chinese** | Follows your browser language; switch under Settings → Appearance |

## A look

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/shots-en-dark.png">
  <img src="docs/assets/shots-en-light.png" alt="Three agents side by side on the desktop, the whole computer on the phone" width="100%">
</picture>

<p align="center"><sub>Screenshots from a local instance running on demo data; the sessions and paths are made up.</sub></p>

## How it compares

| | AIReins | Orca | Claude Code Remote Control | Codex Remote |
|---|---|---|---|---|
| What you control remotely | The whole computer: sessions, any folder, files, terminal | Workspaces/worktrees, agent sessions, terminal, git | One Claude Code session | Codex tasks on a host |
| Agents | Claude Code, Codex, Kimi | Many CLIs in a PTY | Claude Code | Codex |
| Network path | Your tailnet only; no AIReins or AI-vendor relay (Tailscale may fall back to its encrypted DERP relays) | Orca relay (account) by default; LAN or Tailscale optional | Anthropic relay | OpenAI relay |
| Phone client | Web app | iOS / Android apps (beta) | Claude app | ChatGPT app |
| Runs as | One Node process + browser | Desktop app (must stay open) | Your terminal (must stay open) | Desktop app |
| Best for | One person using one computer from anywhere | Running many agents in parallel worktrees | Quick check-ins on one session | Codex users in the ChatGPT app |

<!-- Comparison facts collected 2026-10-12; re-check before each release. -->

## Get started

### Platform support

| Platform | Status |
|---|---|
| Windows 11 + WSL2 (Ubuntu) | Supported: installer, tray, app window, remote gateway |
| Native Linux | Supported; required Ubuntu CI checks |
| macOS | Experimental; CI only, no maintainer hardware |
| Native Windows (no WSL) | Not planned for now |

### Windows + WSL2

Requirements:

| Dependency | Notes |
|---|---|
| Node.js ≥ 22.12 with npm | Required |
| `ss` (iproute2), `rg` (ripgrep) | Required |
| `zip` | For sending folders with Taildrop |
| `curl`, `python3` | Optional, for full `aireins status` output |
| Claude Code, Codex or Kimi Code CLI | At least one, installed and logged in |
| Google Chrome on Windows | For the app window |
| Tailscale on Windows | Optional, for remote access |

```bash
git clone https://github.com/yxhuang/AIReins.git && cd AIReins && bash install.sh
```

`install.sh` checks dependencies, installs npm packages, builds the frontend, installs the `aireins` command, the Windows tray icon and a Start-menu shortcut, and runs a smoke test. Run it again after `git pull` to update. `bash install.sh --check` only reports status and changes nothing.

Pin "AIReins" from the Start menu to the taskbar yourself; Windows offers no reliable way to do it programmatically.

Daily use:

```bash
aireins            # start in the background and open it in your default Windows browser
aireins status     # also: aireins stop | aireins restart | aireins logs
```

AIReins listens on `http://127.0.0.1:8790` (change with `WORKBENCH_PORT`). The tray icon and Start-menu shortcut open it as a Chrome app window.

### Native Linux / experimental macOS

Use the same `git clone` and `bash install.sh` commands. Native Linux needs Node ≥ 22.12, npm, `ss` (iproute2) and `rg`; macOS uses `lsof` instead of `ss` and needs `rg` (for example, `brew install ripgrep`). `aireins` opens `xdg-open` on Linux or `open` on macOS. Headless hosts can set `WORKBENCH_NO_OPEN=1`. No Windows tray, gateway, app window, directory picker or PowerShell is installed or offered on these platforms. Linux systemd deployment is optional; see [host setup](docs/host-connections.md).

WSL2 is the maintainer's daily platform. Ubuntu CI is a required gate; macOS CI may fail while experimental. The maintainer has no Mac, so macOS is tested only in CI. macOS supports file browsing and preview, but file editing and folder Taildrop remain disabled until secure directory-fd operations are available. Ordinary file Taildrop is supported. Please report macOS results in an issue.

## Remote access from your phone

When Tailscale is installed and logged in on Windows, `install.sh` sets up remote access:

1. It writes `~/.workbench/remote.json` (only if missing) with your MagicDNS HTTPS address and your Tailscale login. The remote terminal is **off** by default.
2. It installs a small Windows gateway plus `tailscale serve`, after one UAC prompt.

On native Linux and macOS, install and log in to Tailscale **on the same machine as AIReins**. The installer only creates a missing `remote.json` with `terminal: false` and prints the command for you to run; it never changes Tailscale Serve configuration:

```bash
tailscale serve --bg http://127.0.0.1:8793
```

Use the port printed by the installer if your existing configuration differs. On macOS the app CLI at `/Applications/Tailscale.app/Contents/MacOS/Tailscale` is a fallback when `tailscale` is absent from PATH. Serve forwards directly to the remote loopback listener; no Windows gateway is needed. Host/Origin checks and the Tailscale login allowlist are identical on all platforms. Remote terminal access requires an explicit `terminal: true` opt-in.

Open `https://<your-computer>.<tailnet>.ts.net/` on your phone and add it to the home screen. Details and troubleshooting: [deploy/windows/REMOTE.md](deploy/windows/REMOTE.md). If your browser uses a system proxy, add `*.ts.net` to its bypass list.

## Configuration

AIReins keeps its data in `~/.workbench`. `WORKBENCH_HOME` moves the server's data directory and the native POSIX remote installer's config directory. WSL installation, `aireins` logs and snapshots retain their existing paths. It does not change the three CLIs' global settings, except the Claude Remote Control default when you toggle it in AIReins.

Environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `WORKBENCH_PORT` | `8790` | Local port (always bound to `127.0.0.1`) |
| `WORKBENCH_HOME` | `~/.workbench` | Server data directory |
| `WORKBENCH_LOG` | `~/.workbench/server.log` | Log file written by `aireins` |
| `WORKBENCH_STATIC_DIR` | `frontend/dist` | Serve another frontend build |

Machine-specific options go in `~/.workbench/prefs.json`. They are not shown in the UI; restart AIReins after editing:

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

Anyone who can reach AIReins has the power of your user account on that computer. Keep it on loopback and your tailnet; never expose it with Funnel or port forwarding. Read [SECURITY.md](SECURITY.md) for the threat model and how to report a vulnerability.

## Last word

Agents will keep getting faster. I hope these reins let you ride with a little more confidence.

## License

The code is released under the [MIT License](LICENSE). The project name and logo and the third-party brand icons are not covered by it; see [NOTICE](NOTICE) for details and for what this repository does not include.
