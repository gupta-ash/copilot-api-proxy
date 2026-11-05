# Engineering

Read README.md and docs/{architecture,design,implementation}.md before changing this component. Use docs/testing.md and docs/deployment.md for validation/release boundaries. Author in an authorized non-live source checkout/worktree; never patch installed services or use release extraction as a development checkout.

Preserve runtime/npm/bin identity `copilot-proxy`, protocol routes, transformation policy, authentication/private APP_DIR semantics, source tests, frozen lock and legal attribution. Source deploy/ operators export to installed scripts/ paths; their one-level parent-root derivation is intentional. The public repository/download identity is gupta-ash/copilot-api-proxy.

A source task does not authorize publishing, installing dependencies, accessing credentials, changing autostart, enabling hooks, restarting a shared service or contacting another host. Versioned installation is a user-run local operation. Check is a full preflight; Install repeats it; separate Verify is read-only/offline against retained installed metadata. No central agent, staging checkout or source checkout is an installation prerequisite. Missing prerequisites refuse rather than provisioning global runtimes.

Proxy activation is separately selected and exactly confirmed against component/version/PID/root/live peers. Preserve existing registrar variants and latest private state. No automatic code/database rollback after activation failure, no stale state restoration and no mass port-based kill.

Public fixtures must be synthetic protocol cases, not regex-redacted private conversations. Preserve upstream copyright/license notices, and keep auth tokens, captures, traces, histories, environments and real state out of source/releases.
