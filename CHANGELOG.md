# Changelog

## 0.1.0 (unreleased)

First public release.

- The CLI command is now `aireins` (formerly `wb` / `workbench`); installation removes old symlinks that point to this repository's launcher.
- The Windows tray installs to `%LOCALAPPDATA%\AIReins` with `aireins.ico` (formerly `%LOCALAPPDATA%\workbench`); reinstalling repoints existing shortcuts and taskbar pins and leaves the old folder in place.

- English and Simplified Chinese interface, with a per-browser language preference.

- Claude Code, Codex and Kimi Code sessions in one browser UI: approvals, questions, slash commands, skills, `@` mentions, model and effort switching, interrupt and steer.
- Native history browser with folder filter; resume sessions from and into the CLIs and the VS Code extension.
- File panel: browse any directory with Git status and tabs; preview and edit supported files in your home folder, Windows drives and session folders; multi-tab terminal; Taildrop sending.
- Dispatch view for sub-agents and delegated runs.
- Phone layout; remote access through Tailscale Serve with a login allowlist; switching between computers on the tailnet.
- Windows + WSL2 installer with tray icon, Start-menu shortcut and remote gateway; the installer, launcher, tray and gateway prompts follow the system language (Simplified Chinese / English), as does the window title the tray recognizes.
- Native Linux support and experimental macOS installation/startup, platform capabilities that hide unavailable actions, and Ubuntu/macOS CI with isolated startup checks. macOS file editing and folder Taildrop remain disabled pending secure directory-fd support.
- On native Linux and macOS the terminal opens the server process's `$SHELL` (an executable absolute path, listed in `/etc/shells` when that file exists), falling back to `/bin/zsh` then bash on macOS and bash on Linux; WSL keeps bash. On native Linux and macOS the installer enables Tailscale Serve automatically when it has no configuration yet (never overwriting an existing one), and on macOS offers to `brew install` a missing Node or ripgrep.
- Released under the MIT License; [NOTICE](NOTICE) lists what it does not cover.
