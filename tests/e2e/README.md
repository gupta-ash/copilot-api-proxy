# Opt-in real-upstream end-to-end tests

This suite starts ephemeral source-checkout proxy processes and makes real
Copilot requests. It is gated by `RUN_E2E=1`, consumes real quota and requires
valid operator authentication and network access. The ordinary `bun test` run
skips the real-upstream cases. Do not enable this suite as part of an offline
fixture check or routine CI job.

## Prerequisites

- Install the repository's Bun dependencies; no distribution build is needed.
- Seed valid proxy authentication in `~/.local/share/copilot-proxy/github_token`.
  Treat the token and any resulting runtime traces as private.
- Ensure the configured Copilot account can reach its upstream service.

The harness preallocates an ephemeral loopback port and waits for `/health` to
report `auth_status: "ready"` before sending requests. It pins
`COPILOT_PROXY_CONFIG` to the checkout's `config/default.yaml`, not deployed
operator routing. Trace-enabled callers use a temporary configuration copy with
a logging override. The tests do not deploy the checkout's config to an existing
proxy installation.

## Running

From the repository root, and only when real-upstream execution is intended:

```text
bun run test:e2e
```

This command sets `RUN_E2E=1` for `bun test tests/e2e/`. Results depend on upstream
availability, account access and the current model catalog; no fixed pass count
is guaranteed here.

## Covered lanes

| Lane | Request path/model family | Coverage |
| --- | --- | --- |
| 1 | `/v1/messages`, Claude | Native Anthropic response and SSE framing |
| 2 | `/responses`, GPT-5/GPT-6 | Native Responses request/response and bearer replacement |
| 3 | `/chat/completions`, GPT-4 | Native Chat response and streaming |
| 4 | `/v1/messages`, GPT-5/GPT-6 | Anthropic request conversion and Responses-to-Anthropic SSE |
| 5 | `/responses`, Claude | Responses request conversion and Anthropic-to-Responses SSE |

Lane 5 checks nonempty incremental text, accumulated `output_text.done.text`
and completed message output. These are proxy-level protocol invariants, not a
claim about a particular CLI renderer. Non-streaming cross-vendor responses
retain their upstream shape under the current configuration.

For deterministic, offline protocol examples and their provenance/hash contract,
see [public fixtures](../../docs/fixtures.md).
