#requires -Version 5.1
# Selected-release backend. The root install.ps1 binds public tag/OID/archive and
# executing script bytes before reaching this entrypoint. No token CLI, runtime
# provisioning, directory mirroring, registrar changes or implicit activation.
# Explicit -Activate is forwarded to the separately confirmed stop/start path;
# NoStop/NoStart suppress implicit lifecycle actions, not that explicit choice.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Version,
    [Parameter(Mandatory=$true)][string]$WorkRoot,
    [ValidateSet('Check','Install','Verify')][string]$Mode='Install',
    [string]$UserRoot='', [string]$InstallRoot='', [string]$NodeExe='',
    [ValidateRange(1,65535)][int]$Port,
    [switch]$AdoptExisting, [switch]$Activate,
    [string]$PackageReceipt='', [string]$ArchivePath='', [string]$Frontdoor='',
    [switch]$NoStop, [switch]$NoStart, [switch]$SkipAutostart
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Import-Module -Name ($PSHOME+'/Modules/Microsoft.PowerShell.Management/Microsoft.PowerShell.Management.psd1') -Scope Local -ErrorAction Stop
try {
    if (-not ($NoStop -and $NoStart -and $SkipAutostart)) { throw 'Backend requires NoStop, NoStart and SkipAutostart to suppress implicit lifecycle actions. Explicit Activate uses the separately confirmed stop/start path; invoke the root install.ps1.' }
    $options=@{}; foreach ($key in $PSBoundParameters.Keys) { if ($key -cnotin @('NoStop','NoStart','SkipAutostart')) { $options[$key]=$PSBoundParameters[$key] } }
    $options.BundleRoot=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).ProviderPath
    . (Join-Path $PSScriptRoot 'install_local.ps1')
    Invoke-LocalInstall $options
    exit 0
} catch { Write-Error $_ -ErrorAction Continue; exit 1 }
