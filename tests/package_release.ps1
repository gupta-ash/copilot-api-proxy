# Validate actual release assets or exercise archive/bootstrap/publication fixtures.
# Bootstrap fixtures run the real frontdoor with owned HTTP/source-tree fixtures;
# publication fixtures require Windows PowerShell 5.1. Neither contacts GitHub.
[CmdletBinding(DefaultParameterSetName='Archive')]
param(
    [Parameter(Mandatory=$true, ParameterSetName='Archive')][string]$Archive,
    [Parameter(Mandatory=$true, ParameterSetName='Archive')][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedCommit,
    [Parameter(Mandatory=$true, ParameterSetName='Publication')][switch]$PublicationFixtures,
    [Parameter(Mandatory=$true, ParameterSetName='Fixtures')][switch]$ArchiveFixtures,
    [Parameter(Mandatory=$true, ParameterSetName='Bootstrap')][switch]$BootstrapFixtures,
    [Parameter(Mandatory=$true, ParameterSetName='RawBlobs')][switch]$RawBlobFixtures,
    [Parameter(ParameterSetName='Archive')][string]$ExpectedRepository = 'gupta-ash/copilot-api-proxy',
    [Parameter(Mandatory=$true, ParameterSetName='Archive')][string]$ExpectedTag
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
foreach ($module in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Security')) {
    Import-Module -Name ($PSHOME+'/Modules/'+$module+'/'+$module+'.psd1') -Scope Local -ErrorAction Stop
}
$root = Split-Path -Parent $PSScriptRoot
$packager = Join-Path $root 'scripts/package_release.ps1'
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($packager, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
# Load the actual consumers without running the build/publication entry body.
foreach ($statement in $ast.EndBlock.Statements) {
    if ($statement -is [Management.Automation.Language.FunctionDefinitionAst]) {
        . ([scriptblock]::Create($statement.Extent.Text))
    }
}
Add-Type -AssemblyName @('System.IO.Compression','System.IO.Compression.FileSystem')
function Get-BytesHash([byte[]]$Bytes) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function New-ArchiveFixture([string]$Directory, [string]$Mutation = '') {
    New-Item -ItemType Directory -Path $Directory | Out-Null
    $utf8 = New-Object Text.UTF8Encoding($false)
    $source = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    $tag = 'aaaaaaa'
    $declaration = Get-Content -LiteralPath (Join-Path $root 'deploy/release-files.json') -Raw | ConvertFrom-Json
    $paths = [ordered]@{}
    foreach ($row in $declaration.files) { $paths[$row.destination] = [IO.File]::ReadAllBytes((Join-Path $root $row.source)) }
    if ($Mutation -ceq 'wrong declaration mapping') { $declaration.files[0].destination = 'scripts/install.ps1' }
    if ($Mutation -ceq 'case changed declaration') { $declaration.files[0].source = 'Install.ps1'; $declaration.files[0].destination = 'Install.ps1' }
    if ($Mutation -ceq 'missing retirement declaration') { $declaration.PSObject.Properties.Remove('retired_files') }
    if ($Mutation -ceq 'unsafe retirement') { $declaration.retired_files = @('../outside.txt') }
    if ($Mutation -ceq 'live file retirement') { $declaration.retired_files = @('dist/main.js') }
    $paths['deploy/release-files.json'] = $utf8.GetBytes(($declaration | ConvertTo-Json -Depth 8))
    $declarationHash = Get-BytesHash $paths['deploy/release-files.json']
    $paths['VERSION.txt'] = $utf8.GetBytes("version=$tag`nsource_commit=$source`ndirty=False`n")
    $paths['dist/main.js'] = $utf8.GetBytes('// fixture executable; never run')
    $paths['node_modules/hono/index.js'] = $utf8.GetBytes('// fixture dependency; never run')
    if ($Mutation.StartsWith('missing ', [StringComparison]::Ordinal) -and @('missing retirement declaration', 'missing payload mode') -cnotcontains $Mutation) { $paths.Remove($Mutation.Substring(8)) }
    if ($Mutation -ceq 'wrong marker') { $paths['VERSION.txt'] = $utf8.GetBytes("version=bbbbbbb`nsource_commit=$source`ndirty=False`n") }
    if ($Mutation -ceq 'non ESM package') { $paths['package.json'] = $utf8.GetBytes('{"type":"commonjs"}') }
    if ($Mutation -ceq 'unexpected source fixture') { $paths['tests/unexpected-fixture.txt'] = $utf8.GetBytes('not a release input') }
    if ($Mutation -ceq 'unexpected operator') { $paths['scripts/unexpected_operator.ps1'] = $utf8.GetBytes('not a release input') }
    if ($Mutation -ceq 'unexpected environment file') { $paths['.env'] = $utf8.GetBytes('FIXTURE_ONLY=1') }
    if ($Mutation -ceq 'case changed archive path') { $bytes = $paths['install.ps1']; $paths.Remove('install.ps1'); $paths['Install.ps1'] = $bytes }
    if ($Mutation -ceq 'parent archive path') { $paths['dist/../outside.txt'] = $utf8.GetBytes('unsafe') }
    if ($Mutation -ceq 'backslash archive path') { $paths['dist\extra.js'] = $utf8.GetBytes('unsafe') }
    if ($Mutation -ceq 'dot archive path') { $paths['dist/./extra.js'] = $utf8.GetBytes('unsafe') }
    $archive = Join-Path $Directory "copilot-proxy-$tag.zip"
    $rows = @()
    $zip = [IO.Compression.ZipFile]::Open($archive, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($path in $paths.Keys) {
            $mode = if ($path.EndsWith('.sh', [StringComparison]::Ordinal) -or $path -ceq 'dist/main.js') { '100755' } else { '100644' }
            $bits = if ($mode -ceq '100755') { 33261 } else { 33188 }
            if ($Mutation -ceq 'symlink archive mode' -and $path -ceq 'dist/main.js') { $bits = 41471 }
            $entry = $zip.CreateEntry($path)
            $entry.ExternalAttributes = $bits -shl 16
            $stream = $entry.Open()
            try { $stream.Write($paths[$path], 0, $paths[$path].Length) } finally { $stream.Dispose() }
            $rows += [ordered]@{ path = $path; sha256 = (Get-BytesHash $paths[$path]); mode = $mode }
        }
        if ($Mutation -ceq 'duplicate archive path' -or $Mutation -ceq 'case colliding archive path') {
            $duplicate = if ($Mutation -ceq 'duplicate archive path') { 'dist/main.js' } else { 'dist/MAIN.js' }
            $entry = $zip.CreateEntry($duplicate)
            $entry.ExternalAttributes = 33188 -shl 16
        }
    } finally { $zip.Dispose() }
    $receipt = [ordered]@{
        schema_version = 1; component = 'copilot-proxy'; source_repository = 'fixture/proxy'; source_commit = $source; tag = $tag; version = $tag
        declaration_sha256 = $declarationHash
        asset = (Split-Path -Leaf $archive); asset_sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        built_utc = '2026-01-01T00:00:00.0000000Z'; payload = $rows
    }
    switch -Exact ($Mutation) {
        'wrong repository' { $receipt.source_repository = 'other/proxy' }
        'wrong tag' { $receipt.tag = 'bbbbbbb' }
        'wrong version' { $receipt.version = 'bbbbbbb' }
        'wrong full commit' { $receipt.source_commit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab' }
        'wrong archive checksum' { $receipt.asset_sha256 = '0' * 64 }
        'wrong archive filename' { $receipt.asset = 'other.zip' }
        'wrong declaration checksum' { $receipt.declaration_sha256 = '0' * 64 }
        'wrong payload checksum' { $receipt.payload[0].sha256 = '0' * 64 }
        'wrong payload mode' { $receipt.payload[0].mode = '100755' }
        'numeric payload mode' { $receipt.payload[0].mode = 100644 }
        'missing payload mode' { $receipt.payload[0].Remove('mode') }
        'case changed receipt path' { $receipt.payload[0].path = 'Install.ps1' }
        'duplicate receipt path' { $receipt.payload[-1] = $receipt.payload[0] }
        'omitted receipt path' { $receipt.payload = @($receipt.payload | Select-Object -Skip 1) }
    }
    $receiptPath = "$archive.json"
    [IO.File]::WriteAllText($receiptPath, (($receipt | ConvertTo-Json -Depth 8) + "`n"), $utf8)
    $installer = Join-Path $Directory 'install.ps1'
    [IO.File]::WriteAllBytes($installer, [IO.File]::ReadAllBytes((Join-Path $root 'install.ps1')))
    if ($Mutation -ceq 'wrong standalone installer') { [IO.File]::AppendAllText($installer, '# changed', $utf8) }
    return [pscustomobject]@{ Archive = $archive; Receipt = $receiptPath; Installer = $installer; AssetSha256 = $receipt.asset_sha256 }
}
function Get-FixtureBlobHash([byte[]]$Bytes) {
    $header=[Text.Encoding]::ASCII.GetBytes(('blob '+$Bytes.Length+[char]0))
    $sha=[Security.Cryptography.SHA1]::Create()
    try { [void]$sha.TransformBlock($header,0,$header.Length,$header,0); [void]$sha.TransformFinalBlock($Bytes,0,$Bytes.Length); return [BitConverter]::ToString($sha.Hash).Replace('-','').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
if ($RawBlobFixtures) {
    $scratch=Join-Path $env:TEMP ('proxy-raw-blobs-'+[guid]::NewGuid().ToString('N'))
    try {
        $repository=Join-Path $scratch 'filtered source'
        $output=Join-Path $scratch 'raw output'; $emptyHooks=Join-Path $scratch 'empty hooks'
        New-Item -ItemType Directory -Path $repository,$output,$emptyHooks -Force | Out-Null
        $git=(Get-Command git -CommandType Application -ErrorAction Stop).Source
        function Fixture-Git([string[]]$Arguments) {
            $value=& $git -c core.fsmonitor=false -c diff.autoRefreshIndex=false -c core.autocrlf=true -c ("core.hooksPath="+$emptyHooks) -c user.name=Fixture -c user.email=fixture@example.invalid -C $repository @Arguments
            if ($LASTEXITCODE -ne 0) { throw ('Owned Git fixture command failed: '+($Arguments -join ' ')) }
            return $value
        }
        [void](Fixture-Git @('init','--initial-branch=main'))
        $utf8=[Text.UTF8Encoding]::new($false)
        [IO.File]::WriteAllText((Join-Path $repository '.gitattributes'),"*.ps1 text eol=crlf`n*.sh text eol=crlf`n*.bin -text`n",$utf8)
        $lf=$utf8.GetBytes("# committed LF`nWrite-Output 'synthetic'`n")
        $shell=$utf8.GetBytes("#!/bin/sh`nprintf 'synthetic\\n'`n")
        $binary=[byte[]]@(0,255,13,10,128,65,0,10)
        [IO.File]::WriteAllBytes((Join-Path $repository 'install.ps1'),$lf)
        [IO.File]::WriteAllBytes((Join-Path $repository 'operator.sh'),$shell)
        [IO.File]::WriteAllBytes((Join-Path $repository 'payload.bin'),$binary)
        [void](Fixture-Git @('add','--','.gitattributes','install.ps1','operator.sh','payload.bin'))
        [void](Fixture-Git @('update-index','--chmod=+x','operator.sh'))
        [void](Fixture-Git @('commit','--no-gpg-sign','-m','synthetic raw blob fixture'))
        # checkout-index may leave stat-clean existing files untouched even with --force.
        # Remove only this fixture's two text files so conversion must materialize them.
        Remove-Item -LiteralPath (Join-Path $repository 'install.ps1'),(Join-Path $repository 'operator.sh') -Force
        [void](Fixture-Git @('checkout-index','--all','--force'))
        $checkout=[IO.File]::ReadAllBytes((Join-Path $repository 'install.ps1'))
        if ([Text.Encoding]::UTF8.GetString($checkout) -cnotmatch "`r`n" -or (Get-BytesHash $checkout) -ceq (Get-BytesHash $lf)) { throw 'Fixture did not establish CRLF checkout bytes different from LF committed blob.' }
        $tree=@(Fixture-Git @('ls-tree','-r','HEAD'))
        $installed=Write-CommittedInput $repository $tree 'install.ps1' (Join-Path $output 'install.ps1')
        $operator=Write-CommittedInput $repository $tree 'operator.sh' (Join-Path $output 'operator.sh')
        $data=Write-CommittedInput $repository $tree 'payload.bin' (Join-Path $output 'payload.bin')
        if ((Get-BytesHash ([IO.File]::ReadAllBytes($installed.path))) -cne (Get-BytesHash $lf) -or $installed.mode -cne '100644' -or $installed.oid -cne (Get-FixtureBlobHash $lf)) { throw 'Materialized frontdoor did not preserve raw committed LF/blob/mode.' }
        if ((Get-BytesHash ([IO.File]::ReadAllBytes($operator.path))) -cne (Get-BytesHash $shell) -or $operator.mode -cne '100755' -or $operator.oid -cne (Get-FixtureBlobHash $shell)) { throw 'Materialized executable did not preserve raw committed LF/blob/mode.' }
        if ((Get-BytesHash ([IO.File]::ReadAllBytes($data.path))) -cne (Get-BytesHash $binary) -or $data.oid -cne (Get-FixtureBlobHash $binary)) { throw 'Binary committed bytes were transformed through a text pipeline.' }
        # A dirty/filtered checkout cannot substitute its bytes for the literal OID.
        [IO.File]::WriteAllText((Join-Path $repository 'install.ps1'),"# uncommitted candidate`r`n",$utf8)
        $again=Write-CommittedInput $repository $tree 'install.ps1' (Join-Path $output 're-read.ps1')
        if ((Get-BytesHash ([IO.File]::ReadAllBytes($again.path))) -cne (Get-BytesHash $lf)) { throw 'Raw materializer read checkout bytes instead of committed blob.' }
        Write-Host 'PASS: raw committed static materialization preserves LF, binary bytes and executable modes despite CRLF/dirty checkout filters; no global Git settings changed.'
    } finally { if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force } }
    exit 0
}
if ($BootstrapFixtures) {
    # Execute the real frontdoor in a fresh PS process. Only public HTTP and
    # observations of actual installed receipts are intercepted. The source-bound
    # synthetic backend writes one owned fixture marker, never an install target.
    # Mutations refresh ZIP+receipt digests deliberately: the committed source
    # closure, not agreement between two mutable release assets, must refuse them.
    $scratch=Join-Path $env:TEMP ('proxy-bootstrap-'+[guid]::NewGuid().ToString('N'))
    $originalEnvironment=@{}
    foreach ($key in @('TEMP','TMP','TMPDIR','CLAUDE_CODE_TMPDIR','PSModulePath','PROXY_BOOTSTRAP_ASSETS','PROXY_BOOTSTRAP_MARKER','GITHUB_TOKEN','GH_TOKEN')) { $originalEnvironment[$key]=[Environment]::GetEnvironmentVariable($key,'Process') }
    try {
        New-Item -ItemType Directory -Path $scratch | Out-Null
        # A child must not auto-load a different edition's Security module.
        $foreignModules=Join-Path $scratch 'foreign-edition-modules'
        $foreignSecurity=Join-Path $foreignModules 'Microsoft.PowerShell.Security'
        New-Item -ItemType Directory -Path $foreignSecurity -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $foreignSecurity 'Microsoft.PowerShell.Security.psd1'),"@{ ModuleVersion='1.0.0'; PowerShellVersion='7.0'; CmdletsToExport=@('Get-Acl','Set-Acl') }")
        $env:PSModulePath=$foreignModules+';'+$originalEnvironment.PSModulePath
        $localInstaller=Join-Path $root 'deploy/install_local.ps1'
        $operatorTokens=$null; $operatorErrors=$null
        $operatorAst=[Management.Automation.Language.Parser]::ParseFile($localInstaller,[ref]$operatorTokens,[ref]$operatorErrors)
        if ($operatorErrors.Count) { throw ($operatorErrors | Out-String) }
        $operatorDefinition=@($operatorAst.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'Invoke-OwnedOperator' })
        if ($operatorDefinition.Count -ne 1) { throw 'Missing actual lifecycle child consumer.' }
        . ([scriptblock]::Create($operatorDefinition[0].Extent.Text))
        $operatorFixture=Join-Path $scratch "operator's fixture.ps1"
        $operatorProgram=@'
param([int]$Port,[string]$BindHost)
$ErrorActionPreference='Stop'
$report=[ordered]@{port=$Port;bind_host=$BindHost;module_path=$env:PSModulePath;host_root=$PSHOME;version=$PSVersionTable.PSVersion.ToString();owner=(Get-Acl -LiteralPath $PSScriptRoot).GetOwner([Security.Principal.SecurityIdentifier]).Value;security_module=(Get-Command Get-Acl).Module.Path}
[IO.File]::WriteAllText(($PSScriptRoot+'/operator-report.json'),($report | ConvertTo-Json))
if ($Port -eq 49172) { exit 7 }
exit 0
'@
        [IO.File]::WriteAllText($operatorFixture,$operatorProgram)
        $callerModulePath=$env:PSModulePath
        Invoke-OwnedOperator -Script $operatorFixture -Parameters @{Port=49171;BindHost='127.0.0.1'}
        if ($script:OperatorExitCode -ne 0 -or $env:PSModulePath -cne $callerModulePath) { throw 'Native lifecycle invocation failed or changed caller module search path.' }
        $operatorReport=Get-Content -LiteralPath (Join-Path $scratch 'operator-report.json') -Raw | ConvertFrom-Json
        if ($operatorReport.port -ne 49171 -or $operatorReport.bind_host -cne '127.0.0.1' -or $operatorReport.version -notmatch '^5\.1\.' -or $operatorReport.module_path -cne ($operatorReport.host_root+'\Modules') -or -not $operatorReport.security_module.StartsWith($operatorReport.host_root+'\Modules\',[StringComparison]::OrdinalIgnoreCase) -or $operatorReport.owner -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'Native lifecycle child did not preserve parameters/account or use its own Security module.' }
        Invoke-OwnedOperator -Script $operatorFixture -Parameters @{Port=49172;BindHost='127.0.0.1'}
        if ($script:OperatorExitCode -ne 7 -or $env:PSModulePath -cne $callerModulePath) { throw 'Native lifecycle exit code/caller module search path was not preserved.' }
        Write-Host 'PASS: lifecycle child uses native modules, preserves typed parameters/account and propagates failure without changing caller PSModulePath.'
        $utf8=[Text.UTF8Encoding]::new($false)
        $frontdoor=Join-Path $root 'install.ps1'; $frontBytes=[IO.File]::ReadAllBytes($frontdoor)
        $source='a'*40; $treeOid='b'*40; $tag='aaaaaaa'; $asset='copilot-proxy-'+$tag+'.zip'
        $backend=@'
param($Version,$WorkRoot,$Mode,$UserRoot,$InstallRoot,$NodeExe,[int]$Port,[switch]$AdoptExisting,[switch]$Activate,$PackageReceipt,$ArchivePath,$Frontdoor,[switch]$NoStop,[switch]$NoStart,[switch]$SkipAutostart)
[IO.File]::WriteAllText($env:PROXY_BOOTSTRAP_MARKER,'accepted source-bound fixture backend')
exit 0
'@
        $wrapper=@'
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
foreach ($module in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility')) { Import-Module -Name ($PSHOME+'/Modules/'+$module+'/'+$module+'.psd1') -ErrorAction Stop }
$fixture=$env:PROXY_BOOTSTRAP_ASSETS
$actual=[Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$blocked=@((Join-Path $actual '.agents/installations/copilot-api-proxy'),(Join-Path $actual '.local/share/copilot-proxy/install-dir.txt'))
function Test-Path {
    param([string]$LiteralPath,[string]$Path,[string]$PathType)
    $candidate=if ($LiteralPath) { $LiteralPath } else { $Path }
    foreach ($private in $blocked) { if ($candidate -ieq $private -or $candidate.StartsWith($private+'\',[StringComparison]::OrdinalIgnoreCase)) { return $false } }
    $parameters=@{LiteralPath=$candidate}; if ($PathType) { $parameters.PathType=$PathType }
    return Microsoft.PowerShell.Management\Test-Path @parameters
}
function Invoke-RestMethod {
    param([string]$Uri,$Headers)
    $prefix='https://api.github.com/repos/gupta-ash/copilot-api-proxy/'
    if (-not $Uri.StartsWith($prefix,[StringComparison]::Ordinal)) { throw ('Unmocked network refused: '+$Uri) }
    $endpoint=$Uri.Substring($prefix.Length)
    $routes=@{
        'releases/tags/aaaaaaa'='release.json'; 'git/ref/tags/aaaaaaa'='reference.json';
        'git/commits/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'='commit.json';
        'git/trees/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb?recursive=1'='tree.json';
        'contents/install.ps1?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'='front.json';
        'contents/deploy/release-files.json?ref=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'='declaration.json'
    }
    if (-not $routes.ContainsKey($endpoint)) { throw ('Unmocked network refused: '+$Uri) }
    return Get-Content -LiteralPath (Join-Path $fixture $routes[$endpoint]) -Raw | ConvertFrom-Json
}
function Invoke-WebRequest {
    param([string]$Uri,[string]$OutFile,[switch]$UseBasicParsing)
    $name=[Uri]::UnescapeDataString(([Uri]$Uri).Segments[-1])
    if ($Uri -cne ('https://github.com/gupta-ash/copilot-api-proxy/releases/download/aaaaaaa/'+$name) -or $name -cnotin @('copilot-proxy-aaaaaaa.zip','copilot-proxy-aaaaaaa.zip.json','install.ps1')) { throw ('Unmocked asset refused: '+$Uri) }
    [IO.File]::Copy((Join-Path $fixture $name),$OutFile)
}
& (Join-Path $fixture 'install.ps1') -Version aaaaaaa -WorkRoot (Join-Path $fixture 'work') -InstallRoot (Join-Path $fixture 'never-installed') -Mode Check
exit $LASTEXITCODE
'@
        $cases=[ordered]@{
            'valid source-bound closure'='';
            'unexpected root executable'='Unexpected release member: unexpected.exe';
            'unexpected operator'='Unexpected release member: scripts/unexpected.ps1';
            'unexpected dist executable'='Unexpected generated dist member: dist/unexpected.exe';
            'nested dist script'='Unexpected generated dist member: dist/nested/extra.js';
            'missing operator'='Incomplete/static source mode mismatch: scripts/status_proxy.ps1';
            'changed backend'='Static package bytes differ from committed source: scripts/install_bundle.ps1';
            'changed verifier'='Static package bytes differ from committed source: scripts/install_local.ps1';
            'changed static legal file'='Static package bytes differ from committed source: LICENSE';
            'forged packaged declaration'='Packaged declaration differs from committed source';
            'incomplete committed declaration'='Incomplete/unexpected committed static closure';
            'missing committed backend'='Invalid/missing committed static source mapping';
            'truncated source tree'='Incomplete/unbound committed source tree';
            'wrong source tree identity'='Incomplete/unbound committed source tree';
            'unbound declaration bytes'='Committed declaration bytes do not match its Git object';
            'wrong committed frontdoor blob'='Executing frontdoor is not in the selected commit tree';
            'missing generated map'='Incomplete generated release: dist/main.js.map';
            'orphan generated map'='Incomplete generated dist/map pair: dist/extra.js.map';
            'changed generated payload hash'='ZIP member digest mismatch: dist/main.js'
        }
        $index=0
        foreach ($case in $cases.Keys) {
            $directory=Join-Path $scratch ([string]$index); New-Item -ItemType Directory -Path $directory,(Join-Path $directory 'work'),(Join-Path $directory 'tmp') | Out-Null
            $declaration=Get-Content -LiteralPath (Join-Path $root 'deploy/release-files.json') -Raw | ConvertFrom-Json
            if ($case -ceq 'incomplete committed declaration') { $declaration.files=@($declaration.files | Where-Object { $_.source -cne 'deploy/status_proxy.ps1' }) }
            $committed=@{}; foreach ($row in $declaration.files) { $committed[$row.source]=[IO.File]::ReadAllBytes((Join-Path $root $row.source)) }
            $committed['install.ps1']=$frontBytes; $committed['deploy/install_bundle.ps1']=$utf8.GetBytes($backend)
            $committed['deploy/release-files.json']=$utf8.GetBytes(($declaration | ConvertTo-Json -Depth 8))
            $treeRows=@(); foreach ($path in $committed.Keys) { $treeRows += [ordered]@{path=$path;mode='100644';type='blob';sha=(Get-FixtureBlobHash $committed[$path])} }
            if ($case -ceq 'missing committed backend') { $treeRows=@($treeRows | Where-Object { $_.path -cne 'deploy/install_bundle.ps1' }) }
            if ($case -ceq 'wrong committed frontdoor blob') { foreach ($row in $treeRows) { if ($row.path -ceq 'install.ps1') { $row.sha='c'*40 } } }
            $paths=@{}; foreach ($row in $declaration.files) { $paths[$row.destination]=$committed[$row.source] }
            $paths['VERSION.txt']=$utf8.GetBytes("version=$tag`nsource_commit=$source`ndirty=False`n")
            $paths['dist/main.js']=$utf8.GetBytes('// generated synthetic ESM; never executed')
            $paths['dist/main.js.map']=$utf8.GetBytes('{"version":3,"sources":[],"names":[],"mappings":""}')
            $paths['dist/chunk-fixture.js']=$utf8.GetBytes('// generated synthetic chunk; never executed')
            $paths['dist/chunk-fixture.js.map']=$utf8.GetBytes('{"version":3,"sources":[],"names":[],"mappings":""}')
            $paths['dist/facade-fixture.js']=$utf8.GetBytes('// generated mapless facade; never executed')
            $paths['node_modules/hono/index.js']=$utf8.GetBytes('// generated synthetic dependency; never executed')
            switch -Exact ($case) {
                'unexpected root executable' { $paths['unexpected.exe']=$utf8.GetBytes('inert unexpected executable member') }
                'unexpected operator' { $paths['scripts/unexpected.ps1']=$utf8.GetBytes('inert unexpected operator') }
                'unexpected dist executable' { $paths['dist/unexpected.exe']=$utf8.GetBytes('inert unexpected executable member') }
                'nested dist script' { $paths['dist/nested/extra.js']=$utf8.GetBytes('inert nested dist script') }
                'missing operator' { $paths.Remove('scripts/status_proxy.ps1') }
                'changed backend' { $paths['scripts/install_bundle.ps1']=$utf8.GetBytes($backend+"`n# not committed") }
                'changed verifier' { $paths['scripts/install_local.ps1']=$utf8.GetBytes('# not the committed verifier') }
                'changed static legal file' { $paths['LICENSE']=$utf8.GetBytes('not the committed legal file') }
                'forged packaged declaration' { $forged=Get-Content -LiteralPath (Join-Path $root 'deploy/release-files.json') -Raw | ConvertFrom-Json; $forged.files[0].destination='unexpected.exe'; $paths['deploy/release-files.json']=$utf8.GetBytes(($forged | ConvertTo-Json -Depth 8)) }
                'missing generated map' { $paths.Remove('dist/main.js.map') }
                'orphan generated map' { $paths['dist/extra.js.map']=$utf8.GetBytes('{"version":3,"sources":[],"names":[],"mappings":""}') }
            }
            $archive=Join-Path $directory $asset; $rows=@()
            $zip=[IO.Compression.ZipFile]::Open($archive,[IO.Compression.ZipArchiveMode]::Create)
            try {
                foreach ($path in $paths.Keys) {
                    $mode=if ($path.EndsWith('.sh',[StringComparison]::Ordinal) -or $path -ceq 'dist/main.js') { '100755' } else { '100644' }
                    $entry=$zip.CreateEntry($path); $bits=if ($mode -ceq '100755') { 33261 } else { 33188 }; $entry.ExternalAttributes=$bits -shl 16
                    $stream=$entry.Open(); try { $stream.Write($paths[$path],0,$paths[$path].Length) } finally { $stream.Dispose() }
                    $hash=Get-BytesHash $paths[$path]; if ($case -ceq 'changed generated payload hash' -and $path -ceq 'dist/main.js') { $hash='0'*64 }
                    $rows += [ordered]@{path=$path;sha256=$hash;mode=$mode}
                }
            } finally { $zip.Dispose() }
            $receipt=[ordered]@{schema_version=1;component='copilot-proxy';source_repository='gupta-ash/copilot-api-proxy';source_commit=$source;tag=$tag;version=$tag;declaration_sha256=(Get-BytesHash $paths['deploy/release-files.json']);asset=$asset;asset_sha256=(Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant();built_utc='2026-01-01T00:00:00Z';payload=$rows}
            $base='https://github.com/gupta-ash/copilot-api-proxy/releases/download/'+$tag+'/'
            $release=[ordered]@{tag_name=$tag;draft=$false;assets=@(@($asset,($asset+'.json'),'install.ps1') | ForEach-Object { [ordered]@{name=$_;browser_download_url=($base+$_)} })}
            $front=[ordered]@{type='file';path='install.ps1';encoding='base64';sha=(Get-FixtureBlobHash $frontBytes);content=[Convert]::ToBase64String($frontBytes)}
            $declarationContent=[ordered]@{type='file';path='deploy/release-files.json';encoding='base64';sha=(Get-FixtureBlobHash $committed['deploy/release-files.json']);content=[Convert]::ToBase64String($committed['deploy/release-files.json'])}
            if ($case -ceq 'unbound declaration bytes') { $declarationContent.content=[Convert]::ToBase64String($utf8.GetBytes('{}')) }
            $tree=[ordered]@{sha=$treeOid;truncated=($case -ceq 'truncated source tree');tree=$treeRows}
            if ($case -ceq 'wrong source tree identity') { $tree.sha='c'*40 }
            $documents=@{'release.json'=$release;'reference.json'=[ordered]@{ref=('refs/tags/'+$tag);object=[ordered]@{type='commit';sha=$source}};'commit.json'=[ordered]@{sha=$source;tree=[ordered]@{sha=$treeOid}};'tree.json'=$tree;'front.json'=$front;'declaration.json'=$declarationContent;($asset+'.json')=$receipt}
            foreach ($name in $documents.Keys) { [IO.File]::WriteAllText((Join-Path $directory $name),($documents[$name] | ConvertTo-Json -Depth 12),$utf8) }
            [IO.File]::WriteAllBytes((Join-Path $directory 'install.ps1'),$frontBytes)
            $wrapperPath=Join-Path $directory 'run.ps1'; [IO.File]::WriteAllText($wrapperPath,$wrapper,$utf8)
            $env:PROXY_BOOTSTRAP_ASSETS=$directory; $env:PROXY_BOOTSTRAP_MARKER=Join-Path $directory 'backend-executed.txt'
            foreach ($key in @('TEMP','TMP','TMPDIR','CLAUDE_CODE_TMPDIR')) { [Environment]::SetEnvironmentVariable($key,(Join-Path $directory 'tmp'),'Process') }
            [Environment]::SetEnvironmentVariable('GITHUB_TOKEN',$null,'Process'); [Environment]::SetEnvironmentVariable('GH_TOKEN',$null,'Process')
            $shell=Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
            $savedPreference=$ErrorActionPreference; $ErrorActionPreference='Continue'
            try { $output=& $shell -NoProfile -NonInteractive -File $wrapperPath 2>&1; $code=$LASTEXITCODE } finally { $ErrorActionPreference=$savedPreference }
            $executed=Test-Path -LiteralPath $env:PROXY_BOOTSTRAP_MARKER -PathType Leaf
            if (-not $cases[$case]) {
                if ($code -ne 0 -or -not $executed) { throw ('Valid bootstrap fixture failed: '+($output | Out-String)) }
            } elseif ($code -eq 0 -or $executed -or ($output | Out-String) -notmatch [regex]::Escape($cases[$case])) { throw ("Bootstrap case '$case' did not refuse before backend execution: exit=$code executed=$executed "+($output | Out-String)) }
            if (Test-Path -LiteralPath (Join-Path $directory 'never-installed')) { throw 'Bootstrap fixture wrote an install target.' }
            Write-Host ('PASS: bootstrap '+$case); $index++
        }
    } finally {
        foreach ($key in $originalEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key,$originalEnvironment[$key],'Process') }
        if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
    }
    exit 0
}
if ($ArchiveFixtures) {
    $scratch = Join-Path $env:TEMP ('proxy-archives-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path $scratch | Out-Null
        $cases = @('', 'wrong repository', 'wrong tag', 'wrong version', 'wrong full commit', 'wrong archive checksum', 'wrong archive filename',
            'wrong declaration checksum', 'wrong payload checksum', 'wrong payload mode', 'numeric payload mode', 'missing payload mode', 'case changed receipt path',
            'duplicate receipt path', 'omitted receipt path', 'wrong standalone installer', 'wrong declaration mapping', 'case changed declaration',
            'missing retirement declaration', 'unsafe retirement', 'live file retirement', 'wrong marker', 'non ESM package', 'unexpected source fixture',
            'unexpected operator', 'unexpected environment file', 'case changed archive path', 'parent archive path', 'backslash archive path', 'dot archive path',
            'symlink archive mode', 'duplicate archive path', 'case colliding archive path', 'missing install.ps1', 'missing LICENSE', 'missing NOTICE',
            'missing deploy/release-files.json', 'missing scripts/install_local.ps1')
        $index = 0
        foreach ($case in $cases) {
            $fixture = New-ArchiveFixture (Join-Path $scratch ([string]$index)) $case
            $failure = $null
            try { Assert-ReleaseArchive -Archive $fixture.Archive -ReceiptPath $fixture.Receipt -Repository 'fixture/proxy' -Tag 'aaaaaaa' -SourceCommit ('a' * 40) -Installer $fixture.Installer }
            catch { $failure = $_ }
            if ([bool]$failure -ne [bool]$case) { throw "Archive case '$case' had an unexpected outcome: $failure" }
            Write-Host "PASS: archive $(if ($case) { $case } else { 'exact public closure' })"
            $index++
        }
    } finally { if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force } }
    exit 0
}
if ($PublicationFixtures) {
    if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
        throw 'Publication fixtures require actual Windows PowerShell 5.1, not pwsh.'
    }
    $scratch = Join-Path $env:TEMP ('proxy-publication-' + [guid]::NewGuid().ToString('N'))
    $oldState = $env:PROXY_RELEASE_FIXTURE_STATE
    try {
        New-Item -ItemType Directory -Path $scratch | Out-Null
        $env:PROXY_RELEASE_FIXTURE_STATE = Join-Path $scratch 'state.json'
        $utf8 = New-Object Text.UTF8Encoding($false)
        $stub = @'
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# This is a new native PS5.1 process, not the AST consumer's imported scope.
# Bind its actual hash/JSON/file cmdlets to this host despite inherited PS7 paths.
foreach ($module in @('Microsoft.PowerShell.Management','Microsoft.PowerShell.Utility')) {
    Import-Module -Name ($PSHOME+'/Modules/'+$module+'/'+$module+'.psd1') -Scope Local -ErrorAction Stop
}
$nativeArgs = @($args)
$statePath = $env:PROXY_RELEASE_FIXTURE_STATE
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
function Save-State {
    [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
}
function Option([string]$Name) {
    $index = [array]::IndexOf($nativeArgs, $Name)
    if ($index -lt 0 -or $index + 1 -ge $nativeArgs.Count) { throw "Missing fixture argument: $Name" }
    return $nativeArgs[$index + 1]
}
function Record-Assets {
    $repoIndex = [array]::IndexOf($nativeArgs, '--repo')
    $assets = @($nativeArgs[3..($repoIndex - 1)])
    $expected = @("copilot-proxy-$($state.tag).zip", "copilot-proxy-$($state.tag).zip.json", 'install.ps1')
    if ($assets.Count -ne 3) { throw 'Publication did not supply exactly ZIP, receipt and installer.' }
    for ($index = 0; $index -lt 3; $index++) {
        if ((Split-Path -Leaf $assets[$index]) -cne $expected[$index] -or -not (Test-Path -LiteralPath $assets[$index] -PathType Leaf)) { throw 'Unexpected publication asset.' }
    }
    $receipt = Get-Content -LiteralPath $assets[1] -Raw | ConvertFrom-Json
    $archiveHash = (Get-FileHash -LiteralPath $assets[0] -Algorithm SHA256).Hash.ToLowerInvariant()
    $installerHash = (Get-FileHash -LiteralPath $assets[2] -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($receipt.source_repository -cne 'fixture/proxy' -or $receipt.source_commit -cne $state.source -or $receipt.tag -cne $state.tag -or
        $receipt.asset_sha256 -cne $archiveHash -or @($receipt.payload | Where-Object { $_.path -ceq 'install.ps1' -and $_.sha256 -ceq $installerHash }).Count -ne 1) { throw 'Published receipt does not bind supplied assets/source.' }
    $state.assetHash = $archiveHash
    $state.receiptHash = (Get-FileHash -LiteralPath $assets[1] -Algorithm SHA256).Hash.ToLowerInvariant()
    $state.installerHash = $installerHash
}
function Reply([int]$Status, $Body) {
    [Console]::Out.WriteLine("HTTP/2.0 $Status Fixture")
    [Console]::Out.WriteLine('Content-Type: application/json')
    [Console]::Out.WriteLine('')
    [Console]::Out.WriteLine(($Body | ConvertTo-Json -Depth 8 -Compress))
    # A successful API call with stderr must survive PS5.1 Stop as well.
    [Console]::Error.WriteLine('fixture native stderr')
    if ($Status -ne 200) { exit 1 }
    exit 0
}
try {
    $state.calls = @($state.calls) + ($nativeArgs -join ' ')
    Save-State
    if ($nativeArgs[0] -ceq 'api') {
        if ((Option '--method') -cne 'GET' -or $nativeArgs -cnotcontains '--include') { throw 'Unexpected API mode.' }
        $endpoint = $nativeArgs[-1]
        if ($state.failurePath -and $endpoint.Contains($state.failurePath) -and
            (-not $state.failAfterMutation -or $state.mutations -gt 0)) {
            if ($state.failureStatus -eq 0) { [Console]::Error.WriteLine('fixture network failure'); exit 1 }
            if ($state.failureStatus -eq -1) {
                [Console]::Out.WriteLine("HTTP/2.0 404 Fixture`r`nContent-Type: application/json`r`n`r`nnot-json")
                exit 1
            }
            if ($state.failureStatus -eq -2) { Reply 200 @{ unexpected = 'not a ref' } }
            Reply $state.failureStatus @{ message = $(if ($state.failureStatus -eq 404) { 'Not Found' } else { 'fixture API failure' }) }
        }
        if ($endpoint -ceq "repos/fixture/proxy/commits/$($state.source)") { Reply 200 @{ sha = $state.source } }
        if ($endpoint -ceq "repos/fixture/proxy/git/ref/tags/$($state.tag)") {
            if (-not $state.tagCommit) { Reply 404 @{ message = 'Not Found' } }
            $state.tagReads++; Save-State
            $target = if ($state.annotated) { @{ type = 'tag'; sha = $state.annotation } } else { @{ type = 'commit'; sha = $state.tagCommit } }
            Reply 200 @{ ref = "refs/tags/$($state.tag)"; object = $target }
        }
        if ($endpoint -ceq "repos/fixture/proxy/git/tags/$($state.annotation)" -and $state.annotated) {
            $state.annotationReads++; Save-State
            Reply 200 @{ sha = $state.annotation; object = @{ type = 'commit'; sha = $state.tagCommit } }
        }
        if ($endpoint -ceq "repos/fixture/proxy/releases/tags/$($state.tag)") {
            if (-not $state.exists) { Reply 404 @{ message = 'Not Found' } }
            Reply 200 @{ tag_name = $state.tag; prerelease = $state.held; draft = $false; body = $state.notes }
        }
        throw 'Unexpected fixture endpoint.'
    }
    if ($nativeArgs[0] -cne 'release' -or $nativeArgs[2] -cne $state.tag -or (Option '--repo') -cne 'fixture/proxy') { throw 'Unexpected publication command.' }
    switch -Exact ($nativeArgs[1]) {
        'create' {
            if ($state.exists) { throw 'Duplicate release create.' }
            $state.exists = $true
            if (-not $state.tagCommit) { $state.tagCommit = Option '--target' }
            $state.notes = Option '--notes'
            $state.held = $nativeArgs -ccontains '--prerelease'
            Record-Assets
            if ($nativeArgs -cnotcontains '--latest=false') { $state.latest = $state.tag }
        }
        'edit' {
            if (-not $state.exists) { throw 'Missing release edit.' }
            if ($nativeArgs -ccontains '--notes') { $state.notes = Option '--notes' }
            if ($nativeArgs -ccontains '--prerelease') { $state.held = $true }
            if ($nativeArgs -ccontains '--prerelease=false') { $state.held = $false }
            if ($nativeArgs -ccontains '--latest' -or $nativeArgs -ccontains '--latest=true') { $state.latest = $state.tag }
        }
        'upload' {
            if (-not $state.exists -or $nativeArgs -cnotcontains '--clobber') { throw 'Invalid replacement.' }
            Record-Assets
        }
        default { throw 'Unexpected release operation.' }
    }
    $state.mutations++
    if ($state.raceTag) { $state.tagCommit = 'dddddddddddddddddddddddddddddddddddddddd' }
    Save-State
    exit 0
} catch {
    $state.unexpected = $_.Exception.Message
    Save-State
    [Console]::Error.WriteLine($state.unexpected)
    exit 99
}
'@
        [IO.File]::WriteAllText((Join-Path $scratch 'gh-stub.ps1'), $stub, $utf8)
        $stubCommand = Join-Path $scratch 'gh.cmd'
        [IO.File]::WriteAllText($stubCommand, ('@"' + (Join-Path $PSHOME 'powershell.exe') + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0gh-stub.ps1" %*' + "`r`n@exit /b %errorlevel%`r`n"), [Text.Encoding]::ASCII)
        # A literal alias to our native command precludes a real gh/PATH fallback.
        Set-Alias -Name gh -Value $stubCommand -Scope Local -Force
        $fixture = New-ArchiveFixture (Join-Path $scratch 'release assets')
        $asset = $fixture.Archive
        $newHash = $fixture.AssetSha256
        $newReceiptHash = (Get-FileHash -LiteralPath $fixture.Receipt -Algorithm SHA256).Hash.ToLowerInvariant()
        $newInstallerHash = (Get-FileHash -LiteralPath $fixture.Installer -Algorithm SHA256).Hash.ToLowerInvariant()
        $source = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        $cases = @(
            @{ name = 'wrong bare tag'; tagCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; fails = $true },
            @{ name = 'wrong annotated tag'; tagCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'; annotated = $true; fails = $true },
            @{ name = 'new held release from true 404' },
            @{ name = 'matching bare annotated tag'; tagCommit = $source; annotated = $true },
            @{ name = 'replace matching stable release'; tagCommit = $source; exists = $true },
            @{ name = 'replace matching annotated release'; tagCommit = $source; exists = $true; annotated = $true },
            @{ name = 'preserve existing hold without switch'; tagCommit = $source; exists = $true; held = $true; omitPrerelease = $true },
            @{ name = 'private repository masked auth 404'; failurePath = '/commits/'; failureStatus = 404; fails = $true },
            @{ name = 'tag auth failure'; failurePath = '/git/ref/'; failureStatus = 401; fails = $true },
            @{ name = 'tag access failure'; failurePath = '/git/ref/'; failureStatus = 403; fails = $true },
            @{ name = 'tag network failure'; failurePath = '/git/ref/'; failureStatus = 0; fails = $true },
            @{ name = 'release access failure'; failurePath = '/releases/'; failureStatus = 403; fails = $true },
            @{ name = 'release server failure'; failurePath = '/releases/'; failureStatus = 500; fails = $true },
            @{ name = 'release network failure'; failurePath = '/releases/'; failureStatus = 0; fails = $true },
            @{ name = 'malformed missing response'; failurePath = '/git/ref/'; failureStatus = -1; fails = $true },
            @{ name = 'malformed success object'; failurePath = '/git/ref/'; failureStatus = -2; fails = $true },
            @{ name = 'wrong ref after create'; raceTag = $true; fails = $true; afterMutation = $true },
            @{ name = 'wrong ref after replacement'; tagCommit = $source; exists = $true; raceTag = $true; fails = $true; afterMutation = $true },
            @{ name = 'unverifiable ref after create'; failurePath = '/git/ref/'; failureStatus = 500; failAfterMutation = $true; fails = $true; afterMutation = $true }
        )
        foreach ($case in $cases) {
            $state = [ordered]@{
                source = $source; tag = 'aaaaaaa'; tagCommit = ''; annotated = $false
                annotation = 'cccccccccccccccccccccccccccccccccccccccc'
                exists = $false; held = $false; latest = 'prior-stable'; notes = 'Asset SHA-256: previous-asset.'
                assetHash = 'previous-asset'; mutations = 0; tagReads = 0; annotationReads = 0
                receiptHash = 'previous-receipt'; installerHash = 'previous-installer'
                calls = @(); unexpected = ''; raceTag = $false; failurePath = ''; failureStatus = 0; failAfterMutation = $false
            }
            foreach ($key in $case.Keys) { if ($state.Contains($key)) { $state[$key] = $case[$key] } }
            [IO.File]::WriteAllText($env:PROXY_RELEASE_FIXTURE_STATE, ($state | ConvertTo-Json -Depth 8), $utf8)
            $failure = $null
            try {
                Publish-Release -Repo 'fixture/proxy' -Tag 'aaaaaaa' -SourceCommit $source -Archive $asset -Receipt $fixture.Receipt -Installer $fixture.Installer -AssetSha256 $newHash -Prerelease:(-not $case['omitPrerelease'])
            } catch { $failure = $_ }
            $observed = Get-Content -LiteralPath $env:PROXY_RELEASE_FIXTURE_STATE -Raw | ConvertFrom-Json
            if ($observed.unexpected) { throw "$($case.name): unexpected fixture invocation: $($observed.unexpected)" }
            if ([bool]$failure -ne [bool]$case['fails']) { throw "$($case.name): unexpected publication outcome: $failure" }
            if ($observed.latest -cne 'prior-stable') { throw "$($case.name): publication moved latest." }
            if ($case['fails'] -and -not $case['afterMutation']) {
                if ($observed.mutations -ne 0 -or $observed.assetHash -cne 'previous-asset' -or $observed.receiptHash -cne 'previous-receipt' -or
                    $observed.installerHash -cne 'previous-installer' -or $observed.notes -cne $state.notes) {
                    throw "$($case.name): refusal changed release state."
                }
            } elseif (-not $case['fails']) {
                $expectedNotes = "Source commit: $source. Prebuilt release bundle. Asset SHA-256: $newHash."
                if (-not $observed.exists -or -not $observed.held -or $observed.tagCommit -cne $source -or
                    $observed.assetHash -cne $newHash -or $observed.receiptHash -cne $newReceiptHash -or $observed.installerHash -cne $newInstallerHash -or
                    $observed.notes -cne $expectedNotes) {
                    throw "$($case.name): published state/notes do not bind ZIP, receipt, standalone installer and source."
                }
                $minimumReads = if ($state.tagCommit) { 2 } else { 1 }
                if ($observed.tagReads -lt $minimumReads -or ($state.annotated -and $observed.annotationReads -lt 2)) {
                    throw "$($case.name): exact dereferenced source was not checked after publication."
                }
            } elseif ($observed.mutations -eq 0) { throw "$($case.name): post-publication refusal was not exercised." }
            Write-Host "PASS: $($case.name)"
        }
    } finally {
        $env:PROXY_RELEASE_FIXTURE_STATE = $oldState
        if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
    }
    exit 0
}
Assert-ReleaseArchive -Archive $Archive -ReceiptPath "$Archive.json" -Repository $ExpectedRepository -Tag $ExpectedTag -SourceCommit $ExpectedCommit -Installer (Join-Path (Split-Path -Parent ([IO.Path]::GetFullPath($Archive))) 'install.ps1')
Write-Host "PASS: exact public archive membership, repository/tag/full source binding, SHA-256, modes and standalone installer. No installed state read or modified."
