#requires -Version 5.1
# Local, non-provisioning installer and retained offline verifier.
[CmdletBinding()]
param(
    [string]$Version, [string]$WorkRoot, [ValidateSet('Check','Install','Verify')][string]$Mode='Install',
    [string]$UserRoot='', [string]$InstallRoot='', [string]$NodeExe='', [ValidateRange(1,65535)][int]$Port,
    [switch]$AdoptExisting, [switch]$Activate,
    [string]$PackageReceipt='', [string]$ArchivePath='', [string]$Frontdoor='', [string]$BundleRoot=''
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# An inherited module search path may put a different PowerShell edition first.
# Bind each builtin to the current host without changing caller/global settings.
foreach ($module in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Security','CimCmdlets')) {
    Import-Module -Name ($PSHOME+'/Modules/'+$module+'/'+$module+'.psd1') -Scope Local -ErrorAction Stop
}
$script:LocalInstallerPath=$PSCommandPath
function Invoke-OwnedOperator([string]$Script,[hashtable]$Parameters=@{}) {
    # Lifecycle operators run under native Windows PowerShell with a child-only
    # module search path. Do not export a PS7-first path into the PS5.1 child.
    $native=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if (-not (Test-Path -LiteralPath $native -PathType Leaf)) { throw 'Prerequisite: native Windows PowerShell lifecycle executable is missing.' }
    $literal="'"+$Script.Replace("'","''")+"'"
    $bindings=@()
    foreach ($key in $Parameters.Keys) {
        if ($key -cnotin @('Port','BindHost')) { throw 'Unexpected lifecycle operator parameter.' }
        $bindings += ($key+"='"+([string]$Parameters[$key]).Replace("'","''")+"'")
    }
    $command='$ErrorActionPreference=''Stop''; $env:PSModulePath=$PSHOME+''\Modules''; $parameters=@{'+($bindings -join ';')+'}; & '+$literal+' @parameters; exit $LASTEXITCODE'
    & $native -NoProfile -EncodedCommand ([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command)))
    $script:OperatorExitCode=$LASTEXITCODE
}
function Get-InvokingProfile { return [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile) }
function Get-InvokingSid { return [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
function Get-InstallHash([string]$Path) { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Get-LocalPath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path) -or $Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[*?]' -or $Path -match '(^|[\\/])\.\.([\\/]|$)') { throw 'Expected a local absolute path without traversal.' }
    $full=[IO.Path]::GetFullPath($Path).TrimEnd('\','/')
    foreach ($part in $full.Substring(3).Split('\')) { if ($part -match '[. ]$|^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)|:' ) { throw 'Reserved/ambiguous path refused.' } }
    return $full
}
function Test-Within([string]$Child,[string]$Root) { return $Child.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase) }
function Test-Overlap([string]$A,[string]$B) { return $A -ieq $B -or (Test-Within $A $B) -or (Test-Within $B $A) }
function Test-CodeFile([string]$Path,[string]$Mode) { return $Mode -ceq '100755' -or $Path -match '\.(ps1|sh|js|cjs|mjs|node|wasm)$|(^|/)package\.json$' }
function Assert-PlainPath([string]$Path) {
    $leaf=Get-LocalPath $Path
    for ($cursor=$leaf;$cursor;$cursor=Split-Path -Parent $cursor) {
        $item=Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($item -and $cursor -ine $leaf -and -not $item.PSIsContainer) { throw "File blocks required parent directory: $cursor" }
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "Linked path refused: $cursor" }
        if ($item -and -not $item.PSIsContainer -and $item.PSObject.Properties['LinkType'] -and $item.LinkType -eq 'HardLink') { throw "Hardlinked file refused: $cursor" }
    }
}
function Assert-Fields($Object,[string[]]$Names) {
    if ($null -eq $Object -or $Object -is [array] -or $Object -is [string]) { throw 'Expected a closed JSON object.' }
    $actual=@($Object.PSObject.Properties.Name)
    if ($actual.Count -ne $Names.Count) { throw 'Unexpected JSON fields.' }
    foreach ($name in $Names) { if ($actual -cnotcontains $name) { throw "Missing JSON field: $name" } }
}
function Read-InstallJson([string]$Path) { Assert-PlainPath $Path; return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json }
function Assert-PackagePath([string]$Path) {
    if ($Path -cnotmatch '^[A-Za-z0-9_@.()+,= -]+(/[A-Za-z0-9_@.()+,= -]+)*$') { throw "Unnormalized member: $Path" }
    foreach ($part in $Path.Split('/')) { if ($part -in @('.','..') -or $part -match '[. ]$|^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)') { throw "Unsafe member: $Path" } }
    if ($Path -cnotmatch '^(dist/|node_modules/|scripts/|config/)' -and $Path -cnotin @('install.ps1','deploy/release-files.json','LICENSE','NOTICE','package.json','bun.lock','VERSION.txt')) { throw "Undeclared install root: $Path" }
}
function Assert-PrivateOwner([string]$Path) {
    $cursor=Get-LocalPath $Path
    while (-not (Test-Path -LiteralPath $cursor)) { $cursor=Split-Path -Parent $cursor; if (-not $cursor) { throw 'Missing owned ancestor.' } }
    $owner=(Get-Acl -LiteralPath $cursor).GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -cne (Get-InvokingSid)) { throw "Path is not owned by the invoking account: $cursor" }
}
function New-PrivateDirectory([string]$Path) {
    if (Test-Path -LiteralPath $Path -PathType Container) { return }
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
    $acl=[System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    $sid=[System.Security.Principal.SecurityIdentifier]::new((Get-InvokingSid))
    $acl.SetOwner($sid)
    foreach ($id in @((Get-InvokingSid),'S-1-5-18','S-1-5-32-544')) {
        $principal=[System.Security.Principal.SecurityIdentifier]::new($id)
        $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}
function Write-AtomicBytes([string]$Path,[byte[]]$Bytes) {
    Assert-PlainPath $Path
    $parent=Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $temp=Join-Path $parent ('.install-'+[guid]::NewGuid().ToString('N')+'.tmp')
    try {
        [IO.File]::WriteAllBytes($temp,$Bytes)
        if (Test-Path -LiteralPath $Path -PathType Leaf) { [IO.File]::Replace($temp,$Path,[System.Management.Automation.Language.NullString]::Value) }
        else { [IO.File]::Move($temp,$Path) }
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}
function Write-AtomicText([string]$Path,[string]$Text) { Write-AtomicBytes $Path ([Text.UTF8Encoding]::new($false).GetBytes($Text)) }
function Assert-Receipt($Receipt,[string]$HomeRoot,[string]$CodeRoot,[string]$MetadataRoot) {
    Assert-Fields $Receipt @('schema_version','component','repository','version','source_commit','archive_sha256','parameters','files','configuration_paths','held_paths','last_code_change_utc')
    if ($Receipt.schema_version -ne 1 -or $Receipt.component -cne 'copilot-api-proxy' -or $Receipt.repository -cne 'gupta-ash/copilot-api-proxy' -or $Receipt.source_commit -cnotmatch '^[0-9a-f]{40}$' -or $Receipt.archive_sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'Invalid retained installation identity.' }
    Assert-Fields $Receipt.parameters @('UserRoot','InstallRoot','NodeExe','Port')
    if ($Receipt.parameters.UserRoot -cne $HomeRoot -or $Receipt.parameters.InstallRoot -cne $CodeRoot -or ($Receipt.parameters.Port -isnot [int] -and $Receipt.parameters.Port -isnot [long]) -or $Receipt.parameters.Port -lt 1 -or $Receipt.parameters.Port -gt 65535) { throw 'Retained account/root/port mismatch.' }
    if (@($Receipt.configuration_paths).Count -ne 0 -or @($Receipt.held_paths).Count -ne 0) { throw 'Proxy receipt cannot claim unmanaged config or held files as installed.' }
    if ($null -ne $Receipt.last_code_change_utc) { $stamp=[DateTimeOffset]::Parse($Receipt.last_code_change_utc); if ($stamp.Offset -ne [TimeSpan]::Zero) { throw 'Code change timestamp must be UTC.' } }
    $seen=@{}
    foreach ($row in $Receipt.files) {
        Assert-Fields $row @('path','sha256','mode')
        $path=Get-LocalPath $row.path
        if ($path -cne $row.path -or $seen.ContainsKey($path) -or $row.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $row.mode -cnotin @('100644','100755')) { throw 'Invalid retained owned-file row.' }
        if (Test-Within $path $CodeRoot) { Assert-PackagePath ($path.Substring($CodeRoot.Length+1).Replace('\','/')) }
        elseif ($path -cnotin @((Join-Path $MetadataRoot 'install.ps1'),(Join-Path $MetadataRoot 'install_local.ps1'),(Join-Path $MetadataRoot 'package-receipt.json'))) { throw 'Receipt file escapes declared product roots.' }
        $seen[$path]=$true
    }
    foreach ($required in @((Join-Path $CodeRoot 'dist/main.js'),(Join-Path $CodeRoot 'package.json'),(Join-Path $MetadataRoot 'install.ps1'),(Join-Path $MetadataRoot 'install_local.ps1'),(Join-Path $MetadataRoot 'package-receipt.json'))) { if (-not $seen.ContainsKey($required)) { throw 'Retained verifier/input closure is incomplete.' } }
}
function Assert-InstalledFiles($Receipt) {
    foreach ($row in $Receipt.files) { Assert-PlainPath $row.path; if (-not (Test-Path -LiteralPath $row.path -PathType Leaf) -or (Get-InstallHash $row.path) -cne $row.sha256) { throw "Owned-file drift/conflict: $($row.path)" } }
}
function Read-PackageReceipt([string]$Path,[string]$ExactVersion) {
    $receipt=Read-InstallJson $Path
    Assert-Fields $receipt @('schema_version','component','source_repository','source_commit','tag','version','declaration_sha256','asset','asset_sha256','built_utc','payload')
    if ($receipt.schema_version -ne 1 -or $receipt.component -cne 'copilot-proxy' -or $receipt.source_repository -cne 'gupta-ash/copilot-api-proxy' -or $receipt.tag -cne $ExactVersion -or $receipt.version -cne $ExactVersion -or $receipt.source_commit -cnotmatch '^[0-9a-f]{40}$' -or $receipt.asset_sha256 -cnotmatch '^[0-9a-f]{64}$' -or $receipt.declaration_sha256 -cnotmatch '^[0-9a-f]{64}$' -or $receipt.asset -cne ('copilot-proxy-'+$ExactVersion+'.zip')) { throw 'Invalid package release identity.' }
    $seen=@{}
    foreach ($row in $receipt.payload) {
        Assert-Fields $row @('path','sha256','mode'); Assert-PackagePath $row.path
        if ($seen.ContainsKey($row.path) -or $row.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $row.mode -cnotin @('100644','100755')) { throw 'Invalid/duplicate package file row.' }
        $seen[$row.path]=$row
    }
    return $receipt
}
function Get-LocalConnections([string]$State,[int]$SelectedPort) {
    try { return @(Get-NetTCPConnection -State $State -ErrorAction Stop | Where-Object { $_.LocalPort -eq $SelectedPort }) }
    catch { if ($_.FullyQualifiedErrorId -like 'CmdletizationQuery_NotFound*') { return @() }; throw 'Cannot inspect local TCP ownership; refusing activation/write.' }
}
function Assert-PeerSubset($Current,$Consented) {
    $known=@{}; foreach ($peer in $Consented) { $known[([string]$peer.RemoteAddress+':'+$peer.RemotePort+':'+$peer.OwningProcess)]=$true }
    foreach ($peer in $Current) { if (-not $known.ContainsKey(([string]$peer.RemoteAddress+':'+$peer.RemotePort+':'+$peer.OwningProcess))) { throw 'New live peers appeared after confirmation; rerun for fresh explicit consent.' } }
}
function Assert-NoUntrackedProxy([string]$Root) {
    $scriptArgument='^(?:"[^"]+"|\S+)\s+"?'+[regex]::Escape((Join-Path $Root 'dist/main.js'))+'"?(?:\s|$)'
    foreach ($candidate in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop)) {
        if ($candidate.CommandLine -and $candidate.CommandLine -match $scriptArgument) { throw 'Proxy code is running without matching owned PID metadata; stop/reconcile it explicitly before installation.' }
    }
}
function Get-OwnedProcess([string]$Root,[string]$Node,[int]$SelectedPort) {
    $pidPath=Join-Path $Root 'logs/copilot-proxy.pid'; $metaPath=Join-Path $Root 'logs/copilot-proxy.meta.json'
    $listeners=@(Get-LocalConnections 'Listen' $SelectedPort)
    if (-not (Test-Path -LiteralPath $pidPath -PathType Leaf)) { if ($listeners.Count) { throw 'Selected port has an unowned listener; refusing any stop/write.' }; Assert-NoUntrackedProxy $Root; return $null }
    Assert-PlainPath $pidPath; Assert-PlainPath $metaPath
    $text=[IO.File]::ReadAllText($pidPath).Trim(); if ($text -notmatch '^[1-9][0-9]*$') { throw 'Invalid proxy PID file.' }
    $process=Get-Process -Id ([int]$text) -ErrorAction SilentlyContinue
    if (-not $process) { if ($listeners.Count) { throw 'Port listener differs from stale proxy PID.' }; Assert-NoUntrackedProxy $Root; return $null }
    $meta=Read-InstallJson $metaPath
    $os=Get-CimInstance Win32_Process -Filter ('ProcessId='+$text)
    $scriptArgument='^(?:"[^"]+"|\S+)\s+"?'+[regex]::Escape((Join-Path $Root 'dist/main.js'))+'"?(?:\s|$)'
    if (-not $os -or -not $os.ExecutablePath -or -not $os.CommandLine -or (Get-LocalPath $os.ExecutablePath) -ine $Node -or $os.CommandLine -notmatch $scriptArgument -or $meta.pid -ne [int]$text -or (Get-LocalPath $meta.repo) -ine $Root -or $meta.port -ne $SelectedPort -or [Math]::Abs(($process.StartTime.ToUniversalTime()-[DateTime]::Parse($meta.started_at).ToUniversalTime()).TotalSeconds) -gt 2) { throw 'Live proxy identity/PID/start/root/port mismatch.' }
    foreach ($listener in $listeners) { if ($listener.OwningProcess -ne $process.Id) { throw 'Foreign selected-port listener.' } }
    return $process
}
function Get-ActivationPeers([int]$SelectedPort) { return @(Get-LocalConnections 'Established' $SelectedPort) }
function Get-LauncherVariant([string]$Root) {
    $variant='start_proxy.ps1'
    # Read registrars only. Never create, update, enable or disable one.
    $commands=@()
    if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
        foreach ($task in @(Get-ScheduledTask -ErrorAction Stop | Where-Object { $_.TaskName -eq 'copilot-proxy' })) { foreach ($action in $task.Actions) { $commands += [string]$action.Arguments } }
    }
    foreach ($service in @(Get-CimInstance Win32_Service -Filter "Name='copilot-proxy'" -ErrorAction Stop)) { $commands += [string]$service.PathName }
    foreach ($command in $commands) { if ($command -match 'start_proxy_no_rollback\.ps1' -and $command.IndexOf($Root,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $variant='start_proxy_no_rollback.ps1' } }
    # NSSM may keep the launcher variant in service Parameters rather than PathName.
    $registry='HKLM:\SYSTEM\CurrentControlSet\Services\copilot-proxy\Parameters'
    if (Test-Path -LiteralPath $registry) { $params=Get-ItemProperty -LiteralPath $registry; if ($params.PSObject.Properties['AppParameters'] -and $params.AppParameters -match 'start_proxy_no_rollback\.ps1') { $variant='start_proxy_no_rollback.ps1' } }
    return $variant
}
function Confirm-LocalActivation([string]$ExactVersion,[string]$Root,$Process,[int]$PeerCount) {
    $number=if ($Process) { [string]$Process.Id } else { 'none' }
    $expected='ACTIVATE copilot-api-proxy '+$ExactVersion+' PID='+$number+' ROOT='+$Root+' PEERS='+$PeerCount
    Write-Host ('Confirm exact operation: '+$expected)
    if ((Read-Host 'Type the complete confirmation (live peers will be interrupted)') -cne $expected) { throw 'Activation was not confirmed; no live writes performed.' }
}
function Invoke-LocalInstall {
    param([hashtable]$Options)
    $mode=if ($Options.ContainsKey('Mode')) { $Options.Mode } else { 'Install' }
    $version=[string]$Options.Version
    if ($version -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' -or $version -ieq 'latest') { throw 'An exact release tag is required.' }
    $homeRoot=if ($Options['UserRoot']) { Get-LocalPath $Options['UserRoot'] } else { Get-LocalPath (Get-InvokingProfile) }
    if ($homeRoot -ine (Get-LocalPath (Get-InvokingProfile))) { throw 'UserRoot differs from the invoking account profile.' }
    Assert-PlainPath $homeRoot; Assert-PrivateOwner $homeRoot
    $metaRoot=Join-Path $homeRoot '.agents/installations/copilot-api-proxy'
    $receiptPath=Join-Path $metaRoot 'installed.json'
    $prior=if (Test-Path -LiteralPath $receiptPath -PathType Leaf) { Read-InstallJson $receiptPath } else { $null }
    $appRoot=Join-Path $homeRoot '.local/share/copilot-proxy'; $record=Join-Path $appRoot 'install-dir.txt'
    Assert-PlainPath $appRoot; Assert-PlainPath $metaRoot
    Assert-PrivateOwner $appRoot; Assert-PrivateOwner $metaRoot
    $root=[string]$Options['InstallRoot']
    if (-not $root -and $prior) { $root=[string]$prior.parameters.InstallRoot }
    if (-not $root -and (Test-Path -LiteralPath $record -PathType Leaf)) { Assert-PlainPath $record; $root=[IO.File]::ReadAllText($record).Trim() }
    if (-not $root) { $root=Join-Path $homeRoot '.agents/services/copilot-proxy' }
    $root=Get-LocalPath $root
    if ($root -ieq $homeRoot -or (Test-Within $homeRoot $root) -or (Test-Overlap $root $appRoot) -or (Test-Overlap $root $metaRoot)) { throw 'InstallRoot must be a dedicated same-user-owned code root, separate from the profile root and private state/metadata.' }
    Assert-PlainPath $root; Assert-PrivateOwner $root
    if (Test-Path -LiteralPath (Join-Path $root '.git')) { throw 'A source checkout is not an installation root; source-to-service relocation is not an upgrade.' }
    if (Test-Path -LiteralPath $record) { if ((Get-LocalPath ([IO.File]::ReadAllText($record).Trim())) -ine $root) { throw 'Existing install-dir.txt root is authoritative. Root relocation is not an upgrade.' } }
    if ($prior) { Assert-Receipt $prior $homeRoot $root $metaRoot; Assert-InstalledFiles $prior }
    $node=[string]$Options['NodeExe']
    if (-not $node -and $prior) { $node=[string]$prior.parameters.NodeExe }
    if (-not $node) { $command=Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1; if ($command) { $node=$command.Source } }
    if (-not $node) { throw 'Prerequisite: an existing Node 20+ executable (NodeExe).' }
    $node=Get-LocalPath $node; Assert-PlainPath $node
    if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Prerequisite NodeExe is missing; runtimes are never provisioned.' }
    $selectedPort=if ($Options.ContainsKey('Port') -and $Options.Port) { [int]$Options.Port } elseif ($prior) { [int]$prior.parameters.Port } else { 4143 }
    if ($selectedPort -lt 1 -or $selectedPort -gt 65535) { throw 'Invalid port.' }
    if ($prior -and ($node -cne $prior.parameters.NodeExe -or $selectedPort -ne $prior.parameters.Port)) { throw 'Supplied NodeExe/Port conflicts with the retained installation coordinates.' }
    if ($mode -eq 'Verify') {
        if (-not $prior) { throw 'No retained installation receipt; Verify never repairs or downloads.' }
        if ($Options['Activate'] -or $Options['AdoptExisting']) { throw 'Verify refuses activation/adoption.' }
        if ($prior.version -cne $version) { throw 'Expected version does not match the retained installation.' }
        $envelope=Read-PackageReceipt (Join-Path $metaRoot 'package-receipt.json') $version
        if ($envelope.source_commit -cne $prior.source_commit -or $envelope.asset_sha256 -cne $prior.archive_sha256) { throw 'Retained package binding mismatch.' }
        $expected=@{}; foreach ($row in $envelope.payload) { $expected[(Join-Path $root $row.path)]=$row }
        $codeRows=@($prior.files | Where-Object { Test-Within $_.path $root })
        if ($codeRows.Count -ne $expected.Count) { throw 'Retained installed population differs from the package.' }
        foreach ($row in $codeRows) { if (-not $expected.ContainsKey($row.path) -or $row.sha256 -cne $expected[$row.path].sha256 -or $row.mode -cne $expected[$row.path].mode) { throw 'Installed/package file closure mismatch.' } }
        if (-not (Test-Path -LiteralPath $record -PathType Leaf) -or -not (Test-Path -LiteralPath (Join-Path $appRoot 'config.yaml') -PathType Leaf)) { throw 'Private local installation metadata/config prerequisite is missing.' }
        Write-Host ('Verified installed bytes '+$version+'; offline/read-only. Activation and live authentication are separate checks.')
        return
    }
    $work=Get-LocalPath $Options.WorkRoot; Assert-PlainPath $work; Assert-PrivateOwner $work
    if (-not (Test-Path -LiteralPath $work -PathType Container)) { throw 'WorkRoot must already exist.' }
    $drive=[IO.DriveInfo]::new([IO.Path]::GetPathRoot($work))
    if (-not $drive.IsReady -or $drive.DriveType -notin @([IO.DriveType]::Fixed,[IO.DriveType]::Removable,[IO.DriveType]::Ram)) { throw 'WorkRoot must be available local storage.' }
    foreach ($protected in @($root,$appRoot,$metaRoot)) { if (Test-Overlap $work $protected) { throw 'WorkRoot overlaps code/state/metadata.' } }
    foreach ($key in @('TEMP','TMP','TMPDIR','CLAUDE_CODE_TMPDIR','npm_config_cache','BUN_INSTALL_CACHE_DIR')) { [Environment]::SetEnvironmentVariable($key,$work,'Process') }
    $nodeVersion=(& $node --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $nodeVersion -cnotmatch '^v(\d+)\.\d+\.\d+' -or [int]$matches[1] -lt 20) { throw 'Prerequisite NodeExe must be Node >=20.' }
    $bundle=Get-LocalPath $Options.BundleRoot; Assert-PlainPath $bundle
    if (-not (Test-Within $bundle $work) -or (Test-Overlap $bundle $root)) { throw 'Extracted bundle must be contained in WorkRoot, separate from live code.' }
    $envelope=Read-PackageReceipt $Options.PackageReceipt $version
    if ((Get-InstallHash $Options.ArchivePath) -cne $envelope.asset_sha256) { throw 'Archive checksum changed after frontdoor verification.' }
    $manifest=@{}; foreach ($row in $envelope.payload) { $manifest[$row.path]=$row }
    $actual=@(Get-ChildItem -LiteralPath $bundle -Recurse -Force)
    $files=@($actual | Where-Object { -not $_.PSIsContainer })
    if ($files.Count -ne $manifest.Count) { throw 'Extracted payload membership mismatch.' }
    foreach ($item in $actual) { Assert-PlainPath $item.FullName }
    foreach ($file in $files) { $relative=$file.FullName.Substring($bundle.Length+1).Replace('\','/'); if (-not $manifest.ContainsKey($relative) -or $manifest[$relative].path -cne $relative -or (Get-InstallHash $file.FullName) -cne $manifest[$relative].sha256) { throw 'Extracted package hash/member mismatch.' } }
    foreach ($name in @('install.ps1','scripts/install_bundle.ps1','scripts/install_local.ps1','deploy/release-files.json','LICENSE','NOTICE','dist/main.js','package.json','bun.lock','VERSION.txt','config/default.yaml')) { if (-not $manifest.ContainsKey($name)) { throw "Incomplete package: $name" } }
    if ((Get-InstallHash $Options.Frontdoor) -cne $manifest['install.ps1'].sha256 -or (Get-InstallHash $script:LocalInstallerPath) -cne $manifest['scripts/install_local.ps1'].sha256) { throw 'Executing installer/frontdoor is not the selected committed release.' }
    $declarationPath=Join-Path $bundle 'deploy/release-files.json'
    if ((Get-InstallHash $declarationPath) -cne $envelope.declaration_sha256) { throw 'Committed release declaration mismatch.' }
    $declaration=Read-InstallJson $declarationPath
    Assert-Fields $declaration @('schema_version','component','files','generated_trees','generated_files','retired_files')
    if ($declaration.schema_version -ne 1 -or $declaration.component -cne 'copilot-proxy' -or ($declaration.generated_trees -join ',') -cne 'dist,node_modules' -or ($declaration.generated_files -join ',') -cne 'VERSION.txt') { throw 'Invalid release declaration.' }
    $operators=@('install_bundle.ps1','install_local.ps1','install_service.ps1','uninstall_service.ps1')
    foreach ($name in @('start_proxy','start_proxy_no_rollback','stop_proxy','status_proxy','proxy_log_on','proxy_log_off')) { $operators += ($name+'.ps1'),($name+'.sh') }
    $required=@{}; foreach ($name in $operators) { $required['deploy/'+$name]='scripts/'+$name }
    foreach ($name in @('install.ps1','deploy/release-files.json','LICENSE','NOTICE','config/default.yaml','package.json','bun.lock')) { $required[$name]=$name }
    if (@($declaration.files).Count -ne $required.Count -or $declaration.retired_files -isnot [array]) { throw 'Incomplete/unexpected static release declaration.' }
    $allowed=@{}; $sources=@{}
    foreach ($row in $declaration.files) {
        Assert-Fields $row @('source','destination'); Assert-PackagePath $row.destination
        if (@($required.Keys) -cnotcontains $row.source -or $required[$row.source] -cne $row.destination -or $allowed.ContainsKey($row.destination) -or $sources.ContainsKey($row.source) -or -not $manifest.ContainsKey($row.destination)) { throw 'Invalid/incomplete declared file.' }
        $allowed[$row.destination]=$true; $sources[$row.source]=$true
    }
    if (-not @($manifest.Keys | Where-Object { $_.StartsWith('node_modules/hono/',[StringComparison]::Ordinal) }).Count) { throw 'Production dependency closure is incomplete.' }
    foreach ($name in $manifest.Keys) { if (-not $allowed.ContainsKey($name) -and $name -cne 'VERSION.txt' -and -not $name.StartsWith('dist/') -and -not $name.StartsWith('node_modules/')) { throw 'Extra executable/static package member.' } }
    $pkg=Read-InstallJson (Join-Path $bundle 'package.json')
    if (-not ($pkg.PSObject.Properties | Where-Object { $_.Name -ceq 'type' -and $_.Value -is [string] -and $_.Value -ceq 'module' })) { throw 'package.json must declare type=module.' }
    $marker=[IO.File]::ReadAllText((Join-Path $bundle 'VERSION.txt'))
    if ($marker -cnotmatch ('(?m)^version='+[regex]::Escape($version)+'\r?$') -or $marker -cnotmatch ('(?m)^source_commit='+$envelope.source_commit+'\r?$')) { throw 'VERSION/source marker mismatch.' }
    if ($prior -and $prior.version -ceq $version) {
        if ($prior.source_commit -cne $envelope.source_commit) { throw 'An installed exact version cannot be rebound to a different source commit.' }
        $oldCode=@($prior.files | Where-Object { Test-Within $_.path $root })
        if ($oldCode.Count -ne $manifest.Count) { throw 'An exact installed version cannot change its immutable payload.' }
        foreach ($row in $oldCode) {
            $relative=$row.path.Substring($root.Length+1).Replace('\','/')
            if (-not $manifest.ContainsKey($relative) -or $row.sha256 -cne $manifest[$relative].sha256 -or $row.mode -cne $manifest[$relative].mode) { throw 'An exact installed version cannot change its immutable payload.' }
        }
    }
    $recognizable=(Test-Path -LiteralPath (Join-Path $root 'dist/main.js') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $root 'scripts/start_proxy.ps1') -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $root 'package.json') -PathType Leaf)
    $population=if (Test-Path -LiteralPath $root -PathType Container) { @(Get-ChildItem -LiteralPath $root -Force).Count } else { 0 }
    if (-not $prior -and $population -gt 0 -and (-not $recognizable -or -not $Options['AdoptExisting'])) { throw 'Existing recognizable installation requires explicit AdoptExisting; foreign directories cannot be adopted.' }
    $oldFiles=@{}; if ($prior) { foreach ($row in $prior.files) { $oldFiles[$row.path]=$row } }
    $newFiles=@(); $writes=@(); $retire=@(); $codeChanged=$false
    foreach ($row in $envelope.payload) {
        $target=Get-LocalPath (Join-Path $root $row.path); Assert-PlainPath $target
        if (Test-Path -LiteralPath $target -PathType Container) { throw "Owned-file destination is a directory: $target" }
        if ($prior -and -not $oldFiles.ContainsKey($target) -and (Test-Path -LiteralPath $target)) { throw "Foreign same-name file conflict: $target" }
        $newFiles += [ordered]@{path=$target;sha256=$row.sha256;mode=$row.mode}
        if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or (Get-InstallHash $target) -cne $row.sha256) {
            $writes += [pscustomobject]@{source=(Join-Path $bundle $row.path);target=$target;sha256=$row.sha256}
            if (Test-CodeFile $row.path $row.mode) { $codeChanged=$true }
        }
    }
    $retired=@{}; foreach ($name in $declaration.retired_files) { Assert-PackagePath $name; if ($retired.ContainsKey($name) -or $manifest.ContainsKey($name)) { throw 'Invalid explicit retirement.' }; $retired[$name]=$true }
    if ($prior) { foreach ($old in $prior.files) { if (Test-Within $old.path $root) { $relative=$old.path.Substring($root.Length+1).Replace('\','/'); if (-not $manifest.ContainsKey($relative)) { if (-not $retired.ContainsKey($relative)) { throw "Previously owned file needs explicit retirement: $relative" }; $retire += $old.path; if (Test-CodeFile $relative $old.mode) { $codeChanged=$true } } } } }
    $configPath=Join-Path $appRoot 'config.yaml'; Assert-PlainPath $configPath; Assert-PlainPath $record
    foreach ($path in @($configPath,$record)) { if (Test-Path -LiteralPath $path -PathType Container) { throw 'Private config/record destination is a directory.' } }
    foreach ($path in @($receiptPath,(Join-Path $metaRoot 'install.ps1'),(Join-Path $metaRoot 'install_local.ps1'),(Join-Path $metaRoot 'package-receipt.json'))) {
        Assert-PlainPath $path
        if (Test-Path -LiteralPath $path -PathType Container) { throw 'Retained metadata destination is a directory.' }
    }
    if (-not $prior) {
        $existingPort=$null
        if (Test-Path -LiteralPath $configPath -PathType Leaf) {
            # Parse only local nonsecret coordinates using this verified package's
            # YAML dependency, without initializing the application or auth flow.
            $parse='const fs=require("node:fs"),{createRequire}=require("node:module");const req=createRequire(process.argv[2]);const c=req("yaml").parse(fs.readFileSync(process.argv[3],"utf8"));const p=c?.server?.port??4143;if(!Number.isInteger(p)||p<1||p>65535)process.exit(2);process.stdout.write(String(p));'
            $existingPort=($parse | & $node - (Join-Path $bundle 'package.json') $configPath | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $existingPort -notmatch '^[0-9]+$') { throw 'Cannot establish existing proxy port from local config.' }
        }
        $localMeta=Join-Path $root 'logs/copilot-proxy.meta.json'
        if (Test-Path -LiteralPath $localMeta -PathType Leaf) { $oldMeta=Read-InstallJson $localMeta; if ((Get-LocalPath $oldMeta.repo) -ine $root -or $oldMeta.port -lt 1 -or $oldMeta.port -gt 65535) { throw 'Existing proxy metadata coordinates are inconsistent.' }; $existingPort=[string]$oldMeta.port }
        if ($null -ne $existingPort) {
            if ($Options.ContainsKey('Port') -and $Options.Port -and [int]$existingPort -ne $selectedPort) { throw 'Port conflicts with the existing installation; coordinates are not migrated.' }
            $selectedPort=[int]$existingPort
        } elseif ($recognizable -and -not $Options.ContainsKey('Port')) { throw 'Prerequisite: explicitly declare Port when adopting an installation without local config/process coordinates.' }
    }
    $seed=$null
    if (-not (Test-Path -LiteralPath $configPath)) {
        $seed=[IO.File]::ReadAllText((Join-Path $bundle 'config/default.yaml'))
        $seed=[regex]::Replace($seed,'(?m)^(\s*host\s*:\s*)[^\r\n#]+','${1}127.0.0.1')
        $seed=[regex]::Replace($seed,'(?m)^(\s*port\s*:\s*)\d+','${1}'+$selectedPort)
        $seed=[regex]::Replace($seed,'(?m)^(\s*)custom_dir\s*:\s*~.*$','$1# custom_dir omitted; schema default used')
    }
    # Complete selected-set preflight is above the first live write or stop.
    $process=Get-OwnedProcess $root $node $selectedPort
    if ($mode -eq 'Install' -and $process -and $codeChanged -and -not $Options['Activate']) { throw 'Code change required while proxy is running. Re-run with Activate and exact local confirmation, or stop it explicitly first.' }
    if ($mode -eq 'Check') { Write-Host ("Check: {0} file writes, {1} explicit unchanged retirements; state/registrars unchanged; activation needed={2}." -f $writes.Count,$retire.Count,($codeChanged -and $null -ne $process)); return }
    if ($prior -and $prior.version -ceq $version -and $writes.Count -eq 0 -and $retire.Count -eq 0 -and $null -eq $seed -and (Test-Path -LiteralPath $record -PathType Leaf) -and -not $Options['Activate']) { Write-Host 'Same exact version: actual owned files verified; no live writes or activation.'; return }
    $launcher='start_proxy.ps1'
    if ($Options['Activate']) {
        $launcher=Get-LauncherVariant $root
        $peers=@(Get-ActivationPeers $selectedPort)
        foreach ($peer in $peers) { Write-Host ('Live peer: '+$peer.RemoteAddress+':'+$peer.RemotePort+' PID='+$peer.OwningProcess) }
        Confirm-LocalActivation $version $root $process $peers.Count
        $fresh=Get-OwnedProcess $root $node $selectedPort
        if (($null -eq $fresh) -ne ($null -eq $process) -or ($fresh -and ($fresh.Id -ne $process.Id -or $fresh.StartTime -ne $process.StartTime))) { throw 'Proxy identity changed after activation confirmation.' }
        $newPeers=@(Get-ActivationPeers $selectedPort)
        Assert-PeerSubset $newPeers $peers
    }
    $backup=Join-Path $work ('preservation-'+[guid]::NewGuid().ToString('N'))
    New-PrivateDirectory $backup
    Write-Host ('Retained private preservation: '+$backup)
    $affected=@($writes | ForEach-Object {$_.target})+@($retire)+@($receiptPath,(Join-Path $metaRoot 'install.ps1'),(Join-Path $metaRoot 'install_local.ps1'),(Join-Path $metaRoot 'package-receipt.json'))
    $backupRows=@(); $index=0
    foreach ($path in $affected) { if (Test-Path -LiteralPath $path -PathType Leaf) { Assert-PlainPath $path; $index++; $saved=Join-Path $backup ($index.ToString()+'.bin'); [IO.File]::WriteAllBytes($saved,[IO.File]::ReadAllBytes($path)); $backupRows += [ordered]@{path=$path;backup=$saved;sha256=(Get-InstallHash $saved)} } }
    Write-AtomicText (Join-Path $backup 'inventory.json') ((ConvertTo-Json -InputObject @($backupRows) -Depth 6)+"`n")
    # Diagnostic inputs for reviewed manual code-only recovery, not a pending
    # install state, retry waiver, resume mechanism or automatic rollback.
    $candidateRows=@()
    foreach ($row in $newFiles) { $candidateRows += [ordered]@{path=$row.path;sha256=$row.sha256;mode=$row.mode;existed_before=(Test-Path -LiteralPath $row.path -PathType Leaf)} }
    foreach ($pair in @(@('install.ps1',(Join-Path $bundle 'install.ps1')),@('install_local.ps1',(Join-Path $bundle 'scripts/install_local.ps1')),@('package-receipt.json',$Options.PackageReceipt))) {
        $target=Join-Path $metaRoot $pair[0]
        $candidateRows += [ordered]@{path=$target;sha256=(Get-InstallHash $pair[1]);mode='100644';existed_before=(Test-Path -LiteralPath $target -PathType Leaf)}
    }
    Write-AtomicText (Join-Path $backup 'candidate-files.json') ((ConvertTo-Json -InputObject @($candidateRows) -Depth 6)+"`n")
    Write-AtomicBytes (Join-Path $backup 'candidate-package-receipt.json') ([IO.File]::ReadAllBytes($Options.PackageReceipt))
    $effects=New-Object 'System.Collections.Generic.List[string]'
    try {
        foreach ($saved in $backupRows) { if ((Get-InstallHash $saved.path) -cne $saved.sha256) { throw 'Live file changed after preservation; refusing overwrite.' } }
        if ($prior) { Assert-InstalledFiles $prior }
        if ($Options['Activate']) {
            $fresh=Get-OwnedProcess $root $node $selectedPort
            if (($null -eq $fresh) -ne ($null -eq $process) -or ($fresh -and ($fresh.Id -ne $process.Id -or $fresh.StartTime -ne $process.StartTime))) { throw 'Proxy identity changed before activation.' }
            Assert-PeerSubset @(Get-ActivationPeers $selectedPort) $peers
        }
        if ($Options['Activate'] -and $process) {
            $script:OperatorExitCode=$null
            $effects.Add('attempted owned proxy stop')
            Invoke-OwnedOperator (Join-Path $root 'scripts/stop_proxy.ps1')
            if ($script:OperatorExitCode -ne 0) { throw 'stop_proxy failed; installation was not applied.' }
            if (Get-OwnedProcess $root $node $selectedPort) { throw 'Owned proxy is still running/restarted after stop; no code was copied.' }
            $effects.Add('existing owned proxy stopped')
        }
        foreach ($change in $writes) {
            if ((Get-InstallHash $change.source) -cne $change.sha256) { throw 'Verified package source changed before copy.' }
            if (-not @($backupRows | Where-Object { $_.path -ceq $change.target }).Count -and (Test-Path -LiteralPath $change.target)) { throw 'A foreign file appeared after preflight.' }
            $effects.Add('attempted file/parent creation or replacement '+$change.target)
            Write-AtomicBytes $change.target ([IO.File]::ReadAllBytes($change.source)); $effects.Add($change.target)
        }
        foreach ($path in $retire) { if ((Get-InstallHash $path) -cne $oldFiles[$path].sha256) { throw 'Retirement file changed after preflight.' }; Remove-Item -LiteralPath $path; $effects.Add('retired '+$path) }
        if ($null -ne $seed) { if (Test-Path -LiteralPath $configPath) { throw 'Local config appeared after preflight; refusing overwrite.' }; New-PrivateDirectory $appRoot; Write-AtomicText $configPath $seed; $effects.Add($configPath) }
        if (-not (Test-Path -LiteralPath $record)) { New-PrivateDirectory $appRoot; Write-AtomicText $record $root; $effects.Add($record) }
        New-PrivateDirectory $metaRoot
        foreach ($pair in @(@('install.ps1',(Join-Path $bundle 'install.ps1')),@('install_local.ps1',(Join-Path $bundle 'scripts/install_local.ps1')),@('package-receipt.json',$Options.PackageReceipt))) {
            $target=Join-Path $metaRoot $pair[0]; Write-AtomicBytes $target ([IO.File]::ReadAllBytes($pair[1])); $effects.Add($target)
            $newFiles += [ordered]@{path=$target;sha256=(Get-InstallHash $target);mode='100644'}
        }
        $last=if ($codeChanged) { [DateTime]::UtcNow.ToString('o') } elseif ($prior) { $prior.last_code_change_utc } else { $null }
        $receipt=[ordered]@{schema_version=1;component='copilot-api-proxy';repository='gupta-ash/copilot-api-proxy';version=$version;source_commit=$envelope.source_commit;archive_sha256=$envelope.asset_sha256;parameters=[ordered]@{UserRoot=$homeRoot;InstallRoot=$root;NodeExe=$node;Port=$selectedPort};files=@($newFiles);configuration_paths=@();held_paths=@();last_code_change_utc=$last}
        # Receipt is stamped only after every requested file/config effect completes.
        foreach ($row in $newFiles) { Assert-PlainPath $row.path; if ((Get-InstallHash $row.path) -cne $row.sha256) { throw 'Installed file changed before receipt stamping.' } }
        Write-AtomicText $receiptPath (($receipt | ConvertTo-Json -Depth 8)+"`n")
        Write-Host ('Installed verified bytes '+$version+'. No autostart/credential/state migration performed.')
    } catch {
        $effectsPath=Join-Path $backup 'partial-effects.json'
        Write-AtomicText $effectsPath ((ConvertTo-Json -InputObject @($effects.ToArray()))+"`n")
        throw ('Partial installation; no successful new receipt was stamped and blind retry is not recovery. Preservation='+$backup+'; Inventory='+(Join-Path $backup 'inventory.json')+'; CandidateFiles='+(Join-Path $backup 'candidate-files.json')+'; CandidateReceipt='+(Join-Path $backup 'candidate-package-receipt.json')+'; PartialEffects='+$effectsPath+'. Follow docs/deployment.md#manual-code-only-recovery-after-a-partial-install; preserve all local config/auth/state. Possible effects: '+($effects -join '; ')+'. '+$_)
    }
    if ($Options['Activate']) {
        $env:PATH=(Split-Path -Parent $node)+';'+$env:PATH
        $script:OperatorExitCode=$null
        Push-Location -LiteralPath $root
        try { Invoke-OwnedOperator -Script (Join-Path $root ('scripts/'+$launcher)) -Parameters @{Port=$selectedPort;BindHost='127.0.0.1'}; $startExit=$script:OperatorExitCode }
        finally { Pop-Location }
        if ($startExit -ne 0) { throw 'Installed bytes retained; activation failed. No automatic code/state rollback was performed.' }
        $active=Get-OwnedProcess $root $node $selectedPort
        if (-not $active -or ($process -and $active.Id -eq $process.Id -and $active.StartTime -eq $process.StartTime)) { throw 'Installed bytes retained, but a new-root/new-process activation was not established.' }
        try { $health=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$selectedPort+'/health') }
        catch { throw ('Installed bytes retained; new owned process PID='+$active.Id+' ROOT='+$root+' established, but activation/auth readiness is pending: the single health observation was unavailable. Inspect status and authenticate interactively; no retry or rollback was performed.') }
        if ($health.proxy -cne 'copilot-proxy' -or $health.status -cne 'ok' -or $health.auth_status -cne 'ready') { throw ('Installed bytes retained; new owned process PID='+$active.Id+' ROOT='+$root+' established, but activation/auth readiness is pending after the single health observation. Use the installed interactive device-code/catalog flow and status check; no retry or rollback was performed.') }
        Write-Host ('Activation and authenticated health verified: PID='+$active.Id+' ROOT='+$root)
    } else { Write-Host 'Activation not requested; installed files are not proof of running code/authentication.' }
}
if ($MyInvocation.InvocationName -ne '.') {
    try { Invoke-LocalInstall $PSBoundParameters; exit 0 } catch { Write-Error $_ -ErrorAction Continue; exit 1 }
}
