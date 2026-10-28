# Pi Hub

A self-hosted browser/PWA control room for [Pi](https://pi.dev) agents, with a distributable Pi extension. Keep agent execution, files, and provider credentials on your own machine; access the console from a desktop or phone.

**Early release. This is a privileged single-owner administrative console, not an execution sandbox.** Review the source before installing. Prefer private networking; if exposing it publicly, use HTTPS and enroll 2FA immediately.

## Features

- Attach terminal Pi sessions, or launch separate browser-managed **Pi or Codex CLI** agents.
- Live Markdown, code, tables, and KaTeX mathematics, including `$…$`, `$$…$$`, `\(…\)`, and `\[…\]`.
- Readable paired tool calls/results, file paths, shell output, edit diffs, and structured subagent reports. Empty reasoning is hidden; assistant/tool rounds share one response label.
- Visible steering/follow-up queues, abort, compaction, renaming, model/thinking controls, and supported RPC extension dialogs.
- Current context tokens/window/percentage and live automatic/manual compaction status, refreshed every 15 seconds and on agent start/settle. Context is unknown after compaction until the next model response. Existing attached sessions need `/reload` after updating the extension.
- Slash autocomplete for the selected agent's extensions, skills, templates, and web controls. CLI-only commands are labelled rather than sent as model prompts.
- Latest 40 messages initially; earlier history loads in batches with stable scrolling, including saved sessions beyond the live buffer.
- Password + authenticator-app 2FA, one-use recovery codes, 12-hour ordinary sessions, and optional revocable **30-day trusted browsers**.
- Drag-to-reorder agents, with keyboard/mobile move-up/down controls and order remembered per browser. Page reloads restore the last selected agent when it is still available; otherwise, the first available agent is selected.
- Foldable agent sidebar (desktop choice remembered per browser), mobile drawer with Escape/backdrop dismissal, image/text attachments, transcript export, and an installable PWA shell. Conversations and API responses are not cached offline.
- **F11 reading mode** (also under Activity): full-screen transcript with hidden sidebar/chrome. Move the pointer to the top/bottom edge to reveal the header/composer; controls auto-hide when you move away, except while focused. Escape or F11 exits. On touch screens, tap the transcript to briefly reveal controls. If native fullscreen is unavailable, the same reading layout fills the browser viewport.

## Quick start

Requires **Node 22.19+**, npm, and a working Pi CLI/provider login. Tested against Pi **0.87.1** on Linux/WSL; the server is designed for Linux/macOS/WSL, not native Windows. Browser-managed agents use the `pi` executable on your PATH, or `PI_HUB_PI_BIN`.

```bash
git clone https://github.com/EricWay1024/pi-hub.git
cd pi-hub
npm ci --ignore-scripts
npm run setup                 # hidden password input; choose a projects directory
npm run build
npm start                    # loopback-only, default port 7433
```

Open **http://127.0.0.1:7433** using that exact hostname/origin. In another terminal, attach Pi using the same local checkout:

```bash
pi install /absolute/path/to/pi-hub
```

Existing Pi sessions need `/reload`; new sessions load the extension automatically. `/hub` reconnects and `/hub-off` disconnects a terminal session. The web service must remain running. Installing the extension alone does not start the service or provision a public URL.

### Install the extension from GitHub

Pi's standard git-package installer also works:

```bash
pi install git:github.com/EricWay1024/pi-hub
```

Configure/start the web service with the quick-start instructions above. Both copies read the same owner-only hub configuration. Do not also register the local checkout as an extension: choose one extension source to avoid duplicate loading.

Update or remove a GitHub installation with:

```bash
pi update git:github.com/EricWay1024/pi-hub
pi remove git:github.com/EricWay1024/pi-hub
```

This release is distributed through GitHub, not published to the npm registry. `package.json` declares `pi.extensions` and the `pi-package` keyword. The private npm flag prevents accidental registry publication; it does not prevent Pi git-package installation.

## Authentication

Setup saves a random local agent token and salted scrypt password hash in `~/.config/pi-hub/config.json` (owner-only). `PI_HUB_CONFIG` selects another configuration. Unattended setup accepts `PI_HUB_PASSWORD`, `PI_HUB_PROJECTS_ROOT`, and optionally `PI_HUB_ORIGIN`; do not put secrets in shell history, chat, screenshots, or version control.

### Enroll 2FA

**2FA is off until enrollment is confirmed.** Your password still works before then.

1. Sign in and open **Security · 2FA off** (open the agent menu first on mobile).
2. In your own local terminal—not an agent/chat—read `~/.config/pi-hub/config.json.2fa-enrollment-token`. The backend creates this owner-only token. For custom configurations, append `.2fa-enrollment-token` to the configuration filename.
3. Enter the token and workspace password in the security dialog.
4. Scan the QR code with an authenticator such as 2FAS, Aegis, Google Authenticator, or Microsoft Authenticator. Confirm a six-digit code within five minutes.
5. Store the ten one-use recovery codes securely. They are shown once and still require your password. Activation removes the enrollment-token file and revokes old sessions.

Authenticator codes use standard RFC 6238 TOTP (SHA1, six digits, 30 seconds). Accepted counters and consumed recovery hashes are persisted to prevent reuse across restarts. Wait for a fresh code if the current one was already used. Keep phone and server clocks synchronized.

### Trust a personal browser

At a fresh password + 2FA login, optionally select **Trust this browser for 30 days**. It stays signed in for a fixed 30 days, including across backend restarts; use does not extend its expiry. Only token hashes are saved server-side. Ordinary logins remain 12 hours and do not survive restarts.

**Security → Trusted browsers** lists remembered browsers and lets you forget one or all. Forgetting a browser invalidates its cookie and open connection. Signing out forgets the current browser. Password changes and 2FA resets invalidate every remembered browser. Browser cookies are powerful credentials: trust only a personal, secured device, never a shared computer. This option deliberately trades more persistent access for convenience.

### Recovery and password changes

Use a saved recovery code if the phone is lost. If both phone and recovery codes are lost, the machine owner can run `npm run reset-2fa`, enter the current password, restart the service, and enroll again. This reset is not exposed over the web.

```bash
npm run password             # change password locally, hidden input
# Restart the backend afterward to apply changes and revoke live sessions.
```

Local credential changes prevent the running backend from overwriting those changes; restart it before continuing authentication-state operations.

## Remote access and services

Keep the hub bound to loopback. Prefer a private VPN/tunnel. For public access, set `origin` in the private configuration to the exact HTTPS URL and put a trusted TLS reverse proxy in front of it. The proxy must overwrite `X-Real-IP` with the actual client IP. Block public access to `/agent`; registration is for local agents only.

`deploy/nginx.example.conf` is a template: replace `hub.example.com` and TLS certificate paths with your own values. Copy `deploy/unavailable.html` to `/var/www/pi-hub/unavailable.html` **on the proxy host** (readable by nginx), then validate with `nginx -t` before reloading nginx. The proxy serves this error page with a **Refresh** button when the backend/tunnel is unavailable, including for first-time visitors. Existing proxy installations need these template changes applied manually.

The web app distinguishes an unreachable workspace from a signed-out session, shows a persistent connection warning when disconnected, and retries automatically. **Refresh** rechecks the connection and reloads live agent snapshots without clearing your draft or resending commands. A cached PWA shell can show the warning offline; a fresh browser cannot display the app if neither its server nor the proxy error page is reachable.

An SSH reverse tunnel can expose a remote **loopback-only** port; never forward it to `0.0.0.0`.

On Linux/WSL with user systemd:

```bash
bash deploy/install-local-services.sh                  # local hub only
# Optional reverse tunnel using an existing SSH alias/key:
PI_HUB_SSH_HOST=my-vps bash deploy/install-local-services.sh
systemctl --user status pi-hub pi-hub-tunnel
journalctl --user -u pi-hub -u pi-hub-tunnel -f
```

**Current personal deployment (2026-10-26):** `https://rp.yw.je` now uses the NixOS VPS at `179.237.124.203`. The canonical WSL user unit remains `pi-hub-tunnel.service`, forwarding remote `127.0.0.1:7433` to WSL `127.0.0.1:7433` through SSH alias `truss` (`eric@179.237.124.203:22`). The old VPS is retained under alias `truss-old` (`95.179.224.75:1989`) as a temporary origin bridge, not a second hub. The migration did not restart `pi-hub.service` or move its data off WSL. The temporary `pi-hub-tunnel-nixos-staging.service` is disabled; do not enable it alongside the canonical unit because both claim the same forwarded port. Production proxy configuration, the `/agent` block, unavailable page, TLS renewal and SSH server keepalives are declared in `../move-vps/`; do not hand-edit generated NixOS nginx files.

### Automatic tunnel recovery

The optional tunnel uses the configured hub port on both ends and does not copy provider credentials. `deploy/tunnel.ts` supervises a dedicated SSH connection, with a 10-second connection timeout and retries every five seconds. Every ten seconds it sends an application heartbeat; the VPS checks the Hub HTTP endpoint **through the reverse forward** and acknowledges it. Missing acknowledgements for 45 seconds trigger a tunnel-only reconnect. Failed forwarded HTTP checks also trigger reconnect when the local Hub is healthy; a Hub outage does not restart agents or churn healthy SSH connections.

Crucially, `deploy/tunnel-remote.sh` also runs **on the VPS inside that same SSH session**. If heartbeats stop, it terminates only its own parent SSH session, freeing the forwarded port even when TCP/SSH keepalives are stuck. SSH multiplexing is explicitly disabled so this cannot close another shared SSH connection. It never finds and kills arbitrary port owners; an unrelated port conflict is logged and retried, not forcibly removed. The remote host needs Bash, curl, and standard `ps`/`tr` tools, but no sudo or separately installed watchdog service.

Upgrade an existing tunnel without rewriting or restarting Hub:

```bash
PI_HUB_TUNNEL_ONLY=1 PI_HUB_SSH_HOST=my-vps bash deploy/install-local-services.sh
systemctl --user restart pi-hub-tunnel.service
journalctl --user -u pi-hub-tunnel -f
```

A network switch can still interrupt browser connections briefly. Recovery normally takes around a minute once a working route is available; it is not a guarantee while the computer is asleep or the network/VPS is unreachable. The browser reconnects without replaying commands. A legacy, already-stale tunnel created **before** this upgrade has no remote watchdog and may need one last manual cleanup as described below.

Retain **server-side SSH keepalives on the VPS** as an additional safeguard:

```text
# Global sshd settings (outside Match blocks):
ClientAliveInterval 20
ClientAliveCountMax 3
```

Back up the SSH configuration, validate with `sudo sshd -t`, and reload (not restart) the appropriate SSH service. Reconnect the tunnel for new settings to apply. These probes disconnect unresponsive clients, not healthy idle sessions. Keepalives alone did not reliably release a stalled forwarding port after a WSL route change; the application-level watchdog above does not rely on their TCP timeout behaviour. A tunnel restart does not stop Pi agents. If a port stays occupied, inspect its listener and confirm the upstream is dead before terminating only that stale SSH session—never blindly kill all SSH processes.

Systemd does not keep Windows awake or automatically start WSL after Windows reboot. The site is unavailable while the local host/network is offline; keepalives improve recovery, not offline availability. macOS users can run `npm start` under their own process supervisor.

**Restarting the hub stops browser-managed Pi and Codex processes.** Check the inventory first. Attached Pi terminal agents are independent and reconnect. Use **Resume sessions** to reopen saved conversations; processes are never automatically restored.

## Resume saved sessions

Choose **Resume sessions** in the sidebar (or `/resume`) to browse saved **Pi and Codex** conversations, newest first. Select a workspace or leave **All workspaces** selected; an optional directory field supports nested workspaces. Filter by engine and search session names, first-message previews, folders or IDs. Results page in batches of 50. The index is capped at the newest 2,000 sessions per filter; choose a narrower workspace to reach older conversations.

Resume preserves the saved conversation rather than starting a new one, loads its latest 40 messages, and keeps older history available on demand. Pi uses its saved session file and Codex uses `thread/resume`; legacy Codex CLI history uses native hydrated turns when item pagination is unavailable. No user prompt is sent automatically. Existing local agents connected to Hub are opened instead of duplicated, and concurrent resume requests for the same saved session are coalesced.

This is **saved-history resume, not attachment to an unconnected live terminal**. Finish or close that conversation in its other terminal first. Hub cannot reliably detect every external process that might be using the same saved session. Workspaces must still exist inside `projectsRoot`. Only authenticated metadata is listed; browsers cannot submit arbitrary session-file paths. Pi discovery covers default storage, configured global/environment storage and first-level projects' custom `sessionDir` settings; select a nested workspace explicitly for its custom storage. Missing optional Codex installation does not block Pi discovery.

## Codex CLI agents

Install and sign in to the Codex CLI locally, then choose **Codex CLI** in **New agent → Agent engine**. Tested against **Codex 0.159.2**. The service must find `codex` on its PATH; the installer includes `~/.local/bin`, or set `PI_HUB_CODEX_BIN` to its executable. Codex is optional; Pi-only operation is unchanged.

Each Hub-launched Codex conversation owns a private `codex app-server --stdio` process, using native local login/configuration and preserving hook trust. New and resumed Hub-owned threads explicitly use **`sandbox: danger-full-access` and `approvalPolicy: never`**: filesystem/network access is unrestricted by Codex's sandbox and command approval prompts are disabled. Commands can affect anything the Hub user's OS permissions allow, not just the workspace. This does not grant root privileges, change standalone Codex defaults, or alter already-running threads; reopening an agent already running in Hub keeps its current permissions. Stop and resume it to apply the new policy after the updated backend is loaded. The browser never connects directly to an exposed Codex server. Command/file approvals offer **Approve once**, **Deny**, and **Cancel**; input questions are supported. Other server-request types fail closed without granting permissions.

Supported: streamed messages/reasoning, shell/file/MCP/subagent tool cards, steering with an active-turn precondition, interrupt, rename, manual/native compaction status, context battery and native paginated item history. Model and reasoning choices come from Codex's catalog and apply to the next submitted turn. Pi defaults do not configure Codex. Pi extension commands and Codex CLI-only commands are not forwarded as model prompts. Follow-up queues are not yet supported for Codex; use steering.

Stopping one Codex agent stops only its private app-server, not existing terminal sessions or the shared Codex daemon. Hub restart stops all Hub-managed processes, including Codex. Saved threads can be resumed through **Resume sessions** or the Codex CLI. Attaching to an external live Codex process or sharing its daemon is **not yet implemented**. Offline Codex agents expose only their buffered history. Lost acknowledgements are never automatically retried.

## Usage and limitations

Type `/` to browse commands. Arrow keys navigate; Tab/Enter completes; Esc dismisses; Ctrl/⌘ + Enter sends. Click suggestions on mobile. Web equivalents include `/help`, `/model`, `/thinking`, `/name`, `/compact`, `/abort`, `/copy`, `/export`, `/session`, `/resume`, and `/settings`. `/export` downloads displayed messages as JSON. CLI-only commands such as `/reload`, `/login`, and `/tree` still require the terminal.

Attached extension dialogs may also require their terminal; managed RPC agents support standard extension dialogs, not arbitrary terminal custom UI. Subagent/provider tools and lifecycle events are presented, but the hub is not a separate scheduler or cross-session messaging service.

Managed agents expose their native queue. Attached agents use observed input; cancellation or transformed/template input may not reconcile until the agent settles. Older extensions label web submissions **Submitted** until delivery is observed. Reload attached sessions for CLI queue tracking. Input queued before a reload cannot be recovered through the extension API.

The live recovery buffer is 300 messages per agent; snapshots contain the latest 40 plus 100 tool/activity records. Older pages follow the current ancestry in saved session files, not abandoned branches. `--no-session` runs cannot recover older history. If a command confirmation is lost, inspect history before resending: reconnect does not resend commands automatically.

Attachments support images and text/source files (4 MB each). Export saves the displayed transcript, not necessarily the entire conversation.

Markdown links to local files open through an authenticated, read-only file endpoint. Relative paths resolve from the selected agent's workspace; absolute paths and local `file://` links work inside `projectsRoot`. Editor-style `:line:column` suffixes and `#Lline` anchors open the corresponding line in text previews. PDFs and raster images open inline; other binary files download. Text previews are limited to 2 MB / 20,000 lines, with larger text files downloaded instead; files above 50 MB are rejected. HTML, SVG, and source code are escaped, never executed. Symlink escapes, directories, files outside `projectsRoot`, and files that exist only in a remote/cloud sandbox are not served. Local file access requires the Hub backend to include this endpoint, so backend updates need a safely reviewed restart.

Independent live agents are never merged by name or working directory. Attached IDs survive extension reloads; stale offline entries for the same host/session are pruned without deleting session files.

## Security model

Anyone signed in can execute commands as the server's user through agents/extensions. Launch paths are confined to the configured projects root with realpath/symlink checks, but this is **not a file-access or execution sandbox**. Do not share access or local registration tokens.

- HttpOnly/SameSite cookies; Secure cookies and HSTS when HTTPS is configured; fixed-origin mutation/WebSocket checks; CSP blocks remote images and framing.
- Login/enrollment per-IP throttling and a global authentication-work cap; password-verified TOTP attempts are capped account-wide across IPs (eight per five minutes). Recovery codes bypass the authenticator-only cooldown, not other throttles.
- Enrollment requires the password and a machine-local token, not merely an existing browser cookie.
- Authentication configuration is replaced atomically with owner-only permissions. The server-required TOTP seed is stored in that private file, not encrypted with a separate external key. Protect your machine and backups.
- Remembered tokens are hashed and bound to the password hash, authenticator seed, and configured origin. Revocation is persisted. Only browser names/dates/IDs are returned by the management API.
- Raw Markdown HTML and trusted KaTeX commands are disabled. TOTP is **not phishing-resistant** like hardware keys/passkeys. Only sign in at your exact trusted URL.

No independent security audit has been performed. Public exposure of an agent execution console carries risk even with 2FA.

## Development and checks

```bash
npm ci --ignore-scripts
npm test
npm run check
npm run build
npm audit
```

Use a separate test configuration for Vite development: set its origin to `http://127.0.0.1:5173`, start the backend, then `npm run dev`. Never repurpose the live configuration for development.

Tests cover authentication, TOTP vectors/replay/recovery, trusted-browser lifetime/restart/revocation, WebSockets, extension lifecycle, slash dispatch, math, paths, readable output, queues, saved-history pagination, and tunnel recovery. The opt-in `tests/tunnel-live.test.ts` uses an unused remote loopback port (default 17433), checks remote heartbeat expiry, and freezes only its own test SSH process to verify automatic recovery:

```bash
PI_HUB_TUNNEL_TEST_HOST=my-vps node --import tsx --test tests/tunnel-live.test.ts
```

Never use the production forwarding port for fault tests. Chromium fixtures have also checked mobile layout, 901-message pagination/scrolling, command completion, enrollment, recovery, and remembered-browser restart/revocation. GitHub Actions runs the test/typecheck/build/audit checks on pushes and pull requests.

The Pi development SDK's shrinkwrap can restore vulnerable `brace-expansion` despite npm's root override. The project locks an independent patched 5.0.12 dev dependency and copies it over the SDK copy before tests/checks/builds, without downloads or third-party install scripts. After updates, check both `npm ls brace-expansion` and `npm audit`; `npm run harden-deps` also runs the fix explicitly.

## License

MIT. Contributions and issue reports are welcome; do not include credentials or private agent/session output.
