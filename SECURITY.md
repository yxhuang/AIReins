# Security

Workbench gives whoever can reach it **the same power as your user account on that computer**: it runs AI agents with your credentials, reads and writes files anywhere your account can, and (when enabled) opens a shell. Treat access to Workbench as access to your machine.

## Threat model

What Workbench is designed for:

- **One person, their own devices, a private network.** The server is a single Node process on your computer. There is no relay, no Workbench account, and no telemetry.
- **Loopback only.** Both listeners bind to `127.0.0.1`. The local entry (default port 8790) serves the browser on the same computer. The optional remote entry (`~/.workbench/remote.json`) is reached only through [Tailscale Serve](https://tailscale.com/kb/1312/serve), which forwards from your tailnet to loopback.
- **Who can connect remotely.** A remote request must carry the `Tailscale-User-Login` header that Serve injects (Serve strips any client-supplied copy), and the login must be listed in `allowedLogins`. Write requests and WebSocket handshakes must also carry an `Origin` that exactly matches the configured origin.
- **Browser attacks.** Every request is checked against a Host allowlist (blocks DNS rebinding). On the local entry, write requests and WebSocket handshakes that carry an `Origin` must come from a local Workbench page (blocks cross-site request forgery and WebSocket hijacking). Pages are served with `X-Frame-Options: DENY` and `frame-ancestors 'none'`.
- **Remote terminal is opt-in.** The free-form terminal is available on the remote entry only when `remote.json` sets `"terminal": true`.

What Workbench does **not** protect against:

- **Other processes running as your user.** Local processes can call the local entry directly. This is by design: they already have the same rights.
- **A compromised device that is on your allowlist.** An allowed phone or laptop has full access.
- **Public exposure.** Do not use Tailscale Funnel, a reverse proxy, port forwarding, or `0.0.0.0` binding to put Workbench on the internet. These setups are unsupported and remove the identity check.
- **What the agents themselves do.** Claude Code, Codex and Kimi run with the permission modes you choose. Workbench does not sandbox them beyond what each CLI provides.

## Reporting a vulnerability

Please report security issues privately through GitHub's **[private vulnerability reporting](../../security/advisories/new)** for this repository. Do not open a public issue.

Include the version or commit, your platform (WSL, Linux or macOS), and steps to reproduce. You should get a first response within 7 days. Once a fix is released, the advisory will credit you unless you prefer otherwise.

Issues in scope include authentication or Origin/Host check bypasses, path traversal in the file, preview, upload or Taildrop endpoints, unintended command execution, and secrets written to logs. Problems in Claude Code, Codex, Kimi or Tailscale themselves should go to those projects.
