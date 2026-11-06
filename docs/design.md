# Design contracts

## Routing and authentication

Configuration selects endpoint paths, models and ordered transformation rules. The public packaging cutover does not change those rules. ConfigManager validates YAML and retains last-known-good ordinary reload behavior; invalid redirect/consumer combinations hard-fail bootstrap. Missing configuration uses schema defaults, not the shipped routing seed. The seed is used only when private APP_DIR/config.yaml is absent.

TokenManager owns asynchronous starting/ready/failed state. Its injected token-exchange seam permits offline source tests without pretending to authenticate a real user. Device-code authentication remains interactive in the installed application; tokens are not installer inputs or release files. A health HTTP 200 alone does not establish authentication, version or process/root affinity.

## Release trust and ownership

The existing builder binds its own committed clean HEAD, confirms the exact full commit exists in the selected public GitHub repository, builds a fresh independent literal checkout, and installs frozen production dependencies without scripts. NoRelease still needs authenticated GitHub source-read access but does not publish. Explicit release publication separately checks and dereferences tags, preserves prerelease holds, uploads ZIP/receipt/committed frontdoor and reads back publication identity.

The local frontdoor defaults to the latest stable published release and resolves its exact tag/full OID, with optional exact Version override. A saved script with different bytes validates the selected committed source and complete archive/asset closure before a single verified frontdoor handoff; it never self-overwrites or recursively bypasses another mismatch. ZIP members are canonical regular uniquely named files (including case), exactly SHA/mode-bound to the receipt. An optional owned WorkRoot otherwise defaults to fresh private current-user LOCALAPPDATA scratch. Verify uses retained verified closure with no downloads, application launches, repairs or registrar effects.

Installation owns only receipt-listed immutable files within declared product roots. Unknown neighbors/private APP_DIR remain outside ownership. Explicit prior hashes plus committed retirement are required for deletion. Modified owned code conflicts. First takeover is automatic only for a complete exact known-byte public release, with private preservation of overwritten owned files; no flag bypasses drift/foreign/partial refusals. A version marker is never a no-op shortcut. Check and Install preflight the whole selected set before their first live write; file replacement is atomic, the entire operation is not. Normal Install, including a successful selected-frontdoor handoff, independently binds and verifies its retained installed closure before the caller reports completion.

## Activation and failure

Code changes under an owned running proxy offer the existing exact interactive confirmation binding version/PID/root/live peers; declined/noninteractive consent refuses before writes. Explicit Activate also selects deliberate startup for a stopped target. Identity/peers are rechecked and only owned stop/start operators run; no-rollback registrar variants remain preserved. Ordinary installation never starts a stopped service, creates autostart or enables hooks. State/registrars are never migrated.

Installed bytes, activated code and authorized upstream requests are separate outcomes. Receipts describe immutable installed bytes and a code-change timestamp, not activation. Failures retain private diagnostics/backups; no automatic code/state rollback, stale database restoration or second competing registrar is introduced.
