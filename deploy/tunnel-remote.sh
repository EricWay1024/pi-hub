#!/usr/bin/env bash
# Executed via a dedicated, non-multiplexed SSH connection. No remote install or sudo.
set -eu
port="$1"
heartbeat_timeout="$2"
[[ "$port" =~ ^[0-9]+$ && "$heartbeat_timeout" =~ ^[0-9]+$ ]] || exit 2
command -v curl >/dev/null
session_pid="$PPID"
case "$(ps -p "$session_pid" -o comm=)" in
  sshd|sshd-session) ;;
  *) echo 'Tunnel watchdog must be a direct child of its own SSH session' >&2; exit 2 ;;
esac
release_session() {
  # Check that it is still our parent, not a recycled PID or another user's tunnel.
  if [[ "$(ps -p "$$" -o ppid= | tr -d ' ')" == "$session_pid" ]]; then
    kill -TERM "$session_pid" 2>/dev/null || true
  fi
}
trap release_session EXIT
trap 'exit 0' HUP INT TERM
while IFS= read -r -t "$heartbeat_timeout" ping; do
  [[ "$ping" =~ ^ping\ ([0-9]+)$ ]] || exit 2
  sequence="${BASH_REMATCH[1]}"
  # This traverses the reverse forward, not nginx/DNS or a public auth session.
  status=$(curl --noproxy '*' --silent --connect-timeout 3 --max-time 5 \
    --output /dev/null --write-out '%{http_code}' \
    "http://127.0.0.1:$port/api/auth/status") || status=000
  printf 'pong %s %s\n' "$sequence" "$status"
done
# EOF or a missing heartbeat closes only this SSH session and its forwarded port.
