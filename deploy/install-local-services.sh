#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
NODE="$(command -v node)"
NODE_DIR="$(dirname "$NODE")"
SSH_HOST="${PI_HUB_SSH_HOST:-}"
TUNNEL_ONLY="${PI_HUB_TUNNEL_ONLY:-0}"
if [[ "$TUNNEL_ONLY" == 1 && -z "$SSH_HOST" ]]; then
  printf 'PI_HUB_TUNNEL_ONLY requires PI_HUB_SSH_HOST.\n' >&2; exit 1
fi
if [[ -n "$SSH_HOST" && ! "$SSH_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.@-]*$ ]]; then
  printf 'PI_HUB_SSH_HOST must be a simple SSH alias or user@host.\n' >&2; exit 1
fi
PORT="$("$NODE" --input-type=module -e 'import{readFileSync}from"node:fs";import{homedir}from"node:os";import path from"node:path";const c=JSON.parse(readFileSync(process.env.PI_HUB_CONFIG||path.join(homedir(),".config/pi-hub/config.json"),"utf8"));if(!Number.isInteger(c.port)||c.port<1||c.port>65535)throw Error("Invalid configured hub port");console.log(c.port)')"
quote_unit() {
  local value="$1"
  value="${value//\\/\\\\}"; value="${value//\"/\\\"}"; value="${value//%/%%}"
  printf '"%s"' "$value"
}
mkdir -p "$HOME/.config/systemd/user"
# Generated units contain executable paths, never passwords or registration tokens.
if [[ "$TUNNEL_ONLY" != 1 ]]; then
printf '[Unit]\nDescription=Pi Hub workspace\nAfter=network.target\n\n[Service]\nWorkingDirectory=%s\nExecStart=%s %s %s\nEnvironment=%s\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n' "$(quote_unit "$ROOT")" "$(quote_unit "$NODE")" "$(quote_unit "$ROOT/node_modules/tsx/dist/cli.mjs")" "$(quote_unit "$ROOT/server/cli.ts")" "$(quote_unit "PATH=$NODE_DIR:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin")" > "$HOME/.config/systemd/user/pi-hub.service"
if [[ -n "${PI_HUB_CONFIG:-}" ]]; then
  printf '\n# Custom configuration path (not its contents).\n[Service]\nEnvironment=%s\n' "$(quote_unit "PI_HUB_CONFIG=$PI_HUB_CONFIG")" >> "$HOME/.config/systemd/user/pi-hub.service"
fi
fi
if [[ -n "$SSH_HOST" ]]; then
  command -v ssh >/dev/null
  printf '[Unit]\nDescription=Pi Hub self-healing reverse SSH tunnel\nAfter=network.target pi-hub.service\nWants=pi-hub.service\n\n[Service]\nExecStart=%s %s %s %s\nEnvironment=%s\nRestart=always\nRestartSec=5\nTimeoutStopSec=10\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n' "$(quote_unit "$NODE")" "$(quote_unit "$ROOT/deploy/tunnel.ts")" "$(quote_unit "$SSH_HOST")" "$PORT" "$(quote_unit "PATH=$NODE_DIR:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin")" > "$HOME/.config/systemd/user/pi-hub-tunnel.service"
fi
systemctl --user daemon-reload
if [[ "$TUNNEL_ONLY" != 1 ]]; then systemctl --user enable --now pi-hub.service; fi
if [[ -n "$SSH_HOST" ]]; then systemctl --user enable --now pi-hub-tunnel.service; fi
printf 'Service units installed. Restart an already-running tunnel to apply updates; Hub was not restarted.\n'
