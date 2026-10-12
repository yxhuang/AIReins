# Contributing

Thanks for your interest. Workbench is a small, personal tool maintained by one person, so the most useful contributions are focused ones.

## What helps most

- **Bug fixes**, with steps to reproduce.
- **Platform support**: WSL2 is the daily platform; native Linux has required Ubuntu CI checks, and macOS is experimental with CI-only coverage (no maintainer hardware). macOS issue reports and focused platform fixes are welcome.
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

CI runs `npm ci`, build, all verification commands and an isolated startup check on Node 22.12. Ubuntu must pass; macOS uses `continue-on-error` while experimental.

Before opening a pull request, run everything listed under **Verify** in [AGENTS.md](AGENTS.md). Tests must not need a logged-in CLI or your own `~/.workbench`.

Behaviour and API contracts are documented in `server/README.md`, `frontend/README.md` and `spikes/PROTOCOL-NOTES.md`. Update the relevant document in the same pull request as the behaviour change.

## Pull requests

- One topic per pull request; keep unrelated refactors out.
- Describe what changed, why, and how you tested it (including the platform).

## Security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
