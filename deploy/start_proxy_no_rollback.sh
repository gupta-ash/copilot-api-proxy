#!/usr/bin/env bash
# start_proxy_no_rollback.sh — Linux/macOS equivalent of start_proxy_no_rollback.ps1.
#
# Standalone start of copilot-proxy v2 that LEAVES the started process
# running on /health failure (operator handles cleanup).
#
# Sibling of start_proxy.sh (the recommended auto-rollback variant). The
# two scripts are deliberately separate (NOT one script with a
# --no-rollback flag) so the operator's choice is explicit by NAME at
# invocation time, not buried in a flag. Pick this variant ONLY when you
# want to inspect a started-but-unhealthy process before deciding what
# to do.
#
# This script is structurally identical to start_proxy.sh EXCEPT the
# /health-failure / auth-failure branches: it prints a WARNING with the
# PID + log path, leaves the PID file in place, leaves the process
# running, and exits 2.
#
# It:
#   0. ITER-3 Fix-1 (HIGH-1): acquire EXCLUSIVE start lock at
#      <REPO_PATH>/logs/copilot-proxy.start.lock via `mkdir` (atomic on
#      POSIX) BEFORE preflight. Released via trap EXIT on every exit
#      path. Identical to start_proxy.sh.
#   1. Pre-flight: PID-file collision check, dist/main.js + node presence,
#      logs dir creation. Per discriminator finding M4: umask 077 set
#      BEFORE any file ops; chmod 700 on newly-created logs dir.
#   2. Sets the four COPILOT_PROXY_* env vars from --port / --host /
#      --config / --force.
#   3. Background-launches `nohup node <REPO_PATH>/dist/main.js` with
#      stdout/stderr redirected to <REPO_PATH>/logs/copilot-proxy.*.log.
#   4. Writes the launched PID ATOMICALLY (temp + rename) to
#      <REPO_PATH>/logs/copilot-proxy.pid -- per H4. chmod 600 explicit.
#   5. Polls http://<probe_url>/health for up to 10s where probe_url is
#      built via probe_url() (ITER-3 Fix-4 MEDIUM-1: brackets IPv6
#      literals).
#   5.5. Parses auth_status from /health body. Per discriminator finding
#        H1: WARN on auth_status==failed/disposed (no rollback).
#   6. Writes meta.json sidecar ATOMICALLY -- per H3 + M1.
#      ITER-3 Fix-2 (HIGH-2): meta.started_at = ACTUAL OS process start
#      time (read from /proc/$pid/stat field 22; macOS fallback via ps).
#      NOTE: meta.json is written only on healthy startup. On health/auth
#      failure (no-rollback variant), meta.json is NOT written; PID file
#      remains for operator to clean up via stop_proxy.
#   7. On health failure: WARN + leave running + exit 2.
#      On success: print summary.
#
# IDEMPOTENT (re-runnable) only when the prior process has fully stopped.
# Refuses to start if a live PID file exists; suggests stop_proxy first.
#
# Flags:
#   --port N         Port to bind / probe (default 4143).
#   --host HOST      Host to bind (default 127.0.0.1).
#   --config PATH    Path to config.yaml (default unset).
#   --beta-policy M  anthropic-beta policy: denylist | allowlist | strip_all.
#                    Sets COPILOT_PROXY_BETA_POLICY (default unset; main.ts then
#                    uses config.anthropic_beta.policy). Escape hatch to instantly
#                    restore a known-good posture (allowlist / strip_all).
#   --force          Set COPILOT_PROXY_ALLOW_PORT_IN_USE=1.
#   --dry-run        Print planned actions; no mutations.
#   -h, --help       Print usage; exit 0.
#
# Exit codes:
#   0  success
#   1  pre-flight refusal (lock-held / PID-file collision / dist missing /
#      node missing)
#   2  /health poll failure OR auth_status==failed with process LEFT RUNNING (no rollback)

set -euo pipefail

# Per discriminator finding M4: tighten umask BEFORE any file operations
# so PID file + meta file + (newly-created) logs dir get owner-only perms.
umask 077

PORT=4143
BIND_HOST='127.0.0.1'
CONFIG=''
BETA_POLICY=''
FORCE=0
DRY_RUN=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_PATH="$(cd "$SCRIPT_DIR/.." && pwd)"
LOGS_DIR="$REPO_PATH/logs"
PID_FILE="$LOGS_DIR/copilot-proxy.pid"
PID_FILE_TMP="$LOGS_DIR/copilot-proxy.pid.tmp"
META_FILE="$LOGS_DIR/copilot-proxy.meta.json"
META_FILE_TMP="$LOGS_DIR/copilot-proxy.meta.json.tmp"
STDOUT_LOG="$LOGS_DIR/copilot-proxy.stdout.log"
STDERR_LOG="$LOGS_DIR/copilot-proxy.stderr.log"
DIST_MAIN="$REPO_PATH/dist/main.js"
# ITER-3 Fix-1: exclusive start lock dir.
LOCK_DIR="$LOGS_DIR/copilot-proxy.start.lock"
LOCK_ACQUIRED=0

usage() {
  cat <<EOF
Usage: $0 [--port N] [--host HOST] [--config PATH] [--beta-policy MODE] [--force] [--dry-run]

Standalone start of copilot-proxy v2 that LEAVES the started process
running on /health failure (no rollback). For the recommended auto-
rollback variant, use start_proxy.sh instead.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)    PORT="$2"; shift 2 ;;
    --host)    BIND_HOST="$2"; shift 2 ;;
    --config)  CONFIG="$2"; shift 2 ;;
    --beta-policy) BETA_POLICY="$2"; shift 2 ;;
    --force)   FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

step() { echo "=== $*"; }
sub()  { echo "  - $*"; }
err()  { echo "ERROR: $*" >&2; }
warn() { echo "WARNING: $*" >&2; }

pid_alive() {
  local p="$1"
  kill -0 "$p" 2>/dev/null
}

# Per discriminator finding M2.
probe_host() {
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

# ITER-3 Fix-2 (HIGH-2): get a process's actual OS start time as a UTC
# ISO-8601 string. Linux: /proc/$pid/stat field 22. macOS fallback: ps.
# /proc/$pid/stat format: pid (comm) state ppid pgrp ... starttime ...
# The comm field (#2) is in parens and may contain spaces. Standard
# trick: strip everything up to and including the LAST ')', then count
# fields. After stripping, original-field-3 (state) is now field 1, so
# original-field-22 (starttime) is now field 20.
get_process_start_time_utc() {
  local p="$1"
  local result=''
  if [[ -r "/proc/$p/stat" && -r '/proc/stat' ]]; then
    local boot_time start_ticks clk_tck start_unix stat_line post_paren
    boot_time="$(awk '/^btime/ {print $2}' /proc/stat 2>/dev/null || true)"
    clk_tck="$(getconf CLK_TCK 2>/dev/null || true)"
    stat_line="$(cat "/proc/$p/stat" 2>/dev/null || true)"
    post_paren="${stat_line##*)}"
    start_ticks="$(echo "$post_paren" | awk '{print $20}' 2>/dev/null || true)"
    if [[ -n "$boot_time" && -n "$clk_tck" && -n "$start_ticks" && "$clk_tck" -gt 0 ]]; then
      start_unix=$(( boot_time + start_ticks / clk_tck ))
      local rem_ticks rem_ms
      rem_ticks=$(( start_ticks % clk_tck ))
      rem_ms=$(( rem_ticks * 1000 / clk_tck ))
      result="$(date -u -d "@$start_unix" +%Y-%m-%dT%H:%M:%S 2>/dev/null || true)"
      if [[ -n "$result" ]]; then
        printf '%s.%03dZ\n' "$result" "$rem_ms"
        return 0
      fi
    fi
  fi
  local lstart
  lstart="$(ps -o lstart= -p "$p" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
  if [[ -n "$lstart" ]]; then
    local ep
    ep="$(date -u -d "$lstart" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || true)"
    if [[ -n "$ep" ]]; then
      echo "$ep"
      return 0
    fi
    ep="$(date -u -j -f '%a %b %e %H:%M:%S %Y' "$lstart" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || true)"
    if [[ -n "$ep" ]]; then
      echo "$ep"
      return 0
    fi
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)#approx"
  return 1
}

# ITER-3 Fix-1: lock release trap.
release_lock() {
  if [[ $LOCK_ACQUIRED -eq 1 && -d "$LOCK_DIR" ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || rm -rf "$LOCK_DIR" 2>/dev/null || true
    sub "released start lock: $LOCK_DIR"
  fi
}
trap release_lock EXIT

# Echoes auth_status string. Returns 0 if /health returned 200; 1 otherwise.
test_v2_health() {
  local probehost="$1"; local port="$2"; local timeout="${3:-10}"
  local url; url="$(probe_url "$probehost" "$port" '/health')"
  local start; start=$(date +%s)
  local body
  while [[ $(( $(date +%s) - start )) -lt $timeout ]]; do
    if body="$(curl -fsS --max-time 2 "$url" 2>/dev/null)"; then
      local auth
      auth="$(printf '%s' "$body" \
        | grep -o '"auth_status"[[:space:]]*:[[:space:]]*"[^"]*"' \
        | sed 's/.*"\([^"]*\)"$/\1/' || true)"
      if [[ -z "$auth" ]]; then
        auth='unknown'
      fi
      echo "$auth"
      return 0
    fi
    sleep 0.25
  done
  echo 'unknown'
  return 1
}

# === Main flow =================================================================

step "start_proxy_no_rollback.sh --port $PORT --host $BIND_HOST (dry-run=$DRY_RUN, force=$FORCE)"

PROBE_HOST="$(probe_host "$BIND_HOST")"

# ITER-3 Fix-1 (HIGH-1): logs dir + lock acquisition BEFORE preflight.
if [[ ! -d "$LOGS_DIR" ]]; then
  mkdir -p "$LOGS_DIR"
  chmod 700 "$LOGS_DIR"
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  err "another start_proxy is in progress (lock dir $LOCK_DIR exists). Wait for it to finish, or remove the lock dir manually if stale: rmdir '$LOCK_DIR'"
  exit 1
fi
LOCK_ACQUIRED=1
sub "acquired start lock: $LOCK_DIR"

# Pre-flight ------------------------------------------------------------------
step 'pre-flight'

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && pid_alive "$existing_pid"; then
    err "PID file $PID_FILE exists and PID $existing_pid is alive. Run stop_proxy.sh first."
    exit 1
  else
    sub "stale PID file at $PID_FILE (PID '$existing_pid' not running); will overwrite"
  fi
fi

if [[ ! -f "$DIST_MAIN" ]]; then
  err "$DIST_MAIN not found. Build first: cd $REPO_PATH && bun run build"
  exit 1
fi
sub "dist/main.js: $DIST_MAIN"

if ! command -v node >/dev/null 2>&1; then
  err 'node not found on PATH. Install Node.js or add it to PATH.'
  exit 1
fi
sub "node: $(command -v node)"

sub "logs dir: $LOGS_DIR"

# Env vars --------------------------------------------------------------------
step 'setting env vars'
sub "COPILOT_PROXY_PORT=$PORT"
sub "COPILOT_PROXY_HOST=$BIND_HOST"
[[ -n "$CONFIG" ]] && sub "COPILOT_PROXY_CONFIG=$CONFIG"
[[ -n "$BETA_POLICY" ]] && sub "COPILOT_PROXY_BETA_POLICY=$BETA_POLICY"
[[ $FORCE -eq 1 ]] && sub 'COPILOT_PROXY_ALLOW_PORT_IN_USE=1'

# Background-launch -----------------------------------------------------------
PROBE_URL="$(probe_url "$PROBE_HOST" "$PORT" '/health')"
step "background-launch: node $DIST_MAIN"
if [[ $DRY_RUN -eq 1 ]]; then
  sub "[dry-run] would: nohup node $DIST_MAIN > $STDOUT_LOG 2> $STDERR_LOG &"
  sub "[dry-run] would write PID atomically (temp + rename) to $PID_FILE"
  sub "[dry-run] would test_v2_health $PROBE_HOST $PORT 10 (probe URL: $PROBE_URL)"
  sub "[dry-run] would parse auth_status from /health body"
  sub "[dry-run] would write meta.json atomically (temp + rename) to $META_FILE (started_at = OS process start time)"
  exit 0
fi

export COPILOT_PROXY_PORT="$PORT"
export COPILOT_PROXY_HOST="$BIND_HOST"
[[ -n "$CONFIG" ]] && export COPILOT_PROXY_CONFIG="$CONFIG"
[[ -n "$BETA_POLICY" ]] && export COPILOT_PROXY_BETA_POLICY="$BETA_POLICY"
[[ $FORCE -eq 1 ]] && export COPILOT_PROXY_ALLOW_PORT_IN_USE=1

nohup node "$DIST_MAIN" > "$STDOUT_LOG" 2> "$STDERR_LOG" &
STARTED_PID=$!
sub "started PID $STARTED_PID"

# ITER-3 Fix-2 (HIGH-2): capture ACTUAL OS process start time IMMEDIATELY.
STARTED_AT_UTC="$(get_process_start_time_utc "$STARTED_PID")" || true
if [[ "$STARTED_AT_UTC" == *'#approx' ]]; then
  STARTED_AT_UTC="${STARTED_AT_UTC%#approx}"
  sub "WARNING: could not read OS process start time; using approximate (current) time."
fi
sub "captured OS StartTime: $STARTED_AT_UTC"

# Per H4: atomic temp + rename.
printf '%s' "$STARTED_PID" > "$PID_FILE_TMP"
chmod 600 "$PID_FILE_TMP"
mv -f "$PID_FILE_TMP" "$PID_FILE"
sub "PID file (atomic): $PID_FILE"

# Health poll -----------------------------------------------------------------
step "probing $PROBE_URL (up to 10s)"
AUTH_STATUS='unknown'
if AUTH_STATUS="$(test_v2_health "$PROBE_HOST" "$PORT" 10)"; then
  sub '/health OK'
  sub "auth_status: $AUTH_STATUS"
  if [[ "$AUTH_STATUS" == 'failed' || "$AUTH_STATUS" == 'disposed' ]]; then
    warn "auth_status reports '$AUTH_STATUS' (terminal failure state). Process PID $STARTED_PID left running (no-rollback variant). Inspect logs at $STDERR_LOG; stop with \"$SCRIPT_DIR/stop_proxy.sh\"."
    exit 2
  fi
else
  warn "/health did not return ready within 10s. Process PID $STARTED_PID left running. Inspect logs at $STDERR_LOG; stop with \"$SCRIPT_DIR/stop_proxy.sh\"."
  exit 2
fi

# Per discriminator findings H3 + M1: write meta.json sidecar atomically.
# ITER-3 Fix-2: started_at = ACTUAL OS process start time.
CMDLINE="node $DIST_MAIN"
{
  printf '{'
  printf '"pid":%s,' "$STARTED_PID"
  printf '"port":%s,' "$PORT"
  printf '"host":"%s",' "$BIND_HOST"
  printf '"repo":"%s",' "$REPO_PATH"
  printf '"started_at":"%s",' "$STARTED_AT_UTC"
  printf '"cmdline":"%s",' "$CMDLINE"
  printf '"schema_version":1'
  printf '}'
} > "$META_FILE_TMP"
chmod 600 "$META_FILE_TMP"
mv -f "$META_FILE_TMP" "$META_FILE"
sub "meta file (atomic): $META_FILE"

# Summary ---------------------------------------------------------------------
METRICS_URL="$(probe_url "$PROBE_HOST" "$PORT" '/metrics')"
step 'summary'
echo
echo '=== copilot-proxy started ==='
echo "  PID:           $STARTED_PID"
echo "  port:          $PORT"
echo "  host:          $BIND_HOST"
echo "  /health:       OK"
echo "  auth_status:   $AUTH_STATUS"
echo "  /metrics:      $METRICS_URL"
echo "  PID file:      $PID_FILE"
echo "  meta file:     $META_FILE"
echo "  stdout log:    $STDOUT_LOG"
echo "  stderr log:    $STDERR_LOG"
echo "  stop with:     \"$SCRIPT_DIR/stop_proxy.sh\""
exit 0
