# copilot-api-proxy

A configurable local HTTP gateway for GitHub Copilot, built with TypeScript, Bun and Hono. The runtime package and command remain **`copilot-proxy`**. This repository is `gupta-ash/copilot-api-proxy`; repository renaming does not relocate existing state. It is not an MCP server.

## What it serves

| Endpoint family | Default inbound paths | Purpose |
|---|---|---|
| Anthropic Messages | `/v1/messages` | Native Messages and configured cross-protocol translation |
| OpenAI Responses | `/responses`, `/v1/responses` | Responses clients and configured translation |
| OpenAI Chat Completions | `/chat/completions`, `/v1/chat/completions` | Chat clients |
| Embeddings | `/embeddings`, `/v1/embeddings` | Embedding requests |
| Models | `/models`, `/v1/models` | Upstream model catalog |

Routing, model matching and ordered request/body/header/stream transformations come from YAML configuration. The shipped seed contains five routing lanes; existing configuration is **never overwritten** on upgrade. Translation has protocol-specific limitations and is not a promise that every upstream model supports every client feature. `/health` reports proxy/auth state; `/metrics` serves text metrics; `/admin/logging` controls capture logging. The admin surface is not protected by the normal auth gate: keep the listener on loopback.

## Windows installation and upgrade

The scripted installer supports Windows PowerShell **5.1+**, the actual invoking user's profile, and an **already installed Node >=20**. It does not install Node/Bun/Python, register autostart, enable hooks, start a harness, migrate service roots or acquire credentials. Public downloads require HTTPS GitHub access, not private repository access or a GitHub token. Source development additionally requires Bun and Git.

Release bundles retain all frozen production packages and their licenses, but omit unused package-manager `node_modules/.bin` launchers. Operators run the selected existing Node executable directly. The backend supports omitted switches under StrictMode, native .NET atomic replacement, and quoted local YAML paths on Windows PowerShell 5.1.

Download the standalone frontdoor once from the [latest stable release](https://github.com/gupta-ash/copilot-api-proxy/releases/latest), save and inspect it, then run it locally. Do not pipe remote content into `iex`:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/gupta-ash/copilot-api-proxy/releases/latest/download/install.ps1' -OutFile './install.ps1'
& ./install.ps1
```

**The same ordinary command installs or updates to the latest stable published release.** It resolves an exact tag/full commit before use, excludes drafts/prereleases from default selection, and refuses downgrade/divergent source. No profile, runtime or work-directory argument is required. Node is discovered from optional `-NodeExe`, then a retained selection on upgrade, then `NODE_EXE`, then `node.exe`/`node` on PATH. Invalid explicit/environment choices refuse; no runtime is provisioned and Python is not a prerequisite.

The actual invoking OS profile is automatic and cannot be overridden. The code root comes from a retained receipt, then the same-user `~/.local/share/copilot-proxy/install-dir.txt`, otherwise `~/.agents/services/copilot-proxy`. Existing Node/root/port selections are retained; conflicting supplied coordinates refuse. Fresh port is 4143. Each network operation gets a new owned private directory under the actual user's LOCALAPPDATA, outside source, harness, code, metadata and state roots. Downloads, extraction, temporary files and caches stay there. The exact retained preservation location is printed; never purge backups as disposable cache.

Advanced controls remain optional:

```powershell
& ./install.ps1 -Mode Check                  # latest stable, full preflight, no live writes
& ./install.ps1 -Version '<exact-release-tag>' # pin an exact release, not a branch or "latest"
& ./install.ps1 -Mode Verify                 # retained version, offline/read-only, no WorkRoot needed
# Verify a particular expected version without downloading it:
& ./install.ps1 -Mode Verify -Version '<expected-installed-tag>'
```

`-WorkRoot` can select an existing local, absolute, current-user-owned nonoverlapping operation directory. `-InstallRoot`, `-NodeExe` and `-Port` are deliberate coordinate overrides, not required setup. Root/state relocation is not an upgrade.

The frontdoor binds public repository, dereferenced full commit, committed declaration/static Git blobs, archive checksum and exact normalized member hashes/modes before executing downloaded code. If a later release has a different committed frontdoor, the saved script admits its complete release first and invokes that verified script once with the same resolved operation selections. It never overwrites the saved/running script, relies on checksum-only authority or recurses on another mismatch. Run the saved script outside installed code/metadata. Offline Verify directly runs the hash-bound retained verifier without network or scratch creation; it does not depend on profile-wide LOCALAPPDATA ownership or an older frontdoor's WorkRoot checks.

A recognizable unreceipted installation is adopted automatically **only** when its exact VERSION/source identity resolves to an available public release and every prior owned immutable file still matches that fully verified release. Every overwritten owned file is privately backed up. Arbitrary foreign directories, missing/edited code, conflicting roots and unowned same-name files refuse; there is no adoption override. Unknown neighbors and private state remain untouched. Retirement still requires an explicit committed retired path and unchanged prior-owned bytes.

Receipts and the self-contained verifier/input closure live at `~/.agents/installations/copilot-api-proxy/`. Every normal Install, including same-version no-op and successful selected-frontdoor handoff, independently binds and runs that retained verifier before the caller reports completion. Separate Verify checks actual package-bound owned files and retained coordinates; it does not repair, download, query registrars, launch Node or prove live authentication. A matching `VERSION.txt` alone is never success. Partial failures retain private diagnostics and report possible effects; individual writes are atomic, the entire installation is not.

A partial overlay deliberately remains a drift conflict; blind retry is not recovery. The failure prints exact private backup/inventory/candidate/effects paths. Follow [manual code-only recovery](docs/deployment.md#manual-code-only-recovery-after-a-partial-install): restore only prior-owned immutable files from verified backups when current bytes are old or this operation's verified candidate, remove only newly created unchanged candidate files, preserve state/unknown files, verify the old version, then rerun the reviewed upgrade. No automatic rollback/resume or drift waiver exists. Partial first installs without complete exact-release bytes, or pre-receipt retained verifier metadata, refuse adoption and require the documented evidence-bound manual disposition.

## Authentication and activation are separate

Private APP_DIR remains `~/.local/share/copilot-proxy`. Preserve its `github_token`, `config.yaml`, traces, logs and other state. No token is accepted on the installer command line, copied from build output, logged or recorded as an authentication-success receipt.

Authenticate interactively as the actual user, using the installed Node application:

```powershell
$Receipt = Get-Content -LiteralPath (Join-Path $env:USERPROFILE '.agents/installations/copilot-api-proxy/installed.json') -Raw | ConvertFrom-Json
$Root = $Receipt.parameters.InstallRoot
$Node = $Receipt.parameters.NodeExe
& $Node (Join-Path $Root 'dist\main.js') --list-models
```

Follow the **displayed GitHub verification URL and device code**. The resulting token stays only in private APP_DIR. Normal first startup also performs that flow when no token exists. There is no separate `login` command. Choose a model ID actually returned by this catalog; access depends on your GitHub Copilot entitlement and current upstream availability.

Installation never starts a stopped service or alters autostart by default. If an owned running proxy needs changed code, the ordinary local command offers the existing **exact interactive activation confirmation** before any stop/live write. Declining or noninteractive invocation refuses. You can instead stop the owned proxy explicitly first, or select `-Activate` for a deliberate restart/start. Confirmation binds component/version/current PID/root/live peer count; peers are displayed and rechecked. Only the owned stop operator is called, its exit must succeed, then the installed start operator runs with `-BindHost 127.0.0.1 -Port <retained-port>`. A pre-existing no-rollback registrar variant is preserved. No unattended restart, mass port kill or automatic code/database rollback occurs.

For a stopped installation you can explicitly start it separately:

```powershell
& (Join-Path $Root 'scripts\start_proxy.ps1') -Port 4143 -BindHost 127.0.0.1
# Use the retained port and start_proxy_no_rollback.ps1 instead when that is your chosen registrar variant.
& (Join-Path $Root 'scripts\status_proxy.ps1')
& (Join-Path $Root 'scripts\stop_proxy.ps1')
```

Autostart is **optional**, never created by this installer. Existing explicit NSSM registration remains `scripts/install_service.ps1`; inspect its parameters and invoke it separately only after reviewing the intended account/root/launcher. Do not register a second competing task/service. On Windows, the standalone stop operator cannot guarantee graceful request drain; use the documented service lifecycle when that is required. Installed bytes, a healthy old listener and new-process activation are distinct facts. Activation/auth failure is reported separately and does not roll back private state.

After the existing start operator's listener wait, the installer performs one health observation, without implicit readiness retries. If the new owned PID/root exists but auth is not yet ready, installed bytes remain successful and the operation reports **activation/auth readiness pending** with a nonzero result. Finish the interactive device-code/catalog flow and inspect status before claiming readiness; no code/state rollback is attempted.

## Client routing

The installer does not overwrite client or model settings. Use a user-selected catalog model and the endpoint matching the client protocol:

- **Claude Code / Anthropic clients:** set the Anthropic origin to `http://127.0.0.1:4143`; the client sends `/v1/messages`. Select an available model through that client's supported model setting. Follow its supported local-provider authentication convention; a placeholder client credential is not Copilot authorization.
- **Codex:** configure a model provider with `base_url = "http://127.0.0.1:4143"` and `wire_api = "responses"`, then select it and a catalog model. Do not append `/v1` to the origin merely to imitate a different OpenAI provider.
- **OMP:** configure a provider in `models.yml` using `baseUrl: http://127.0.0.1:4143` and the matching supported API (for example `openai-responses` for a Responses model, or `anthropic-messages` for a Messages model). Use the schema/capabilities supported by your installed OMP release; this package neither installs nor upgrades OMP.

Replace 4143 with your retained chosen port. Catalog/health calls contact the running proxy; real forwarding additionally uses GitHub/Copilot network/auth. Offline fixture tests are not proof of live entitlement.

## Source, tests and removal

- [Architecture and state](docs/architecture.md)
- [Design invariants](docs/design.md)
- [Implementation and prerequisites](docs/implementation.md)
- [Build/package/manual release contract](docs/deployment.md)
- [Verification commands and boundaries](docs/testing.md)
- [Synthetic fixture policy](docs/fixtures.md)

Portable TypeScript source and shell operators are included where supported. The scripted installer is Windows-only; Linux/macOS harness installers are not claimed tested.

For owned-file uninstall: stop only the owned instance, separately remove only the explicitly registered autostart you chose, read `installed.json`, verify each listed immutable file still matches its recorded hash, and remove only those exact owned files. Preserve modified files, unknown neighbors, private APP_DIR, logs, sessions and recovery backups. Remove product installation metadata only after retaining any needed audit/recovery record. No recursive service/home mirror deletion or automatic credential/database removal is provided.

## License

First-party code is MIT. Code adapted from `xianml/copilot-api-pro` and transform interfaces derived from `musistudio/claude-code-router` retain attribution. See [LICENSE](LICENSE), [NOTICE](NOTICE) and file headers. Release dependency licenses remain with their packages; public publication requires the separate redistribution/privacy review.
