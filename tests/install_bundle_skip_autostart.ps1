#requires -Version 5.1
# Exercise actual selected-package file placement; intercept only account/TCP
# observation and explicitly forbid all activation/provisioning/registrar APIs.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Archive,[string]$Receipt=($Archive+'.json'))
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archiveFull=(Resolve-Path -LiteralPath $Archive).ProviderPath
$receiptFull=(Resolve-Path -LiteralPath $Receipt).ProviderPath
$node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$scratch=Join-Path $env:TEMP ('proxy-no-autostart-'+[guid]::NewGuid().ToString('N'))
$oldTemp=$env:TEMP
try {
    New-Item -ItemType Directory -Path $scratch | Out-Null
    $work=Join-Path $scratch 'work'; $homeFixture=Join-Path $scratch 'user'
    New-Item -ItemType Directory -Path $work,$homeFixture | Out-Null
    $env:TEMP=$work
    $bundle=Join-Path $work 'bundle'; [IO.Compression.ZipFile]::ExtractToDirectory($archiveFull,$bundle)
    . (Join-Path $bundle 'scripts/install_local.ps1')
    function Get-InvokingProfile { return $homeFixture }
    function Get-LocalConnections { return @() }
    $script:forbiddenCalls=0
    function Deny-SideEffect { $script:forbiddenCalls++; throw 'Forbidden registration, provisioning or activation.' }
    function New-ScheduledTaskAction { Deny-SideEffect }
    function New-ScheduledTaskTrigger { Deny-SideEffect }
    function Register-ScheduledTask { Deny-SideEffect }
    function Get-ScheduledTask { Deny-SideEffect }
    function Start-ScheduledTask { Deny-SideEffect }
    function Enable-ScheduledTask { Deny-SideEffect }
    function Stop-Process { Deny-SideEffect }
    function Start-Process { Deny-SideEffect }
    function Get-LauncherVariant { Deny-SideEffect }
    function Invoke-RestMethod { Deny-SideEffect }
    function Invoke-WebRequest { Deny-SideEffect }
    function nssm { Deny-SideEffect }
    function winget { Deny-SideEffect }
    $app=Join-Path $homeFixture '.local/share/copilot-proxy'
    New-Item -ItemType Directory -Path $app -Force | Out-Null
    $config=Join-Path $app 'config.yaml'
    [IO.File]::WriteAllText($config,"server:`n  port: 49179`n  host: 127.0.0.1`n# synthetic operator configuration`n")
    [IO.File]::WriteAllText((Join-Path $app 'github_token'),'synthetic-nonsecret-canary')
    $configHash=Get-InstallHash $config; $tokenHash=Get-InstallHash (Join-Path $app 'github_token')
    $package=Read-InstallJson $receiptFull
    $root=Join-Path $homeFixture '.agents/services/copilot-proxy'
    Invoke-LocalInstall @{Version=$package.version;Mode='Install';WorkRoot=$work;UserRoot=$homeFixture;InstallRoot=$root;NodeExe=$node;BundleRoot=$bundle;PackageReceipt=$receiptFull;ArchivePath=$archiveFull;Frontdoor=(Join-Path $bundle 'install.ps1')}
    if ($script:forbiddenCalls -ne 0) { throw 'Nonactivating installer called a forbidden API.' }
    if ((Get-InstallHash $config) -cne $configHash -or (Get-InstallHash (Join-Path $app 'github_token')) -cne $tokenHash) { throw 'Private local settings/auth bytes changed.' }
    $record=Read-InstallJson (Join-Path $homeFixture '.agents/installations/copilot-api-proxy/installed.json')
    if ($record.parameters.Port -ne 49179) { throw 'Existing local port was not retained.' }
    foreach ($row in $package.payload) { if ((Get-InstallHash (Join-Path $root $row.path)) -cne $row.sha256) { throw 'Selected package member was not installed exactly.' } }
    Invoke-LocalInstall @{Version=$package.version;Mode='Verify';WorkRoot=$work;UserRoot=$homeFixture}
    if ($script:forbiddenCalls -ne 0) { throw 'Offline Verify called a forbidden API.' }
    Write-Host 'PASS: actual nonactivating install/Verify preserved private config/auth/port and called zero registrar/runtime-provisioning/network/activation operations.'
} finally { $env:TEMP=$oldTemp; if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force } }
