# Design contracts

## Routing and authentication

Configuration selects endpoint paths, models and ordered transformation rules. The public packaging cutover does not change those rules. ConfigManager validates YAML and retains last-known-good ordinary reload behavior; invalid redirect/consumer combinations hard-fail bootstrap. Missing configuration uses schema defaults, not the shipped routing seed. The seed is used only when private APP_DIR/config.yaml is absent.

TokenManager owns asynchronous starting/ready/failed state. Its injected token-exchange seam permits offline source tests without pretending to authenticate a real user. Device-code authentication remains interactive in the installed application; tokens are not installer inputs or release files. A health HTTP 200 alone does not establish authentication, version or process/root affinity.

## Release trust and ownership

The existing builder binds its own committed clean HEAD, confirms the exact full commit exists in the selected public GitHub repository, builds a fresh independent literal checkout, and installs frozen production dependencies without scripts. NoRelease still needs authenticated GitHub source-read access but does not publish. Explicit release publication separately checks and dereferences tags, preserves prerelease holds, uploads ZIP/receipt/committed frontdoor and reads back publication identity.

The local frontdoor requires an exact tag and matches the selected release's script bytes. ZIP members must be canonical, regular, uniquely named (including case), and exactly bound by SHA/mode to the receipt. Download/extraction/temp/cache stay under a local owned WorkRoot. Verify instead uses retained verified input closure and never downloads, launches the application, repairs files or touches registrars.

Installation owns only receipt-listed immutable files within declared product roots. Unknown neighbors/private APP_DIR remain outside ownership. An explicit prior hash plus explicit new retirement declaration is required for deletion. Modified owned code is a conflict. First takeover requires AdoptExisting and private file preservation. A version marker is not a no-op shortcut. Check and Install preflight the complete change before their first live write; individual file replacement is atomic, but the operation is not a whole-tree transaction.

## Activation and failure

Code changes under a running proxy require Activate and exact local confirmation binding version/PID/root/live peers. Identity and peers are rechecked. Only the installed owned stop/start operators are used; a pre-existing no-rollback registrar variant is preserved. Default installation creates no autostart, stops/starts nothing and enables no hook. Existing state/registrars are not migrated.

Installed bytes, activated code and authorized upstream requests are separate outcomes. Receipts describe immutable installed bytes and a code-change timestamp, not activation. Failures retain private diagnostics/backups; no automatic code/state rollback, stale database restoration or second competing registrar is introduced.
