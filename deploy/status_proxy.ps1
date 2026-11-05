# status_proxy.ps1 -- standalone status report for copilot-proxy v2.
# PowerShell 5.1+ compatible.
#
# Companion of start_proxy.ps1 / start_proxy_no_rollback.ps1 / stop_proxy.ps1.
#
# It:
#   1. Reads PID file at <RepoPath>/logs/copilot-proxy.pid (single decimal
#      PID, no trailing newline; .Trim() defensively).
#   2. If PID file missing OR PID dead: prints NOT RUNNING and exits 2.
#   3. Per discriminator finding M1: reads meta.json at
#      <RepoPath>/logs/copilot-proxy.meta.json; uses meta.port + meta.host
#      for /health and /metrics probes (closes M1 port-discovery defect).
#      If meta.json absent: WARN + fall back to 127.0.0.1:<-Port> (default
#      4143). The -Port CLI flag still overrides meta.
#   4. Probes /health and /metrics on the resolved host:port via
#      Get-ProbeUrl (ITER-3 Fix-4 MEDIUM-1: brackets IPv6 literals).
#      Parses copilot_proxy_token_status (0/1/2 -> starting/ready/failed)
#      and copilot_proxy_process_uptime_seconds from /metrics.
#   5. Prints a summary table.
#
# The PID file is the source of truth for "is it running"; lsof / netstat
# would couple status semantics to "process listening on port N" which is
# brittle. The /health probe verifies serve liveness; the token_status
# gauge is the canonical "is it ready to serve auth-gated routes" signal.
#
# Parameters:
#   -Port <int>   Port to probe for /health + /metrics (default: meta.port
#                 if meta.json present, else 4143). CLI flag overrides meta.
#
# Exit codes:
#   0  process alive AND /health returned 200
#   1  process alive but /health failed OR token_status=failed
#   2  process not running (no PID file, or PID dead)

[CmdletBinding()]
param(
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoPath = (Resolve-Path (Join-Path $ScriptDir '..')).ProviderPath
$LogsDir = Join-Path $RepoPath 'logs'
$PidFile = Join-Path $LogsDir 'copilot-proxy.pid'
$MetaFile = Join-Path $LogsDir 'copilot-proxy.meta.json'
$StdoutLog = Join-Path $LogsDir 'copilot-proxy.stdout.log'
$StderrLog = Join-Path $LogsDir 'copilot-proxy.stderr.log'

# Track whether -Port was explicitly passed (CLI overrides meta).
$PortExplicit = $PSBoundParameters.ContainsKey('Port')

function Test-PidAlive {
    param([int]$TargetPid)
    try {
        $p = Get-Process -Id $TargetPid -ErrorAction Stop
        return $null -ne $p
    } catch {
        return $false
    }
}

function Get-ProbeHost([string]$BindHost) {
    if ($BindHost -eq '0.0.0.0' -or [string]::IsNullOrEmpty($BindHost)) {
        return '127.0.0.1'
    }
    if ($BindHost -eq '::') {
        return '::1'
    }
    return $BindHost
}

# ITER-3 Fix-4 (MEDIUM-1): bracket IPv6 literals for URL composition.
# Detection heuristic: host contains ':' AND not pure-IPv4-dotted AND
# not already bracketed -> bracket it (RFC 3986 sec 3.2.2).
function Get-ProbeUrl([string]$BindHost, [int]$Port, [string]$Path) {
    $h = $BindHost
    if ($h -match ':' -and $h -notmatch '^[0-9.]+$' -and -not $h.StartsWith('[')) {
        $h = '[' + $h + ']'
    }
    return ('http://' + $h + ':' + $Port + $Path)
}

function Get-MetricValue {
    param([string]$Body, [string]$Name)
    $lines = $Body -split "`n"
    foreach ($line in $lines) {
        $trim = $line.Trim()
        if ($trim.StartsWith('#')) { continue }
        # Match "<name> <value>" (no labels) — these gauges are unlabeled.
        if ($trim -match ('^' + [regex]::Escape($Name) + '\s+(\S+)\s*$')) {
            return $Matches[1]
        }
    }
    return $null
}

function Convert-TokenStatus([string]$val) {
    if ($null -eq $val) { return 'unknown' }
    switch ($val.Trim()) {
        '0' { return 'starting' }
        '1' { return 'ready' }
        '2' { return 'failed' }
        default { return "unknown ($val)" }
    }
}

function Show-LastCrash {
    # Surface the node-side crash marker if present (task #4). Read-only. Written by
    # lib/crash.ts to APP_DIR/logs; persists across restarts, so it reflects the LAST
    # recorded crash (not necessarily the current run). Shown EARLY so it is visible
    # even when the process is dead (a crash is exactly when you want to see it).
    $marker = Join-Path $env:USERPROFILE '.local\share\copilot-proxy\logs\copilot-proxy.crash.json'
    if (-not (Test-Path -LiteralPath $marker)) { return }
    try {
        $crash = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
        $cmsg = [string]$crash.message
        if ($cmsg.Length -gt 120) { $cmsg = $cmsg.Substring(0, 120) + '...' }
        Write-Host ('  last recorded crash: ' + $crash.at + ' (' + $crash.kind + ') - ' + $cmsg) -ForegroundColor Yellow
    } catch {
        Write-Host '  last recorded crash: (marker present but unparseable)' -ForegroundColor Yellow
    }
}

# === Main flow =================================================================

# Surface any recorded crash FIRST — visible even in the NOT-RUNNING exits below
# (a crash is exactly when the operator wants to see why the proxy is down).
Show-LastCrash

# Step 1+2: PID file presence + liveness.
if (-not (Test-Path $PidFile)) {
    Write-Host 'copilot-proxy: NOT RUNNING (PID file: missing)'
    exit 2
}

$pidText = $null
try {
    $pidText = (Get-Content -Raw -Path $PidFile).Trim()
} catch {
    Write-Host "copilot-proxy: NOT RUNNING (PID file unreadable: $_)"
    exit 2
}

$targetPid = 0
if (-not [int]::TryParse($pidText, [ref]$targetPid) -or $targetPid -le 0) {
    Write-Host "copilot-proxy: NOT RUNNING (PID file: present but invalid PID '$pidText')"
    exit 2
}

if (-not (Test-PidAlive -TargetPid $targetPid)) {
    Write-Host "copilot-proxy: NOT RUNNING (PID file: present, PID $targetPid dead)"
    exit 2
}

# Step 3: M1 — port + host discovery from meta.json.
$probePort = 4143
$probeHost = '127.0.0.1'
$portSource = 'probed; meta.json missing'

if (Test-Path $MetaFile) {
    try {
        $meta = Get-Content -Raw -Path $MetaFile | ConvertFrom-Json
        if ($null -ne $meta.port) { $probePort = [int]$meta.port }
        if ($null -ne $meta.host) { $probeHost = Get-ProbeHost ([string]$meta.host) }
        $portSource = 'from meta'
    } catch {
        $portSource = "probed; meta.json unparseable ($_)"
    }
}

if ($PortExplicit -and $Port -gt 0) {
    $probePort = $Port
    $portSource = 'from -Port flag (overrides meta)'
}

# Step 4: probe /health.
$healthOk = $false
$healthUrl = Get-ProbeUrl $probeHost $probePort '/health'
try {
    $hr = Invoke-WebRequest -Uri $healthUrl `
                            -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($hr.StatusCode -eq 200) { $healthOk = $true }
} catch {
    $healthOk = $false
}

# Step 4 (cont): probe /metrics, parse token_status + uptime.
$tokenStatusLabel = 'unknown'
$uptimeStr = '(n/a)'
$metricsUrl = Get-ProbeUrl $probeHost $probePort '/metrics'
try {
    $mr = Invoke-WebRequest -Uri $metricsUrl `
                            -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    if ($mr.StatusCode -eq 200) {
        $body = [string]$mr.Content
        $tokenVal = Get-MetricValue -Body $body -Name 'copilot_proxy_token_status'
        $tokenStatusLabel = Convert-TokenStatus $tokenVal
        $uptimeVal = Get-MetricValue -Body $body -Name 'copilot_proxy_process_uptime_seconds'
        if ($null -ne $uptimeVal) { $uptimeStr = "${uptimeVal}s" }
    }
} catch {
    # leave defaults
}

# Step 5: summary table.
$healthLabel = if ($healthOk) { 'ok' } else { 'FAIL' }
Write-Host 'copilot-proxy status'
Write-Host "  PID:           $targetPid"
Write-Host "  port ($portSource): $probePort"
Write-Host "  host:          $probeHost"
Write-Host "  /health:       $healthLabel"
Write-Host "  token_status:  $tokenStatusLabel"
Write-Host "  uptime:        $uptimeStr"
Write-Host "  PID file:      $PidFile"
Write-Host "  meta file:     $MetaFile"
Write-Host "  stdout log:    $StdoutLog"
Write-Host "  stderr log:    $StderrLog"

# Step 5 (cont): exit code reflects health.
if (-not $healthOk -or $tokenStatusLabel -eq 'failed') { exit 1 }
exit 0
