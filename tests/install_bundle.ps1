#requires -Version 5.1
# Consumer-visible tests against a real built release and isolated synthetic homes.
# Account/TCP interception is explicit: these fixtures are not real-account or
# production service acceptance. No model, auth, registrar or external network use.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Archive,[string]$Receipt=($Archive+'.json'))
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
foreach ($module in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Security')) { Import-Module -Name ($PSHOME+'/Modules/'+$module+'/'+$module+'.psd1') -Scope Local -ErrorAction Stop }
Add-Type -AssemblyName @('System.IO.Compression','System.IO.Compression.FileSystem')
$archiveFull=(Resolve-Path -LiteralPath $Archive).ProviderPath
$receiptFull=(Resolve-Path -LiteralPath $Receipt).ProviderPath
$node=(Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$scratch=Join-Path $env:TEMP ('proxy-install-fixture-'+[guid]::NewGuid().ToString('N'))
$environment=@{}; foreach ($key in @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','CLAUDE_CODE_TMPDIR','NODE_EXE','GITHUB_TOKEN','GH_TOKEN','COPILOT_PROXY_CONFIG','COPILOT_PROXY_PORT','COPILOT_PROXY_HOST')) { $environment[$key]=[Environment]::GetEnvironmentVariable($key,'Process') }
$junction=$null
try {
    New-Item -ItemType Directory -Path $scratch | Out-Null
    $work=Join-Path $scratch 'work'; $homeFixture=Join-Path $scratch 'home'
    New-Item -ItemType Directory -Path $work,$homeFixture | Out-Null
    foreach ($key in @('HOME','USERPROFILE','APPDATA','LOCALAPPDATA')) { [Environment]::SetEnvironmentVariable($key,$homeFixture,'Process') }
    foreach ($key in @('TEMP','TMP','TMPDIR','CLAUDE_CODE_TMPDIR')) { [Environment]::SetEnvironmentVariable($key,$work,'Process') }
    foreach ($key in @('GITHUB_TOKEN','GH_TOKEN','COPILOT_PROXY_CONFIG','COPILOT_PROXY_PORT','COPILOT_PROXY_HOST')) { [Environment]::SetEnvironmentVariable($key,$null,'Process') }
    $bundle=Join-Path $work 'release'
    [IO.Compression.ZipFile]::ExtractToDirectory($archiveFull,$bundle)
    . (Join-Path $bundle 'scripts/install_local.ps1')
    function Get-InvokingProfile { return $homeFixture }
    function Get-LocalConnections { return @() }
    function Get-LauncherVariant { throw 'Fixture must not inspect registrars without Activate.' }
    function Invoke-RestMethod { throw 'Offline installer fixture must not call network.' }
    function Invoke-WebRequest { throw 'Offline installer fixture must not call network.' }
    function Register-ScheduledTask { throw 'Unexpected registrar mutation.' }
    function winget { throw 'Unexpected runtime provisioning.' }
    $package=Read-InstallJson $receiptFull
    $root=Join-Path $homeFixture '.agents/services/copilot-proxy'
    $meta=Join-Path $homeFixture '.agents/installations/copilot-api-proxy'
    $app=Join-Path $homeFixture '.local/share/copilot-proxy'
    $options=@{Version=$package.version;Mode='Check';WorkRoot=$work;UserRoot=$homeFixture;InstallRoot=$root;NodeExe=$node;Port=49173;BundleRoot=$bundle;PackageReceipt=$receiptFull;ArchivePath=$archiveFull;Frontdoor=(Join-Path $bundle 'install.ps1')}
    function Refuses([hashtable]$InputOptions,[string]$Pattern) {
        $caught=$null; try { Invoke-LocalInstall $InputOptions } catch { $caught=$_ }
        if (-not $caught -or [string]$caught -notmatch $Pattern) { throw "Expected refusal matching '$Pattern'; got '$caught'." }
    }
    function Clone-Options { $copy=@{}; foreach ($key in $options.Keys) { $copy[$key]=$options[$key] }; return $copy }
    $missing=Clone-Options; $missing.NodeExe=Join-Path $work 'missing-node.exe'
    Refuses $missing 'NodeExe is missing'
    if (Test-Path -LiteralPath $root) { throw 'Prerequisite refusal created live files.' }
    $env:NODE_EXE=Join-Path $work 'missing-environment-node.exe'
    $missingEnvironment=Clone-Options; $missingEnvironment.Remove('NodeExe')
    Refuses $missingEnvironment 'NodeExe is missing'
    $env:NODE_EXE=$node
    $discovered=Clone-Options; foreach ($key in @('NodeExe','UserRoot','InstallRoot','Port')) { $discovered.Remove($key) }
    Invoke-LocalInstall $discovered
    if ((Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath $app) -or (Test-Path -LiteralPath $meta)) { throw 'Automatic Node/profile/root Check mutated live roots.' }
    Invoke-LocalInstall $options
    if ((Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath $app) -or (Test-Path -LiteralPath $meta)) { throw 'Check mutated live roots.' }
    $options.Mode='Install'; Invoke-LocalInstall $options
    foreach ($row in $package.payload) { $target=Join-Path $root $row.path; if (-not (Test-Path -LiteralPath $target -PathType Leaf) -or (Get-InstallHash $target) -cne $row.sha256) { throw "Installed release mismatch: $($row.path)" } }
    $installedPath=Join-Path $meta 'installed.json'
    $installed=Read-InstallJson $installedPath
    if ($installed.parameters.Port -ne 49173 -or -not $installed.last_code_change_utc) { throw 'Resolved coordinates/code-change metadata missing.' }
    $seed=[IO.File]::ReadAllText((Join-Path $app 'config.yaml'))
    if ($seed -notmatch '(?m)^\s*host:\s*127\.0\.0\.1' -or $seed -notmatch '(?m)^\s*port:\s*49173') { throw 'Fresh seed did not use selected loopback port.' }
    foreach ($name in @('github_token','user.db','user.db-wal','user.db-shm','audit.log','sessions.json','stable-id')) { [IO.File]::WriteAllText((Join-Path $app $name),('synthetic-preserve-'+$name)) }
    $neighbor=Join-Path $root 'dist/unknown-neighbor.txt'; [IO.File]::WriteAllText($neighbor,'unknown-preserve')
    $config=Join-Path $app 'config.yaml'; [IO.File]::AppendAllText($config,"`n# synthetic operator configuration`n")
    $state=@{}; foreach ($file in Get-ChildItem -LiteralPath $app -File) { $state[$file.FullName]=Get-InstallHash $file.FullName }; $state[$neighbor]=Get-InstallHash $neighbor
    $before=Get-InstallHash $installedPath; $time=(Get-Item -LiteralPath $installedPath).LastWriteTimeUtc
    Invoke-LocalInstall $options
    if ((Get-InstallHash $installedPath) -cne $before -or (Get-Item -LiteralPath $installedPath).LastWriteTimeUtc -ne $time) { throw 'Verified same-version run was not a true no-op.' }
    foreach ($path in $state.Keys) { if ((Get-InstallHash $path) -cne $state[$path]) { throw 'Same-version run changed private state/unknown neighbor.' } }
    $verify=@{Version=$package.version;Mode='Verify';WorkRoot=$work;UserRoot=$homeFixture}
    Invoke-LocalInstall $verify
    $retainedOptions=Clone-Options; foreach ($key in @('NodeExe','UserRoot','InstallRoot','Port')) { $retainedOptions.Remove($key) }
    $env:NODE_EXE=Join-Path $work 'unusable-environment-node.exe'
    Invoke-LocalInstall $retainedOptions
    if ((Get-InstallHash $installedPath) -cne $before) { throw 'Omitted coordinates did not preserve the verified existing installation.' }
    $env:NODE_EXE=$node
    $verify.Remove('WorkRoot'); $verify.Remove('UserRoot')
    Invoke-LocalInstall $verify
    # The frontdoor's offline fallback supplies this existing retained directory,
    # not a profile-wide LocalAppData parent or a newly created work directory.
    $metadataBefore=@(Get-ChildItem -LiteralPath $meta -Recurse -Force | ForEach-Object { $_.FullName })
    $verify.WorkRoot=$meta
    Invoke-LocalInstall $verify
    $metadataAfter=@(Get-ChildItem -LiteralPath $meta -Recurse -Force | ForEach-Object { $_.FullName })
    if (@(Compare-Object $metadataBefore $metadataAfter).Count -or (Get-InstallHash $installedPath) -cne $before -or (Get-Item -LiteralPath $installedPath).LastWriteTimeUtc -ne $time) { throw 'Offline retained-directory verification created/changed installation metadata.' }
    foreach ($path in $state.Keys) { if ((Get-InstallHash $path) -cne $state[$path]) { throw 'Offline retained-directory verification changed state/unknown neighbors.' } }
    $verify.Remove('WorkRoot')
    $wrong=Clone-Options; $wrong.InstallRoot=Join-Path $homeFixture 'different-root'; Refuses $wrong 'authoritative|mismatch'
    $wrong=Clone-Options; $wrong.Port=49174; Refuses $wrong 'coordinates'
    $wrong=Clone-Options; $wrong.UserRoot=Join-Path $scratch 'foreign-user'; Refuses $wrong 'profile'
    $verify.Version='wrong-version'; Refuses $verify 'Expected version'; $verify.Version=$package.version
    $managed=Join-Path $root 'dist/main.js'; $original=[IO.File]::ReadAllBytes($managed)
    [IO.File]::AppendAllText($managed,"`n// synthetic local edit`n")
    Refuses $verify 'drift/conflict'; Refuses $options 'drift/conflict'
    [IO.File]::WriteAllBytes($managed,$original)
    # Verify must remain independent of downloaded/extracted inputs.
    $hidden=Join-Path $work 'download-unavailable'; [IO.Directory]::Move($bundle,$hidden)
    Invoke-LocalInstall $verify
    [IO.Directory]::Move($hidden,$bundle)
    # Derive two synthetic forward releases from the real built dependency/runtime
    # closure. These are local behavior fixtures, not GitHub/source trust receipts.
    function New-FixtureRelease([string]$Tag,[string]$Commit,[bool]$AddRetired,[bool]$Retire) {
        $directory=Join-Path $work $Tag
        New-Item -ItemType Directory -Path $directory | Out-Null
        foreach ($item in Get-ChildItem -LiteralPath $bundle -Force) { Copy-Item -LiteralPath $item.FullName -Destination $directory -Recurse }
        $declaration=Read-InstallJson (Join-Path $directory 'deploy/release-files.json')
        $declaration.retired_files=@(); if ($Retire) { $declaration.retired_files=@('dist/fixture-retirement.js') }
        [IO.File]::WriteAllText((Join-Path $directory 'deploy/release-files.json'),($declaration | ConvertTo-Json -Depth 8))
        [IO.File]::WriteAllText((Join-Path $directory 'VERSION.txt'),("version="+$Tag+"`nsource_commit="+$Commit+"`ndirty=False`n"))
        if ($AddRetired) { [IO.File]::WriteAllText((Join-Path $directory 'dist/fixture-retirement.js'),'export const syntheticRetirement = true;') }
        [IO.File]::AppendAllText((Join-Path $directory 'dist/main.js'),("`n// synthetic release "+$Tag+"`n"))
        $modeMap=@{}; foreach ($row in $package.payload) { $modeMap[$row.path]=$row.mode }
        $rows=@(); foreach ($file in Get-ChildItem -LiteralPath $directory -Recurse -File) {
            $relative=$file.FullName.Substring($directory.Length+1).Replace('\','/')
            $fileMode=if ($modeMap.ContainsKey($relative)) { $modeMap[$relative] } else { '100644' }
            $rows += [ordered]@{path=$relative;sha256=(Get-InstallHash $file.FullName);mode=$fileMode}
        }
        $zipPath=Join-Path $work ('copilot-proxy-'+$Tag+'.zip')
        [IO.Compression.ZipFile]::CreateFromDirectory($directory,$zipPath)
        $envelope=Read-InstallJson $receiptFull
        $envelope.version=$Tag; $envelope.tag=$Tag; $envelope.source_commit=$Commit; $envelope.asset=[IO.Path]::GetFileName($zipPath)
        $envelope.asset_sha256=Get-InstallHash $zipPath; $envelope.declaration_sha256=Get-InstallHash (Join-Path $directory 'deploy/release-files.json'); $envelope.payload=$rows
        $path=$zipPath+'.json'; [IO.File]::WriteAllText($path,($envelope | ConvertTo-Json -Depth 8))
        $result=Clone-Options; $result.Version=$Tag; $result.BundleRoot=$directory; $result.ArchivePath=$zipPath; $result.PackageReceipt=$path; $result.Frontdoor=Join-Path $directory 'install.ps1'
        return $result
    }
    $second=New-FixtureRelease 'fixture-v2' ('2'*40) $true $false
    Invoke-LocalInstall $second
    $retirement=Join-Path $root 'dist/fixture-retirement.js'
    if (-not (Test-Path -LiteralPath $retirement)) { throw 'Upgrade did not add its explicit owned member.' }
    foreach ($path in $state.Keys) { if ((Get-InstallHash $path) -cne $state[$path]) { throw 'Upgrade changed private state/unknown neighbor.' } }
    $third=New-FixtureRelease 'fixture-v3' ('3'*40) $false $true
    [IO.File]::AppendAllText($retirement,'// locally edited')
    Refuses $third 'drift/conflict'
    Copy-Item -LiteralPath (Join-Path $second.BundleRoot 'dist/fixture-retirement.js') -Destination $retirement -Force
    Invoke-LocalInstall $third
    if (Test-Path -LiteralPath $retirement) { throw 'Explicit unchanged retirement did not remove the prior-owned file.' }
    foreach ($path in $state.Keys) { if ((Get-InstallHash $path) -cne $state[$path]) { throw 'Retirement changed private state/unknown neighbor.' } }
    $verify.Version='fixture-v3'; Invoke-LocalInstall $verify
    # A partial overlay must stay a conflict until an operator performs the
    # documented, hash-bound manual code-only recovery. No installer recovery
    # exemption, pending state, automatic rollback or candidate-drift waiver.
    $priorRecovery=Read-InstallJson $installedPath
    $priorReceiptHash=Get-InstallHash $installedPath
    $fourth=New-FixtureRelease 'fixture-v4' ('4'*40) $true $false
    $beforePreservation=@(Get-ChildItem -LiteralPath $work -Directory -Filter 'preservation-*' | ForEach-Object { $_.FullName })
    $recoveryWriter=(Get-Command Write-AtomicBytes).ScriptBlock
    function Write-AtomicBytes([string]$Path,[byte[]]$Bytes) {
        & $recoveryWriter $Path $Bytes
        if ($Path -ceq (Join-Path $meta 'package-receipt.json')) { throw 'synthetic interruption after candidate verifier input replacement' }
    }
    Refuses $fourth 'Partial installation;.*Inventory=.*CandidateFiles=.*PartialEffects=.*manual-code-only-recovery'
    Set-Item Function:\Write-AtomicBytes $recoveryWriter
    if ((Get-InstallHash $installedPath) -cne $priorReceiptHash) { throw 'Partial overlay stamped a new successful receipt.' }
    Refuses $fourth 'drift/conflict'; Refuses $verify 'drift/conflict'
    $newPreservation=@(Get-ChildItem -LiteralPath $work -Directory -Filter 'preservation-*' | Where-Object { $beforePreservation -cnotcontains $_.FullName })
    if ($newPreservation.Count -ne 1) { throw 'Failed operation did not retain one identifiable private preservation set.' }
    $preservation=$newPreservation[0].FullName
    $inventory=Read-InstallJson (Join-Path $preservation 'inventory.json')
    $candidateFiles=Read-InstallJson (Join-Path $preservation 'candidate-files.json')
    $candidateMap=@{}; foreach ($row in $candidateFiles) { $candidateMap[$row.path]=$row }
    $priorMap=@{}; foreach ($row in $priorRecovery.files) { $priorMap[$row.path]=$row }
    $manualRestore=@(); $manualRemove=@()
    # This fixture mirrors the documented human-reviewed algorithm, not a
    # production recovery entrypoint. Preflight every intended recovery effect.
    foreach ($row in $inventory) {
        if (-not $priorMap.ContainsKey($row.path)) { continue } # never restore APP_DIR/receipt/unknown paths
        if ((Get-InstallHash $row.backup) -cne $row.sha256 -or $row.sha256 -cne $priorMap[$row.path].sha256) { throw 'Manual recovery backup is not the prior-owned immutable preimage.' }
        $current=Get-InstallHash $row.path
        if ($current -cne $row.sha256 -and (-not $candidateMap.ContainsKey($row.path) -or $current -cne $candidateMap[$row.path].sha256)) { throw 'Manual recovery refuses unexplained locally edited bytes.' }
        $manualRestore += $row
    }
    foreach ($row in $candidateFiles) {
        if (-not $row.existed_before -and -not $priorMap.ContainsKey($row.path) -and (Test-Path -LiteralPath $row.path -PathType Leaf)) {
            if ((Get-InstallHash $row.path) -cne $row.sha256) { throw 'Manual recovery refuses edited new candidate file.' }
            $manualRemove += $row.path
        }
    }
    foreach ($row in $manualRestore) { Write-AtomicBytes $row.path ([IO.File]::ReadAllBytes($row.backup)) }
    foreach ($path in $manualRemove) { Remove-Item -LiteralPath $path }
    foreach ($path in $state.Keys) { if ((Get-InstallHash $path) -cne $state[$path]) { throw 'Manual recovery changed config/auth/DB/WAL/log/session/identity/unknown state.' } }
    if ((Get-InstallHash $installedPath) -cne $priorReceiptHash) { throw 'Manual code-only recovery changed the old installation receipt.' }
    Invoke-LocalInstall $verify # exact old version restored; no activation required
    Invoke-LocalInstall $fourth
    $verify.Version='fixture-v4'; Invoke-LocalInstall $verify
    foreach ($path in $state.Keys) { if ((Get-InstallHash $path) -cne $state[$path]) { throw 'Reinstallation after manual recovery changed private state/unknown neighbors.' } }
    # External lifecycle/consent/process observations are fixture seams here;
    # the real installer still verifies/writes its retained byte closure. Pending
    # auth must not become success, retries, or automatic state/code rollback.
    $seams=@{}; foreach ($name in @('Get-OwnedProcess','Get-LauncherVariant','Confirm-LocalActivation','Invoke-OwnedOperator','Invoke-RestMethod')) { $seams[$name]=(Get-Command $name).ScriptBlock }
    $script:fixtureActivated=$false; $script:healthObservations=0; $script:operatorCalls=@()
    $declined=New-FixtureRelease 'fixture-v5-declined' ('5'*40) $false $false
    $beforeDecline=Get-InstallHash $installedPath
    function Get-OwnedProcess { return [pscustomobject]@{Id=2147482999;StartTime=[DateTime]::UtcNow} }
    function Get-LauncherVariant { return 'start_proxy_no_rollback.ps1' }
    function Confirm-LocalActivation { throw 'synthetic declined bound activation consent' }
    Refuses $declined 'synthetic declined bound activation consent'
    if ((Get-InstallHash $installedPath) -cne $beforeDecline -or $script:operatorCalls.Count -ne 0) { throw 'Ordinary running update mutated files or invoked a lifecycle operator before consent.' }
    foreach ($name in $seams.Keys) { Set-Item -Path ('Function:\'+$name) -Value $seams[$name] }
    $activationStamp=[DateTime]::UtcNow
    function Get-OwnedProcess { if ($script:fixtureActivated) { return [pscustomobject]@{Id=2147483000;StartTime=$activationStamp} }; return $null }
    function Get-LauncherVariant { return 'start_proxy_no_rollback.ps1' }
    function Confirm-LocalActivation { } # synthetic explicit operator consent only
    function Invoke-OwnedOperator([string]$Script,[hashtable]$Parameters=@{}) {
        $script:operatorCalls += [pscustomobject]@{script=$Script;parameters=$Parameters}
        $script:fixtureActivated=$true; $script:OperatorExitCode=0
    }
    function Invoke-RestMethod { $script:healthObservations++; return [pscustomobject]@{proxy='copilot-proxy';status='ok';auth_status='starting'} }
    $pending=@{}; foreach ($key in $fourth.Keys) { $pending[$key]=$fourth[$key] }; $pending.Activate=$true
    Refuses $pending 'Installed bytes retained;.*activation/auth readiness is pending'
    if ($script:healthObservations -ne 1 -or $script:operatorCalls.Count -ne 1 -or (Split-Path -Leaf $script:operatorCalls[0].script) -cne 'start_proxy_no_rollback.ps1' -or $script:operatorCalls[0].parameters.Port -ne 49173 -or $script:operatorCalls[0].parameters.BindHost -cne '127.0.0.1') { throw 'Pending activation retried or changed the preserved launcher/loopback coordinates.' }
    foreach ($name in $seams.Keys) { Set-Item -Path ('Function:\'+$name) -Value $seams[$name] }
    Invoke-LocalInstall $verify
    foreach ($path in $state.Keys) { if ((Get-InstallHash $path) -cne $state[$path]) { throw 'Auth-pending activation changed private state/unknown neighbors.' } }
    # An interrupted individual-file write has diagnostics, not a success stamp.
    $failureHome=Join-Path $scratch 'interrupted-home'; New-Item -ItemType Directory -Path $failureHome | Out-Null
    $homeFixture=$failureHome
    $interrupted=Clone-Options; $interrupted.UserRoot=$failureHome; $interrupted.InstallRoot=Join-Path $failureHome '.agents/services/copilot-proxy'
    $writer=(Get-Command Write-AtomicBytes).ScriptBlock
    function Write-AtomicBytes([string]$Path,[byte[]]$Bytes) {
        if ($Path -ieq (Join-Path $interrupted.InstallRoot 'dist/main.js')) { throw 'synthetic interrupted copy' }
        & $writer $Path $Bytes
    }
    Refuses $interrupted 'Partial installation'
    if (Test-Path -LiteralPath (Join-Path $failureHome '.agents/installations/copilot-api-proxy/installed.json')) { throw 'Interrupted copy stamped a successful installation.' }
    if (-not @(Get-ChildItem -LiteralPath $work -Recurse -Filter partial-effects.json).Count) { throw 'Partial effects diagnostics were not retained.' }
    Set-Item Function:\Write-AtomicBytes $writer
    # Candidate-looking partial bytes are not an exact known-byte installation.
    foreach ($name in @('dist','scripts')) { New-Item -ItemType Directory -Path (Join-Path $interrupted.InstallRoot $name) -Force | Out-Null }
    foreach ($name in @('dist/main.js','scripts/start_proxy.ps1','package.json')) { Copy-Item -LiteralPath (Join-Path $bundle $name) -Destination (Join-Path $interrupted.InstallRoot $name) -Force }
    Refuses $interrupted 'verified exact known-byte release'
    $knownReceipt=Join-Path $work 'known-existing-package.json'; Copy-Item -LiteralPath $receiptFull -Destination $knownReceipt
    $partialMarker=Join-Path $interrupted.InstallRoot 'VERSION.txt'; if (Test-Path -LiteralPath $partialMarker) { Remove-Item -LiteralPath $partialMarker }
    $interrupted.ExistingPackageReceipt=$knownReceipt; Refuses $interrupted 'drift/conflict'
    $homeFixture=$options.UserRoot
    # Automatic adoption accepts only a complete prior release, preserving every
    # overwritten owned file privately and refusing even recognizable edits.
    $adoptHome=Join-Path $scratch 'adopt-home'; New-Item -ItemType Directory -Path $adoptHome | Out-Null
    $homeFixture=$adoptHome
    $adoptRoot=Join-Path $adoptHome '.agents/services/copilot-proxy'
    New-Item -ItemType Directory -Path $adoptRoot -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $bundle -Force) { Copy-Item -LiteralPath $item.FullName -Destination $adoptRoot -Recurse }
    [IO.File]::WriteAllText((Join-Path $adoptRoot 'unknown.txt'),'unclaimed')
    $adopt=@{}; foreach ($key in $second.Keys) { $adopt[$key]=$second[$key] }; $adopt.UserRoot=$adoptHome; $adopt.InstallRoot=$adoptRoot
    Refuses $adopt 'verified exact known-byte release'
    $adopt.ExistingPackageReceipt=$knownReceipt
    $oldEntry=Join-Path $adoptRoot 'dist/main.js'; $oldBytes=[IO.File]::ReadAllBytes($oldEntry)
    [IO.File]::AppendAllText($oldEntry,'// synthetic local edit')
    Refuses $adopt 'drift/conflict'
    [IO.File]::WriteAllBytes($oldEntry,$oldBytes)
    # Even byte-equal pre-receipt verifier inputs remain a conflict, not an
    # automatic recovery permission. This file is created/removed by this fixture.
    $adoptMeta=Join-Path $adoptHome '.agents/installations/copilot-api-proxy'
    New-Item -ItemType Directory -Path $adoptMeta -Force | Out-Null
    $foreignInput=Join-Path $adoptMeta 'install.ps1'
    [IO.File]::WriteAllBytes($foreignInput,[IO.File]::ReadAllBytes((Join-Path $bundle 'install.ps1')))
    $foreignDigest=Get-InstallHash $foreignInput
    Refuses $adopt 'Foreign retained installation metadata'
    if ((Get-InstallHash $foreignInput) -cne $foreignDigest -or (Get-InstallHash $oldEntry) -cne (Get-InstallHash (Join-Path $bundle 'dist/main.js'))) { throw 'Pre-receipt metadata refusal changed existing files.' }
    Remove-Item -LiteralPath $foreignInput
    Invoke-LocalInstall $adopt
    Invoke-LocalInstall @{Version=$second.Version;Mode='Verify'}
    if ([IO.File]::ReadAllText((Join-Path $adoptRoot 'unknown.txt')) -cne 'unclaimed') { throw 'Adoption claimed an unknown neighbor.' }
    $inventories=@(Get-ChildItem -LiteralPath $work -Filter inventory.json -Recurse)
    if (-not @($inventories | Where-Object { [IO.File]::ReadAllText($_.FullName).Contains($oldEntry.Replace('\','\\')) }).Count) { throw 'Automatic adoption did not preserve overwritten owned-file backup metadata.' }
    $homeFixture=$options.UserRoot
    # Unsafe target links refuse without touching the actual installation.
    $junction=Join-Path $homeFixture 'linked-code'; New-Item -ItemType Junction -Path $junction -Target $root | Out-Null
    $wrong=Clone-Options; $wrong.InstallRoot=$junction; Refuses $wrong 'Linked path|authoritative'
    Write-Host 'PASS: real package automatic Node/profile/root Check, retained coordinates/offline Verify, drift/no-op, forward update, explicit unchanged retirement, consent-declined no-write, partial overlay/manual code-only recovery, exact-byte automatic adoption/refusal, private backup and state/neighbor preservation.'
} finally {
    foreach ($key in $environment.Keys) { [Environment]::SetEnvironmentVariable($key,$environment[$key],'Process') }
    if ($junction -and (Test-Path -LiteralPath $junction)) { [IO.Directory]::Delete($junction) }
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
