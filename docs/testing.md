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

BootstrapFixtures executes the real frontdoor in native Windows PowerShell with only owned mocked HTTP/source-tree inputs and a marker-only backend. It refreshes malicious ZIP/receipt digests deliberately and requires rejection before backend execution for unexpected executables, incomplete/static substitutions, forged declarations and unbound source trees. It also places an incompatible Security module first in the inherited search path, exercises the actual lifecycle child helper with typed port/host inputs and a nonzero exit, and checks that native builtin/account binding succeeds without changing caller PSModulePath. No service is launched and no live install target is written.

Installer fixtures actually install the built payload into isolated homes, then exercise Check/no-write, offline Verify without extraction, state/config/auth/unknown-neighbor preservation, no-op verification, drift/refusal, account/root/port conflicts, explicit adoption/private backups, forward local fixture updates, explicit unchanged retirement and interrupted-write diagnostics. A partial upgrade is deliberately refused by ordinary Install/Verify; the fixture then follows the documented hash-bound manual code-only recovery, verifies the old version, and performs a new Install/Verify while checking every state canary. A recognizable partial first install still needs explicit adoption. Account and TCP observation are explicitly intercepted: they do not prove actual target-account acceptance or production activation. Derived local forward releases are test data, not GitHub ancestry/trust proof. Nonactivation fixtures forbid runtime provisioning, network, registrar and lifecycle APIs.

For user-run acceptance separately exercise the public frontdoor against real published assets: wrong tag/OID/digest/member/mode/frontdoor must refuse before live writes, and Verify must remain offline/read-only. Run each target operation locally; never substitute a test interception for actual account/ownership proof.

## Live boundaries

Actual installed device-code authentication, model catalog access and upstream forwarding require GitHub/Copilot network access and entitlement. They are separate from injected offline fixtures. An authorized disposable service activation must prove a new owned PID/start/root and authenticated health; an unchanged healthy old process is not activation proof. Production activation requires the installer's exact confirmation and current peer gate. Autostart is a separate explicit registration operation and is not created by install/Verify.

Do not run optional e2e tests against production or inherited credentials merely to validate layout. Follow tests/e2e/README.md only when explicitly authorizing real upstream calls, isolated state and their network/cost effects.
