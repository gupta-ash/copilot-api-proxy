#!/usr/bin/env bash
# stop_proxy.sh — Linux/macOS equivalent of stop_proxy.ps1.
#
# Standalone graceful stop of copilot-proxy v2.
#
# Companion of start_proxy.sh / start_proxy_no_rollback.sh / status_proxy.sh.
#
# It:
#   1. Reads PID file at <REPO_PATH>/logs/copilot-proxy.pid (single decimal
#      PID, no trailing newline -- written by start_proxy{,_no_rollback}.sh;
#      we strip whitespace defensively in case the operator hand-edited it).
#   1.5. Per discriminator finding H3: reads meta.json at
#        <REPO_PATH>/logs/copilot-proxy.meta.json. Verifies meta.pid +
#        started_at match the live process's start time (`ps -p $pid -o
#        lstart=`) within +/-2 seconds. On mismatch: REFUSE to kill (PID
#        may have been recycled), exit 1, KEEP both files.
#        ITER-3 Fix-3 (HIGH-3): MIRROR PowerShell strict validation.
#        When meta file is PRESENT but UNREADABLE/UNPARSEABLE/MISSING-FIELDS,
#        REFUSE (exit 1, files KEPT). PID-only fallback applies ONLY when
#        meta file is fully ABSENT (backward compat for pre-remediation
#        installs).
#   2. If PID file missing: print 'not running' and exit 0 (no-op-clean).
#      If PID file present but PID dead: clean up stale file (and meta if
#      present) and exit 0.
#   3. Per discriminator finding H2 (POSIX SIGTERM honesty comment):
#      on POSIX, `kill -TERM` delivers SIGTERM and Node's
#      `process.on('SIGTERM')` handler runs `await handle.close({
#      graceMs: 30_000 })` per `src/main.ts:228,231` -- this IS true
#      graceful drain. The 35s timeout = 30s drain + 5s safety margin.
#   4. Polls kill -0 every 500ms for up to 35s.
#   5. Force-kills with kill -KILL on timeout. Per discriminator finding
#      M3: re-polls liveness for 2s after force-kill (500ms intervals);
#      on STILL-alive, prints ERROR + KEEPS PID + meta files + exits 1.
#      Files only deleted once liveness check confirms gone.
#   6. Deletes the PID file AND meta file.
#   7. Prints summary.
#
# IDEMPOTENT: re-runnable; missing/stale PID file -> no-op exit 0.
#
# Flags:
#   --force      Skip drain wait; force-kill immediately after SIGTERM.
#   --dry-run    Print planned actions; no mutations.
#   -h, --help   Print usage; exit 0.
#
# Exit codes:
#   0  success (incl. no-op-clean)
#   1  unexpected error (permission denied, PID file unreadable,
#      meta-mismatch refusal, meta-corrupt refusal per ITER-3 Fix-3,
#      force-kill failure)

set -euo pipefail

FORCE=0
DRY_RUN=0
DRAIN_TIMEOUT_SEC=35
IDENTITY_TOLERANCE_SEC=2

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_PATH="$(cd "$SCRIPT_DIR/.." && pwd)"
LOGS_DIR="$REPO_PATH/logs"
PID_FILE="$LOGS_DIR/copilot-proxy.pid"
META_FILE="$LOGS_DIR/copilot-proxy.meta.json"

usage() {
  cat <<EOF
Usage: $0 [--force] [--dry-run]

Standalone graceful stop of copilot-proxy v2 (SIGTERM, then poll up to
${DRAIN_TIMEOUT_SEC}s for graceful drain, then SIGKILL on timeout).
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
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

# Extract a JSON string-or-number value by key (no jq dep). Handles
# "key":"value" (string) and "key":123 (number). Returns empty if not found.
json_extract() {
  local body="$1"; local key="$2"
  # Try string first.
  local val
  val="$(printf '%s' "$body" \
    | grep -o "\"$key\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
    | head -n1 \
    | sed 's/.*"\([^"]*\)"$/\1/' || true)"
  if [[ -n "$val" ]]; then
    echo "$val"
    return
  fi
  # Try number.
  val="$(printf '%s' "$body" \
    | grep -oE "\"$key\"[[:space:]]*:[[:space:]]*-?[0-9]+(\.[0-9]+)?" \
    | head -n1 \
    | sed -E "s/.*:[[:space:]]*//" || true)"
  echo "$val"
}

# Convert ISO-8601 "2026-05-05T20:15:23.123Z" to epoch seconds.
iso_to_epoch() {
  local iso="$1"
  # Try GNU date first.
  local ep
  ep="$(date -u -d "$iso" +%s 2>/dev/null || true)"
  if [[ -n "$ep" ]]; then echo "$ep"; return; fi
  # macOS / BSD date fallback (strip subsecond + Z, parse with -j -f).
  local clean
  clean="$(printf '%s' "$iso" | sed -E 's/\.[0-9]+Z?$//' | sed -E 's/Z$//')"
  ep="$(date -u -j -f '%Y-%m-%dT%H:%M:%S' "$clean" +%s 2>/dev/null || true)"
  echo "$ep"
}

# Get process start time as epoch seconds.
proc_start_epoch() {
  local p="$1"
  local lstart
  if ! lstart="$(ps -p "$p" -o lstart= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"; then
    echo ''
    return
  fi
  if [[ -z "$lstart" ]]; then echo ''; return; fi
  local ep
  ep="$(date -u -d "$lstart" +%s 2>/dev/null || true)"
  if [[ -z "$ep" ]]; then
    ep="$(date -j -f '%a %b %e %H:%M:%S %Y' "$lstart" +%s 2>/dev/null || true)"
  fi
  echo "$ep"
}

# === Main flow =================================================================

step "stop_proxy.sh (dry-run=$DRY_RUN, force=$FORCE)"

if [[ ! -f "$PID_FILE" ]]; then
  sub "not running (no PID file at $PID_FILE)"
  if [[ -f "$META_FILE" && $DRY_RUN -eq 0 ]]; then
    rm -f "$META_FILE"
    sub "cleaned up orphan meta file $META_FILE"
  fi
  exit 0
fi

if ! pid_text="$(tr -d '[:space:]' < "$PID_FILE")"; then
  err "could not read PID file $PID_FILE"
  exit 1
fi

if ! [[ "$pid_text" =~ ^[0-9]+$ ]] || [[ "$pid_text" -le 0 ]]; then
  sub "PID file at $PID_FILE contains invalid PID '$pid_text'; cleaning up"
  if [[ $DRY_RUN -eq 0 ]]; then
    rm -f "$PID_FILE"
    [[ -f "$META_FILE" ]] && rm -f "$META_FILE"
  fi
  exit 0
fi

TARGET_PID="$pid_text"

if ! pid_alive "$TARGET_PID"; then
  sub "stale PID file at $PID_FILE (PID $TARGET_PID not running); cleaning up"
  if [[ $DRY_RUN -eq 0 ]]; then
    rm -f "$PID_FILE"
    [[ -f "$META_FILE" ]] && rm -f "$META_FILE"
  fi
  exit 0
fi

sub "PID $TARGET_PID is alive"

# Step 1.5: H3 PID-identity verification via meta.json.
# ITER-3 Fix-3 (HIGH-3): mirror PowerShell stop_proxy.ps1's strict
# branching. When meta file is PRESENT but invalid, REFUSE (exit 1, KEEP
# files). Only fall through to PID-only verification when meta file is
# fully ABSENT (backward compat path).
if [[ -f "$META_FILE" ]]; then
  if ! META_BODY="$(cat "$META_FILE" 2>/dev/null)"; then
    err "meta file $META_FILE present but unreadable. Refusing to stop (cannot verify PID identity). Files KEPT: $PID_FILE, $META_FILE. Delete the meta file manually if you want to force-stop the process via PID alone."
    exit 1
  fi
  META_PID="$(json_extract "$META_BODY" 'pid')"
  META_STARTED_AT="$(json_extract "$META_BODY" 'started_at')"
  if [[ -z "$META_PID" || ! "$META_PID" =~ ^[0-9]+$ ]]; then
    err "meta file $META_FILE present but missing/invalid 'pid' field. Refusing to stop (cannot verify PID identity). Files KEPT: $PID_FILE, $META_FILE. Delete the meta file manually if you want to force-stop the process via PID alone."
    exit 1
  fi
  if [[ "$META_PID" != "$TARGET_PID" ]]; then
    err "meta.pid ($META_PID) does not match PID-file ($TARGET_PID). Refusing to stop. Investigate: meta file at $META_FILE, PID file at $PID_FILE."
    exit 1
  fi
  # ITER-3 Fix-3: missing/unparseable started_at = REFUSE (was: warn + skip).
  if [[ -z "$META_STARTED_AT" ]]; then
    err "meta file $META_FILE present but missing 'started_at' field. Refusing to stop (cannot verify PID identity). Files KEPT: $PID_FILE, $META_FILE. Delete the meta file manually if you want to force-stop the process via PID alone."
    exit 1
  fi
  META_EP="$(iso_to_epoch "$META_STARTED_AT")"
  if [[ -z "$META_EP" ]]; then
    err "meta file $META_FILE has unparseable started_at='$META_STARTED_AT'. Refusing to stop (cannot verify PID identity). Files KEPT: $PID_FILE, $META_FILE. Delete the meta file manually if you want to force-stop the process via PID alone."
    exit 1
  fi
  PROC_EP="$(proc_start_epoch "$TARGET_PID")"
  if [[ -z "$PROC_EP" ]]; then
    warn "could not read live process start time for PID $TARGET_PID; skipping identity check (best-effort)."
  else
    DELTA=$(( META_EP - PROC_EP ))
    if [[ $DELTA -lt 0 ]]; then DELTA=$(( -DELTA )); fi
    if [[ $DELTA -gt $IDENTITY_TOLERANCE_SEC ]]; then
      err "PID $TARGET_PID identity mismatch (per H3): meta.started_at=$META_STARTED_AT (epoch $META_EP) but live process start (epoch $PROC_EP); delta=${DELTA}s exceeds tolerance ${IDENTITY_TOLERANCE_SEC}s. PID may have been recycled to a different process. Refusing to kill. Files KEPT: $PID_FILE, $META_FILE. Investigate manually."
      exit 1
    fi
    sub "PID identity verified (started_at delta=${DELTA}s within +/-${IDENTITY_TOLERANCE_SEC}s)"
  fi
else
  warn "meta.json missing; falling back to PID-only verification (cannot detect PID recycling)."
fi

# Step 3: SIGTERM (true graceful drain on POSIX -- triggers Node SIGTERM handler).
step "stopping PID $TARGET_PID (SIGTERM; POSIX delivers to Node)"
if [[ $DRY_RUN -eq 1 ]]; then
  sub "[dry-run] would: kill -TERM $TARGET_PID"
  if [[ $FORCE -eq 1 ]]; then
    sub "[dry-run] --force passed; would skip drain wait"
  else
    sub "[dry-run] would poll for graceful exit up to ${DRAIN_TIMEOUT_SEC}s"
  fi
  sub "[dry-run] would: kill -KILL $TARGET_PID (if still alive)"
  sub "[dry-run] would re-poll liveness 2s after force-kill (M3); KEEP files + exit 1 on still-alive"
  sub "[dry-run] would delete PID file $PID_FILE and meta file $META_FILE"
  exit 0
fi

if ! kill -TERM "$TARGET_PID" 2>/dev/null; then
  err "kill -TERM $TARGET_PID failed"
  exit 1
fi

START_EPOCH=$(date +%s)
EXIT_METHOD='unknown'

if [[ $FORCE -eq 1 ]]; then
  sub '--force passed; skipping drain wait'
else
  step "waiting up to ${DRAIN_TIMEOUT_SEC}s for graceful drain"
  DEADLINE=$(( START_EPOCH + DRAIN_TIMEOUT_SEC ))
  while [[ $(date +%s) -lt $DEADLINE ]] && pid_alive "$TARGET_PID"; do
    sleep 0.5
  done
  if ! pid_alive "$TARGET_PID"; then
    EXIT_METHOD='graceful (SIGTERM-handler drain on POSIX)'
    DRAIN_SEC=$(( $(date +%s) - START_EPOCH ))
    sub "PID $TARGET_PID exited gracefully in ${DRAIN_SEC}s"
  fi
fi

# Step 5: force-kill if still alive, with M3 post-force-kill liveness check.
if pid_alive "$TARGET_PID"; then
  kill -KILL "$TARGET_PID" 2>/dev/null || true
  POST_DEADLINE=$(( $(date +%s) + 2 ))
  while [[ $(date +%s) -lt $POST_DEADLINE ]] && pid_alive "$TARGET_PID"; do
    sleep 0.5
  done
  if pid_alive "$TARGET_PID"; then
    err "could not force-kill PID $TARGET_PID; check process state manually. Files KEPT: $PID_FILE, $META_FILE."
    exit 1
  fi
  if [[ $FORCE -eq 1 ]]; then
    EXIT_METHOD='force-killed (--force flag)'
    sub "force-killed PID $TARGET_PID"
  else
    EXIT_METHOD='force-killed (drain exceeded)'
    warn "graceful drain exceeded ${DRAIN_TIMEOUT_SEC}s; force-killed PID $TARGET_PID"
  fi
fi

# Step 6: delete PID file AND meta file (only after confirmed gone).
if [[ -f "$PID_FILE" ]]; then
  rm -f "$PID_FILE"
  sub "deleted PID file $PID_FILE"
fi
if [[ -f "$META_FILE" ]]; then
  rm -f "$META_FILE"
  sub "deleted meta file $META_FILE"
fi

# Step 7: summary.
TOTAL_SEC=$(( $(date +%s) - START_EPOCH ))
step 'summary'
echo
echo '=== copilot-proxy stopped ==='
echo "  PID:            $TARGET_PID"
echo "  drain duration: ${TOTAL_SEC}s"
echo "  exit method:    $EXIT_METHOD"
exit 0
