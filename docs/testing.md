# Verification boundaries

Run source/build/test work only in a disposable authorized checkout. Before imports set synthetic HOME, USERPROFILE, APPDATA, LOCALAPPDATA and temporary directories; clear real GitHub/Copilot/provider/vault credentials and upstream override variables. Use owned ephemeral loopback ports. Do not start the production CLI or canonical service as an offline test. This guide lists commands to run; it is not a recorded PASS.

## Source checks

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run typecheck
bun test tests/integration/default_config_smoke.test.ts tests/integration/default_config_stream_smoke.test.ts tests/integration/lane_routing_smoke.test.ts tests/integration/stream_pipeline_replay.test.ts
bun test tests/integration/source_loopback.test.ts tests/integration/metrics_endpoint.test.ts
bun test tests/scripts/fixture_tools.test.ts tests/transform/ tests/lib/selector.test.ts tests/lib/incident-log.test.ts
bun test tests/integration/thinking_event_translation.test.ts tests/integration/phase16_replay.test.ts tests/integration/m11_custom_rule_e2e.test.ts tests/integration/auth_layer_b.test.ts tests/routes/_shared/
```

Synthetic fixtures establish supported protocol and transformation regression behavior, not captured private-traffic parity. The fixture tools require explicit inputs and SHA binding; reviewing/redacting arbitrary supplied captures remains the operator's responsibility. See [fixtures](fixtures.md).

The existing source-loopback test starts a real `startServer` on port 0 with ConfigSchema and TokenManager; only upstream authentication is injected. It checks actual health identity/readiness and retrieves the metrics response. It neither contacts Copilot nor proves real authorization. Metrics tests cover real text output and auth-state behavior.

## Independent real-server smoke

In addition to tests, run a throwaway program outside the repository after build. Set `PROXY_SOURCE_ROOT` to this source root and `PROXY_SMOKE_ROOT` to a fresh owned fixture directory; both paths and every synthetic profile/temp/cache path must be outside installed/live state. Put this program under your operation WorkRoot and execute it with Bun. The program imports real server/schema/token-manager implementations and injects only the token exchange seam:

```typescript
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
const root = process.env.PROXY_SOURCE_ROOT!;
const scratch = process.env.PROXY_SMOKE_ROOT!;
if (!root || !scratch) throw new Error("Explicit source and fixture roots required");
const { TokenManager } = await import(join(root, "src/auth/token-manager.ts"));
const { startServer } = await import(join(root, "src/server.ts"));
const { ConfigSchema } = await import(join(root, "src/types/config-schema.ts"));
await mkdir(scratch); // refuses a reused fixture
const tokenPath = join(scratch, "synthetic-token");
await writeFile(tokenPath, "synthetic-offline-smoke", { mode: 0o600 });
const manager = new TokenManager({
  githubTokenPath: tokenPath, accountType: "enterprise", vsCodeVersion: "1.95.0",
  fetchCopilotToken: async () => ({ token: "synthetic", refresh_in: 3540,
    expires_at: Math.floor(Date.now() / 1000) + 3600 }),
});
let server;
try {
  await manager.start();
  server = await startServer({ host: "127.0.0.1", port: 0,
    config: ConfigSchema.parse({}), tokenManager: manager });
  const healthResponse = await fetch(server.url + "/health");
  const health = await healthResponse.json();
  if (healthResponse.status !== 200 || health.proxy !== "copilot-proxy" ||
      health.status !== "ok" || health.auth_status !== "ready") throw new Error("health mismatch");
  const metrics = await fetch(server.url + "/metrics");
  const text = await metrics.text();
  if (metrics.status !== 200 || !metrics.headers.get("content-type")?.includes("text/plain") ||
      !text.includes("copilot_proxy_token_status")) throw new Error("metrics mismatch");
  console.log(JSON.stringify({ url: server.url, health, metrics: text }));
} finally { manager.dispose(); await server?.close({ graceMs: 100 }); }
```

Inspect the program's actual output. This is offline synthetic authorization, not a live Copilot authorization receipt. Remove the throwaway program after retaining any requested nonsecret observations; do not commit generated scratch.

## Real package and installer fixtures

Build only after the accepted source commit exists in the selected remote. The builder requires Git, Bun and authenticated GitHub CLI access even for NoRelease, and network access to frozen dependencies. Source publication and building are separate from installation:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/package_release.ps1 -Repo gupta-ash/copilot-api-proxy -NoRelease -OutDir '<fresh-owned-output>'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/package_release.ps1 -ArchiveFixtures
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/package_release.ps1 -RawBlobFixtures
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/package_release.ps1 -BootstrapFixtures
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/package_release.ps1 -PublicationFixtures
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/package_release.ps1 -Archive '<archive.zip>' -ExpectedTag '<exact-tag>' -ExpectedCommit '<full-40-hex-oid>'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/install_bundle.ps1 -Archive '<archive.zip>'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/install_bundle_skip_autostart.ps1 -Archive '<archive.zip>'
```

Keep the ZIP's `.zip.json` receipt and standalone `install.ps1` beside it. Archive/publication fixtures exercise real packager validation and intercepted `gh`, without remote publication. PublicationFixtures specifically uses Windows PowerShell 5.1 native-stderr behavior. Archive validation checks embedded declaration, exact normalized membership, legal/installer closure, SHA/mode/tag/source/checksum bindings and malformed archives.

RawBlobFixtures creates an owned temporary Git repository with committed LF text, a forced CRLF checkout, an executable source mode and nontext binary bytes. It calls the production raw-blob materializer and checks actual output bytes/OIDs/modes, including after the checkout is changed. Fixture Git configuration is command-local; no global settings are changed. This does not build/publish a release.

BootstrapFixtures executes the real frontdoor in native Windows PowerShell with owned intercepted public HTTP/source-tree inputs and a marker-only trust backend; it is not installation/readiness proof. It covers latest-stable exact selection, draft/prerelease refusal, source/archive/standalone admission, changed-frontdoor handoff requiring actual backend/frontdoor hash agreement and unchanged saved bytes, bounded second-handoff refusal, unexpected executables, incomplete/static substitutions, forged declarations and unbound trees. It also checks native module/lifecycle parameter/exit behavior. No proxy/model/auth is launched and no installed target is written.

Installer fixtures apply the real built payload into synthetic homes, then exercise Node environment discovery/invalid-choice refusal, omitted profile/root selections, retained coordinates despite changed environment, Check/no-write, offline Verify with no WorkRoot/extraction, config/auth/state/unknown-neighbor preservation, verified no-op/drift, account/root/port conflicts, exact-byte automatic adoption/private backups, edited/foreign/partial/pre-receipt-metadata refusals, forward updates, explicit unchanged retirement, declined ordinary-running-update consent before writes and interrupted-write diagnostics. Partial upgrades stay drift conflicts until hash-bound manual code-only recovery; tests then verify/reinstall with every state canary intact. Account/TCP observations are explicitly intercepted, not proof of actual-user production acceptance. Derived releases are test data, not ancestry/trust proof.

Separately exercise the saved public frontdoor against actual published assets in an owned **disposable Windows account/profile**, without real credentials or a pre-existing live service. This is the actual no-profile/no-runtime/no-work-root acceptance lane, not spoofed USERPROFILE acceptance: the installer uses the OS account. Follow the commands/scenarios below. Never run this lane against a canonical production proxy.

### Saved-frontdoor end-to-end acceptance

After publication, in that disposable account with Node >=20 on PATH, download once outside install/state roots and retain the initial SHA. Do not set Python/runtime/profile flags:

```powershell
Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/gupta-ash/copilot-api-proxy/releases/latest/download/install.ps1' -OutFile './install.ps1'
$SavedHash = (Get-FileHash -LiteralPath './install.ps1' -Algorithm SHA256).Hash
& ./install.ps1 -Mode Check
if ($LASTEXITCODE) { throw 'Check failed' }
& ./install.ps1
if ($LASTEXITCODE) { throw 'Fresh install failed' }
& ./install.ps1 -Mode Verify
if ($LASTEXITCODE) { throw 'Offline installed verification failed' }
& ./install.ps1
if ($LASTEXITCODE) { throw 'Verified same-version update failed' }
if ((Get-FileHash -LiteralPath './install.ps1' -Algorithm SHA256).Hash -cne $SavedHash) { throw 'Saved frontdoor was overwritten' }
```

Inspect the receipt and exact owned population, default port 4143 and actual Node/account/root. Require a new owned private WorkRoot under actual LOCALAPPDATA, and no stopped-service start, autostart or credential acquisition. Remove only disposable download/extraction inputs after retaining preservation evidence; Verify must still pass offline with HTTP/registrar/Node-launch APIs denied.

For a second accepted descendant stable release with different committed frontdoor bytes, reuse **the unchanged saved script**, add synthetic config/auth/state/log/session/unknown-neighbor canaries, then run `& ./install.ps1 -Mode Check`, `& ./install.ps1`, and `& ./install.ps1 -Mode Verify`. Require the actual newer tag/OID/payload, preserved root/Node/port/canaries, unchanged saved SHA and independent retained verification. Explicit downgrade/divergent-source selection must refuse; never infer ancestry from tag spelling.

For successful Install handoff, do not accept child exit 0 as verification: after the child returns, require the caller's independent retained verifier invocation and actual installed-byte checks. Fault that boundary with missing/changed verifier, wrong retained version/source/archive/root, or managed-file drift left by an otherwise successful child. Require nonzero/no caller completion and unchanged private-state canaries. A selected future receipt may add fields under its own source-bound verifier's schema; the caller must still check required identity and actual admitted payload/verifier SHA values, not impose the older caller's closed schema. Direct current-release receipt schema stays closed. Separate Verify with deliberate InstallRoot/NodeExe/Port conflicts must still refuse rather than silently dropping arguments. In the actual disposable-account lane, install the supported earlier release, run this saved script's `-Mode Verify` without WorkRoot and with downloads unavailable, and require the real retained backend's no-write/no-network checks to pass through the existing owned metadata directory, independent of LOCALAPPDATA parent ownership.

Fresh prerequisite cases: missing/invalid NODE_EXE with PATH unavailable, invalid explicit NodeExe even with valid PATH Node, and Node <20. Each must name the existing-Node prerequisite and leave code/state untouched; no Python or global runtime provisioning. A complete unreceipted old public release must automatically upgrade with private backups and no takeover switch. Edited/missing old code, foreign same-name files, inconsistent marker/root/account/port, links or unreceipted foreign verifier metadata must refuse before writes; there is no override.

Trust faults: wrong tag/OID/archive digest, traversal/case collisions/extra/missing/link members, source/static/standalone substitution despite refreshed mutable checksums, and a second frontdoor mismatch after the verified hop. Require no backend mutation or recursive fallback. Under an **owned disposable** running proxy, ordinary update must offer the existing exact component/version/PID/root/peers confirmation; decline/noninteractive input/new peers must fail before stop/write. Only confirmed activation may call owned stop/start operators; preserve the no-rollback registrar variant. Interrupted application/verification/activation must return nonzero with exact possible effects/private evidence, never print completion or roll back state.

## Live boundaries

Actual installed device-code authentication, model catalog access and upstream forwarding require GitHub/Copilot network access and entitlement. They are separate from injected offline fixtures. An authorized disposable service activation must prove a new owned PID/start/root and authenticated health; an unchanged healthy old process is not activation proof. Production activation requires the installer's exact confirmation and current peer gate. Autostart is a separate explicit registration operation and is not created by install/Verify.

Do not run optional e2e tests against production or inherited credentials merely to validate layout. Follow tests/e2e/README.md only when explicitly authorizing real upstream calls, isolated state and their network/cost effects.
