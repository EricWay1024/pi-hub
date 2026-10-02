# Security

Pi Hub is an early-release, single-owner agent execution console. There has been no independent security audit. Authenticated users can execute commands as the machine's user; project launch-path checks are not a sandbox.

Prefer private networking. Public deployments require a trusted HTTPS reverse proxy, blocked public `/agent` access, a strong password, and confirmed 2FA enrollment. Trust a browser only on a personal secured device: its cookie permits administrative access until expiry or revocation.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** feature on this repository's Security tab. Do not file public issues containing exploit details, passwords, cookies, enrollment tokens, authenticator seeds, recovery codes, provider credentials, or private conversation/session output.

Reports should include the affected version/commit, a minimal reproduction using dummy data, expected/actual behavior, and impact. Do not test against other people's deployments without their permission.

## If access may be compromised

From a safe device, forget affected trusted browsers (or all) in Security settings. Change the workspace password locally and restart the backend. A password change invalidates remembered-browser records; a restart revokes ordinary sessions and stops browser-managed agents. Review agent activity and files—revoking authentication cannot undo commands already executed.

If the authenticator seed/recovery material is compromised, use the local `reset-2fa` command, restart, and enroll a new authenticator. Protect local configuration and backups; do not attach them to reports.
