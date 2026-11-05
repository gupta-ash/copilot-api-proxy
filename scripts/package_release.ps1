# Build a literal, clean, GitHub-published HEAD in a disposable independent clone.
# Source deploy/ operators map to bundle scripts/ through release-files.json.
# PowerShell 5.1+. NoRelease produces a retained local archive, never a Release.
[CmdletBinding()]
param(
    [string]$Repo = 'gupta-ash/copilot-api-proxy',
    [switch]$SkipBuild,
    [switch]$DryRun,
    [switch]$NoRelease,
    [string]$OutDir = '',
    [switch]$Prerelease
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
foreach ($module in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility')) {
    Import-Module -Name ($PSHOME+'/Modules/'+$module+'/'+$module+'.psd1') -Scope Local -ErrorAction Stop
}
$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).ProviderPath

function Invoke-Native {
    param([string]$Exe, [string[]]$Arguments)
    # PS5.1 otherwise promotes redirected native stderr to a terminating error.
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $Exe @Arguments 2>$null
        return [pscustomobject]@{ ExitCode = $LASTEXITCODE; Output = $output }
    } finally { $ErrorActionPreference = $saved }
}
function Run-Native([string]$Exe, [string[]]$Arguments) {
    & $Exe @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Exe failed (exit $LASTEXITCODE)." }
}
function Git-Value([string[]]$Arguments) {
    $result = & git -C $RepoPath @Arguments
    if ($LASTEXITCODE -ne 0) { throw 'Git provenance query failed.' }
    return ($result | Out-String).Trim()
}
function Get-RawBlobHash([byte[]]$Bytes) {
    $header=[Text.Encoding]::ASCII.GetBytes(('blob '+$Bytes.Length+[char]0))
    $sha=[Security.Cryptography.SHA1]::Create()
    try { [void]$sha.TransformBlock($header,0,$header.Length,$header,0); [void]$sha.TransformFinalBlock($Bytes,0,$Bytes.Length); return [BitConverter]::ToString($sha.Hash).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Read-CommittedBlob([string]$SourceRoot,[string]$Oid) {
    if ($Oid -cnotmatch '^[0-9a-f]{40}$') { throw 'A literal committed blob OID is required.' }
    $source=[IO.Path]::GetFullPath($SourceRoot).TrimEnd('\','/')
    if ($source -match '["\r\n]') { throw 'Unsafe Git source root.' }
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=(Get-Command git -CommandType Application -ErrorAction Stop).Source
    $start.Arguments='-c core.fsmonitor=false -c diff.autoRefreshIndex=false -C "'+$source+'" cat-file blob '+$Oid
    $start.UseShellExecute=$false; $start.CreateNoWindow=$true
    $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
    $process=[Diagnostics.Process]::new(); $process.StartInfo=$start
    $memory=[IO.MemoryStream]::new()
    try {
        if (-not $process.Start()) { throw 'Cannot start literal Git blob reader.' }
        $stderr=$process.StandardError.ReadToEndAsync()
        $process.StandardOutput.BaseStream.CopyTo($memory)
        $process.WaitForExit(); $diagnostic=$stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw ('Cannot read committed Git blob: '+$diagnostic) }
        $bytes=$memory.ToArray()
        if ((Get-RawBlobHash $bytes) -cne $Oid) { throw 'Raw committed blob identity mismatch.' }
        return ,$bytes
    } finally { $memory.Dispose(); $process.Dispose() }
}
function Write-CommittedInput([string]$SourceRoot,[string[]]$Tree,[string]$Source,[string]$Destination) {
    $rows=@($Tree | Where-Object { $_ -cmatch ('^100(?:644|755) blob [0-9a-f]{40}\t'+[regex]::Escape($Source)+'$') })
    if ($rows.Count -ne 1 -or $rows[0] -cnotmatch '^([0-9]{6}) blob ([0-9a-f]{40})\t') { throw ('Source lacks one literal regular Git blob/mode: '+$Source) }
    $mode=$matches[1]; $oid=$matches[2]
    Assert-Unlinked $Destination
    $bytes=Read-CommittedBlob $SourceRoot $oid
    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    [IO.File]::WriteAllBytes($Destination,$bytes)
    if ((Get-RawBlobHash ([IO.File]::ReadAllBytes($Destination))) -cne $oid) { throw ('Materialized static file differs from committed blob: '+$Source) }
    return [pscustomobject]@{source=$Source;oid=$oid;mode=$mode;path=$Destination}
}
function Get-GitHubObject {
    param([string]$Endpoint, [switch]$AllowMissing)
    $result = Invoke-Native gh @('api', '--method', 'GET', '--include', $Endpoint)
    $text = (@($result.Output) -join "`n")
    # Use the HTTP status, not gh's diagnostic wording or an arbitrary nonzero exit.
    if ($text -notmatch '\AHTTP/\S+ ([0-9]{3})[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n') {
        throw "Unverifiable GitHub response for $Endpoint (exit $($result.ExitCode))."
    }
    $status = [int]$matches[1]
    $body = $text.Substring($matches[0].Length) | ConvertFrom-Json
    if ($null -eq $body -or $body -is [array]) { throw "Invalid GitHub object for $Endpoint." }
    if ($result.ExitCode -eq 0 -and $status -eq 200) { return $body }
    if ($AllowMissing -and $result.ExitCode -eq 1 -and $status -eq 404 -and
        $body.PSObject.Properties['message'] -and $body.message -ceq 'Not Found') {
        return $null
    }
    throw "GitHub query refused for $Endpoint (HTTP $status, exit $($result.ExitCode))."
}
function Get-ReleaseTagCommit {
    param([string]$Repo, [string]$Tag, [switch]$AllowMissing)
    $reference = Get-GitHubObject "repos/$Repo/git/ref/tags/$Tag" -AllowMissing:$AllowMissing
    if ($null -eq $reference) { return $null }
    if ($reference.ref -cne "refs/tags/$Tag") { throw 'GitHub returned a different tag reference.' }
    $target = $reference.object
    $seen = @{}
    while ($true) {
        if ($target.sha -cnotmatch '^[0-9a-f]{40}$' -or $seen.ContainsKey($target.sha)) { throw 'Invalid/cyclic tag object.' }
        $seen[$target.sha] = $true
        if ($target.type -ceq 'commit') { return [string]$target.sha }
        if ($target.type -cne 'tag') { throw 'Release tag does not resolve to a commit.' }
        $annotated = Get-GitHubObject "repos/$Repo/git/tags/$($target.sha)"
        if ($annotated.sha -cne $target.sha) { throw 'Annotated tag object identity changed.' }
        $target = $annotated.object
    }
}
function Publish-Release {
    param([string]$Repo, [string]$Tag, [string]$SourceCommit,
          [string]$Archive, [string]$Receipt, [string]$Installer, [string]$AssetSha256, [switch]$Prerelease)
    Assert-ReleaseArchive -Archive $Archive -ReceiptPath $Receipt -Repository $Repo -Tag $Tag -SourceCommit $SourceCommit -Installer $Installer
    if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $AssetSha256) { throw 'Publication archive digest changed.' }
    # Repository access must be provable now: a private repository auth failure can
    # masquerade as a missing tag/release. The full commit was also checked pre-build.
    $published = Get-GitHubObject "repos/$Repo/commits/$SourceCommit"
    if ($published.sha -cne $SourceCommit) { throw 'Published source commit identity changed.' }
    $tagCommit = Get-ReleaseTagCommit $Repo $Tag -AllowMissing
    if ($null -ne $tagCommit -and $tagCommit -cne $SourceCommit) { throw 'Existing tag points to another source commit.' }
    $release = Get-GitHubObject "repos/$Repo/releases/tags/$Tag" -AllowMissing
    if ($null -ne $release -and ($null -eq $tagCommit -or $release.tag_name -cne $Tag -or
        $release.prerelease -isnot [bool] -or $release.draft -isnot [bool] -or $release.draft)) {
        throw 'Release/tag identity or publication state is ambiguous.'
    }
    $notes = "Source commit: $SourceCommit. Prebuilt release bundle. Asset SHA-256: $AssetSha256."
    if ($null -ne $release) {
        # Preserve an existing hold even if the caller omits -Prerelease; there is
        # no implicit stable/latest promotion through asset replacement.
        $holdArgs = @()
        if ($Prerelease -or $release.prerelease) {
            $holdArgs = @('--prerelease', '--latest=false')
            Run-Native gh (@('release', 'edit', $Tag, '--repo', $Repo) + $holdArgs)
        }
        Run-Native gh @('release', 'upload', $Tag, $Archive, $Receipt, $Installer, '--repo', $Repo, '--clobber')
        Run-Native gh (@('release', 'edit', $Tag, '--repo', $Repo, '--notes', $notes) + $holdArgs)
    } else {
        $releaseArgs = @('release', 'create', $Tag, $Archive, $Receipt, $Installer, '--repo', $Repo, '--target', $SourceCommit,
                         '--title', "copilot-proxy $Tag", '--notes', $notes)
        if ($Prerelease) { $releaseArgs += '--prerelease', '--latest=false' }
        Run-Native gh $releaseArgs
    }
    # --target does not override an existing ref. Read back the exact ref and
    # dereference annotated tags after either create or replacement.
    if ((Get-ReleaseTagCommit $Repo $Tag) -cne $SourceCommit) { throw 'Published tag does not resolve to the accepted source commit.' }
    $readback = Get-GitHubObject "repos/$Repo/releases/tags/$Tag"
    if ($readback.tag_name -cne $Tag -or $readback.draft -ne $false -or
        $readback.prerelease -isnot [bool] -or $readback.body -cne $notes -or
        (($Prerelease -or ($null -ne $release -and $release.prerelease)) -and -not $readback.prerelease)) {
        throw 'Published release notes or hold state failed readback.'
    }
}
function Assert-Unlinked([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction SilentlyContinue
        if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Linked path refused: $cursor"
        }
        $cursor = Split-Path -Parent $cursor
    }
}
function Copy-Tree([string]$Source, [string]$Destination) {
    Assert-Unlinked $Source
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "Missing tree: $Source" }
    $items = @(Get-ChildItem -LiteralPath $Source -Recurse -Force)
    foreach ($item in $items) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked payload refused: $($item.FullName)" }
    }
    New-Item -ItemType Directory -Path $Destination | Out-Null
    foreach ($item in @(Get-ChildItem -LiteralPath $Source -Force)) {
        Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force
    }
}

function Assert-PayloadPath([string]$Path) {
    if (-not $Path -or $Path -cmatch '(^/|[\\:\x00-\x1f]|(^|/)\.{1,2}(/|$)|//|[. ](/|$)|/$)' -or
        $Path -cnotmatch '^[^/]+(?:/[^/]+)*$') { throw "Noncanonical payload path: $Path" }
}
function Assert-ReleaseDeclaration($Declaration, [string]$SourceRoot = '') {
    if ($Declaration.schema_version -ne 1 -or $Declaration.component -cne 'copilot-proxy') { throw 'Unsupported release declaration.' }
    if (($Declaration.generated_trees -join ',') -cne 'dist,node_modules' -or ($Declaration.generated_files -join ',') -cne 'VERSION.txt') { throw 'Unexpected generated membership.' }
    $operators = @('install_bundle.ps1', 'install_local.ps1', 'install_service.ps1', 'uninstall_service.ps1')
    foreach ($name in @('start_proxy', 'start_proxy_no_rollback', 'stop_proxy', 'status_proxy', 'proxy_log_on', 'proxy_log_off')) {
        $operators += "$name.ps1", "$name.sh"
    }
    $required = @{}
    foreach ($name in $operators) { $required["deploy/$name"] = "scripts/$name" }
    foreach ($name in @('install.ps1', 'deploy/release-files.json', 'LICENSE', 'NOTICE', 'config/default.yaml', 'package.json', 'bun.lock')) { $required[$name] = $name }
    $seen = @{}
    $sourceSeen = @{}
    if (@($Declaration.files).Count -ne $required.Count) { throw 'Release declaration must contain exactly the public installer, legal files, declaration, operator scripts and static runtime inputs.' }
    foreach ($entry in $Declaration.files) {
        $src = [string]$entry.source
        $dst = [string]$entry.destination
        if (@($required.Keys) -cnotcontains $src -or $dst -cne $required[$src] -or $seen.ContainsKey($dst) -or $sourceSeen.ContainsKey($src)) { throw "Duplicate/invalid membership: $src -> $dst" }
        $seen[$dst] = $true
        $sourceSeen[$src] = $true
        if ($SourceRoot -and -not (Test-Path -LiteralPath (Join-Path $SourceRoot $src) -PathType Leaf)) { throw "Missing source: $src" }
    }
    if (-not $Declaration.PSObject.Properties['retired_files'] -or $Declaration.retired_files -isnot [array]) { throw 'Release declaration requires an explicit retired_files array.' }
    $retired = @{}
    foreach ($path in $Declaration.retired_files) {
        if ($path -isnot [string]) { throw 'Retired file paths must be strings.' }
        Assert-PayloadPath $path
        if ($path -cnotmatch '^(?:(?:dist|node_modules|scripts|config)/.+|install\.ps1|deploy/release-files\.json|LICENSE|NOTICE|package\.json|bun\.lock|VERSION\.txt)$' -or $retired.ContainsKey($path) -or $seen.ContainsKey($path)) { throw "Invalid retired payload: $path" }
        $retired[$path] = $true
    }
}
function Assert-ReleaseArchive {
    param([string]$Archive, [string]$ReceiptPath, [string]$Repository, [string]$Tag, [string]$SourceCommit, [string]$Installer = '')
    $receipt = Get-Content -LiteralPath $ReceiptPath -Raw | ConvertFrom-Json
    if ($receipt.schema_version -ne 1 -or $receipt.component -cne 'copilot-proxy' -or $receipt.source_repository -cne $Repository -or
        $receipt.source_commit -cne $SourceCommit -or $SourceCommit -cnotmatch '^[0-9a-f]{40}$' -or $receipt.tag -cne $Tag -or
        $receipt.version -cne $Tag -or $Tag -cnotmatch '^[0-9a-f]{4,40}$' -or -not $SourceCommit.StartsWith($Tag, [StringComparison]::Ordinal)) { throw 'Receipt repository/tag/source binding failed.' }
    if ($receipt.asset -cne (Split-Path -Leaf $Archive) -or $receipt.asset_sha256 -cnotmatch '^[0-9a-f]{64}$' -or
        (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $receipt.asset_sha256) { throw 'Receipt archive binding failed.' }
    Add-Type -AssemblyName @('System.IO.Compression','System.IO.Compression.FileSystem')
    $zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Archive).ProviderPath)
    try {
        $payload = @{}
        foreach ($entry in $zip.Entries) {
            $path = $entry.FullName
            Assert-PayloadPath $path
            if ($payload.ContainsKey($path)) { throw "Duplicate/case-colliding archive entry: $path" }
            $bits = ($entry.ExternalAttributes -shr 16) -band 0xffff
            $mode = switch ($bits) { 33188 { '100644' } 33261 { '100755' } default { throw "Nonregular/unsupported archive mode: $path" } }
            $stream = $entry.Open()
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
            finally { $sha.Dispose(); $stream.Dispose() }
            $payload[$path] = [pscustomobject]@{ path = $path; sha256 = $hash; mode = $mode; entry = $entry }
        }
        if ($receipt.payload -isnot [array] -or $receipt.payload.Count -ne $payload.Count) { throw 'Receipt membership differs from archive.' }
        $seen = @{}
        foreach ($row in $receipt.payload) {
            $path = [string]$row.path
            Assert-PayloadPath $path
            if ($seen.ContainsKey($path) -or -not $payload.ContainsKey($path) -or $payload[$path].path -cne $path -or
                $row.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $row.sha256 -cne $payload[$path].sha256 -or $row.mode -isnot [string] -or $row.mode -cne $payload[$path].mode) { throw "Payload byte/mode binding failed: $path" }
            $seen[$path] = $true
        }
        if (@($payload.Keys) -cnotcontains 'deploy/release-files.json' -or $receipt.declaration_sha256 -cne $payload['deploy/release-files.json'].sha256) { throw 'Packaged declaration binding failed.' }
        $reader = New-Object IO.StreamReader($payload['deploy/release-files.json'].entry.Open())
        try { $declaration = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        Assert-ReleaseDeclaration $declaration
        $required = @($declaration.files | ForEach-Object { $_.destination }) + @('VERSION.txt', 'dist/main.js')
        foreach ($path in $required) { if (@($payload.Keys) -cnotcontains $path) { throw "Missing required payload: $path" } }
        foreach ($path in $payload.Keys) {
            if ($required -cnotcontains $path -and -not $path.StartsWith('dist/', [StringComparison]::Ordinal) -and -not $path.StartsWith('node_modules/', [StringComparison]::Ordinal)) { throw "Unexpected first-party payload: $path" }
            if (@($declaration.retired_files) -ccontains $path) { throw "Retired file remains in payload: $path" }
        }
        if (-not @($payload.Keys | Where-Object { $_.StartsWith('node_modules/hono/', [StringComparison]::Ordinal) }).Count) { throw 'Production dependencies are missing.' }
        $reader = New-Object IO.StreamReader($payload['VERSION.txt'].entry.Open())
        try { $marker = $reader.ReadToEnd() } finally { $reader.Dispose() }
        if ($marker -cne "version=$Tag`nsource_commit=$SourceCommit`ndirty=False`n") { throw 'Version marker binding failed.' }
        $reader = New-Object IO.StreamReader($payload['package.json'].entry.Open())
        try { $package = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        if ($package.type -cne 'module') { throw 'Root package.json must preserve Node ESM mode.' }
        if ($Installer -and ((Split-Path -Leaf $Installer) -cne 'install.ps1' -or
            (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $payload['install.ps1'].sha256)) { throw 'Standalone installer differs from packaged committed installer.' }
    } finally { $zip.Dispose() }
}

$workspace = $null
try {
    if ($NoRelease -and $Prerelease) { throw '-NoRelease and -Prerelease are contradictory.' }
    foreach ($exe in @('git', 'bun')) {
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { throw "$exe is required." }
    }
    $fullSha = Git-Value @('rev-parse', 'HEAD')
    if ($fullSha -notmatch '^[0-9a-f]{40}$') { throw 'HEAD must resolve to a full commit OID.' }
    $version = Git-Value @('rev-parse', '--short', 'HEAD')
    $dirty = Git-Value @('--no-optional-locks', 'status', '--porcelain')
    if ($DryRun) {
        Write-Host "Preview only: bind $Repo at $fullSha; clean tree required; SkipBuild is refused for real packaging."
        Write-Host 'Would clone the literal commit into temporary storage, install frozen dependencies, build, and stage declared membership.'
        Write-Host "Would retain archive in OutDir='$OutDir' (empty selects a new temp output directory). NoRelease=$NoRelease; Prerelease=$Prerelease."
        if (-not $NoRelease) { Write-Host 'Would explicitly publish the archive, .zip.json receipt and committed install.ps1 to GitHub Releases.' }
        if ($dirty) { Write-Host 'Current tree is dirty: real packaging would refuse.' }
        exit 0
    }
    if ($dirty) { throw 'Clean committed source required. Commit and publish the accepted source before packaging.' }
    if ($SkipBuild) { throw '-SkipBuild is preview-only; every real archive requires a fresh build.' }
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'gh is required even for NoRelease to verify the exact published source commit.' }
    # Bind the executing packager itself, not just a neighboring worktree HEAD.
    $scriptBlob = Git-Value @('rev-parse', 'HEAD:scripts/package_release.ps1')
    $actualBlob = Get-RawBlobHash ([IO.File]::ReadAllBytes($PSCommandPath))
    if ($scriptBlob -ne $actualBlob) { throw 'Executing packager differs from the accepted Git object.' }
    $published = Invoke-Native gh @('api', "repos/$Repo/commits/$fullSha", '--jq', '.sha')
    if ($published.ExitCode -ne 0 -or (@($published.Output) -join "`n").Trim() -cne $fullSha) {
        throw "Exact commit $fullSha is not verifiably published in $Repo."
    }
    # No source symlink/submodule may redirect committed inputs into a live tree.
    $tree = & git -C $RepoPath ls-tree -r $fullSha
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inventory committed tree.' }
    if (@($tree | Where-Object { $_ -match '^(120000|160000) ' }).Count) { throw 'Source symlinks/submodules are not release inputs.' }
    Assert-Unlinked $RepoPath
    if (-not $OutDir) { $OutDir = Join-Path $env:TEMP ('copilot-proxy-release-' + [guid]::NewGuid().ToString('N')) }
    $OutDir = [IO.Path]::GetFullPath($OutDir)
    Assert-Unlinked $OutDir
    $sourceFull = $RepoPath.TrimEnd('\', '/')
    if ($OutDir -ieq $sourceFull -or $OutDir.StartsWith($sourceFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'OutDir must be outside the source checkout.'
    }
    if ($OutDir -match '(?i)[\\/]\.agents[\\/]services([\\/]|$)') { throw 'OutDir cannot be an installed service tree.' }
    $zipName = "copilot-proxy-$version.zip"
    $zipPath = Join-Path $OutDir $zipName
    $receiptPath = Join-Path $OutDir "$zipName.json"
    $installerPath = Join-Path $OutDir 'install.ps1'
    if ((Test-Path -LiteralPath $zipPath) -or (Test-Path -LiteralPath $receiptPath) -or (Test-Path -LiteralPath $installerPath)) { throw 'Output already exists; select a fresh OutDir (no clobber).' }

    $workspace = Join-Path $env:TEMP ('copilot-proxy-build-' + [guid]::NewGuid().ToString('N'))
    Assert-Unlinked $workspace
    New-Item -ItemType Directory -Path $workspace | Out-Null
    $buildRoot = Join-Path $workspace 'source'
    $stageDir = Join-Path $workspace 'payload'
    $depsDir = Join-Path $workspace 'production-deps'
    $emptyHooks = Join-Path $workspace 'empty-hooks'
    New-Item -ItemType Directory -Path $emptyHooks | Out-Null
    Run-Native git @('clone', '--no-local', '--no-checkout', '--', $RepoPath, $buildRoot)
    Run-Native git @('-C', $buildRoot, '-c', "core.hooksPath=$emptyHooks", 'checkout', '--detach', $fullSha)
    $buildSha = & git -C $buildRoot rev-parse HEAD
    if ($LASTEXITCODE -ne 0 -or $buildSha.Trim() -cne $fullSha) { throw 'Disposable checkout revision mismatch.' }
    # Static inputs come from raw blobs, never checkout/clean/smudge/EOL filters.
    $staticRoot=Join-Path $workspace 'committed-inputs'
    $declarationPath=Join-Path $staticRoot 'deploy/release-files.json'
    $declarationInput=Write-CommittedInput $buildRoot $tree 'deploy/release-files.json' $declarationPath
    $declaration = Get-Content -LiteralPath $declarationPath -Raw | ConvertFrom-Json
    Assert-ReleaseDeclaration $declaration
    $modes = @{}; $staticInputs=@{}
    foreach ($entry in $declaration.files) {
        $committedInput=if ($entry.source -ceq 'deploy/release-files.json') { $declarationInput } else { Write-CommittedInput $buildRoot $tree $entry.source (Join-Path $staticRoot $entry.source) }
        $modes[$entry.destination]=$committedInput.mode; $staticInputs[$entry.destination]=$committedInput
    }
    Push-Location $buildRoot
    try {
        Run-Native bun @('install', '--frozen-lockfile', '--ignore-scripts')
        Run-Native bun @('run', 'build')
    } finally { Pop-Location }
    if (-not (Test-Path -LiteralPath (Join-Path $buildRoot 'dist/main.js') -PathType Leaf)) { throw 'Fresh build omitted dist/main.js.' }
    New-Item -ItemType Directory -Path $depsDir, $stageDir | Out-Null
    foreach ($name in @('package.json', 'bun.lock')) { [void](Write-CommittedInput $buildRoot $tree $name (Join-Path $depsDir $name)) }
    Push-Location $depsDir
    try { Run-Native bun @('install', '--production', '--frozen-lockfile', '--ignore-scripts') } finally { Pop-Location }
    if (-not (Test-Path -LiteralPath (Join-Path $depsDir 'node_modules/hono'))) { throw 'Production dependency closure is missing hono.' }
    Copy-Tree (Join-Path $buildRoot 'dist') (Join-Path $stageDir 'dist')
    Copy-Tree (Join-Path $depsDir 'node_modules') (Join-Path $stageDir 'node_modules')
    # Package-manager CLI shims are not used by the Node service or operators.
    # Keep every production package, but do not redistribute generated launchers.
    $generatedBins=Join-Path $stageDir 'node_modules/.bin'
    if (Test-Path -LiteralPath $generatedBins) { Remove-Item -LiteralPath $generatedBins -Recurse -Force }
    foreach ($entry in $declaration.files) {
        $committedInput=$staticInputs[$entry.destination]
        $destination = Join-Path $stageDir $entry.destination
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        [IO.File]::Copy($committedInput.path,$destination,$false)
        if ((Get-RawBlobHash ([IO.File]::ReadAllBytes($destination))) -cne $committedInput.oid) { throw ('Prepared static input differs from committed Git blob: '+$entry.destination) }
    }
    # Deterministic payload marker. Timestamps belong only in the external envelope receipt.
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText((Join-Path $stageDir 'VERSION.txt'), "version=$version`nsource_commit=$fullSha`ndirty=False`n", $utf8)
    $rows = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $stageDir -Recurse -Force -File | Sort-Object FullName)) {
        $relative = $file.FullName.Substring($stageDir.Length + 1).Replace('\', '/')
        if (-not $relative.StartsWith('node_modules/') -and $file.Name -match '(?i)(\.env(\.|$)|\.log$|\.pem$|\.key$|\.p12$|\.pfx$|github_token|id_rsa)') { throw "Secret/log filename refused: $relative" }
        Assert-PayloadPath $relative
        $mode = if ($modes.ContainsKey($relative)) { $modes[$relative] } else { '100644' }
        if ($relative.EndsWith('.sh', [StringComparison]::Ordinal) -or $relative -ceq 'dist/main.js') { $mode = '100755' }
        if ($staticInputs.ContainsKey($relative)) {
            $committedInput=$staticInputs[$relative]
            $expectedMode=if ($relative.EndsWith('.sh',[StringComparison]::Ordinal)) { '100755' } else { $committedInput.mode }
            if ($mode -cne $expectedMode -or (Get-RawBlobHash ([IO.File]::ReadAllBytes($file.FullName))) -cne $committedInput.oid) { throw ('Static payload Git blob/mode mismatch before archive/publication: '+$relative) }
        }
        $rows += [ordered]@{ path = $relative; sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); mode = $mode }
    }
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    Add-Type -AssemblyName @('System.IO.Compression','System.IO.Compression.FileSystem')
    $zip = [IO.Compression.ZipFile]::Open($zipPath, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($row in $rows) {
            $entry = [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $stageDir $row.path), $row.path, [IO.Compression.CompressionLevel]::Optimal)
            $bits = if ($row.mode -ceq '100755') { 33261 } else { 33188 }
            $entry.ExternalAttributes = $bits -shl 16
        }
    } finally { $zip.Dispose() }
    $receipt = [ordered]@{
        schema_version = 1; component = 'copilot-proxy'; source_repository = $Repo; source_commit = $fullSha
        tag = $version; version = $version
        declaration_sha256 = (Get-FileHash -LiteralPath $declarationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        asset = $zipName; asset_sha256 = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        built_utc = (Get-Date).ToUniversalTime().ToString('o'); payload = $rows
    }
    $receiptStream = [IO.File]::Open($receiptPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $writer = New-Object IO.StreamWriter($receiptStream, $utf8)
    try { $writer.Write(($receipt | ConvertTo-Json -Depth 6) + "`n") } finally { $writer.Dispose() }
    [IO.File]::Copy($staticInputs['install.ps1'].path, $installerPath, $false)
    Assert-ReleaseArchive -Archive $zipPath -ReceiptPath $receiptPath -Repository $Repo -Tag $version -SourceCommit $fullSha -Installer $installerPath
    Write-Host "Archive: $zipPath"
    Write-Host "Receipt: $receiptPath"
    Write-Host "Installer: $installerPath"
    if ($NoRelease) { Write-Host 'Local candidate retained; no Release created or modified.'; exit 0 }

    $tag = $version
    Publish-Release -Repo $Repo -Tag $tag -SourceCommit $fullSha -Archive $zipPath -Receipt $receiptPath -Installer $installerPath -AssetSha256 $receipt.asset_sha256 -Prerelease:$Prerelease
    Write-Host "Published https://github.com/$Repo/releases/tag/$tag (ZIP, receipt and standalone installer retained)."
    exit 0
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
} finally {
    if ($workspace -and (Test-Path -LiteralPath $workspace)) { Remove-Item -LiteralPath $workspace -Recurse -Force -ErrorAction SilentlyContinue }
}
