# AGENTS.md

AIReins: one Node process (`server/`) plus a Vite/React page (`frontend/`) that drives Claude Code, Codex and Kimi Code through their official CLIs, for one person on their own computer and tailnet.

If `.work-orders/HANDOFF.md` exists (a local, untracked file), read it first: it holds the maintainer's current state and open tasks.

## Sources of truth

Read the relevant one before changing behaviour, and update it in the same change:

- `server/README.md`: API contracts, access control, remote entry, config files, diagnostics.
- `frontend/README.md`: frontend architecture, navigation and UI rules.
- `spikes/PROTOCOL-NOTES.md`: the three CLI protocols (Claude stream-json, Codex app-server, Kimi ACP) as observed.
- `docs/terminal-panel-design.md` §9: terminal contract. `docs/host-connections.md`: install and host switching.

These documents are in Chinese; write additions in the language of the surrounding text.

## Verify

A change is done when all of these pass:

```bash
npm test
npm run test:hosts
node deploy/windows/tests/install-remote.test.mjs
npm run typecheck && npm run typecheck:frontend && npm run check:theme && npm run check:i18n
```

Keep interface copy in the paired dictionaries in `frontend/src/i18n/`; follow `TERMS.md` there. Register each justified literal exception in `frontend/scripts/check-i18n.mjs`.

The second and third are outside `npm test`; run them too. Tests must not depend on a logged-in CLI, the user's `~/.workbench`, or a built `frontend/dist`.

## Constraints

- **Stack**: Node + Vite only. Propose any new runtime dependency in an issue first.
- **Build**: `npm run build` keeps old hashed assets in `frontend/dist` (`emptyOutDir: false`) because open pages still reference them. Keep it that way.
- **Running instance**: backend changes take effect after `aireins restart`; that stops every running session, so check `aireins status` and let the user choose the moment. Frontend changes need `npm run build` and a page refresh (the backend serves `frontend/dist`); under `npm run dev` a refresh is enough.
- **Security boundary**: both listeners bind `127.0.0.1`. Keep the Host/Origin checks and the Tailscale login allowlist exactly as strict; remote access goes through Tailscale Serve only. See `SECURITY.md`.
- **CLI state is the user's**: read the three CLIs' global config, never write it; per-session settings stay per-session. The one exception is the Claude Remote Control default (`remoteControlAtStartup`), written through the existing symlink without replacing it.
- **Deleting native sessions** goes only through `codex delete --force` and Kimi ACP `session/delete`, keeping the realpath, reference and identity guards.
- **Codex single writer**: release an AIReins session before another client resumes the same Codex thread.
- **Logs** carry no secrets. Pass proxy variables through in both cases (`HTTPS_PROXY` and `https_proxy`).
- **Machine-specific behaviour** lives in `~/.workbench/prefs.json`, never in the repository (see `server/README.md`).
- **Windows tray** (`deploy/windows/wb-tray.ps1`) finds the window by page title: when `workbenchWindowTitle` in `frontend/src/host-connections.ts` changes, update `IsWbTitle` to match. `Open-Workbench` manages its own Busy flag; call it without setting Busy first. Tray changes reach users only after `bash install.sh` and a tray restart.
