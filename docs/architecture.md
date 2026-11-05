# Architecture

`src/main.ts` owns CLI/environment bootstrap, configuration, token initialization, listening and signal shutdown. `src/server.ts` exposes `buildApp(config, tokenManager, traceWriter?)` and `startServer(options)`. The latter returns the actual listener port and `close({graceMs})`; the owner must also dispose authentication.

Five endpoint families dispatch through `src/routes/` to `src/services/copilot/`. Shared middleware applies auth, metrics and optional trace handling. `src/types/` defines protocol/config schemas; `src/lib/transform/` defines ordered body/header/response/event rules. Generated registry imports bind YAML rule names to implementation, so generators and schema validation remain part of the build rather than target-time work.

Native lanes preserve their protocol, while cross-protocol lanes run explicit request and streaming-event translators. SSE fixtures check supported wire behavior; they cannot establish parity for unobserved upstream behavior. `/health` identifies the proxy and auth state; `/metrics` serves real text metrics; `/admin/logging` is not protected by the normal token gate. Loopback exposure is intentional.

`src/lib/paths.ts` derives private APP_DIR from `os.homedir()/.local/share/copilot-proxy`. Long-lived GitHub auth, config, logs/traces and sidecars remain there; Copilot access tokens stay in memory. Launcher PID/meta/lock and stdout/stderr logs remain under the selected service root's logs/. Existing custom path semantics are unchanged.

The Windows installer defaults fresh code to `~/.agents/services/copilot-proxy`, preserves a recorded same-user root, and refuses relocation. A release contains built dist/, frozen production dependencies, explicitly mapped operators/static inputs, legal files, root frontdoor and committed declaration. Neither source fixtures nor private state belongs in a release. Retained verifier metadata is separately rooted at `~/.agents/installations/copilot-api-proxy`; disposable extraction is not a runtime dependency.
