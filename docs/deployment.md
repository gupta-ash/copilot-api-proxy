# Versioned local deployment

The public repository is [`gupta-ash/copilot-api-proxy`](https://github.com/gupta-ash/copilot-api-proxy). The runtime, npm package name and command remain `copilot-proxy`.

Installation is a manual, current-user operation on Windows PowerShell 5.1 or later. It does not require a separate deployment controller or a shared staging checkout. Use a specific published release tag, not a moving branch or a `latest` download URL.

## Release assets and trust

Each release publishes these three assets together:

- `copilot-proxy-<tag>.zip`: the built application, production dependencies and installer closure.
- `copilot-proxy-<tag>.zip.json`: the package receipt.
- `install.ps1`: the standalone installer copied from the same committed source as the ZIP's root `install.ps1`.

The receipt uses `schema_version: 1` and `component: "copilot-proxy"`. It binds `source_repository`, the full 40-character `source_commit`, exact `tag` and `version`, `asset`, `asset_sha256`, and `declaration_sha256`. Its `payload` contains the exact case-sensitive normalized file list, with `path`, lowercase SHA-256 `sha256`, and regular-file `mode` (`100644` or `100755`) for each entry. These modes are also encoded in ZIP entry attributes. `built_utc` is receipt metadata, not an installed version marker.

The installer checks this binding before invoking the packaged backend, including the standalone installer's equality to the root installer inside the ZIP. A checksum receipt is not a digital signature: the initial standalone script and release must come from a repository and release identity you trust. Save and inspect the script; do not pipe a downloaded script into `Invoke-Expression`.

Before extraction or backend execution, the frontdoor also binds the selected commit's nontruncated Git tree and committed release declaration. Every static member, including both installer backends and all operators, must match its declared committed Git blob and projected mode. Only the bounded generated ESM/map output and receipt-bound production dependency tree are admitted outside that static closure. Windows builtin modules are imported from the invoking PowerShell's own installation, not an inherited different-edition module search path; lifecycle children use native Windows PowerShell with a child-only native module path. Caller profiles and global module-path settings are unchanged.

## Download and check an exact version

Prerequisites:

- Windows PowerShell 5.1+ and network access to the selected GitHub release.
- An existing Node.js executable, major version 20 or later. The installer does not install Node for you.
- A dedicated, existing, current-user-owned absolute `WorkRoot` outside source checkouts, installed code and application state. Downloads and extraction belong there, not in the live service directory.

Replace `<exact-tag>` with the release tag you selected. The tag is the source builder's abbreviated commit identity; use the exact published spelling.

```powershell
$version = '<exact-tag>'
$work = Join-Path $env:LOCALAPPDATA 'copilot-api-proxy-download'
New-Item -ItemType Directory -Path $work -Force | Out-Null
$installer = Join-Path $work 'install.ps1'
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

Invoke-WebRequest -UseBasicParsing `
    -Uri "https://github.com/gupta-ash/copilot-api-proxy/releases/download/$version/install.ps1" `
    -OutFile $installer

& $installer -Version $version -WorkRoot $work -NodeExe $node -Mode Check
if ($LASTEXITCODE -ne 0) { throw 'Release check failed.' }
```

`Check` downloads and validates the selected assets in `WorkRoot` and checks the local target. It does not install code, activate the proxy, rewrite application state or change autostart registration. Inspect the downloaded receipt's repository, tag and full source commit, and confirm the selected local target before installation. A successful check is not proof that the selected version is running.

## Install, then activate explicitly

Use the same script and exact version:

```powershell
& $installer -Version $version -WorkRoot $work -NodeExe $node -Mode Install
if ($LASTEXITCODE -ne 0) { throw 'Installation failed.' }
```

The default code location is the retained installation location or existing same-user installation record; for a fresh installation it is `~/.agents/services/copilot-proxy`. `-InstallRoot` may select a dedicated same-user code directory for a fresh installation. It is not a relocation command for an existing installation. `-UserRoot` defaults to the actual invoking user's profile; it does not authorize installing into another account.

An existing installation without the public installer's ownership receipt requires explicit `-AdoptExisting` and must pass the installer's ownership and content checks. This is not permission to overwrite an arbitrary nonempty directory. Keep an existing installation and its application state intact if adoption is refused.

The application state directory remains `~/.local/share/copilot-proxy`: authentication, configuration, logs and traces are local state, not release inputs. The installer preserves existing configuration and the selected port; a fresh installation defaults to loopback port 4143. Existing autostart registration is left untouched.

Installing files and running those files are separate outcomes. If changed code is required while the proxy is running, ordinary `Install` refuses before live writes: either stop the proxy explicitly first or request activation with exact local confirmation. Installing into a stopped target without activation does not start it or establish live readiness. When ready for a local restart, request activation interactively:

```powershell
& $installer -Version $version -WorkRoot $work -NodeExe $node -Mode Install -Activate
if ($LASTEXITCODE -ne 0) { throw 'Install or activation did not complete.' }
```

Review and enter the exact confirmation string presented by the installer. It binds the component, selected version, observed process identity, installation root and live peer count. Do not automate this prompt or treat `-Activate` alone as restart approval. The installer preserves the discovered launcher variant, including a no-rollback variant, rather than silently changing the existing startup policy.

The root frontdoor forwards explicit `-Activate` to the backend's separately confirmed stop/start path; `NoStop`/`NoStart` suppress implicit lifecycle actions only. The start operator already waits for its listener. The installation then makes one authenticated-health observation; it does not add a readiness retry loop. A new owned PID/root with authentication still starting is reported as **activation/auth readiness pending**, separately from successfully installed bytes. Inspect status and finish the interactive installed device-code/catalog flow before claiming live readiness. A pending observation never authorizes automatic code/state rollback.

## Verify installed files offline

```powershell
& $installer -Version $version -WorkRoot $work -Mode Verify
if ($LASTEXITCODE -ne 0) { throw 'Installed verification failed.' }
```

`Verify` uses retained local metadata and verifier files; it does not fetch another release or contact GitHub. It checks installed ownership, package-bound bytes and retained installation coordinates without repairing files. It does not prove that the selected version is running or that live authentication is ready. Successful explicit activation separately establishes the owned process and authenticated health; do not treat an offline file verification as that runtime proof.

The installer retains its public receipt and frontdoor/verifier closure under `~/.agents/installations/copilot-api-proxy`. The installed ownership receipt identifies the public component as `copilot-api-proxy`; this is distinct from the package receipt's unchanged runtime component `copilot-proxy`. Keep the retained closure with the installation so subsequent offline verification uses the accepted installer rather than an arbitrary checkout.

Do not invoke `scripts/install_bundle.ps1` directly as a substitute for these checks. It is the packaged backend called only after the root installer accepts the selected release and local ownership.

Optional adoption/activation switches may be omitted under PowerShell StrictMode; omission is false, not a missing-property error. Offline Verify likewise recovers omitted install-root and Node coordinates from its retained receipt rather than requiring repeated arguments.

## Manual code-only recovery after a partial install

Install uses atomic individual-file writers, not a whole-tree transaction. If an upgrade fails after some replacements, the old successful `installed.json` intentionally remains and subsequent Verify/Install will report immutable drift. **Do not blindly retry, edit hashes, delete the old receipt, use adoption as an upgrade bypass, or teach the installer to accept candidate-looking drift.** No pending-state/resume or automatic rollback mechanism is provided.

The failure message names the operation's private preservation directory and exact `inventory.json`, `candidate-files.json`, `candidate-package-receipt.json` and `partial-effects.json` paths. Retain all of them plus the verified failed candidate archive/extraction. `inventory.json` maps overwritten files to private byte/hash backups. `candidate-files.json` records that operation's immutable candidate paths/hashes/modes and whether each existed before; it is diagnostic authority for a reviewed manual operation, never permission to overwrite arbitrary drift.

An authorized local operator can recover the old immutable installation as follows. Review the entire proposed recovery before its first write:

1. Establish the exact same account, install root, prior successful version and failed candidate source/archive binding. Check the preserved `installed.json` backup against the still-current old receipt; validate candidate hashes against the verified selected package receipt and its committed declaration. Read the precise partial effects. Refuse linked/hardlinked paths, changed backup bytes, mismatched roots, or missing/ambiguous operation evidence. Never run a recovery from another user's receipt or another preservation directory.
2. Observe the actual owned PID/start/root and peers. If code recovery requires a stop, obtain explicit local consent for that exact process/peer impact, run only its known-owned `scripts/stop_proxy.ps1`, and check the exit and absence of the owned process. Do not start/stop anything merely because this document was opened, and do not kill an arbitrary port listener. Preserve the observed registrar/launcher variant.
3. Limit restoration to **prior receipt-listed immutable code/static files and its exact retained verifier/input closure**. For each such path in the preservation inventory, validate the backup SHA against both the inventory and the prior receipt. Before replacing an existing file, its current SHA must equal either that prior SHA or the failed operation's verified candidate SHA for the same absolute path. Any third hash is a local-edit conflict: hold it for separate reviewed disposition. A missing file is not a matching hash; restore an explicitly retired prior-owned file only after independently binding its absence to this candidate's committed retirement list and the recorded exact retirement effect. Otherwise hold unexplained absence.
4. Remove a newly created immutable candidate file only when this operation records `existed_before: false`, the prior receipt did not own it, its destination is within the declared code/verifier roots, and its **current** SHA still equals this operation's verified candidate hash. Preserve modified candidates, pre-existing files, directories and unknown neighbors. Do not infer recursive deletion authority from a directory name.
5. Apply only that reviewed file-by-file restoration/removal, using same-directory temporary files and atomic replacement for restoration. Recheck each source/current hash immediately before its write. Leave the old successful receipt unchanged; restore its prior immutable verifier/input files first if the partial overlay changed them. **Never restore or delete target-local user configuration, tokens, APP_DIR, SQLite/WAL/SHM/journals, logs, audit, sessions, stable IDs, install-root records, registrars or unrelated files.** The receipt-owned immutable `config/default.yaml` seed is a package file, not the user's APP_DIR/config.yaml. Backups are retained evidence, not an old live-state snapshot to replay.
6. Invoke the restored old release's committed frontdoor with its **old exact tag** and `-Mode Verify`, offline. Resolve any remaining exact-path conflict rather than manufacturing a pass. Only after old-version verification succeeds should you rerun the reviewed candidate's Check → Install → separate Verify. Activation/authentication remain separate explicit operations. Retain the failed operation's evidence even after successful recovery.

For inspection, use the exact paths printed by the failed operation, not a search for the newest directory:

```powershell
$Preservation = '<exact-private-preservation-path-from-failure>'
$Inventory = Get-Content -LiteralPath (Join-Path $Preservation 'inventory.json') -Raw | ConvertFrom-Json
$Candidates = Get-Content -LiteralPath (Join-Path $Preservation 'candidate-files.json') -Raw | ConvertFrom-Json
$Effects = Get-Content -LiteralPath (Join-Path $Preservation 'partial-effects.json') -Raw | ConvertFrom-Json
$Inventory | Format-Table path,backup,sha256
$Candidates | Format-Table path,sha256,mode,existed_before
$Effects
```

Those commands only inspect evidence; they do not automatically execute recovery. Do not convert an unreviewed entire inventory into a copy loop. For a **partial first installation** there is no prior successful receipt/version to restore or verify. Preserve state and audit the exact candidate effects; remove only newly created unchanged immutable candidate files under the rules above if choosing to return to an empty code root. If recognizable unreceipted installation bytes remain and you choose to complete takeover instead, Check/Install require explicit `-AdoptExisting` and ordinary full preflight/private backup. No partial-install exception releases that requirement.

## Package contents

`deploy/release-files.json` is committed and included in the archive at the same path. The exact static closure is:

- Root `install.ps1`, `LICENSE`, `NOTICE`, `package.json`, and frozen `bun.lock`.
- `deploy/release-files.json` and `config/default.yaml`.
- Six PowerShell/shell pairs for start, start-no-rollback, stop, status, log-on and log-off.
- PowerShell installers `install_bundle.ps1`, `install_local.ps1`, `install_service.ps1`, and `uninstall_service.ps1`, exported from source `deploy/` into archive `scripts/`.

The generated inputs are `dist/`, production `node_modules/`, and root `VERSION.txt`. Static files retain their committed regular Git modes; shell scripts and `dist/main.js` are executable (`100755`), and other generated files use `100644`. The root `package.json` remains an ESM runtime input, not optional metadata.

The declaration includes an explicit `retired_files` array, initially empty. A release removing previously owned files must declare those package-relative paths. Retirement is limited to owned package roots and does not authorize deleting unknown or modified local files. A path cannot be both retired and present in the new payload.

Source code, development scripts, source test fixtures, engineering documentation, repository history, environment files, authentication material, logs and installed application state are not first-party release payloads. Production dependencies are installed separately using the committed frozen lock; a live installation or developer `node_modules` tree is never a packaging source.

## Maintainer packaging and publication

Run `scripts/package_release.ps1` only from accepted, committed source whose literal `HEAD` is already available in the selected GitHub repository. The default repository is `gupta-ash/copilot-api-proxy`. The packager verifies that its own executing bytes match the committed Git object, refuses a dirty checkout or source links/submodules, clones the exact full OID into a disposable independent checkout, installs frozen dependencies, builds afresh and packages only declared inputs plus generated production output. Existing source version/tag generation remains unchanged: the release tag and `VERSION.txt` version use `git rev-parse --short HEAD`, bound to the full source OID in both marker and receipt.

The executing packager is checked against its raw Git blob, without clean-filter normalization. All static package inputs, including the declaration, frontdoor, operators, package metadata and frozen lock, are materialized with binary `git cat-file blob <literal-oid>` reads. Their raw Git blob hashes and committed/projected regular modes are checked before archive/publication. Checkout CRLF/smudge filters never select static release bytes, and no global Git settings are changed. Only generated application output comes from the fresh literal-commit build checkout; frozen production dependencies use the raw committed package/lock inputs.

To retain local candidate assets without creating or changing a GitHub Release:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/package_release.ps1 `
    -NoRelease -OutDir '<fresh-output-directory-outside-the-checkout>'
```

`-NoRelease` still requires GitHub access to prove the exact source commit is published. It retains all three assets. It does not install or activate anything. An output ZIP, receipt or `install.ps1` already present in `OutDir` causes refusal rather than overwrite. `-SkipBuild` is refused for real packaging; `-DryRun` only previews the operation.

Publication is a separate explicit invocation and fresh build:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/package_release.ps1 `
    -Prerelease -OutDir '<another-fresh-output-directory>'
```

Before mutation, publication rechecks access to the exact full source commit and exact tag ref, including dereferencing annotated tags. A mismatching bare or annotated tag refuses. Only an explicit HTTP 404 with `Not Found` is treated as absence; authentication, access, network, malformed-response and other API failures refuse publication. Draft or ambiguous release/tag state also refuses.

Creation and replacement publish ZIP, receipt and standalone installer together. Replacement of an existing matching release is explicit (`gh release upload --clobber`); this does not relax local output no-clobber rules. An existing prerelease hold is preserved even if `-Prerelease` is omitted. Held publication uses `--prerelease --latest=false`, never an implicit stable/latest promotion. Release notes bind the full source commit and archive SHA-256, and both notes and dereferenced tag identity are read back before success.

A failed upload, edit or readback does not guarantee rollback of remote changes. Inspect retained local assets and actual release state before retrying. ZIP timestamps can differ between builds; compare receipt payload digests and modes rather than assuming independently built archive checksums are identical.

### Consumer checks

These commands exercise real archive acceptance/refusal and the real publication helper with a disposable native `gh` stub. They do not build, install or publish:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/package_release.ps1 -ArchiveFixtures
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/package_release.ps1 -RawBlobFixtures
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/package_release.ps1 -BootstrapFixtures
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/package_release.ps1 -PublicationFixtures
```

`PublicationFixtures` must run under actual Windows PowerShell 5.1, not `pwsh`, to cover native stderr handling. To inspect retained candidate assets against their expected public identity:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/package_release.ps1 `
    -Archive '<output-directory>/copilot-proxy-<tag>.zip' `
    -ExpectedRepository 'gupta-ash/copilot-api-proxy' `
    -ExpectedTag '<tag>' -ExpectedCommit '<full-40-character-source-oid>'
```

The candidate's `.zip.json` receipt and standalone `install.ps1` must be beside the ZIP. Archive validation checks the packaged declaration itself, exact normalized membership, SHA-256 and mode binding, version marker, ESM package input and standalone installer equality without reading or changing installed state.
