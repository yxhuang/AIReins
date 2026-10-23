# Changelog

## Unreleased

### Changed

- Windows cold starts show a local loading window while the backend starts. Opening an already running instance skips the WSL launch command.
- Windows shortcuts use an installer-built launcher to forward requests to a running tray without starting PowerShell. Cold starts load the precompiled tray types; upgrades keep recoverable entry-file backups.
- Page initialization loads independent requests in parallel and restores the active conversation without waiting for project ordering or extension pages. CLI metadata probes run in the background even on the first launch; connected pages refresh when probing finishes.

### Fixed

- Codex workers and configuration probes can use a machine-local `codexProxyUrl` preference even when AIReins starts without proxy variables. The endpoint stays configured while the proxy is offline, so later connections can recover when it returns; failed turns are not replayed automatically.

## 0.2.2 (2026-10-20)

### Fixed

- Worktree detection no longer blocks the server on a special `.git` file (such as a FIFO), and permission errors or symlink loops no longer stop a session from starting; they are treated as "not a worktree".
- A session whose folder is a symlink into a worktree is now recognized. Bare repositories and `--separate-git-dir` repositories, whose main folder cannot be determined, are no longer grouped under the Git metadata folder.
- Sidebar search also matches a worktree session's main repository path (including its Windows drive form) and branch name.

## 0.2.1 (2026-10-20)

### Changed

- Sessions started inside a linked Git worktree (`git worktree add`) are grouped in the sidebar under their main repository instead of appearing as a separate project, and each such row shows its branch name. AIReins only reads the worktree's `.git` metadata and does not create, merge or remove worktrees.

## 0.2.0 (2026-10-19)

### Added

- Local Windows + WSL and macOS file-panel menus can open files with the system default application and folders in the file manager. The action follows workspace authorization checks and is unavailable through remote access or on native Linux.
- Markdown file previews can open local document links in the file panel, resolving relative paths from the Markdown file's directory and preserving unsaved-change confirmation. Web links open in a separate tab.

### Changed

- Light-theme inputs and floating panels use a warm off-white surface, with matching warm-gray scrollbars in explicit light mode and when following a light system theme.
- Normal and focus conversation views hide raw debug-event cards while preserving the original event records for diagnostics; normalized errors, tool results, approvals and questions remain visible under the existing view rules.
- Privacy checks now have versioned commit hooks and scan every incoming commit in CI, including filenames, commit messages and author metadata. Local handoff documents stay outside the public repository.

### Fixed

- The native Windows folder/file picker is no longer blurry on high-DPI displays, and it now comes to the front instead of flashing in the taskbar.
- Resuming a native session first stops an idle or failed AIReins worker that still owns it. Busy sessions, concurrent resumes, deletion and worker restarts are guarded against competing writers.
- Claude native-title detection retries after registering its file watcher, covering macOS watcher startup delays.
- The installer handles macOS Bash 3.2 variable and empty-array edge cases; CI fixtures use consistent shell, platform and temporary-directory behavior on macOS.

## 0.1.0 (2026-10-17)

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
- Strongly recommend the independent ai-usage quota panel; the installer supports optional setup and sidebar connection with `--with-ai-usage` / `--without-ai-usage`, service identity checks, preserved manifests and read-only `--check` status.
- Released under the MIT License; [NOTICE](NOTICE) lists what it does not cover.
