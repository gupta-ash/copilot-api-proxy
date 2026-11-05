#!/usr/bin/env bash
# start_proxy.sh — Linux/macOS equivalent of start_proxy.ps1.
#
# Recommended standalone start of copilot-proxy v2 with auto-rollback on
# /health failure.
#
# Sibling of:
#   - start_proxy_no_rollback.sh (same flow; LEAVES the started process
#     running on /health failure for operator inspection).
#   - stop_proxy.sh / status_proxy.sh (lifecycle complement).
#
# This script fills the M12 gap between cutover.sh (one-shot bundle->v2
# migration) and a systemd unit (heavy production daemon). It wraps the
# `node ./dist/main.js` invocation operators were previously typing by
# hand with PID-file management, log redirection, /health validation, and
# auto-rollback.
#
# It:
#   0. ITER-3 Fix-1 (HIGH-1): acquire EXCLUSIVE start lock at
#      <REPO_PATH>/logs/copilot-proxy.start.lock via `mkdir` (atomic on
#      POSIX) BEFORE preflight. Closes the launch race that survives the
#      atomic-PID-file rename window. Released via trap EXIT on every
#      exit path (success, rollback, failure, Ctrl-C).
#   1. Pre-flight: PID-file collision check, dist/main.js + node presence,
#      logs dir creation. Per discriminator finding M4: umask 077 set
#      BEFORE any file ops; chmod 700 on newly-created logs dir.
#   2. Sets the four COPILOT_PROXY_* env vars from --port / --host /
#      --config / --force.
#   3. Background-launches `nohup node <REPO_PATH>/dist/main.js` with
#      stdout/stderr redirected to <REPO_PATH>/logs/copilot-proxy.*.log.
#   4. Writes the launched PID ATOMICALLY (temp + rename) to
#      <REPO_PATH>/logs/copilot-proxy.pid -- per discriminator finding
#      H4 (closes concurrent-start race window). chmod 600 explicit
#      defense-in-depth.
#   5. Polls http://<probe_url>/health for up to 10s where probe_url is
#      built via probe_url() (ITER-3 Fix-4 MEDIUM-1: brackets IPv6
#      literals e.g. ::1 -> http://[::1]:4143/health).
#   5.5. Parses auth_status from /health body via grep+sed (no jq dep).
#        Per discriminator finding H1: rollback on auth_status==failed
#        or disposed. Accept ready/starting/uninitialized.
#   6. Writes meta.json sidecar ATOMICALLY at
#      <REPO_PATH>/logs/copilot-proxy.meta.json (PID + port + host +
#      repo + ISO-8601 started_at + cmdline + schema_version=1) -- per
#      discriminator findings H3 + M1.
#      ITER-3 Fix-2 (HIGH-2): meta.started_at = ACTUAL OS process start
#      time (read from /proc/$pid/stat field 22 -> unix epoch -> ISO-8601;
#      macOS fallback via `ps -o lstart=`), NOT script-clock at meta-write
#      time. Closes the false-refuse race when /health takes >2s and
#      stop_proxy's identity check exceeds the +/-2s tolerance.
#   7. On health/auth failure: rollback path (SIGTERM + 5s wait + SIGKILL +
#      ITER-3 Fix-5 (MEDIUM-2): re-poll liveness 2s after force-kill;
#      KEEP files + exit 1 on still-alive). On normal rollback completion:
#      delete PID + meta + exit 2. On success: print summary + exit 0.
#
# IDEMPOTENT (re-runnable) only when the prior process has fully stopped.
# Refuses to start if a live PID file exists; suggests stop_proxy first.
#
# Flags:
#   --port N         Port to bind / probe (default 4143).
#   --host HOST      Host to bind (default 127.0.0.1).
#   --config PATH    Path to config.yaml (default unset; main.ts resolves
#                    via PATHS.APP_DIR/config.yaml).
#   --beta-policy M  anthropic-beta policy: denylist | allowlist | strip_all.
#                    Sets COPILOT_PROXY_BETA_POLICY (default unset; main.ts then
#                    uses config.anthropic_beta.policy). Escape hatch to instantly
#                    restore a known-good posture (allowlist / strip_all).
#   --force          Set COPILOT_PROXY_ALLOW_PORT_IN_USE=1 (skip
#                    EADDRINUSE pre-check; useful within TIME_WAIT).
#   --dry-run        Print planned actions; no mutations.
#   -h, --help       Print usage; exit 0.
#
# Exit codes:
#   0  success
#   1  pre-flight refusal (lock-held / PID-file collision / dist missing /
#      node missing / rollback-still-alive after force-kill per Fix-5)
#   2  /health poll failure OR auth_status==failed with rollback executed

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
# ITER-3 Fix-1: exclusive start lock dir (atomic via mkdir on POSIX).
LOCK_DIR="$LOGS_DIR/copilot-proxy.start.lock"
LOCK_ACQUIRED=0

usage() {
  cat <<EOF
Usage: $0 [--port N] [--host HOST] [--config PATH] [--beta-policy MODE] [--force] [--dry-run]

Recommended standalone start of copilot-proxy v2 with auto-rollback on
/health failure. See start_proxy_no_rollback.sh for the no-rollback
variant.
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

pid_alive() {
  local p="$1"
  kill -0 "$p" 2>/dev/null
}

# Per discriminator finding M2: probe the bound host, not hardcoded
# 127.0.0.1. Special case: 0.0.0.0 isn't a valid client-side address.
probe_host() {
  case "$1" in
    '0.0.0.0'|'') echo '127.0.0.1' ;;
    '::') echo '::1' ;;
    *) echo "$1" ;;
  esac
}

# ITER-3 Fix-4 (MEDIUM-1): build a syntactically-valid http URL given a
# host + port + path. IPv6 literals MUST be bracketed in URL host
# components per RFC 3986 sec 3.2.2. Detection heuristic: host contains
# ':' AND not pure-IPv4-dotted AND not already bracketed -> bracket.
probe_url() {
  local h="$1"; local port="$2"; local path="$3"
  # If host contains ':' and is not IPv4 (digits + dots only) and is not
  # already bracketed, treat as IPv6 literal -> bracket it.
  if [[ "$h" == *:* && ! "$h" =~ ^[0-9.]+$ && "${h:0:1}" != '[' ]]; then
    h="[${h}]"
  fi
  echo "http://${h}:${port}${path}"
}

# ITER-3 Fix-2 (HIGH-2): get a process's actual OS start time as a UTC
# ISO-8601 string. Linux: /proc/$pid/stat field 22 (process start in
# clock ticks since boot). macOS fallback: ps -o lstart=. Last-resort:
# current time with a debug warning.
#
# /proc/$pid/stat format: pid (comm) state ppid pgrp ... starttime ...
# The comm field (field 2) is in parens and may contain spaces. Standard
# trick: strip everything up to and including the LAST ')', then count
# fields. After stripping, original-field-3 (state) is now field 1, so
# original-field-22 (starttime) is now field 20.
get_process_start_time_utc() {
  local p="$1"
  local result=''
  # Linux /proc path.
  if [[ -r "/proc/$p/stat" && -r '/proc/stat' ]]; then
    local boot_time start_ticks clk_tck start_unix stat_line post_paren
    boot_time="$(awk '/^btime/ {print $2}' /proc/stat 2>/dev/null || true)"
    clk_tck="$(getconf CLK_TCK 2>/dev/null || true)"
    stat_line="$(cat "/proc/$p/stat" 2>/dev/null || true)"
    # Strip up to and including the last ')'; remaining fields start at original field 3.
    post_paren="${stat_line##*)}"
    # starttime = original field 22 = (22-3+1)=20th field of post_paren.
    start_ticks="$(echo "$post_paren" | awk '{print $20}' 2>/dev/null || true)"
    if [[ -n "$boot_time" && -n "$clk_tck" && -n "$start_ticks" && "$clk_tck" -gt 0 ]]; then
      start_unix=$(( boot_time + start_ticks / clk_tck ))
      # Fractional millis from remaining ticks.
      local rem_ticks rem_ms
      rem_ticks=$(( start_ticks % clk_tck ))
      rem_ms=$(( rem_ticks * 1000 / clk_tck ))
      # Format: 2026-05-05T20:15:23.123Z
      result="$(date -u -d "@$start_unix" +%Y-%m-%dT%H:%M:%S 2>/dev/null || true)"
      if [[ -n "$result" ]]; then
        printf '%s.%03dZ\n' "$result" "$rem_ms"
        return 0
      fi
    fi
  fi
  # macOS / BSD fallback via `ps -o lstart=` (e.g. "Mon May  5 20:15:23 2026").
  local lstart
  lstart="$(ps -o lstart= -p "$p" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true)"
  if [[ -n "$lstart" ]]; then
    # Try GNU date first.
    local ep
    ep="$(date -u -d "$lstart" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || true)"
    if [[ -n "$ep" ]]; then
      echo "$ep"
      return 0
    fi
    # BSD date -j -f.
    ep="$(date -u -j -f '%a %b %e %H:%M:%S %Y' "$lstart" +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || true)"
    if [[ -n "$ep" ]]; then
      echo "$ep"
      return 0
    fi
  fi
  # Last-resort: current time with warning. Caller decides what to do.
  echo "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)#approx"
  return 1
}

# ITER-3 Fix-1: lock release trap. Idempotent; safe if lock not yet acquired.
release_lock() {
  if [[ $LOCK_ACQUIRED -eq 1 && -d "$LOCK_DIR" ]]; then
    rmdir "$LOCK_DIR" 2>/dev/null || rm -rf "$LOCK_DIR" 2>/dev/null || true
    sub "released start lock: $LOCK_DIR"
  fi
}
trap release_lock EXIT

# === Main flow =================================================================

step "start_proxy.sh --port $PORT --host $BIND_HOST (dry-run=$DRY_RUN, force=$FORCE)"

PROBE_HOST="$(probe_host "$BIND_HOST")"

# ITER-3 Fix-1 (HIGH-1): acquire exclusive start lock BEFORE preflight.
# Need logs dir first.
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

# 1. PID-file collision check.
if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(tr -d '[:space:]' < "$PID_FILE")"
  if [[ "$existing_pid" =~ ^[0-9]+$ ]] && pid_alive "$existing_pid"; then
    err "PID file $PID_FILE exists and PID $existing_pid is alive. Run stop_proxy.sh first."
    exit 1
  else
    sub "stale PID file at $PID_FILE (PID '$existing_pid' not running); will overwrite"
  fi
fi

# 2. dist/main.js presence.
if [[ ! -f "$DIST_MAIN" ]]; then
  err "$DIST_MAIN not found. Build first: cd $REPO_PATH && bun run build"
  exit 1
fi
sub "dist/main.js: $DIST_MAIN"

# 3. node presence.
if ! command -v node >/dev/null 2>&1; then
  err 'node not found on PATH. Install Node.js or add it to PATH.'
  exit 1
fi
sub "node: $(command -v node)"

# 4. logs dir. Per discriminator finding M4: chmod 700 only if newly
# created (don't broaden existing perms). NB: lock acquisition above
# already ensured logs dir exists.
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
  sub "[dry-run] would write meta.json atomically (temp + rename) to $META_FILE (started_at = OS process start time via /proc/<pid>/stat)"
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
# Becomes meta.started_at. stop_proxy reads same /proc data so delta ~0.
STARTED_AT_UTC="$(get_process_start_time_utc "$STARTED_PID")" || true
if [[ "$STARTED_AT_UTC" == *'#approx' ]]; then
  STARTED_AT_UTC="${STARTED_AT_UTC%#approx}"
  sub "WARNING: could not read OS process start time; using approximate (current) time. Stop_proxy identity check may be inaccurate."
fi
sub "captured OS StartTime: $STARTED_AT_UTC"

# Per discriminator finding H4: write PID file atomically (temp + rename).
# umask 077 (set above) ensures 600 perms; chmod 600 explicit DiD.
printf '%s' "$STARTED_PID" > "$PID_FILE_TMP"
chmod 600 "$PID_FILE_TMP"
mv -f "$PID_FILE_TMP" "$PID_FILE"
sub "PID file (atomic): $PID_FILE"

# Health poll -----------------------------------------------------------------
step "probing $PROBE_URL (up to 10s)"
ROLLBACK=0
FAILURE_REASON=''
AUTH_STATUS='unknown'

# test_v2_health uses probe_url() internally for IPv6 bracketing.
test_v2_health() {
  local url; url="$(probe_url "$PROBE_HOST" "$PORT" '/health')"
  local timeout="${1:-10}"
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

if AUTH_STATUS="$(test_v2_health 10)"; then
  sub '/health OK'
  sub "auth_status: $AUTH_STATUS"
  # Per discriminator finding H1: rollback on failed/disposed.
  if [[ "$AUTH_STATUS" == 'failed' || "$AUTH_STATUS" == 'disposed' ]]; then
    err "auth_status reports '$AUTH_STATUS' (terminal failure state); rolling back."
    ROLLBACK=1
    FAILURE_REASON="auth_status=$AUTH_STATUS"
  fi
else
  err "/health did not return 200 within 10s."
  ROLLBACK=1
  FAILURE_REASON='/health poll timeout'
fi

if [[ $ROLLBACK -eq 1 ]]; then
  err "Rolling back PID $STARTED_PID ($FAILURE_REASON)."
  if pid_alive "$STARTED_PID"; then
    kill -TERM "$STARTED_PID" 2>/dev/null || true
  fi
  # Wait up to 5s for graceful exit.
  deadline=$(( $(date +%s) + 5 ))
  while [[ $(date +%s) -lt $deadline ]] && pid_alive "$STARTED_PID"; do
    sleep 0.25
  done
  if pid_alive "$STARTED_PID"; then
    kill -KILL "$STARTED_PID" 2>/dev/null || true
    # ITER-3 Fix-5 (MEDIUM-2): re-poll liveness 2s post-force-kill
    # (mirror stop_proxy's M3 fix). On STILL-alive: KEEP files + exit 1.
    post_deadline=$(( $(date +%s) + 2 ))
    while [[ $(date +%s) -lt $post_deadline ]] && pid_alive "$STARTED_PID"; do
      sleep 0.5
    done
    if pid_alive "$STARTED_PID"; then
      err "could not force-kill PID $STARTED_PID after rollback; check process state manually. Files KEPT: $PID_FILE (no meta written yet)."
      exit 1
    fi
    sub "force-killed PID $STARTED_PID"
  else
    sub "PID $STARTED_PID exited gracefully"
  fi
  if [[ -f "$PID_FILE" ]]; then
    rm -f "$PID_FILE"
    sub "deleted PID file $PID_FILE"
  fi
  if [[ -f "$META_FILE" ]]; then
    rm -f "$META_FILE"
    sub "deleted meta file $META_FILE"
  fi
  exit 2
fi

# Per discriminator findings H3 + M1: write meta.json sidecar atomically
# (temp + rename) so stop_proxy can verify PID identity and status_proxy
# knows which port to probe.
# ITER-3 Fix-2: started_at = ACTUAL OS process start time (captured above
# via /proc/<pid>/stat or ps fallback).
CMDLINE="node $DIST_MAIN"
# Hand-roll JSON; no jq dep. Escape the cmdline + repo paths conservatively
# (no embedded quotes or backslashes expected in the production paths).
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
