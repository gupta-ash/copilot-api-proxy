# Versioned local deployment

The public repository is [`gupta-ash/copilot-api-proxy`](https://github.com/gupta-ash/copilot-api-proxy). The runtime, npm package name and command remain `copilot-proxy`.

Installation is a current-user local operation on Windows PowerShell 5.1 or later. Run the saved `install.ps1` without options to install/update the latest stable published release; it resolves and binds the exact tag/full commit before applying anything. No deployment controller, staging/source checkout, profile choice or runtime/work-directory matrix is required.

## Release assets and trust

Each release publishes these three assets together:

- `copilot-proxy-<tag>.zip`: the built application, production dependencies and installer closure.
- `copilot-proxy-<tag>.zip.json`: the package receipt.
- `install.ps1`: the standalone installer copied from the same committed source as the ZIP's root `install.ps1`.

The receipt uses `schema_version: 1` and `component: "copilot-proxy"`. It binds `source_repository`, the full 40-character `source_commit`, exact `tag` and `version`, `asset`, `asset_sha256`, and `declaration_sha256`. Its `payload` contains the exact case-sensitive normalized file list, with `path`, lowercase SHA-256 `sha256`, and regular-file `mode` (`100644` or `100755`) for each entry. These modes are also encoded in ZIP entry attributes. `built_utc` is receipt metadata, not an installed version marker.

The installer checks this binding before invoking the packaged backend, including standalone/archive/committed frontdoor equality. A checksum receipt is not a digital signature or source authority: the initial script must come from the public repository identity you trust. Save and inspect it; never pipe it into `Invoke-Expression`. When a selected later release changes the committed frontdoor, the saved script validates the complete source/asset/member closure first, then invokes that verified script once with the exact resolved tag and same selections. It does not overwrite the saved/running script, bypass a mismatch or recurse on another mismatch.

Before extraction or backend execution, the frontdoor also binds the selected commit's nontruncated Git tree and committed release declaration. Every static member, including both installer backends and all operators, must match its declared committed Git blob and projected mode. Only the bounded generated ESM/map output and receipt-bound production dependency tree are admitted outside that static closure. Windows builtin modules are imported from the invoking PowerShell's own installation, not an inherited different-edition module search path; lifecycle children use native Windows PowerShell with a child-only native module path. Caller profiles and global module-path settings are unchanged.

## Ordinary installation and update

Prerequisites are Windows PowerShell 5.1+, HTTPS public GitHub access and an existing Node >=20. No Python or authenticated/private repository access is needed. Node selection is optional explicit `-NodeExe`, retained Node on upgrade, `NODE_EXE`, then PATH `node.exe`/`node`; an invalid selected executable refuses instead of falling back or provisioning a runtime.

Download the component frontdoor once into a directory outside installed code/metadata, inspect it, then use the same local command for fresh installation and later updates:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/gupta-ash/copilot-api-proxy/releases/latest/download/install.ps1' -OutFile './install.ps1'
& ./install.ps1
if ($LASTEXITCODE -ne 0) { throw 'Install/update refused or failed; retain its named diagnostics.' }
```

The actual invoking OS profile is automatic; it cannot be selected on the public command line. WorkRoot defaults to a fresh owned, privately ACLed operation directory under that user's actual LOCALAPPDATA. Its exact path and retained private backups are printed. Child downloads/extraction/temp/cache stay there. Optional `-WorkRoot` must already exist, be local/absolute/owned and not overlap source, harness, install or state roots. Preservation is not disposable download cache.

## Optional check and exact-version controls

```powershell
& ./install.ps1 -Mode Check                    # latest stable, no live target writes
& ./install.ps1 -Version '<exact-tag>' -Mode Check
& ./install.ps1 -Version '<exact-tag>'          # same installation/update path, exact tag pinned
```

Service tags retain the source builder's abbreviated commit identity, not semantic-version ordering. Explicit Version must be an exact published tag, never a branch or literal `latest`. Default release selection excludes drafts/prereleases. Upgrades, including unreceipted adoption, must descend from the actual prior source OID.

`Check` downloads and validates the selected assets in `WorkRoot` and checks the local target. It does not install code, activate the proxy, rewrite application state or change autostart registration. Inspect the downloaded receipt's repository, tag and full source commit, and confirm the selected local target before installation. A successful check is not proof that the selected version is running.

## Installation ownership and explicit activation

The code root is selected from the retained receipt, then the existing same-user `~/.local/share/copilot-proxy/install-dir.txt`, otherwise `~/.agents/services/copilot-proxy`. Optional `-InstallRoot` selects a fresh dedicated code root, never relocates an existing installation. Retained Node/root/port selections win when omitted; supplied conflicting coordinates refuse.

An unreceipted recognizable installation is adopted automatically only after its exact VERSION/source marker resolves to an available fully admitted public release, and every prior immutable owned file matches that release. Overwritten owned files are privately backed up. Missing/edited/foreign files, incomplete installations and pre-receipt retained verifier metadata refuse; there is no adoption override or blind partial-install retry. Unknown neighbors and private state remain untouched; removed old files still need explicit retirement and unchanged old hashes.

The application state directory remains `~/.local/share/copilot-proxy`: authentication, configuration, logs and traces are local state, not release inputs. The installer preserves existing configuration and the selected port; a fresh installation defaults to loopback port 4143. Existing autostart registration is left untouched.

Installing and running those files are separate outcomes. A stopped installation never starts by default. When changed code is required under an owned running process, ordinary Install offers the existing exact interactive activation confirmation before its first stop/live write; decline/noninteractive input refuses. Alternatively stop only the owned proxy explicitly first, or select deliberate activation/start:

```powershell
& ./install.ps1 -Activate
if ($LASTEXITCODE -ne 0) { throw 'Install or activation did not complete; preserve the named evidence.' }
```

Review and enter the exact confirmation string presented by the installer. It binds the component, selected version, observed process identity, installation root and live peer count. Do not automate this prompt or treat `-Activate` alone as restart approval. The installer preserves the discovered launcher variant, including a no-rollback variant, rather than silently changing the existing startup policy.

The root frontdoor forwards explicit `-Activate` to the backend's separately confirmed stop/start path; `NoStop`/`NoStart` suppress implicit lifecycle actions only. The start operator already waits for its listener. The installation then makes one authenticated-health observation; it does not add a readiness retry loop. A new owned PID/root with authentication still starting is reported as **activation/auth readiness pending**, separately from successfully installed bytes. Inspect status and finish the interactive installed device-code/catalog flow before claiming live readiness. A pending observation never authorizes automatic code/state rollback.

## Verify installed files offline

```powershell
& ./install.ps1 -Mode Verify
# An optional expected-version mismatch fails without any download:
& ./install.ps1 -Mode Verify -Version '<expected-installed-tag>'
if ($LASTEXITCODE -ne 0) { throw 'Installed verification failed.' }
```

Every normal Install, including a verified same-version no-op, invokes the independent retained installed verifier before reporting completion. After successful selected-frontdoor handoff, the caller binds required component/repository/version/source/archive/account/root identities and the actual installed payload/verifier SHA values to its admitted release; that verified selected retained verifier, not the older caller, enforces the selected receipt's closed schema. Direct current-release installation retains its closed receipt/schema checks. Separate Verify uses the retained version when omitted and directly invokes its hash-bound retained verifier. When WorkRoot is omitted it supplies the existing owned retained metadata directory internally; Verify returns before work/temp/network processing, creates nothing, and makes no assumption about ownership of the profile-wide LOCALAPPDATA parent. It never fetches releases, launches Node, repairs files or queries/changes registrars. Actual package-bound files and retained account/root/port/config prerequisites are checked; activation/authentication remain separate outcomes.

The installer retains its public receipt and frontdoor/verifier closure under `~/.agents/installations/copilot-api-proxy`. The installed ownership receipt identifies the public component as `copilot-api-proxy`; this is distinct from the package receipt's unchanged runtime component `copilot-proxy`. Keep the retained closure with the installation so subsequent offline verification uses the accepted installer rather than an arbitrary checkout.

Do not invoke `scripts/install_bundle.ps1` directly as a substitute for these checks. It is the packaged backend called only after the root installer accepts the selected release and local ownership.

Optional activation may be omitted under PowerShell StrictMode; omission is false, not a missing-property error. Offline Verify recovers omitted install-root and Node coordinates from its retained receipt rather than requiring repeated arguments. Supplied identity/root/runtime/port conflicts are forwarded intact to the retained verifier, never silently discarded.

Retained code-change timestamps are serialized in UTC with a `Z` suffix. They verify on both Windows PowerShell 5.1 (JSON strings) and PowerShell 7 (JSON `DateTime` values). Typed dates must retain `Kind=Utc`; local/unspecified dates refuse even when the host happens to use UTC. The verifier never reparses a date's culture-dependent display text.

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

Those commands only inspect evidence; they do not execute recovery. Do not convert an unreviewed entire inventory into a copy loop. A partial first installation has no prior successful receipt/version to restore or verify. Preserve state and audit its exact effects; remove only newly created unchanged immutable candidate files under the rules above if returning to an empty code root. Adoption never completes incomplete or edited candidate bytes merely because they look recognizable: the complete verified exact-release prior population is required.

If the failure occurred after writing retained inputs but before `installed.json`, the exact files `~/.agents/installations/copilot-api-proxy/{install.ps1,install_local.ps1,package-receipt.json}` intentionally block another install as foreign/pre-receipt metadata. They are not permission to repair or delete the metadata directory. An authorized manual disposition may remove each **individual** such file only when this operation's retained candidate inventory records that absolute path with `existed_before: false`, its current SHA still equals that candidate SHA, its candidate bytes match the source-bound selected release (the package receipt itself must still match the preserved admitted receipt), and recorded partial effects bind its creation to this operation. Preserve the operation evidence/backups first and recheck path/account/hash immediately before each removal. If a file existed before, differs, is linked, or lacks this evidence, hold it for separate reviewed disposition; do not delete, overwrite or claim it. Never fabricate `installed.json`, clear the entire metadata namespace, restore private APP_DIR state, remove install-dir.txt or use candidate-looking bytes as admission. Once only those proven new immutable leftovers have been removed, ordinary Check/Install may proceed only if the remaining code is empty or a complete exact known-byte release. There is no automatic repair/resume or metadata bypass.

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
