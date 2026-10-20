# Contributing

Thanks for your interest. AIReins is a small, personal tool maintained by one person, so the most useful contributions are focused ones.

## What helps most

- **Bug fixes**, with steps to reproduce.
- **Platform support**: WSL2 is the daily platform; native Linux has required Ubuntu CI checks, and macOS is experimental with CI-only coverage (no maintainer hardware). macOS issue reports and focused platform fixes are welcome.
- **Translations** and wording fixes: edit the paired dictionaries in [`frontend/src/i18n/`](frontend/src/i18n/), follow [TERMS.md](frontend/src/i18n/TERMS.md), and run `npm run check:i18n` ([check script](frontend/scripts/check-i18n.mjs)).

For a larger feature, open an issue first so we can agree on the approach before you write code.

## Out of scope

AIReins stays a single Node process plus a web page, for one person on their own computer. These are deliberate choices:

- Desktop wrappers or rewrites (Electron, Tauri, Rust, Go).
- Managing fleets of agents in parallel git worktrees; [Orca](https://github.com/stablyai/orca) does that well.
- Hosted relays, accounts, or exposing AIReins to the public internet.

## Development setup

```bash
npm install
npm run server   # backend on 127.0.0.1:8790
npm run dev      # Vite dev server on :5173 (proxies to the backend)
```

CI runs `npm ci`, build, all verification commands and an isolated startup check on Node 22.12. Ubuntu must pass; macOS uses `continue-on-error` while experimental.

Before opening a pull request, run everything listed under **Verify** in [AGENTS.md](AGENTS.md). Tests must not need a logged-in CLI or your own `~/.workbench`.

Behaviour and API contracts are documented in `server/README.md`, `frontend/README.md` and `spikes/PROTOCOL-NOTES.md`. Update the relevant document in the same pull request as the behaviour change.

Install the versioned privacy hooks in each clone:

```bash
npm run hooks:install
git config --local aireins.privatePatterns /absolute/path/to/private-patterns.txt
```

The same hooks rebuild the frontend after `git pull` (merge or rebase) when `frontend/`, `shared/` or `package*.json` changed, and only print a reminder for `npm install` or `aireins restart`; `bash install.sh` enables them when `core.hooksPath` is unset. Keep the private pattern file outside version control. The hooks check staged content and commit messages; if the setting is absent or its file is missing, they warn and continue with generic rules. Hooks can be bypassed and do not replace a review before publishing. Avoid real session IDs, personal paths and credentials in fixtures or screenshots.

CI checks every incoming commit with `node scripts/check-privacy.mjs --range <base>..<head>` (push: before..sha, or the default branch..sha for new branches and tags; pull request: base..head), including commit metadata, and also runs the full-tree `npm run check:privacy`. CI has no local private pattern file. Binary files and images skip automatic content checks: manually inspect visible text and metadata before committing them. A passing check does not establish that an image is safe to publish.

## Pull requests

- One topic per pull request; keep unrelated refactors out.
- Describe what changed, why, and how you tested it (including the platform).

## Security issues

Do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
