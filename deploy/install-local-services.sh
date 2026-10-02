#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
NODE="$(command -v node)"
NODE_DIR="$(dirname "$NODE")"
SSH_HOST="${PI_HUB_SSH_HOST:-}"
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
printf '[Unit]\nDescription=Pi Hub workspace\nAfter=network.target\n\n[Service]\nWorkingDirectory=%s\nExecStart=%s %s %s\nEnvironment=%s\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=15\nKillMode=control-group\n\n[Install]\nWantedBy=default.target\n' "$(quote_unit "$ROOT")" "$(quote_unit "$NODE")" "$(quote_unit "$ROOT/node_modules/tsx/dist/cli.mjs")" "$(quote_unit "$ROOT/server/cli.ts")" "$(quote_unit "PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin")" > "$HOME/.config/systemd/user/pi-hub.service"
if [[ -n "${PI_HUB_CONFIG:-}" ]]; then
  printf '\n# Custom configuration path (not its contents).\n[Service]\nEnvironment=%s\n' "$(quote_unit "PI_HUB_CONFIG=$PI_HUB_CONFIG")" >> "$HOME/.config/systemd/user/pi-hub.service"
fi
if [[ -n "$SSH_HOST" ]]; then
  SSH="$(command -v ssh)"
  printf '[Unit]\nDescription=Pi Hub reverse SSH tunnel\nAfter=network.target pi-hub.service\nWants=pi-hub.service\n\n[Service]\nExecStart=%s -NT -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=20 -o ServerAliveCountMax=3 -R 127.0.0.1:%s:127.0.0.1:%s %s\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n' "$(quote_unit "$SSH")" "$PORT" "$PORT" "$(quote_unit "$SSH_HOST")" > "$HOME/.config/systemd/user/pi-hub-tunnel.service"
fi
systemctl --user daemon-reload
systemctl --user enable --now pi-hub.service
if [[ -n "$SSH_HOST" ]]; then systemctl --user enable --now pi-hub-tunnel.service; fi
printf 'Hub installed. Optional tunnel installed only when PI_HUB_SSH_HOST is supplied.\n'
