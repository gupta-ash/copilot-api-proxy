#!/usr/bin/env bash
# status_proxy.sh — Linux/macOS equivalent of status_proxy.ps1.
#
# Standalone status report for copilot-proxy v2.
#
# Companion of start_proxy.sh / start_proxy_no_rollback.sh / stop_proxy.sh.
#
# It:
#   1. Reads PID file at <REPO_PATH>/logs/copilot-proxy.pid (single decimal
#      PID, no trailing newline; whitespace-stripped defensively).
#   2. If PID file missing OR PID dead: prints NOT RUNNING and exits 2.
#   3. Per discriminator finding M1: reads meta.json at
#      <REPO_PATH>/logs/copilot-proxy.meta.json; uses meta.port + meta.host
#      for /health and /metrics probes (closes M1 port-discovery defect).
#      If meta.json absent: WARN + fall back to 127.0.0.1:<--port>
#      (default 4143). The --port CLI flag still overrides meta.
#   4. Probes /health and /metrics on the resolved host:port via probe_url
#      (ITER-3 Fix-4 MEDIUM-1: brackets IPv6 literals). Parses
#      copilot_proxy_token_status (0/1/2 -> starting/ready/failed) and
#      copilot_proxy_process_uptime_seconds from /metrics.
#   5. Prints a summary table.
#
# The PID file is the source of truth for "is it running"; lsof / netstat
# would couple status semantics to "process listening on port N" which is
# brittle. The /health probe verifies serve liveness; the token_status
# gauge is the canonical "is it ready to serve auth-gated routes" signal.
#
# Flags:
#   --port N     Port to probe for /health + /metrics (default: meta.port
#                if meta.json present, else 4143). CLI flag overrides meta.
#   -h, --help   Print usage; exit 0.
#
# Exit codes:
#   0  process alive AND /health returned 200
#   1  process alive but /health failed OR token_status=failed
#   2  process not running (no PID file, or PID dead)

set -euo pipefail

PORT_CLI=''   # empty means not explicitly passed

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_PATH="$(cd "$SCRIPT_DIR/.." && pwd)"
LOGS_DIR="$REPO_PATH/logs"
PID_FILE="$LOGS_DIR/copilot-proxy.pid"
META_FILE="$LOGS_DIR/copilot-proxy.meta.json"
STDOUT_LOG="$LOGS_DIR/copilot-proxy.stdout.log"
STDERR_LOG="$LOGS_DIR/copilot-proxy.stderr.log"

usage() {
  cat <<EOF
Usage: $0 [--port N]

Standalone status report for copilot-proxy v2 (PID liveness + /health +
/metrics token_status + uptime).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)    PORT_CLI="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

pid_alive() {
  local p="$1"
  kill -0 "$p" 2>/dev/null
}

probe_host_norm() {
  case "$1" in
    '0.0.0.0'|'') echo '127.0.0.1' ;;
    '::') echo '::1' ;;
    *) echo "$1" ;;
  esac
}

# ITER-3 Fix-4 (MEDIUM-1): bracket IPv6 literals for URL composition.
probe_url() {
  local h="$1"; local port="$2"; local path="$3"
  if [[ "$h" == *:* && ! "$h" =~ ^[0-9.]+$ && "${h:0:1}" != '[' ]]; then
    h="[${h}]"
  fi
  echo "http://${h}:${port}${path}"
}

# Extract a JSON value (string-or-number) by key. No jq dep.
json_extract() {
  local body="$1"; local key="$2"
  local val
  val="$(printf '%s' "$body" \
    | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -n1 \
    | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  if [[ -n "$val" ]]; then
    echo "$val"
    return
  fi
  val="$(printf '%s' "$body" \
    | grep -oE "\"$key\"[[:space:]]*:[[:space:]]*-?[0-9]+(\.[0-9]+)?" \
    | head -n1 \
    | sed -E "s/.*:[[:space:]]*//" || true)"
  echo "$val"
}

token_status_label() {
  case "${1:-}" in
    0) echo 'starting' ;;
    1) echo 'ready' ;;
    2) echo 'failed' ;;
    '') echo 'unknown' ;;
    *) echo "unknown ($1)" ;;
  esac
}

# === Main flow =================================================================

if [[ ! -f "$PID_FILE" ]]; then
  echo 'copilot-proxy: NOT RUNNING (PID file: missing)'
  exit 2
fi

if ! pid_text="$(tr -d '[:space:]' < "$PID_FILE" 2>/dev/null)"; then
  echo "copilot-proxy: NOT RUNNING (PID file unreadable)"
  exit 2
fi

if ! [[ "$pid_text" =~ ^[0-9]+$ ]] || [[ "$pid_text" -le 0 ]]; then
  echo "copilot-proxy: NOT RUNNING (PID file: present but invalid PID '$pid_text')"
  exit 2
fi

TARGET_PID="$pid_text"

if ! pid_alive "$TARGET_PID"; then
  echo "copilot-proxy: NOT RUNNING (PID file: present, PID $TARGET_PID dead)"
  exit 2
fi

# Step 3: M1 port + host discovery.
PROBE_PORT=4143
PROBE_HOST='127.0.0.1'
PORT_SOURCE='probed; meta.json missing'

if [[ -f "$META_FILE" ]]; then
  if META_BODY="$(cat "$META_FILE" 2>/dev/null)"; then
    META_PORT="$(json_extract "$META_BODY" 'port')"
    META_HOST="$(json_extract "$META_BODY" 'host')"
    if [[ -n "$META_PORT" && "$META_PORT" =~ ^[0-9]+$ ]]; then
      PROBE_PORT="$META_PORT"
    fi
    if [[ -n "$META_HOST" ]]; then
      PROBE_HOST="$(probe_host_norm "$META_HOST")"
    fi
    PORT_SOURCE='from meta'
  else
    PORT_SOURCE='probed; meta.json unreadable'
  fi
fi

if [[ -n "$PORT_CLI" && "$PORT_CLI" =~ ^[0-9]+$ ]]; then
  PROBE_PORT="$PORT_CLI"
  PORT_SOURCE='from --port flag (overrides meta)'
fi

# Step 4: probe /health.
HEALTH_OK=0
HEALTH_URL="$(probe_url "$PROBE_HOST" "$PROBE_PORT" '/health')"
if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
  HEALTH_OK=1
fi

# Probe /metrics; parse copilot_proxy_token_status + uptime.
TOKEN_LABEL='unknown'
UPTIME_STR='(n/a)'
METRICS_URL="$(probe_url "$PROBE_HOST" "$PROBE_PORT" '/metrics')"
if METRICS_BODY="$(curl -fsS --max-time 3 "$METRICS_URL" 2>/dev/null)"; then
  TOKEN_VAL="$(printf '%s\n' "$METRICS_BODY" | awk '
    !/^#/ && $1 == "copilot_proxy_token_status" { print $2; exit }
  ')"
  TOKEN_LABEL="$(token_status_label "$TOKEN_VAL")"
  UPTIME_VAL="$(printf '%s\n' "$METRICS_BODY" | awk '
    !/^#/ && $1 == "copilot_proxy_process_uptime_seconds" { print $2; exit }
  ')"
  if [[ -n "$UPTIME_VAL" ]]; then
    UPTIME_STR="${UPTIME_VAL}s"
  fi
fi

if [[ $HEALTH_OK -eq 1 ]]; then
  HEALTH_LABEL='ok'
else
  HEALTH_LABEL='FAIL'
fi

echo 'copilot-proxy status'
echo "  PID:           $TARGET_PID"
echo "  port ($PORT_SOURCE): $PROBE_PORT"
echo "  host:          $PROBE_HOST"
echo "  /health:       $HEALTH_LABEL"
echo "  token_status:  $TOKEN_LABEL"
echo "  uptime:        $UPTIME_STR"
echo "  PID file:      $PID_FILE"
echo "  meta file:     $META_FILE"
echo "  stdout log:    $STDOUT_LOG"
echo "  stderr log:    $STDERR_LOG"

if [[ $HEALTH_OK -ne 1 ]] || [[ "$TOKEN_LABEL" == 'failed' ]]; then
  exit 1
fi
exit 0
