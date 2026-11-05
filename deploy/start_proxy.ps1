# start_proxy.ps1 -- recommended standalone start of copilot-proxy v2 with
# auto-rollback on /health failure. PowerShell 5.1+ compatible.
#
# Sibling of:
#   - start_proxy_no_rollback.ps1 (same flow; LEAVES the started process
#     running on /health failure for operator inspection).
#   - stop_proxy.ps1 / status_proxy.ps1 (lifecycle complement).
#
# Standalone lifecycle launcher; deploy/ in source, scripts/ in the installed bundle.
# NSSM registration remains a separate explicit operation in install_service.ps1. It
# wraps the `node ./dist/main.js` invocation operators were previously
# typing by hand with PID-file management, log redirection, /health
# validation, and auto-rollback.
#
# It:
#   0. ITER-3 Fix-1 (HIGH-1): acquire EXCLUSIVE start lock at
#      <RepoPath>/logs/copilot-proxy.start.lock via New-Item -ItemType
#      Directory (atomic on NTFS) BEFORE preflight. Closes the launch race
#      that survives the atomic-PID-file rename window. Released via
#      try/finally on every exit path (success, rollback, failure, Ctrl-C).
#   1. Pre-flight: PID-file collision check, dist/main.js + node presence,
#      logs dir creation.
#   2. Sets the four COPILOT_PROXY_* env vars from -Port / -Host /
#      -Config / -Force.
#   3. Background-launches `node <RepoPath>/dist/main.js` via Start-Process
#      with stdout/stderr redirected to <RepoPath>/logs/copilot-proxy.*.log.
#   4. Writes the launched PID ATOMICALLY (temp + rename) to
#      <RepoPath>/logs/copilot-proxy.pid -- closes H4 concurrent-start race.
#   5. Polls http://<probe_url>/health for up to 10s where probe_url is
#      built via Get-ProbeUrl (ITER-3 Fix-4 MEDIUM-1: brackets IPv6
#      literals e.g. ::1 -> http://[::1]:4143/health).
#   5.5. Parses auth_status from /health body. Per discriminator finding
#        H1: trigger rollback on auth_status == "failed" / "disposed".
#        Accept "ready", "starting", "uninitialized" (transient).
#   6. Writes meta.json sidecar ATOMICALLY at
#      <RepoPath>/logs/copilot-proxy.meta.json (PID + port + host + repo
#      + ISO-8601 started_at + cmdline + schema_version=1).
#      ITER-3 Fix-2 (HIGH-2): meta.started_at = `$proc.StartTime.ToUniversalTime()`
#      (ACTUAL OS process start time), NOT script-clock at meta-write
#      time. Closes the false-refuse race when /health takes >2s and
#      stop_proxy's identity check exceeds the +/-2s tolerance.
#   7. On health/auth failure: rollback path (SIGTERM-equivalent + 5s
#      wait + force-kill + ITER-3 Fix-5 (MEDIUM-2): re-poll liveness 2s
#      after force-kill; KEEP files + exit 1 on still-alive). On normal
#      rollback completion: delete PID + meta + exit 2. On success: print
#      summary + exit 0.
#
# IDEMPOTENT (re-runnable) only when the prior process has fully stopped.
# Refuses to start if a live PID file exists; suggests stop_proxy first.
#
# Parameters:
#   -Port <int>      Port to bind / probe (default 4143).
#   -Host <string>   Host to bind (default 127.0.0.1).
#   -Config <path>   Path to config.yaml (default unset; main.ts resolves
#                    via PATHS.APP_DIR/config.yaml).
#   -BetaPolicy <m>  anthropic-beta policy: denylist | allowlist | strip_all.
#                    Sets COPILOT_PROXY_BETA_POLICY (default unset; main.ts then
#                    uses config.anthropic_beta.policy). Escape hatch to instantly
#                    restore a known-good posture (allowlist = pre-D1 fail-safe;
#                    strip_all = drop the header entirely).
#   -Force           Set COPILOT_PROXY_ALLOW_PORT_IN_USE=1 (skip
#                    EADDRINUSE pre-check; useful within TIME_WAIT).
#   -DryRun          Print planned actions; no mutations.
#   -ListModels      Print the upstream Copilot model catalog for the
#                    configured OAuth identity, then exit. Does NOT start the
#                    proxy, bind a port, or touch PID/meta/lock files. Read-only
#                    and safe alongside a live proxy. Honors -Config and -DryRun.
#                    Propagates node's exit code (0 ok; 1 token-not-ready/error).
#
# Exit codes:
#   0  success
#   1  pre-flight refusal (lock-held / PID-file collision / dist missing /
#      node missing / rollback-still-alive after force-kill per Fix-5)
#   2  /health poll failure OR auth_status==failed with rollback executed

[CmdletBinding()]
param(
    [int]$Port = 4143,
    [Alias('Host')]
    [string]$BindHost = '127.0.0.1',
    [string]$Config = '',
    [string]$BetaPolicy = '',
    [switch]$Force,
    [switch]$DryRun,
    [switch]$ListModels
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Resolve root one level above source deploy/ or installed scripts/.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoPath = (Resolve-Path (Join-Path $ScriptDir '..')).ProviderPath
$LogsDir = Join-Path $RepoPath 'logs'
$PidFile = Join-Path $LogsDir 'copilot-proxy.pid'
$PidFileTmp = Join-Path $LogsDir 'copilot-proxy.pid.tmp'
$MetaFile = Join-Path $LogsDir 'copilot-proxy.meta.json'
$MetaFileTmp = Join-Path $LogsDir 'copilot-proxy.meta.json.tmp'
$StdoutLog = Join-Path $LogsDir 'copilot-proxy.stdout.log'
$StderrLog = Join-Path $LogsDir 'copilot-proxy.stderr.log'
$DistMain = Join-Path $RepoPath 'dist\main.js'
# ITER-3 Fix-1: exclusive start lock dir (atomic via New-Item -ItemType Directory).
$LockDir = Join-Path $LogsDir 'copilot-proxy.start.lock'

# Windows ACLs: logs/ inherits from <RepoPath>; current-user-only ACLs are
# the default. No explicit icacls needed (per discriminator finding M4).

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

function Preserve-PriorLog {
    <#
      Rotate a prior stdout/stderr log to a timestamped sibling BEFORE Start-Process
      truncates it (Start-Process redirection opens create/truncate), so a crashed
      run's forensics survive the restart (task #4 crash-resilience). Best-effort:
      any failure warns and returns — log preservation must NEVER block the start.
    #>
    param(
        [Parameter(Mandatory = $true)][string]$LogPath,
        [int]$KeepN = 10
    )
    try {
        if (-not (Test-Path -LiteralPath $LogPath)) { return }
        $item = Get-Item -LiteralPath $LogPath -ErrorAction Stop
        if ($item.Length -le 0) { return }

        $dir = Split-Path -Parent $LogPath
        $name = [System.IO.Path]::GetFileNameWithoutExtension($LogPath)  # copilot-proxy.stdout
        $ext = [System.IO.Path]::GetExtension($LogPath)                 # .log
        $stamp = (Get-Date).ToString('yyyyMMdd-HHmmss')
        $dest = Join-Path $dir ($name + '.' + $stamp + $ext)
        # Collision guard for a rapid same-second restart: append -N until free.
        $n = 2
        while (Test-Path -LiteralPath $dest) {
            $dest = Join-Path $dir ($name + '.' + $stamp + '-' + $n + $ext)
            $n++
        }
        Move-Item -LiteralPath $LogPath -Destination $dest -Force
        Write-Sub ('preserved prior log -> ' + (Split-Path -Leaf $dest))

        # Prune: keep the newest $KeepN rotations for this stream, but ALWAYS retain
        # the one we just created ($dest) even under clock skew / future-dated siblings.
        # Match ONLY our EXACT timestamp grammar (<name>.YYYYMMDD-HHMMSS[-N]<ext>) via an
        # anchored, escaped regex, so a manually-archived sibling is never a prune
        # candidate — neither copilot-proxy.stdout.backup.log NOR a timestamp-prefixed
        # one like copilot-proxy.stdout.20260101-000000.bak.log. The optional -N is the
        # collision-guard suffix produced above.
        $destName = Split-Path -Leaf $dest
        $tsRegex = '^' + [regex]::Escape($name) + '\.\d{8}-\d{6}(-\d+)?' + [regex]::Escape($ext) + '$'
        $others = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match $tsRegex -and $_.Name -ne $destName } |
            Sort-Object LastWriteTime -Descending)
        $keepOthers = [Math]::Max(0, $KeepN - 1)   # $dest is always kept separately
        if ($others.Count -gt $keepOthers) {
            $others | Select-Object -Skip $keepOthers | ForEach-Object {
                Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {
        Write-Warn ("could not preserve prior log '" + $LogPath + "': " + $_.Exception.Message)
    }
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

# Per discriminator finding M2: probe the bound host, not hardcoded
# 127.0.0.1. Special case: 0.0.0.0 isn't a valid client-side address, so
# probe 127.0.0.1 in that case; :: -> ::1 (loopback IPv6).
function Get-ProbeHost([string]$BindHost) {
    if ($BindHost -eq '0.0.0.0' -or [string]::IsNullOrEmpty($BindHost)) {
        return '127.0.0.1'
    }
    if ($BindHost -eq '::') {
        return '::1'
    }
    return $BindHost
}

# #2 fix helper: lightweight scan for `server:` -> `host:` in config.yaml.
# Avoids a YAML-parser dependency; handles the standard block-style layout
# (`server:` on its own line, `host:` indented beneath). Skips comment lines
# and inline comments. Returns $null when not found so the caller keeps the
# 127.0.0.1 default.
function Get-ConfigHost([string]$Path) {
    if ([string]::IsNullOrEmpty($Path) -or -not (Test-Path $Path)) { return $null }
    $inServer = $false
    foreach ($line in (Get-Content -Path $Path)) {
        if ($line -match '^\s*#') { continue }
        if ($line -match '^server\s*:\s*$') { $inServer = $true; continue }
        if ($inServer) {
            if ($line -match '^\S') { $inServer = $false; continue }
            if ($line -match '^\s+host\s*:\s*(.+?)\s*$') {
                $val = ($matches[1] -replace '\s+#.*$', '').Trim().Trim('"').Trim("'")
                if (-not [string]::IsNullOrEmpty($val)) { return $val }
            }
        }
    }
    return $null
}

# ITER-3 Fix-4 (MEDIUM-1): build a syntactically-valid http URL given a
# host + port. IPv6 literals MUST be bracketed in URL host components per
# RFC 3986 sec 3.2.2: `http://[::1]:4143/health` not `http://::1:4143/health`.
# Detection heuristic: if host contains ':' AND is not pure-IPv4-dotted
# AND not already bracketed, treat as IPv6 literal -> bracket it.
# IPv4 + hostnames pass through unchanged.
function Get-ProbeUrl([string]$BindHost, [int]$Port, [string]$Path) {
    $h = $BindHost
    if ($h -match ':' -and $h -notmatch '^[0-9.]+$' -and -not $h.StartsWith('[')) {
        $h = '[' + $h + ']'
    }
    return ('http://' + $h + ':' + $Port + $Path)
}

# Returns a hashtable: @{ Ok=$true/$false; AuthStatus='<string>'; Body='<json>' }
# AuthStatus is 'unknown' if extraction fails.
function Test-V2Health {
    param([string]$ProbeHost, [int]$Port, [int]$TimeoutSec = 10)
    $url = Get-ProbeUrl $ProbeHost $Port '/health'
    $start = Get-Date
    while (((Get-Date) - $start).TotalSeconds -lt $TimeoutSec) {
        try {
            $r = Invoke-WebRequest -Uri $url `
                                    -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($r.StatusCode -eq 200) {
                $authStatus = 'unknown'
                try {
                    $json = [string]$r.Content | ConvertFrom-Json
                    if ($null -ne $json -and $null -ne $json.auth_status) {
                        $authStatus = [string]$json.auth_status
                    }
                } catch {
                    # Parse failed; default to unknown (accept).
                }
                return @{ Ok = $true; AuthStatus = $authStatus; Body = [string]$r.Content }
            }
        } catch {
            # try again
        }
        Start-Sleep -Milliseconds 250
    }
    return @{ Ok = $false; AuthStatus = 'unknown'; Body = '' }
}

# === Main flow =================================================================

# --- -ListModels early exit -------------------------------------------------
# Convenience wrapper for `node <repo>/dist/main.js --list-models`: prints the
# upstream Copilot model catalog for the configured OAuth identity and exits,
# WITHOUT starting the proxy, binding a port, or touching PID/meta/lock files.
# Read-only and safe to run alongside a live proxy (same config + token +
# integration-id => same catalog Copilot validates requests against). Honors
# -Config (reads the same config.yaml the proxy would) and -DryRun.
if ($ListModels) {
    Write-Step 'list-models (no proxy start)'

    if (-not (Test-Path $DistMain)) {
        Write-Err "$DistMain not found. Build first: cd $RepoPath && bun run build"
        exit 1
    }
    Write-Sub "dist/main.js: $DistMain"

    $node = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $node) {
        Write-Err 'node executable not found on PATH. Install Node.js or add it to PATH.'
        exit 1
    }
    Write-Sub "node: $($node.Source)"

    if (-not [string]::IsNullOrEmpty($Config)) {
        $env:COPILOT_PROXY_CONFIG = $Config
        Write-Sub "COPILOT_PROXY_CONFIG=$Config"
    }
    if (-not [string]::IsNullOrEmpty($BetaPolicy)) {
        Write-Sub "COPILOT_PROXY_BETA_POLICY=$BetaPolicy"
    }

    if ($DryRun) {
        Write-Sub "[dry-run] would run: node `"$DistMain`" --list-models"
        exit 0
    }

    Write-Host ''
    # Default to failure; only an observed child exit code clears it. This keeps
    # a pre-exec launch failure (node resolved but not launchable) from being
    # reported as success.
    $listExit = 1
    # Scope COPILOT_PROXY_BETA_POLICY to THIS child launch only, then restore it.
    # Process-scope env vars persist across .ps1 invocations in the same
    # PowerShell session, so leaving it set would contaminate a later same-shell
    # start_proxy.ps1 run that passes NO -BetaPolicy. Distinguish "unset" from
    # "empty" via Test-Path so restore is exact.
    $priorBetaSet = Test-Path Env:\COPILOT_PROXY_BETA_POLICY
    $priorBeta = if ($priorBetaSet) { $env:COPILOT_PROXY_BETA_POLICY } else { $null }
    try {
        if (-not [string]::IsNullOrEmpty($BetaPolicy)) {
            $env:COPILOT_PROXY_BETA_POLICY = $BetaPolicy
        }
        & $node.Source "$DistMain" --list-models
        # Child ran without throwing (always in PS 5.1; in PS 7.x when the child
        # exits 0 or native-error-as-terminating is off). Capture its real code.
        $listExit = $LASTEXITCODE
    } catch {
        # PS 7.4+ throws NativeCommandExitException when the child exits non-zero
        # and $PSNativeCommandUseErrorActionPreference is $true. There the child
        # DID run and $LASTEXITCODE holds its code -> propagate it. Any OTHER
        # exception means node never launched -> real error, exit 1.
        if ($_.Exception.GetType().FullName -eq 'System.Management.Automation.NativeCommandExitException') {
            $listExit = $LASTEXITCODE
        } else {
            Write-Err "failed to launch node --list-models: $($_.Exception.Message)"
            $listExit = 1
        }
    } finally {
        if ($priorBetaSet) {
            $env:COPILOT_PROXY_BETA_POLICY = $priorBeta
        } else {
            Remove-Item Env:\COPILOT_PROXY_BETA_POLICY -ErrorAction SilentlyContinue
        }
    }
    if ($null -eq $listExit) { $listExit = 1 }
    exit $listExit
}

# #2 fix: honor config.yaml `server.host` when -Host is NOT explicitly passed.
# Previously -Host defaulted to 127.0.0.1 and was ALWAYS exported as
# COPILOT_PROXY_HOST, which overrode config.server.host in main.ts (env wins).
# Now, when the operator does not pass -Host, the bind host is taken from
# config.yaml so `server.host: 0.0.0.0` / a LAN IP takes effect. The resolved
# host also keeps the post-start /health probe and the meta sidecar pointed at
# the real bound address. An explicit -Host still wins.
if (-not $PSBoundParameters.ContainsKey('BindHost')) {
    $cfgPathForHost = if (-not [string]::IsNullOrEmpty($Config)) { $Config }
                      elseif (-not [string]::IsNullOrEmpty($env:COPILOT_PROXY_CONFIG)) { $env:COPILOT_PROXY_CONFIG }
                      else { Join-Path $env:USERPROFILE '.local\share\copilot-proxy\config.yaml' }
    $cfgHost = Get-ConfigHost -Path $cfgPathForHost
    if (-not [string]::IsNullOrEmpty($cfgHost)) {
        $BindHost = $cfgHost
    }
}

Write-Step "start_proxy.ps1 -Port $Port -Host $BindHost (DryRun=$DryRun, Force=$Force)"

$ProbeHost = Get-ProbeHost $BindHost

# ITER-3 Fix-1 (HIGH-1): acquire exclusive start lock BEFORE preflight.
# We need the logs dir to exist for the lock dir. mkdir -p the logs dir
# first (idempotent; not a mutation in dry-run since we still need to
# acquire the lock so the dry-run reflects real behavior).
if (-not (Test-Path $LogsDir)) {
    New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
}

$LockAcquired = $false
try {
    try {
        New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
        $LockAcquired = $true
        Write-Sub "acquired start lock: $LockDir"
    } catch {
        Write-Err "another start_proxy is in progress (lock dir $LockDir exists). Wait for it to finish, or remove the lock dir manually if stale: Remove-Item -Recurse -Force '$LockDir'"
        exit 1
    }

# Pre-flight ------------------------------------------------------------------
Write-Step 'pre-flight'

# 1. PID-file collision check.
if (Test-Path $PidFile) {
    $existingPidText = (Get-Content -Raw -Path $PidFile).Trim()
    $existingPid = 0
    if ([int]::TryParse($existingPidText, [ref]$existingPid) -and (Test-PidAlive -TargetPid $existingPid)) {
        Write-Err "PID file $PidFile exists and PID $existingPid is alive. Run stop_proxy.ps1 first."
        exit 1
    } else {
        Write-Sub "stale PID file at $PidFile (PID '$existingPidText' not running); will overwrite"
    }
}

# 2. dist/main.js presence.
if (-not (Test-Path $DistMain)) {
    Write-Err "$DistMain not found. Build first: cd $RepoPath && bun run build"
    exit 1
}
Write-Sub "dist/main.js: $DistMain"

# 3. node presence.
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Err 'node not found on PATH. Install Node.js or add it to PATH.'
    exit 1
}
Write-Sub "node: $($node.Source)"

# 4. logs dir.
if ($DryRun) {
    Write-Sub "[dry-run] would: mkdir -p $LogsDir"
} else {
    New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
    Write-Sub "logs dir: $LogsDir"
}

# Env vars --------------------------------------------------------------------
Write-Step 'setting env vars'
Write-Sub "COPILOT_PROXY_PORT=$Port"
Write-Sub "COPILOT_PROXY_HOST=$BindHost"
if (-not [string]::IsNullOrEmpty($Config)) { Write-Sub "COPILOT_PROXY_CONFIG=$Config" }
if (-not [string]::IsNullOrEmpty($BetaPolicy)) { Write-Sub "COPILOT_PROXY_BETA_POLICY=$BetaPolicy" }
if ($Force) { Write-Sub "COPILOT_PROXY_ALLOW_PORT_IN_USE=1" }

if (-not $DryRun) {
    $env:COPILOT_PROXY_PORT = "$Port"
    $env:COPILOT_PROXY_HOST = "$BindHost"
    if (-not [string]::IsNullOrEmpty($Config)) { $env:COPILOT_PROXY_CONFIG = $Config }
    # COPILOT_PROXY_BETA_POLICY is NOT set here — it is scoped to the child spawn
    # (set immediately before Start-Process, restored right after) so it does not
    # persist into a later same-shell start_proxy.ps1 run. See below.
    if ($Force) { $env:COPILOT_PROXY_ALLOW_PORT_IN_USE = '1' }
}

# Background-launch -----------------------------------------------------------
$ProbeUrl = Get-ProbeUrl $ProbeHost $Port '/health'
Write-Step "background-launch: node $DistMain"
if ($DryRun) {
    Write-Sub "[dry-run] would preserve prior $StdoutLog / $StderrLog to timestamped siblings (keep newest 10)"
    Write-Sub "[dry-run] would Start-Process node -ArgumentList $DistMain -RedirectStandardOutput $StdoutLog -RedirectStandardError $StderrLog -WindowStyle Hidden -PassThru"
    Write-Sub "[dry-run] would write PID atomically (temp + rename) to $PidFile"
    Write-Sub "[dry-run] would Test-V2Health -ProbeHost $ProbeHost -Port $Port -TimeoutSec 10 (probe URL: $ProbeUrl)"
    Write-Sub "[dry-run] would parse auth_status from /health body"
    Write-Sub "[dry-run] would write meta.json atomically (temp + rename) to $MetaFile (started_at = `$proc.StartTime.ToUniversalTime())"
    exit 0
}

# Preserve the prior run's logs before Start-Process truncates them (task #4).
Preserve-PriorLog $StdoutLog
Preserve-PriorLog $StderrLog

# Scope COPILOT_PROXY_BETA_POLICY to the child spawn only, then restore it.
# Start-Process inherits the parent env at spawn time so the child keeps the
# value; restoring immediately after (in finally) prevents a later same-shell
# start_proxy.ps1 run WITHOUT -BetaPolicy from inheriting a stale value
# (process-scope env vars persist across .ps1 invocations in one PS session).
# Test-Path distinguishes "unset" from "empty" so the restore is exact.
$priorBetaSet = Test-Path Env:\COPILOT_PROXY_BETA_POLICY
$priorBeta = if ($priorBetaSet) { $env:COPILOT_PROXY_BETA_POLICY } else { $null }
try {
    if (-not [string]::IsNullOrEmpty($BetaPolicy)) {
        $env:COPILOT_PROXY_BETA_POLICY = $BetaPolicy
    }
    $proc = Start-Process node `
        -ArgumentList ('"' + $DistMain + '"') `
        -RedirectStandardOutput $StdoutLog `
        -RedirectStandardError $StderrLog `
        -WindowStyle Hidden `
        -PassThru
} finally {
    if ($priorBetaSet) {
        $env:COPILOT_PROXY_BETA_POLICY = $priorBeta
    } else {
        Remove-Item Env:\COPILOT_PROXY_BETA_POLICY -ErrorAction SilentlyContinue
    }
}
$startedPid = $proc.Id
Write-Sub "started PID $startedPid"

# ITER-3 Fix-2 (HIGH-2): capture ACTUAL OS process start time IMMEDIATELY
# after Start-Process returns. This becomes meta.started_at. stop_proxy
# reads (Get-Process -Id $pid).StartTime which is the same OS clock, so
# delta is ~0 modulo measurement jitter. Previous behavior (Get-Date at
# meta-write time, AFTER the up-to-10s /health probe) caused false stop
# refusals when /health probe took >2s.
$startedAtUtc = $proc.StartTime.ToUniversalTime()
Write-Sub ("captured OS StartTime: " + $startedAtUtc.ToString('o'))

# Per discriminator finding H4: write PID file atomically (temp + rename)
# to close the concurrent-start race window. WriteAllText to .tmp then
# Move-Item -Force replaces atomically on Windows NTFS.
[System.IO.File]::WriteAllText($PidFileTmp, "$startedPid")
Move-Item -Force -Path $PidFileTmp -Destination $PidFile
Write-Sub "PID file (atomic): $PidFile"

# Health poll -----------------------------------------------------------------
Write-Step "probing $ProbeUrl (up to 10s)"
$healthResult = Test-V2Health -ProbeHost $ProbeHost -Port $Port -TimeoutSec 10
$rollback = $false
$failureReason = ''

if (-not $healthResult.Ok) {
    Write-Err "/health did not return 200 within 10s."
    $rollback = $true
    $failureReason = '/health poll timeout'
} else {
    Write-Sub '/health OK'
    Write-Sub "auth_status: $($healthResult.AuthStatus)"
    # Per discriminator finding H1: parse auth_status; rollback on failed/disposed.
    if ($healthResult.AuthStatus -eq 'failed' -or $healthResult.AuthStatus -eq 'disposed') {
        Write-Err "auth_status reports '$($healthResult.AuthStatus)' (terminal failure state); rolling back."
        $rollback = $true
        $failureReason = "auth_status=$($healthResult.AuthStatus)"
    }
}

if ($rollback) {
    Write-Err "Rolling back PID $startedPid ($failureReason)."
    if (Test-PidAlive -TargetPid $startedPid) {
        try { Stop-Process -Id $startedPid -ErrorAction SilentlyContinue } catch {}
    }
    # Wait up to 5s for graceful exit.
    $deadline = (Get-Date).AddSeconds(5)
    while ((Get-Date) -lt $deadline -and (Test-PidAlive -TargetPid $startedPid)) {
        Start-Sleep -Milliseconds 250
    }
    if (Test-PidAlive -TargetPid $startedPid) {
        try { Stop-Process -Id $startedPid -Force -ErrorAction SilentlyContinue } catch {}
        # ITER-3 Fix-5 (MEDIUM-2): re-poll liveness 2s post-force-kill
        # (mirror stop_proxy's M3 fix). On STILL-alive: KEEP files + exit 1
        # (rollback-failure-failure, NOT exit 2).
        $postKillDeadline = (Get-Date).AddSeconds(2)
        while ((Get-Date) -lt $postKillDeadline -and (Test-PidAlive -TargetPid $startedPid)) {
            Start-Sleep -Milliseconds 500
        }
        if (Test-PidAlive -TargetPid $startedPid) {
            Write-Err "could not force-kill PID $startedPid after rollback; check process state manually. Files KEPT: $PidFile (no meta written yet)."
            exit 1
        }
        Write-Sub "force-killed PID $startedPid"
    } else {
        Write-Sub "PID $startedPid exited gracefully"
    }
    if (Test-Path $PidFile) {
        Remove-Item -Force $PidFile
        Write-Sub "deleted PID file $PidFile"
    }
    if (Test-Path $MetaFile) {
        Remove-Item -Force $MetaFile
        Write-Sub "deleted meta file $MetaFile"
    }
    exit 2
}

# Per discriminator findings H3 + M1: write meta.json sidecar atomically.
# stop_proxy uses meta.started_at to verify PID identity (catch PID
# recycling); status_proxy uses meta.port + meta.host for probes.
# ITER-3 Fix-2: started_at = ACTUAL OS process start time (captured above
# as $startedAtUtc), NOT script-clock at meta-write time.
$startedAtIso = $startedAtUtc.ToString('o')
$cmdline = "node $DistMain"
$meta = [ordered]@{
    pid             = $startedPid
    port            = $Port
    host            = $BindHost
    repo            = $RepoPath
    started_at      = $startedAtIso
    cmdline         = $cmdline
    schema_version  = 1
}
$metaJson = $meta | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText($MetaFileTmp, $metaJson)
Move-Item -Force -Path $MetaFileTmp -Destination $MetaFile
Write-Sub "meta file (atomic): $MetaFile"

# Phase 5 v3.1 Group D (F-DISC-12): poll the proxy's meta.json for resolved
# config_path + trace_dir. The proxy writes this to ~/.local/share/copilot-proxy/
# logs/copilot-proxy.meta.json AFTER successful startup (post-Group-B main.ts).
# Distinct from the script's own meta.json at <repo>/logs/.
$ProxyMetaPath = Join-Path $env:USERPROFILE '.local\share\copilot-proxy\logs\copilot-proxy.meta.json'
$ResolvedConfig = $null
$ResolvedTraceDir = $null
$pollAttempts = 0
while ($pollAttempts -lt 25) {
    if (Test-Path $ProxyMetaPath) {
        try {
            $proxyMeta = Get-Content $ProxyMetaPath -Raw | ConvertFrom-Json
            if ($proxyMeta.config_path) {
                $ResolvedConfig = $proxyMeta.config_path
                # trace_dir may be null in JSON when level < raw; ConvertFrom-Json
                # surfaces that as $null. Read forward-compatibly (don't validate
                # schema_version; future schemas with extra keys still parse).
                if ($proxyMeta.PSObject.Properties.Name -contains 'trace_dir') {
                    $ResolvedTraceDir = $proxyMeta.trace_dir
                }
                break
            }
        } catch {
            # JSON parse failed (mid-write race) -- retry
        }
    }
    Start-Sleep -Milliseconds 200
    $pollAttempts++
}
if (-not $ResolvedConfig) {
    Write-Warn "proxy meta.json not visible at $ProxyMetaPath within 5s; Config:/Trace dir: lines omitted from summary (check stdout log for proxy-side warning)."
}

# Summary ---------------------------------------------------------------------
$MetricsUrl = Get-ProbeUrl $ProbeHost $Port '/metrics'
Write-Step 'summary'
Write-Host ''
Write-Host '=== copilot-proxy started ===' -ForegroundColor Green
Write-Host "  PID:           $startedPid"
Write-Host "  port:          $Port"
Write-Host "  host:          $BindHost"
Write-Host "  /health:       OK"
Write-Host "  auth_status:   $($healthResult.AuthStatus)"
Write-Host "  /metrics:      $MetricsUrl"
Write-Host "  PID file:      $PidFile"
Write-Host "  meta file:     $MetaFile"
Write-Host "  stdout log:    $StdoutLog"
Write-Host "  stderr log:    $StderrLog"
if ($ResolvedConfig) {
    Write-Host "  Config:        $ResolvedConfig"
} else {
    Write-Host "  Config:        (proxy meta.json not yet written; check stdout log)" -ForegroundColor Yellow
}
if ($ResolvedTraceDir) {
    Write-Host "  Trace dir:     $ResolvedTraceDir"
}
# When $ResolvedTraceDir is null/empty, intentionally omit the line (level < raw).
Write-Host "  stop with:     & `"$ScriptDir\stop_proxy.ps1`""
exit 0

}
finally {
    # ITER-3 Fix-1: release lock on EVERY exit path (success, rollback,
    # failure, Ctrl-C). Best-effort; if removal fails, the next start_proxy
    # will report "lock held" and the operator can clean up manually.
    if ($LockAcquired -and (Test-Path $LockDir)) {
        try {
            Remove-Item -Force -Recurse $LockDir -ErrorAction SilentlyContinue
            Write-Host "  - released start lock: $LockDir" -ForegroundColor Gray
        } catch {
            # best-effort
        }
    }
}
