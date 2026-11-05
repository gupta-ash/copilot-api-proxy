# uninstall_service.ps1 -- remove the copilot-proxy nssm service.
#
# Per M12 D-LOCK-7. Reverses install_service.ps1 fully:
#   1. nssm stop (ignore failure if not running).
#   2. nssm remove confirm.
#   3. Optionally clean logs dir (-CleanLogs).
#
# Parameters:
#   -RepoPath PATH   override repo path (default: script's parent's parent;
#                    used only with -CleanLogs)
#   -CleanLogs       also delete $RepoPath/logs/

[CmdletBinding()]
param(
    [string]$RepoPath = '',
    [switch]$CleanLogs
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

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

Write-Step "uninstall_service.ps1 -RepoPath $RepoPath"

# nssm sanity check.
$nssm = Get-Command nssm -ErrorAction SilentlyContinue
if (-not $nssm) {
    Write-Host 'WARNING: nssm not found on PATH; nothing to uninstall.' -ForegroundColor Yellow
    exit 0
}

# Step 1 -- stop (ignore failure if not running).
Write-Step 'stopping service (ignore failure if not running)'
try {
    & nssm stop copilot-proxy 2>$null | Out-Null
} catch {
    # ignore
}

# Step 2 -- remove (idempotent — exits 0 even if already gone).
Write-Step 'removing service'
& nssm remove copilot-proxy confirm 2>$null | Out-Null
Write-Sub 'service copilot-proxy removed (or did not exist)'

# Step 3 -- optionally clean logs.
if ($CleanLogs) {
    $LogsDir = Join-Path $RepoPath 'logs'
    if (Test-Path $LogsDir) {
        Write-Step "cleaning logs at $LogsDir"
        Remove-Item -Recurse -Force $LogsDir
        Write-Sub 'logs removed'
    } else {
        Write-Sub "no logs dir at $LogsDir; nothing to clean"
    }
}

Write-Step 'uninstall_service.ps1 done'
exit 0
