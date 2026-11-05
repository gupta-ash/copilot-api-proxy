# stop_proxy.ps1 -- standalone graceful stop of copilot-proxy v2.
# PowerShell 5.1+ compatible.
#
# Companion of start_proxy.ps1 / start_proxy_no_rollback.ps1 / status_proxy.ps1.
#
# It:
#   1. Reads PID file at <RepoPath>/logs/copilot-proxy.pid (single decimal PID,
#      no trailing newline -- written by start_proxy{,_no_rollback}.ps1; we
#      .Trim() defensively in case the operator hand-edited it).
#   1.5. Per discriminator finding H3: reads meta.json at
#        <RepoPath>/logs/copilot-proxy.meta.json. Verifies PID + started_at
#        match the live process's StartTime within +/-2 seconds. On
#        mismatch: REFUSE to kill (PID may have been recycled), exit 1,
#        KEEP both files.
#        ITER-3 Fix-6 (MEDIUM-3, option b): the prior error message
#        misleadingly advertised `-Force` as a bypass for meta validation,
#        but `-Force` only skips post-SIGTERM drain wait; it does NOT
#        bypass meta validation. The error message has been corrected to
#        instruct manual deletion of the meta file (the real escape hatch).
#        We chose option (b) over option (a) — adding an explicit `-Force`
#        bypass — because:
#          (1) the user explicitly chose strict-validation discipline; an
#              undocumented `-Force` bypass widens attack surface; and
#          (2) manual `Remove-Item $MetaFile` is a deliberate, auditable
#              operator action and forces them to acknowledge the risk.
#        If meta.json absent: WARN + fall back to PID-only verification
#        (backward compat for pre-remediation installs).
#   2. If PID file missing: print 'not running' and exit 0 (no-op-clean).
#      If PID file present but PID dead: clean up stale file (and meta if
#      present) and exit 0.
#   3. Per discriminator finding H2 (Windows hard-kill honesty): on Windows,
#      `Stop-Process` is effectively `TerminateProcess` -- the Node process
#      is hard-killed without delivering its `process.on('SIGTERM')`
#      handler. The 35s drain wait is therefore the time for the OS to
#      reap the process, NOT graceful in-flight-request drain. For true
#      graceful drain on Windows, use the nssm service (which sends
#      Ctrl-Break via the Service Control Manager).
#      We try `taskkill /PID $targetPid` (no /F) FIRST as a best-effort
#      graceful try. taskkill without /F sends WM_CLOSE; for hidden-
#      console Node processes this MAY trigger SetConsoleCtrlHandler.
#      If the process exits within the 35s window, label exit method
#      "exited via taskkill (may have been graceful Ctrl-C handler)".
#      If still alive after 35s, fall through to `Stop-Process -Force`.
#   4. Polls Get-Process every 500ms for up to 35s (M5 SIGTERM drain is
#      30s + 5s safety margin per src/main.ts:228,231).
#   5. Force-kills with Stop-Process -Force on timeout. Per discriminator
#      finding M3: re-polls liveness for 2s after force-kill (500ms
#      intervals); on STILL-alive, prints ERROR + KEEPS PID + meta files
#      + exits 1. Files only deleted once liveness check confirms gone.
#   6. Deletes the PID file AND meta file.
#   7. Prints summary including honest exit-method label.
#
# IDEMPOTENT: re-runnable; missing/stale PID file → no-op exit 0.
#
# Parameters:
#   -Force      Skip drain wait; force-kill immediately after taskkill try.
#               NOTE: -Force does NOT bypass meta validation. To stop a
#               process when meta.json is corrupt, manually delete the
#               meta file first: `Remove-Item .\logs\copilot-proxy.meta.json`.
#   -DryRun     Print planned actions; no mutations.
#
# Exit codes:
#   0  success (incl. no-op-clean)
#   1  unexpected error (permission denied, PID file unreadable,
#      meta-mismatch refusal, force-kill failure)

[CmdletBinding()]
param(
    [switch]$Force,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoPath = (Resolve-Path (Join-Path $ScriptDir '..')).ProviderPath
$LogsDir = Join-Path $RepoPath 'logs'
$PidFile = Join-Path $LogsDir 'copilot-proxy.pid'
$MetaFile = Join-Path $LogsDir 'copilot-proxy.meta.json'

$DrainTimeoutSec = 35
$IdentityToleranceSec = 2.0   # +/-2s tolerance on started_at vs StartTime

function Write-Step([string]$msg) {
    Write-Host ('=== ' + $msg) -ForegroundColor Cyan
}
function Write-Sub([string]$msg) {
    Write-Host ('  - ' + $msg) -ForegroundColor Gray
}
function Write-Err([string]$msg) {
    Write-Host ('ERROR: ' + $msg) -ForegroundColor Red
}
function Write-Warn([string]$msg) {
    Write-Host ('WARNING: ' + $msg) -ForegroundColor Yellow
}

function Test-PidAlive {
    param([int]$TargetPid)
    try {
        $p = Get-Process -Id $TargetPid -ErrorAction Stop
        return $null -ne $p
    } catch {
        return $false
    }
}

function Get-ProcessStartTime {
    param([int]$TargetPid)
    try {
        $p = Get-Process -Id $TargetPid -ErrorAction Stop
        # StartTime is local time; convert to UTC for comparison with meta.started_at.
        return $p.StartTime.ToUniversalTime()
    } catch {
        return $null
    }
}

# === Main flow =================================================================

Write-Step "stop_proxy.ps1 (DryRun=$DryRun, Force=$Force)"

# Step 1+2: read PID file, handle no-op cases.
if (-not (Test-Path $PidFile)) {
    Write-Sub "not running (no PID file at $PidFile)"
    # If a stray meta file exists without a PID file, clean it up too.
    if ((Test-Path $MetaFile) -and (-not $DryRun)) {
        Remove-Item -Force $MetaFile
        Write-Sub "cleaned up orphan meta file $MetaFile"
    }
    exit 0
}

try {
    $pidText = (Get-Content -Raw -Path $PidFile).Trim()
} catch {
    Write-Err "could not read PID file ${PidFile}: $_"
    exit 1
}

$targetPid = 0
if (-not [int]::TryParse($pidText, [ref]$targetPid) -or $targetPid -le 0) {
    Write-Sub "PID file at $PidFile contains invalid PID '$pidText'; cleaning up"
    if (-not $DryRun) {
        Remove-Item -Force $PidFile
        if (Test-Path $MetaFile) { Remove-Item -Force $MetaFile }
    }
    exit 0
}

if (-not (Test-PidAlive -TargetPid $targetPid)) {
    Write-Sub "stale PID file at $PidFile (PID $targetPid not running); cleaning up"
    if (-not $DryRun) {
        Remove-Item -Force $PidFile
        if (Test-Path $MetaFile) { Remove-Item -Force $MetaFile }
    }
    exit 0
}

Write-Sub "PID $targetPid is alive"

# Step 1.5: H3 PID-identity verification via meta.json.
if (Test-Path $MetaFile) {
    try {
        $metaJson = Get-Content -Raw -Path $MetaFile | ConvertFrom-Json
    } catch {
        Write-Err "meta file $MetaFile present but unreadable/invalid JSON: $_. Refusing to stop (cannot verify PID identity). Files KEPT: $PidFile, $MetaFile. Delete the meta file manually if you want to force-stop the process via PID alone (-Force does NOT bypass meta validation)."
        exit 1
    }
    # Confirm PID matches.
    $metaPid = [int]($metaJson.pid)
    if ($metaPid -ne $targetPid) {
        Write-Err "meta.pid ($metaPid) does not match PID-file ($targetPid). Refusing to stop. Investigate: meta file at $MetaFile, PID file at $PidFile."
        exit 1
    }
    # Compare started_at against process StartTime within tolerance.
    $procStartUtc = Get-ProcessStartTime -TargetPid $targetPid
    if ($null -eq $procStartUtc) {
        Write-Warn "could not read StartTime for PID $targetPid; skipping identity check (best-effort)."
    } else {
        # #3 fix: a meta written by a foreign writer (older script version /
        # Task Scheduler / service wrapper) may store started_at WITHOUT a
        # timezone designator (e.g. "06/22/2026 02:09:01"). RoundtripKind would
        # treat such a value as LOCAL time and .ToUniversalTime() would shift it
        # by the UTC offset, producing a false identity mismatch (the H3
        # 7-hours-delta bug). All proxy writers intend UTC, so when no tz
        # designator (trailing Z or +/-HH:MM offset) is present, parse the value
        # AS universal rather than local.
        $startedAtRaw = [string]$metaJson.started_at
        $hasTz = ($startedAtRaw -match 'Z$') -or ($startedAtRaw -match '[+\-]\d{2}:?\d{2}$')
        if ($hasTz) {
            $metaStartedAtUtc = [DateTime]::Parse($startedAtRaw, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
        } else {
            $metaStartedAtUtc = [DateTime]::Parse($startedAtRaw, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal -bor [System.Globalization.DateTimeStyles]::AdjustToUniversal)
        }
        $deltaSec = [math]::Abs(($procStartUtc - $metaStartedAtUtc).TotalSeconds)
        if ($deltaSec -gt $IdentityToleranceSec) {
            Write-Err "PID $targetPid identity mismatch (per H3): meta.started_at=$($metaJson.started_at) but live process StartTime (UTC)=$($procStartUtc.ToString('o')); delta=${deltaSec}s exceeds tolerance ${IdentityToleranceSec}s. PID may have been recycled to a different process. Refusing to kill. Files KEPT: $PidFile, $MetaFile. Investigate manually."
            exit 1
        }
        Write-Sub "PID identity verified (started_at delta=${deltaSec}s within +/-${IdentityToleranceSec}s)"
    }
} else {
    Write-Warn "meta.json missing; falling back to PID-only verification (cannot detect PID recycling)."
}

# Step 3: graceful try via taskkill (H2), then Stop-Process fallback.
Write-Step "stopping PID $targetPid (H2: taskkill graceful try, then Stop-Process)"
if ($DryRun) {
    Write-Sub "[dry-run] would: taskkill /PID $targetPid (no /F) as graceful try"
    Write-Sub "[dry-run] note: on Windows, Stop-Process is effectively TerminateProcess (hard-kill); see header comment + runbook for honest semantics"
    if ($Force) {
        Write-Sub "[dry-run] -Force passed; would skip drain wait"
    } else {
        Write-Sub "[dry-run] would poll for graceful exit up to ${DrainTimeoutSec}s"
    }
    Write-Sub "[dry-run] would: Stop-Process -Id $targetPid -Force (if still alive)"
    Write-Sub "[dry-run] would re-poll liveness 2s after force-kill (M3); KEEP files + exit 1 on still-alive"
    Write-Sub "[dry-run] would delete PID file $PidFile and meta file $MetaFile"
    exit 0
}

# Try taskkill first (H2 best-effort graceful).
$taskkillOk = $false
try {
    $tkOut = & taskkill /PID $targetPid 2>&1
    if ($LASTEXITCODE -eq 0) {
        $taskkillOk = $true
        Write-Sub "taskkill /PID $targetPid issued (best-effort graceful; may or may not trigger Node SIGTERM handler)"
    } else {
        Write-Sub "taskkill /PID $targetPid returned $LASTEXITCODE; falling back to Stop-Process"
    }
} catch {
    Write-Sub "taskkill not available or failed ($_); falling back to Stop-Process"
}

if (-not $taskkillOk) {
    try {
        Stop-Process -Id $targetPid -ErrorAction SilentlyContinue
        Write-Sub "Stop-Process -Id $targetPid issued (Windows: hard-kill via TerminateProcess)"
    } catch {
        Write-Err "Stop-Process -Id ${targetPid}: $_"
        exit 1
    }
}

$startTime = Get-Date
$exitMethod = 'unknown'

if ($Force) {
    Write-Sub '-Force passed; skipping drain wait'
} else {
    Write-Step "waiting up to ${DrainTimeoutSec}s for process exit"
    $deadline = $startTime.AddSeconds($DrainTimeoutSec)
    while ((Get-Date) -lt $deadline -and (Test-PidAlive -TargetPid $targetPid)) {
        Start-Sleep -Milliseconds 500
    }
    if (-not (Test-PidAlive -TargetPid $targetPid)) {
        $drainSec = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
        if ($taskkillOk) {
            $exitMethod = "exited via taskkill in ${drainSec}s (may have been graceful Ctrl-C handler)"
        } else {
            $exitMethod = "exited in ${drainSec}s (Windows: hard-kill via Stop-Process; not a SIGTERM-handler drain)"
        }
        Write-Sub "PID $targetPid $exitMethod"
    }
}

# Step 5: force-kill if still alive, with M3 post-force-kill liveness check.
if (Test-PidAlive -TargetPid $targetPid) {
    try {
        Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Err "Stop-Process -Force -Id ${targetPid}: $_"
    }
    # Per discriminator finding M3: re-poll liveness for up to 2s post-force-kill.
    $postKillDeadline = (Get-Date).AddSeconds(2)
    while ((Get-Date) -lt $postKillDeadline -and (Test-PidAlive -TargetPid $targetPid)) {
        Start-Sleep -Milliseconds 500
    }
    if (Test-PidAlive -TargetPid $targetPid) {
        Write-Err "could not force-kill PID $targetPid; check process state manually. Files KEPT: $PidFile, $MetaFile."
        exit 1
    }
    if ($Force) {
        $exitMethod = 'force-killed (-Force flag; Windows: hard-kill via Stop-Process -Force)'
        Write-Sub "force-killed PID $targetPid"
    } else {
        $exitMethod = 'force-killed (drain exceeded; Windows: hard-kill via Stop-Process -Force)'
        Write-Warn "graceful drain exceeded ${DrainTimeoutSec}s; force-killed PID $targetPid"
    }
}

# Step 6: delete PID file AND meta file (only after confirmed gone).
if (Test-Path $PidFile) {
    Remove-Item -Force $PidFile
    Write-Sub "deleted PID file $PidFile"
}
if (Test-Path $MetaFile) {
    Remove-Item -Force $MetaFile
    Write-Sub "deleted meta file $MetaFile"
}

# Step 7: summary.
$totalSec = [math]::Round(((Get-Date) - $startTime).TotalSeconds, 1)
Write-Step 'summary'
Write-Host ''
Write-Host '=== copilot-proxy stopped ===' -ForegroundColor Green
Write-Host "  PID:            $targetPid"
Write-Host "  drain duration: ${totalSec}s"
Write-Host "  exit method:    $exitMethod"
exit 0
