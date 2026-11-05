# Public test fixtures

All checked-in conversation, instruction and replay content is synthetic. The
examples describe a fictional blue-and-gold palette or sample files; they are
not captured user conversations with names or identifiers replaced. No private
capture directory, external prompt corpus or installed bundle is needed by the
fixture-based tests.

## Coverage and provenance

- `tests/fixtures/cc_opus_billing_header*.json`: an independently authored
  request and expected result for two opt-in system-block stripping rules.
  The remaining instruction, messages, tool schema, metadata and scalar fields
  must survive unchanged. This demonstration does **not** change production
  policy: the default Claude route preserves billing-header system blocks.
- `tests/fixtures/responses_to_anthropic*.json`: an independently authored,
  complete body-conversion pair. The unconditional test compares all system
  blocks, cache control, messages, merged tool results, tool schema and scalar
  policy. It replaces a host-dependent private-capture comparison; it does not
  claim real captured-traffic parity.
- `tests/fixtures/parallel_tools_codex.json`: synthetic concurrent tool blocks
  with interleaved argument fragments and reverse stop order. Tests assert
  per-block identity, assembled arguments and usage independently of its
  illustrative expected event prefix.
- `tests/fixtures/stream-replay/*`: synthetic upstream/client pairs:

  | Lane | Preserved regression coverage |
  | --- | --- |
  | `cc_claude_passthrough` | Exact native bytes, complete text lifecycle, usage, underscore-bearing backend-style message ID |
  | `cc_gpt55_thinking` | Three reasoning segments, six thinking fragments, 48 numbered text fragments across multiple read chunks, structural-event passthrough, terminal usage |
  | `codex_claude_reverse` | Two thinking segments, signature suppression, accumulated text, parallel tools and reverse stop order |
  | `codex_gpt55_native` | Exact bare-data Responses framing, complete text lifecycle, stable synthetic response/item IDs, usage |

Each lane's `source.type` is `synthetic`. `source.sha256` binds the exact
`upstream.sse` bytes; `source.expected_client_sha256` binds the exact expected
client bytes. The provenance test checks both digests and rejects empty payloads.
Native expected streams equal their upstream bytes. Translated expected streams
are hand-authored from the event mapping, not proof of an observed successful
replay. SSE files must retain LF framing and byte-preserving checkout rules.
The reverse lane retains an existing synthetic protocol example with generic
public model and fixture IDs; the former capture-derived lanes were replaced
in full. Offline fixtures use no private model names; opt-in real-upstream tests
select public catalog model names instead.

## Extraction tools are not publication gates

These tools copy selected capture content. A matching hash proves which input
was selected, **not** permission to publish it or absence of private material.
Do not overwrite public fixtures with real prompts, reasoning summaries, tool
arguments, file contents, identifiers or instruction corpora. Identifier/regex
redaction cannot establish that a real conversation is safe to publish.

```text
bun run scripts/extract_fixture.ts <capture.json> <output.json> <expected-upstream-sha256>
bun run scripts/extract_replay_fixture.ts <flow.json> <upstream.sse>
```

All paths are explicit. The first command requires a 64-digit SHA-256 of the
exact capture file bytes and validates it before writing `request.body` without
redaction. The SSE extractor prefers `response.body.raw_full`; its legacy
`raw_first_2k` fallback reports truncation when the retained prefix is incomplete.
Extraction should target a private working location, never be treated as an
automatic public-fixture update.

## Intentional snapshot regeneration

```text
bun run scripts/regen_replay_snapshots.ts --bundle <bundle.js> --expected-bundle-sha256 <64-hex-digest> --check-only
bun run scripts/regen_replay_snapshots.ts --bundle <bundle.js> --expected-bundle-sha256 <64-hex-digest> --lane <lane-name>
```

Both modes validate the exact explicitly selected bundle bytes before replaying
any lane. There is no machine-specific bundle path or implicit digest baseline.
The bundle is a provenance gate only: the existing `replayLane` helper exercises
the source checkout's production forwarders and transformation rules, not the
bundle file. Review source changes, the selected baseline and expected bytes
together. Regeneration updates `source.expected_client_sha256`; intentional
upstream edits also require an explicit update of `source.sha256`.

`--force` only repairs an existing zero-byte expected file in regeneration mode.
It does not bypass the bundle hash gate, and check-only/default replay still
reject empty expected files. Synthetic replay is deterministic protocol coverage,
not a substitute for separately authorized real-upstream interoperability tests.
