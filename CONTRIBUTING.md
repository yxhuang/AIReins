# Contributing

Thanks for your interest. Workbench is a small, personal tool maintained by one person, so the most useful contributions are focused ones.

## What helps most

- **Bug fixes**, with steps to reproduce.
- **Platform support**: native Linux and macOS are not supported yet (see the README). Reports and patches from those platforms are very welcome.
- **Translations** and wording fixes.

For a larger feature, open an issue first so we can agree on the approach before you write code.

## Out of scope

Workbench stays a single Node process plus a web page, for one person on their own computer. These are deliberate choices:

- Desktop wrappers or rewrites (Electron, Tauri, Rust, Go).
- Managing fleets of agents in parallel git worktrees; [Orca](https://github.com/stablyai/orca) does that well.
- Hosted relays, accounts, or exposing Workbench to the public internet.

## Development setup

```bash
npm install
npm run server   # backend on 127.0.0.1:8790
npm run dev      # Vite dev server on :5173 (proxies to the backend)
```

Before opening a pull request, run everything listed under **Verify** in [AGENTS.md](AGENTS.md). Tests must not need a logged-in CLI or your own `~/.workbench`.

Behaviour and API contracts are documented in `server/README.md`, `frontend/README.md` and `spikes/PROTOCOL-NOTES.md`. Update the relevant document in the same pull request as the behaviour change.

## Pull requests

- One topic per pull request; keep unrelated refactors out.
- Describe what changed, why, and how you tested it (including the platform).

## Security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).
