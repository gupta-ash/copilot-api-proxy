# install_service.ps1 -- install copilot-proxy as a Windows service via nssm.
#
# Per M12 D-LOCK-7. Operator runs this ONCE on a freshly-built v2 install.
# Service runtime is `node` (NOT `bun`) per controller decision (D38 iter-3
# context): node is universally on Windows-server PATH; bun is not.
# nssm-with-node is a well-trodden pattern.
#
# Pre-flight (per D38 iter-1 H2 fix — exits 1 if any pre-flight fails):
#   - nssm on PATH (else print install instruction)
#   - node on PATH (capture absolute path for nssm install arg)
#   - $RepoPath/dist/main.js exists (else print 'bun run build' instruction)
#
# After pre-flight, install via nssm with rotating logs at $RepoPath/logs/.
#
# Parameters:
#   -RepoPath PATH   override repo path (default: script's parent's parent)
#   -NodePath PATH   override node binary path
#   -NoStart         install only; do not auto-start

[CmdletBinding()]
param(
    [string]$RepoPath = '',
    [string]$NodePath = '',
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Resolve $RepoPath if not passed.
if ([string]::IsNullOrEmpty($RepoPath)) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $RepoPath = (Resolve-Path (Join-Path $ScriptDir '..')).ProviderPath
}

function Write-Step([string]$msg) {
    Write-Host ('=== ' + $msg) -ForegroundColor Cyan
}
function Write-Sub([string]$msg) {
    Write-Host ('  - ' + $msg) -ForegroundColor Gray
}
function Write-Err([string]$msg) {
    Write-Host ('ERROR: ' + $msg) -ForegroundColor Red
}

Write-Step "install_service.ps1 -RepoPath $RepoPath"

# -- Pre-flight --
Write-Step 'pre-flight'

# 1. nssm
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssm) {
    Write-Err 'nssm not found on PATH.'
    Write-Host '  Install via: choco install nssm    (or download from https://nssm.cc/download)'
    exit 1
}
Write-Sub "nssm: $($nssm.Source)"

# 2. node (resolved or overridden)
if ([string]::IsNullOrEmpty($NodePath)) {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Write-Err 'node not found on PATH and -NodePath not supplied.'
        exit 1
    }
    $NodePath = $node.Source
}
if (-not (Test-Path $NodePath)) {
    Write-Err "node not found at $NodePath"
    exit 1
}
Write-Sub "node: $NodePath"

# 3. dist/main.js
$DistMain = Join-Path $RepoPath 'dist\main.js'
if (-not (Test-Path $DistMain)) {
    Write-Err "$DistMain not found."
    Write-Host "  Build first: cd $RepoPath && bun run build"
    exit 1
}
Write-Sub "dist/main.js: $DistMain"

# -- Install --
Write-Step 'install'

# Per D38 iter-1 H2 fix: create logs dir BEFORE nssm AppStdout/Err set.
$LogsDir = Join-Path $RepoPath 'logs'
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
Write-Sub "logs dir: $LogsDir"

# Install (or re-install if already present).
$existing = & nssm status copilot-proxy 2>$null
if ($LASTEXITCODE -eq 0) {
    Write-Sub 'service copilot-proxy already exists; updating in place'
} else {
    & nssm install copilot-proxy "$NodePath" "$DistMain" | Out-Null
    Write-Sub 'service copilot-proxy installed'
}

& nssm set copilot-proxy AppDirectory "$RepoPath" | Out-Null
& nssm set copilot-proxy DisplayName 'Copilot Proxy (v2)' | Out-Null
& nssm set copilot-proxy Description 'Multi-harness proxy for GitHub Copilot Enterprise' | Out-Null
& nssm set copilot-proxy Start SERVICE_AUTO_START | Out-Null
& nssm set copilot-proxy AppStdout "$LogsDir\copilot-proxy.stdout.log" | Out-Null
& nssm set copilot-proxy AppStderr "$LogsDir\copilot-proxy.stderr.log" | Out-Null
& nssm set copilot-proxy AppRotateFiles 1 | Out-Null
& nssm set copilot-proxy AppRotateBytes 10485760 | Out-Null

if ($NoStart) {
    Write-Step 'install_service.ps1 done (NoStart) - start later with: nssm start copilot-proxy'
    exit 0
}

Write-Step 'starting service'
& nssm start copilot-proxy | Out-Null
Write-Sub 'requested start (check status: nssm status copilot-proxy)'

Write-Step 'install_service.ps1 done'
Write-Host 'Service installed. Start with: nssm start copilot-proxy'
exit 0
