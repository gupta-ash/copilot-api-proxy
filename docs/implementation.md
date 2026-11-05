# Implementation

## Source map

- `src/main.ts`: CLI/environment/bootstrap and signal lifecycle.
- `src/server.ts`: buildApp/startServer, endpoint factories, health/metrics and closing.
- `src/auth/token-manager.ts`: auth lifecycle and injected exchange seam.
- `src/lib/{config,paths}.ts`: configuration, private APP_DIR and persistent paths.
- `src/lib/transform/`: rule registry/engine and generated barrel.
- `src/routes/`, `src/services/`, `src/types/`: protocol dispatch, upstream APIs and schemas.
- `deploy/`: single authored operator copies, release declaration and local installer.
- `scripts/`: build/package/developer tools. Operator exports deliberately remain `scripts/<basename>` in releases.
- `tests/`: synthetic unit/protocol/integration cases and package/install fixtures; never exported as runtime data.

Use the existing TypeScript `~/` alias and import style. Bun owns source dependency installation/build/tests; Node >=20 runs the prebuilt `dist/main.js`. Keep dependency declarations and frozen bun.lock together; targets never run generators or source TypeScript.

```powershell
bun install --frozen-lockfile --ignore-scripts
bun run build
bun run typecheck
```

prebuild invokes `scripts/gen_version.ts` and `scripts/gen_barrel.ts`; tsdown creates the distribution. `bun run dev` and `bun run start` launch the real source application, read/write the user's private APP_DIR and can contact GitHub. They are not credential-free smoke checks. Use isolated HOME/USERPROFILE/APPDATA/LOCALAPPDATA/temp and injected upstream/auth for offline tests.

`scripts/package_release.ps1` packages a literal committed public-source revision. `deploy/release-files.json` explicitly maps source inputs to bundle destinations and names explicit obsolete file retirements. root `install.ps1` performs exact public release download/trust checks; `scripts/install_bundle.ps1` is the nonactivating backend entrypoint, sharing owned-file application/offline verification with `scripts/install_local.ps1`. Retained metadata/verifier closure is independent of extraction and source. No installation path requires fleet/staging modules, a source checkout, a developer project path or another host.

Portable source/shell operators retain their existing boundaries; the new scripted install platform is Windows PowerShell 5.1+. See [testing](testing.md), [deployment](deployment.md) and [fixture policy](fixtures.md).
