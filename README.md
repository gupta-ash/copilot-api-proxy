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

Choose an **exact published release tag** from [Releases](https://github.com/gupta-ash/copilot-api-proxy/releases). Service tags are committed source prefixes, not `latest` or semantic-version ordering. Download that release's standalone committed `install.ps1`; do not pipe remote content into `iex`.

```powershell
$Tag = '<exact-release-tag>'
$Work = Join-Path $env:LOCALAPPDATA 'copilot-proxy-install\operation-001'
New-Item -ItemType Directory -Path $Work -ErrorAction Stop | Out-Null
$Installer = Join-Path $Work 'install.ps1'
Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/gupta-ash/copilot-api-proxy/releases/download/$Tag/install.ps1" -OutFile $Installer
$Node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $Installer -Version $Tag -WorkRoot $Work -NodeExe $Node -Mode Check
if ($LASTEXITCODE) { throw 'Check refused; inspect the named prerequisite.' }
& $Installer -Version $Tag -WorkRoot $Work -NodeExe $Node -Mode Install
if ($LASTEXITCODE) { throw 'Install failed; preserve the reported diagnostics/backups.' }
# Separate, offline, read-only invocation. No download/extraction/source is needed.
& $Installer -Version $Tag -WorkRoot $Work -Mode Verify
```

`-UserRoot` defaults to the actual invoking profile and cannot select another account. `-InstallRoot` defaults to a retained installation receipt, then the existing same-user `~/.local/share/copilot-proxy/install-dir.txt`, otherwise `~/.agents/services/copilot-proxy`. A conflicting existing root refuses; root relocation is not an upgrade. `-Port` defaults to 4143 on a fresh install and retains existing coordinates when omitted. `-NodeExe` likewise reuses the recorded executable. Supplied conflicting coordinates refuse. WorkRoot must already exist, be local/absolute/owned, and not overlap source, install, metadata or state roots. Child downloads, extraction, temporary files and caches stay there.

The frontdoor dereferences annotated tags and binds repository, full commit, archive checksum, exact normalized ZIP member hashes/modes, release declaration and its own committed script bytes before executing the backend. A different frontdoor must be explicitly downloaded from the selected release; no silent self-replacement occurs. Upgrades must descend from the retained installed source; no implicit downgrade/retry occurs.

For the first takeover of a recognizable existing installation **without** a new receipt, add `-AdoptExisting` to Check and Install. Adoption is explicit, same-user and same-root; every overwritten owned file is privately backed up under WorkRoot. It cannot adopt an arbitrary foreign directory. Unknown neighbors remain untouched. Local edits to immutable owned code are conflicts, not permission to overwrite them. Obsolete files are removed only when explicitly declared retired, previously owned and still equal to their old installed hash. Private preservation paths are printed and retained: never treat them as disposable download cache.

Receipts and the self-contained verifier/input closure live at `~/.agents/installations/copilot-api-proxy/`. Verify checks actual owned files against retained package bindings and the expected version; it does not repair, download, query registrars, launch a process or prove live authentication. A matching `VERSION.txt` alone is never success. Same-version Install is a true no-op only after actual owned-file verification. Partial failures retain private diagnostics and report possible effects; individual writes are atomic, the entire installation is not.

A partial overlay deliberately remains a drift conflict; blind retry is not recovery. The failure prints exact private backup/inventory/candidate/effects paths. Follow [manual code-only recovery](docs/deployment.md#manual-code-only-recovery-after-a-partial-install): an authorized operator restores only prior-owned immutable files from verified backups when current bytes are old or this operation's verified candidate, removes only newly created unchanged candidate files, preserves all state/unknown files, verifies the old version, then reruns the reviewed upgrade. No automatic rollback/resume or arbitrary drift waiver exists. A recognizable partial first installation still requires explicit adoption if completing takeover without a successful receipt.

## Authentication and activation are separate

Private APP_DIR remains `~/.local/share/copilot-proxy`. Preserve its `github_token`, `config.yaml`, traces, logs and other state. No token is accepted on the installer command line, copied from build output, logged or recorded as an authentication-success receipt.

Authenticate interactively as the actual user, using the installed Node application:

```powershell
$Root = Join-Path $env:USERPROFILE '.agents\services\copilot-proxy' # use your retained root
& $Node (Join-Path $Root 'dist\main.js') --list-models
```

Follow the **displayed GitHub verification URL and device code**. The resulting token stays only in private APP_DIR. Normal first startup also performs that flow when no token exists. There is no separate `login` command. Choose a model ID actually returned by this catalog; access depends on your GitHub Copilot entitlement and current upstream availability.

Installation defaults never stop/start a service or alter autostart. If code must change while an owned proxy is running, Install refuses before live mutation unless `-Activate` is selected. Re-run the exact selected-release command with `-Activate` and type the displayed complete confirmation binding component/version/current PID/root/live peer count. Existing peers are displayed; interrupting them requires that explicit consent and an immediate identity/peer recheck. Only the owned stop operator is called, its exit must succeed, then the installed start operator runs with `-BindHost 127.0.0.1 -Port <retained-port>`. A pre-existing no-rollback registrar variant is preserved. No mass port-based kill or automatic code/database rollback occurs.

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
