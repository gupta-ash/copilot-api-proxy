// Canonical configuration schema. Rule schemas are supplied by the registry;
// body/header rules stay separate, and routes reference symbolic upstreams.
// Legacy configuration spelling is normalized below with deprecation warnings.

/**
 * config-schema.ts — top-level zod schema for the YAML proxy config.
 *
 * The schema is built dynamically from the rule registry: every body rule
 * registered in `src/lib/transform/` contributes its own zod schema (each
 * one a `z.object` with a `z.literal("rule_name")` discriminator on `use`).
 * `RuleSchema` is the union of all those per-rule schemas, with a custom
 * pre-validator that catches an unknown `use:` value and emits a helpful
 * "Did you mean..." message via Levenshtein-distance suggestion.
 *
 * Top-level shape:
 *
 *   server: { port, host }
 *   endpoints: { [endpointName]: { inbound_paths, methods? } }
 *   upstreams: { [serviceName]: { paths: { [endpointName]: string } } }
 *   routes: Route[]
 *   transforms: { custom_dir }
 *   logging: { level, trace_dir?, warn_size_mb, retention_days, stream_buffer_mb }
 *   auth: { github_token_path?, account_type, vs_code_version }
 *
 * Per-route shape (POST D37 — symbolic upstream refs):
 *
 *   match: { method?, path, model_pattern? }
 *   body_rules: Rule[]      // EXECUTE FIRST (D-LOCK-1, matches architecture.md:444-446)
 *   header_rules: Rule[]    // EXECUTE SECOND
 *   response_rules: Rule[]
 *   upstream: { via: string, via_endpoint: string, shape: UpstreamShape }
 *
 * **Route matching contract (M5 spec § route-matching):**
 *   - `method`: exact match (default `"POST"` if omitted at consumption site).
 *   - `path`: exact-string equality with the request URL pathname (NOT regex
 *     or glob; M6+ may add).
 *   - `model_pattern`: optional. Treated as a JS regex; compiled lazily by the
 *     consumer; invalid regex → predicate fails closed.
 *   - **Precedence:** routes are evaluated in declared order; FIRST match wins.
 *   - **No-match:** request returns 404 `{error: {type:"no_route", ...}}` —
 *     pure passthrough is NOT a default; operator must explicitly configure.
 *
 * **D37 — symbolic upstream refs.** Routes reference upstream services and
 * endpoint families by name (`via`, `via_endpoint`) rather than embedding a
 * URL string. The host is composed at runtime via
 * `copilotBaseUrl(config.auth.account_type)` (see `src/auth/api-config.ts`);
 * the path comes from `config.upstreams[via].paths[via_endpoint]`. Use
 * `resolveUpstreamUrl(config, route)` to compose them. The legacy
 * `upstream.endpoint: URL` form is auto-mapped via preprocess shim with a
 * deprecation warning; unmapped URLs are rejected with a clear error.
 */

import path from "node:path";

import { z } from "zod";

// Side-effect import: registers every day-1 rule into the body registry.
import "~/lib/transform/index.ts";
import { copilotBaseUrl } from "~/auth/api-config.ts";
import { PATHS } from "~/lib/paths.ts";
import { list, snapshot } from "~/lib/transform/registry.ts";

// ============================================================================
// Levenshtein-distance suggestion helper
// ============================================================================

/** Classic iterative Levenshtein-distance (small inputs, two-row buffer). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // prev/curr rows
  let prev: Array<number> = new Array<number>(n + 1);
  let curr: Array<number> = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const del = (prev[j] ?? 0) + 1;
      const ins = (curr[j - 1] ?? 0) + 1;
      const sub = (prev[j - 1] ?? 0) + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

/**
 * Return up to 3 closest registered rule names to `typo`, sorted ascending by
 * distance, only including names with distance <= 3 (avoid wild guesses).
 */
export function suggestRuleName(
  typo: string,
  registered: ReadonlyArray<string>,
): Array<string> {
  return registered
    .map((name) => ({ name, distance: levenshtein(typo, name) }))
    .filter((entry) => entry.distance <= 3)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((entry) => entry.name);
}

// ============================================================================
// Dynamic RuleSchema
// ============================================================================

/**
 * Build `RuleSchema` from the body registry. Day-1 rules each export a
 * `z.object` with `use: z.literal("name")`, so the union behaves like a
 * discriminated union — but we keep it a `z.union` to avoid the typing
 * gymnastics of building `z.discriminatedUnion` with a dynamic `Array<...>`.
 *
 * **Lazy resolution.** The registry is consulted on EACH parse rather than
 * captured at module-load time. This lets test suites that `reset()` and
 * re-register day-1 rules get a stable schema regardless of import order;
 * and it means M5+ can register additional rules at runtime and have them
 * picked up by config validation without re-importing this module.
 *
 * `pre`-stage check: if the input is a plain object with a `use` field that
 * doesn't match any registered name, emit a custom error that includes a
 * Levenshtein-based suggestion list. This runs BEFORE the union dispatch so
 * the user gets one tidy error instead of N "expected literal X" failures.
 *
 * **M5 F3 production guard.** When `NODE_ENV === "production"` AND the body
 * registry is empty, we REJECT the input rather than silently accept it. An
 * empty registry in production almost always means the auto-generated barrel
 * (`scripts/gen_barrel.ts`) is broken — accepting arbitrary config silently
 * would let the proxy boot with NO rules and start mis-forwarding traffic.
 * In test mode we still accept (test ordering can legitimately hit this case
 * during reset/re-register sequences).
 */
function buildRuleSchema(): z.ZodTypeAny {
  return z.unknown().superRefine((input, ctx) => {
    // Resolve the registry lazily so tests that reset+re-register stay sound.
    const snap = snapshot("body");
    const registered = list("body");

    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      ctx.addIssue({
        code: "custom",
        message: "Rule must be an object",
        path: [],
      });
      return;
    }
    const useVal = (input as { use?: unknown }).use;
    if (typeof useVal !== "string") {
      ctx.addIssue({
        code: "custom",
        message: "Rule.use is required and must be a string",
        path: ["use"],
      });
      return;
    }
    if (registered.length === 0) {
      // M5 F3: production-mode empty registry is a broken barrel. Refuse to
      // silently accept arbitrary config that would let bad routes ship.
      if (process.env["NODE_ENV"] === "production") {
        ctx.addIssue({
          code: "custom",
          message:
            "Cannot validate rules: body registry is empty (barrel auto-gen broken?). Refusing to silently accept arbitrary config in production.",
          path: ["use"],
        });
        return;
      }
      // Test mode: accept (test ordering edge case is real and benign here).
      return;
    }
    if (!registered.includes(useVal)) {
      const suggestions = suggestRuleName(useVal, registered);
      const suggestionMsg =
        suggestions.length > 0
          ? ` Did you mean: ${suggestions.map((s) => `'${s}'`).join(", ")}?`
          : ` Registered rules: ${registered.map((r) => `'${r}'`).join(", ")}.`;
      ctx.addIssue({
        code: "custom",
        message: `Unknown rule: '${useVal}'.${suggestionMsg}`,
        path: ["use"],
      });
      return;
    }
    // Dispatch to the matching per-rule schema for full field-level validation.
    const ruleSchema = snap.get(useVal)?.schema;
    if (ruleSchema === undefined) {
      // Internal inconsistency between list() and snapshot() — should not happen.
      ctx.addIssue({
        code: "custom",
        message: `Internal: rule '${useVal}' missing from snapshot`,
        path: ["use"],
      });
      return;
    }
    const sub = ruleSchema.safeParse(input);
    if (!sub.success) {
      for (const issue of sub.error.issues) {
        ctx.addIssue({
          ...issue,
          path: issue.path,
        });
      }
    }
  });
}

export const RuleSchema = buildRuleSchema();

// ============================================================================
// Dynamic StreamEventRuleSchema (M10 D-LOCK-6 / C2 fix)
// ============================================================================

/**
 * Build `StreamEventRuleSchema` from the **stream_event** registry. Mirrors
 * `buildRuleSchema()` shape exactly; only the `snapshot(...)` + `list(...)`
 * arguments resolve the stream-event registry rather than the body registry.
 *
 * **Why a parallel schema (per C2 fix).** `RuleSchema` resolves only the
 * body registry (line 158 above: `snapshot("body")` + `list("body")`). The
 * two M7b stream translators register via `registerStreamEvent` into the
 * SEPARATE `stream_event_registry` (per `registry.ts:182`). If
 * `stream_event_rules: z.array(RuleSchema).default([])` were used,
 * `RuleSchema` would reject `translate_responses_event_to_anthropic_event`
 * with "Unknown rule" BEFORE `validateStreamEventRules` ever ran. The
 * parallel schema lets the zod-parse layer dispatch correctly per surface.
 *
 * **Cross-registry suggestion (per C2 + M2 cross-registry confusion
 * mitigation).** When zod rejects a name, the error message ALSO checks
 * the body registry — if the unknown stream-event rule name IS registered
 * as a body rule, the error message points the operator to the right
 * config section (`body_rules` or `header_rules` instead of
 * `stream_event_rules`).
 *
 * **M5 F3 production guard parity.** When `NODE_ENV === "production"` AND
 * the stream-event registry is empty, REJECT (mirrors body-registry
 * behavior). An empty stream-event registry in production almost always
 * means the auto-generated barrel is broken; silently accepting arbitrary
 * config would let the proxy boot with NO rules and start mis-forwarding
 * traffic.
 */
function buildStreamEventRuleSchema(): z.ZodTypeAny {
  return z.unknown().superRefine((input, ctx) => {
    const snap = snapshot("stream_event");
    const registered = list("stream_event");

    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      ctx.addIssue({
        code: "custom",
        message: "Stream-event rule must be an object with a 'use' field",
        path: [],
      });
      return;
    }
    const obj = input as Record<string, unknown>;
    const useVal = obj["use"];
    if (typeof useVal !== "string") {
      ctx.addIssue({
        code: "custom",
        message:
          "Stream-event rule 'use' field is required and must be a string",
        path: ["use"],
      });
      return;
    }
    if (registered.length === 0) {
      // Mirror M5 F3 production-mode guard.
      if (process.env["NODE_ENV"] === "production") {
        ctx.addIssue({
          code: "custom",
          message:
            "Cannot validate stream-event rules: stream_event registry is empty (broken auto-load?). Refusing to silently accept arbitrary config in production.",
          path: ["use"],
        });
        return;
      }
      // Test mode: accept (mirrors body-registry behavior).
      return;
    }
    if (!registered.includes(useVal)) {
      const suggestions = suggestRuleName(useVal, registered);
      // ALSO check the body registry — a body-rule name in
      // stream_event_rules indicates the operator put a rule in the
      // wrong list. Suggest the correct section.
      const bodyRegistered = list("body");
      const bodySuggest = bodyRegistered.includes(useVal)
        ? ` NOTE: '${useVal}' IS registered as a body rule — did you mean to put it in body_rules or header_rules instead of stream_event_rules?`
        : "";
      const suggestionMsg =
        suggestions.length > 0
          ? ` Did you mean: ${suggestions.map((s) => `'${s}'`).join(", ")}?`
          : ` Registered stream-event rules: ${registered.map((r) => `'${r}'`).join(", ")}.`;
      ctx.addIssue({
        code: "custom",
        message: `Unknown stream-event rule: '${useVal}'.${suggestionMsg}${bodySuggest}`,
        path: ["use"],
      });
      return;
    }
    const ruleSchema = snap.get(useVal)?.schema;
    if (ruleSchema === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `Internal: stream-event rule '${useVal}' missing from snapshot`,
        path: ["use"],
      });
      return;
    }
    const sub = ruleSchema.safeParse(input);
    if (!sub.success) {
      for (const issue of sub.error.issues) {
        ctx.addIssue({ ...issue, path: issue.path });
      }
    }
  });
}

export const StreamEventRuleSchema = buildStreamEventRuleSchema();

// ============================================================================
// Endpoints + Upstreams sections (D37)
// ============================================================================

const HttpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Per-endpoint-family configuration:
 *   - `inbound_paths`: paths the proxy listens on. The first entry is the
 *     CANONICAL path (used in logs + handler `findMatchingRoute` lookup);
 *     additional entries are aliases (all dispatch to the same handler;
 *     handler normalizes the actual path → canonical before route-match).
 *   - `methods`: HTTP methods to register for this endpoint family. Default
 *     `["POST"]`. The `models` family overrides to `["GET"]`.
 */
export const EndpointDefSchema = z.object({
  inbound_paths: z.array(z.string().min(1)).min(1),
  methods: z.array(HttpMethodSchema).optional(),
});

export const EndpointsSectionSchema = z
  .record(z.string(), EndpointDefSchema)
  .default(() => ({
    anthropic_messages: { inbound_paths: ["/v1/messages"] },
    openai_responses: { inbound_paths: ["/responses", "/v1/responses"] },
    openai_chat_completions: {
      inbound_paths: ["/chat/completions", "/v1/chat/completions"],
    },
    embeddings: { inbound_paths: ["/embeddings", "/v1/embeddings"] },
    models: {
      inbound_paths: ["/models", "/v1/models"],
      methods: ["GET" as const],
    },
  }));

/**
 * Per-upstream-service configuration. Currently only `copilot_enterprise` is
 * supported; the schema is extensible for future services.
 *
 * **Host composition is delegated to `copilotBaseUrl(config.auth.account_type)`.**
 * We do NOT carry a `base_url_template` field — `copilotBaseUrl` correctly
 * handles all 3 account types (`individual` → `api.githubcopilot.com` WITHOUT
 * subdomain prefix; `business`/`enterprise` → `api.{accountType}.githubcopilot.com`).
 * A template-substitution scheme would produce wrong URLs for `individual`.
 */
export const UpstreamServiceSchema = z.object({
  paths: z.record(z.string(), z.string().min(1)),
});

export const UpstreamsSectionSchema = z
  .record(z.string(), UpstreamServiceSchema)
  .default(() => ({
    copilot_enterprise: {
      paths: {
        anthropic_messages: "/v1/messages",
        openai_responses: "/responses",
        openai_chat_completions: "/chat/completions",
        embeddings: "/embeddings",
        models: "/models",
      },
    },
  }));

// ============================================================================
// Route schema (D37 symbolic upstream refs)
// ============================================================================

const UpstreamShapeSchema = z.enum([
  "openai_responses",
  "openai_chat",
  "anthropic_messages",
]);

/**
 * Route schema. **D37** — `upstream.endpoint: URL` is REPLACED by symbolic
 * `via` + `via_endpoint` refs. Legacy YAML using `endpoint:` is auto-mapped
 * via preprocess shim (with deprecation warning); unmapped URLs are rejected.
 */
export const RouteSchema = z.object({
  match: z.object({
    method: HttpMethodSchema.optional(),
    path: z.string().min(1),
    model_pattern: z.string().optional(),
  }),
  body_rules: z.array(RuleSchema).default([]),
  header_rules: z.array(RuleSchema).default([]),
  // M9 D-LOCK-13: per-route response-side rule list. Pairs body redirect
  // rules (which declare response_shape) with response-side consumer rules
  // (which declare the matching response_shape). M9's `lib/config.ts`
  // post-zod-parse loop calls `validateResponseShape(body_rules,
  // response_rules, bodySnap, bodySnap)` per route and throws
  // `ValidationHardFailError` (per D-LOCK-14) if any redirect declares a
  // shape that no response rule offers. Default `[]` = passthrough lanes
  // (no redirect → no consumer needed).
  response_rules: z.array(RuleSchema).default([]),
  // M10 D-LOCK-6: per-route stream-event rule list. Drives the handler's
  // choice between `forwardStream` (verbatim byte path; default `[]`) and
  // `forwardStreamTranslated` (decode → applyEvent → re-encode; non-empty).
  // Uses StreamEventRuleSchema (NOT RuleSchema) so registry lookup hits
  // the stream_event registry per C2 fix — the body-engine `RuleSchema`
  // resolves only the body registry and would reject every stream-event
  // rule at zod-parse time.
  stream_event_rules: z.array(StreamEventRuleSchema).default([]),
  upstream: z.object({
    via: z.string().min(1),
    via_endpoint: z.string().min(1),
    shape: UpstreamShapeSchema,
  }),
});

// ============================================================================
// Top-level config schema
// ============================================================================

const LogLevelSchema = z.enum(["off", "on", "raw", "verbose"]);

const ServerSectionSchema = z
  .object({
    port: z.number().int().min(1).max(65535).default(4143),
    host: z.string().default("0.0.0.0"),
  })
  .default(() => ({ port: 4143, host: "0.0.0.0" }));

const TransformsSectionSchema = z
  .object({
    custom_dir: z
      .string()
      .default(() => path.join(PATHS.APP_DIR, "transforms")),
  })
  .default(() => ({
    custom_dir: path.join(PATHS.APP_DIR, "transforms"),
  }));

const LoggingSectionSchema = z
  .object({
    level: LogLevelSchema.default("on"),
    trace_dir: z.string().optional(),
    /**
     * F143 - per-day-bucket size past which `TraceWriter.write` emits a
     * debug line and KEEPS WRITING. It caps nothing: trace integrity wins
     * over a strict limit, pinned by tests/lib/trace_rotation.test.ts.
     * EMISSION RULE, and it is the WHOLE rule: at an enabled debug level,
     * each write emits one line if and only if the bucket THAT WRITE lands
     * in has a cached observed size greater than this threshold
     * (`observed > warnBytes`, trace.ts). There is no latch and no other
     * stopping condition. Day rollovers, retention sweeps and size
     * recomputations matter ONLY through their effect on that one
     * comparison -- none of them starts or stops emission by itself.
     * Renamed from `max_size_mb`, which named a cap this code has never
     * enforced; the old spelling is aliased in the preprocess below.
     */
    warn_size_mb: z.number().int().positive().default(50),
    /**
     * Phase 5 v3.1 Group B (F-DISC-8) — number of days to retain day-bucket
     * trace dirs. `TraceWriter.runRetention()` deletes any `traces-YYYY-MM-DD`
     * subdir older than `now - retention_days`. The TraceWriter caps below 2
     * to avoid racing in-flight writes; the schema default mirrors that
     * intent (7 = a comfortable workweek of forensic depth).
     */
    retention_days: z.number().int().positive().default(7),
    /**
     * Phase 5 v3.1 Group B (F-DISC-4 + buffer cap revision) — per-stream
     * trace buffer cap in megabytes. `forwardStream`/`forwardStreamTranslated`
     * stop pushing chunks past this point (the operator-visible warn surfaces
     * once per stream); the flow file is still written with a sub-cap
     * `event_counts`. Default 4 MB matches the streaming-side default.
     */
    stream_buffer_mb: z.number().int().min(1).default(4),
    /**
     * Feature W2 — content-phase stall detector. `no_response_wait_ms` is the
     * Case-1 (pre-content) window; `response_wait_ms` the Case-2 (post-content)
     * gap window. `no_response_wait_ms` is capped below the 20-min (1_200_000)
     * hard backstop so Case-1 fires first; the literals are kept decoupled from
     * services/copilot/_retry.ts on purpose (no cross-import).
     */
    stall_detection: z
      .object({
        enabled: z.boolean().default(true),
        no_response_wait_ms: z
          .number()
          .int()
          .positive()
          .max(1_199_000)
          .default(1_140_000),
        response_wait_ms: z.number().int().positive().default(600_000),
        log_path: z.string().optional(),
      })
      .default(() => ({
        enabled: true,
        no_response_wait_ms: 1_140_000,
        response_wait_ms: 600_000,
      })),
    /**
     * Always-on stream-incident log (D96 Phase 1). A SIBLING of `level`, never
     * a child of it: `level` is a volume knob for routine trace detail, while
     * an incident record is the thing you pay the level for, and gating it
     * behind `raw` means the fleet records nothing at the moment something
     * breaks (F138). One JSONL line per stream whose outcome is anything other
     * than `success`; successes are excluded, so the file is bounded by the
     * failure rate rather than by traffic.
     *
     * On by default THROUGH THE SCHEMA, which is what makes it reach the
     * fleet: `install_bundle.ps1` places `config.yaml` only-if-absent, so a
     * `config/default.yaml` edit is a first-install seed and not a fleet lever
     * (F128/D95). The W2 stall detector and the D70 beta policy both ship this
     * same way.
     */
    incident_log: z
      .object({
        enabled: z.boolean().default(true),
        log_path: z.string().optional(),
        max_bytes: z
          .number()
          .int()
          .positive()
          .default(8 * 1024 * 1024),
      })
      .default(() => ({
        enabled: true,
        max_bytes: 8 * 1024 * 1024,
      })),
    /**
     * F165 / D96 Amendment 1 — the proxy-emitted SSE keep-alive comment
     * (`: keepalive\n\n`), ARMED only from INSIDE the stall detector's own race,
     * so it cannot be armed outside a stall window, cannot be armed after the
     * terminal event (the race is gated on `!sawTerminal`), and cannot exist at
     * all when the detector is off (D100). `makeKeepAliveConfig` additionally
     * REFUSES, with a warn, when `stall_detection` is disabled.
     *
     * ⚠ **ARMING is what the race bounds; DELIVERY is not — and the original
     * wording below claimed both.** Once the keep-alive arm wins, the write is
     * awaited OUTSIDE the race, so the stall deadline can elapse with those 13
     * bytes still in flight to a slow client: the comment is then delivered after
     * the window, and stall handling waits for the write to settle. That is
     * D106's recorded residual (an unbounded `await` inside the read loop), and
     * **D118 is what makes it reachable BY DEFAULT** — before the flip a box
     * emitted keep-alives only if an operator had set `enabled: true` explicitly,
     * which the runbook documented how to do; whether any box had is UNKNOWN, and
     * only 2 of 4 configs were ever inspected.
     *
     * ⚠ **NOTHING BOUNDS THAT WRITE, and an earlier revision of this docblock
     * claimed `_retry.ts`'s wall-clock deadline did.** That is FALSE and is
     * corrected here rather than left: the deadline is an `AbortSignal` passed to
     * `fetch()`, so it bounds the UPSTREAM leg; it cannot unblock a downstream
     * `stream.write`. What is true, and is the reason this is a narrowing rather
     * than a new class: the read loop ALREADY awaits `stream.write` unbounded for
     * every payload chunk, so a client that stops draining already defers stall
     * handling. What D118 adds is a write on the BYTE-SILENT path, where there
     * was none — and that is the path the detector exists for.
     *
     * ORIGINAL, PRESERVED (D93 rule 1) — overclaimed on the delivery half:
     * "written from INSIDE the stall detector's own race so it cannot outlive the
     * stall window, cannot exist post-terminal, and cannot exist when the detector
     * is off (D100)."
     *
     * Keep-alive defaults to true at three schema levels. Zod does not re-run
     * an inner object's defaults when an outer default supplies the parent,
     * so the inner field, this object's outer default and the parent logging
     * default must agree across all supported configuration shapes.
     * The installer seeds config.yaml only when absent; it never overwrites an
     * existing configuration. A seed-file change alone does not update it.
     *
     * `interval_ms` is the gap BETWEEN comments; `require_first_byte` withholds
     * the comment until the upstream has produced a byte (currently redundant —
     * see `KeepAliveConfig`); `max_total_ms` bounds how long ONE read may keep
     * emitting. ⚠ `max_total_ms` is checked when the next interval is ARMED, so
     * emission stops within one `interval_ms` of it, and the client's own
     * watchdog still applies on top — it is a budget, not a hard cap.
     */
    keep_alive: z
      .object({
        enabled: z.boolean().default(true),
        interval_ms: z.number().int().positive().default(30_000),
        require_first_byte: z.boolean().default(true),
        max_total_ms: z.number().int().positive().default(300_000),
      })
      .default(() => ({
        enabled: true,
        interval_ms: 30_000,
        require_first_byte: true,
        max_total_ms: 300_000,
      })),
  })
  .default(() => ({
    level: "on" as const,
    warn_size_mb: 50,
    retention_days: 7,
    stream_buffer_mb: 4,
    stall_detection: {
      enabled: true,
      no_response_wait_ms: 1_140_000,
      response_wait_ms: 600_000,
    },
    incident_log: {
      enabled: true,
      max_bytes: 8 * 1024 * 1024,
    },
    // ⚠ CORRECTED 2026-08-09 — "the compiler cannot enforce it" is FALSE for a
    // REQUIRED sub-object under this repo's zod (^4.1.11), measured by mutation
    // rather than reasoned: deleting the `keep_alive` block below and leaving the
    // inner `z.object` intact does NOT typecheck. It fails
    // `TS2769: No overload matches this call` — `.default()` is typed against the
    // schema's full OUTPUT type, so an omitted required key is a compile error.
    // The sentence is left standing below rather than rewritten (D93 rule 1); only
    // its scope is corrected here.
    //
    // WHAT SURVIVES, AND IT IS WHY THE BLOCK IS STILL MANDATORY: F66's RUNTIME
    // half is untouched — the outer `.default()` returns a LITERAL and does not
    // re-run the inner defaults, so the values below must be repeated by hand.
    // And the compiler checks PRESENCE ONLY, never AGREEMENT: an outer literal
    // saying `enabled: true` against an inner `.default(false)` compiles cleanly
    // and is wrong at runtime. That gap is what the test in tests/types/ pins, so
    // the test is NOT made redundant by this correction — it guards a different
    // property than the one the compiler guards.
    //
    // F66 — MANDATORY, and the compiler cannot enforce it. Zod's outer
    // `.default(() => ({...}))` does NOT re-run the inner object's defaults, so
    // a sub-section present only in the inner `z.object` is `undefined` at
    // runtime on any config that omits a `logging:` key entirely — while
    // `z.infer` insists the field is there. For `keep_alive` the omission was
    // INVISIBLE while the default was false (`undefined` and `enabled: false`
    // behave identically).
    //
    // ⚠ D118 MEASURED the scope of that warning and it was TOO NARROW. It names
    // configs with no `logging:` key — but the shape every deployed fleet
    // config.yaml actually has is `logging:` PRESENT with no `keep_alive` key,
    // which is answered by this object's OWN outer default, not by this literal.
    // Flipping the inner literal alone left BOTH shapes false while typechecking
    // clean and passing every test, including the guard below. All three sites
    // must AGREE; the test in tests/types/ now pins all three. **F222.**
    keep_alive: {
      enabled: true,
      interval_ms: 30_000,
      require_first_byte: true,
      max_total_ms: 300_000,
    },
  }));

const AuthSectionSchema = z
  .object({
    github_token_path: z.string().optional(),
    account_type: z
      .enum(["individual", "business", "enterprise"])
      .default("enterprise"),
    vs_code_version: z.string().default("1.95.0"),
  })
  .default(() => ({
    account_type: "enterprise" as const,
    vs_code_version: "1.95.0",
  }));

// ============================================================================
// anthropic-beta policy section (Feature D1)
// ============================================================================

/**
 * Default `allow` list — the 8 anthropic-beta tokens CC / omp send at ship
 * time. Used only by the `allowlist` policy (the pre-D1 fail-safe posture).
 * Kept as data so `allowlist` mode has an explicit set to filter to.
 */
const DEFAULT_BETA_ALLOW: string[] = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "interleaved-thinking-2025-05-14",
  "redact-thinking-2026-02-12",
  "effort-2025-11-24",
  "advanced-tool-use-2025-11-20",
];
/**
 * Default `deny` list. Upstream (Copilot-Ent) is a DENYLIST: it rejects
 * specific beta tokens by name (`advisor-tool-2026-03-01` → 400 "unsupported
 * beta header(s): ...") and passes everything else (an unknown/nonsense beta
 * returns 200 — verified). `context-1m-2025-08-07` is deliberately NOT denied:
 * it is an accepted no-op upstream, so an honest denylist lets it pass.
 *
 * **Exported** so the `describeUpstreamError` remediation hint
 * (`routes/_shared/error-helpers.ts`) can render a deny snippet that UNIONs
 * these built-in defaults with the newly-rejected token(s) — one source of
 * truth, no drift between the schema default and the operator-facing hint.
 */
export const DEFAULT_BETA_DENY: string[] = ["advisor-tool-2026-03-01"];
/** Betas the denylist/allowlist rule-sets ensure are present via a union merge. */
const DEFAULT_BETA_MERGE_APPEND: string[] = ["advanced-tool-use-2025-11-20"];

/**
 * Top-level `anthropic_beta` section (Feature D1). Controls how the proxy
 * rewrites the beta lanes' (`^claude` model_pattern: Lane 1 `/v1/messages` +
 * Lane 5 `/responses`) `anthropic-beta` `header_rules` at boot, via
 * `applyBetaPolicy` (src/lib/apply-beta-policy.ts) applied IN-MEMORY after
 * config-load.
 *
 *   - `policy: "denylist"` (default) — deny only known-bad tokens; pass
 *     everything else so new upstream-accepted betas flow for free.
 *   - `policy: "allowlist"` — keep only `allow` tokens (the pre-D1 fail-safe).
 *   - `policy: "strip_all"` — remove `anthropic-beta` entirely (nuclear).
 *
 * Optional-with-defaults (mirrors ServerSectionSchema / AuthSectionSchema) so a
 * config that omits the section still parses AND picks up `denylist`
 * automatically — no deployed `config.yaml` edit required (W2 precedent).
 * Override at startup via `COPILOT_PROXY_BETA_POLICY` (or the start-script
 * `-BetaPolicy` / `--beta-policy` flag) without editing config.
 */
const AnthropicBetaSectionSchema = z
  .object({
    policy: z.enum(["denylist", "allowlist", "strip_all"]).default("denylist"),
    deny: z.array(z.string()).default(() => [...DEFAULT_BETA_DENY]),
    allow: z.array(z.string()).default(() => [...DEFAULT_BETA_ALLOW]),
    merge_append: z
      .array(z.string())
      .default(() => [...DEFAULT_BETA_MERGE_APPEND]),
  })
  .default(() => ({
    policy: "denylist" as const,
    deny: [...DEFAULT_BETA_DENY],
    allow: [...DEFAULT_BETA_ALLOW],
    merge_append: [...DEFAULT_BETA_MERGE_APPEND],
  }));

/**
 * Inner (post-preprocess) schema — wraps the raw object in cross-validation.
 *
 * **D37 superRefine checks** (per spec § config schema):
 *   1. Every `route.upstream.via` must reference a defined upstream service.
 *   2. Every `route.upstream.via_endpoint` must reference an endpoint defined
 *      in BOTH `endpoints` AND `upstreams[via].paths`.
 *   3. Empty `endpoints` map → reject.
 *   4. Method coherence: route's `match.method` must be in the endpoint's
 *      `methods` (or default `['POST']`).
 *   5. Shape ↔ endpoint coherence: route's `upstream.shape` must match the
 *      shape implied by the `via_endpoint` family.
 *   6. Dangling endpoints (defined but unreferenced) → console.warn (no reject).
 */
const ConfigSchemaInner = z
  .object({
    routes: z.array(RouteSchema).default([]),
    endpoints: EndpointsSectionSchema,
    upstreams: UpstreamsSectionSchema,
    transforms: TransformsSectionSchema,
    logging: LoggingSectionSchema,
    auth: AuthSectionSchema,
    server: ServerSectionSchema,
    anthropic_beta: AnthropicBetaSectionSchema,
  })
  .superRefine((cfg, ctx) => {
    // Check #3: empty endpoints map.
    const endpointNames = Object.keys(cfg.endpoints);
    if (endpointNames.length === 0) {
      ctx.addIssue({
        code: "custom",
        message:
          "endpoints section is empty; at least one endpoint family must be defined",
        path: ["endpoints"],
      });
      return; // further checks moot
    }

    const upstreamNames = Object.keys(cfg.upstreams);

    // Endpoint shape coherence map.
    const endpointToShape: Record<string, string> = {
      anthropic_messages: "anthropic_messages",
      openai_responses: "openai_responses",
      openai_chat_completions: "openai_chat",
    };

    // Per-route checks #1 / #2 / #4 / #5.
    for (let i = 0; i < cfg.routes.length; i++) {
      const route = cfg.routes[i];
      if (route === undefined) continue;
      const via = route.upstream.via;
      const viaEndpoint = route.upstream.via_endpoint;

      // Check #1: via references defined upstream service.
      const upstreamSvc = cfg.upstreams[via];
      if (upstreamSvc === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `route.upstream.via='${via}' does not reference a defined upstream service. Valid alternatives: ${
            upstreamNames.length > 0
              ? upstreamNames.map((n) => `'${n}'`).join(", ")
              : "(none defined)"
          }`,
          path: ["routes", i, "upstream", "via"],
        });
        continue; // can't validate via_endpoint if via is bogus
      }

      // Check #2: via_endpoint exists in BOTH endpoints AND upstreams[via].paths.
      const inEndpoints = viaEndpoint in cfg.endpoints;
      const inUpstreamPaths = viaEndpoint in upstreamSvc.paths;
      if (!inEndpoints || !inUpstreamPaths) {
        const validEndpointNames = endpointNames
          .filter((n) => n in upstreamSvc.paths)
          .map((n) => `'${n}'`)
          .join(", ");
        ctx.addIssue({
          code: "custom",
          message: `route.upstream.via_endpoint='${viaEndpoint}' does not reference an endpoint defined in BOTH 'endpoints' AND 'upstreams.${via}.paths'. Valid alternatives: ${
            validEndpointNames.length > 0 ? validEndpointNames : "(none)"
          }`,
          path: ["routes", i, "upstream", "via_endpoint"],
        });
        continue;
      }

      // Check #4: method coherence.
      const endpointDef = cfg.endpoints[viaEndpoint];
      if (endpointDef !== undefined && route.match.method !== undefined) {
        const allowedMethods = endpointDef.methods ?? ["POST"];
        if (!allowedMethods.includes(route.match.method)) {
          ctx.addIssue({
            code: "custom",
            message: `route.match.method='${route.match.method}' not in endpoint '${viaEndpoint}'.methods=[${allowedMethods.join(
              ", ",
            )}] for route ${route.match.path}`,
            path: ["routes", i, "match", "method"],
          });
        }
      }

      // Check #5: shape ↔ endpoint coherence.
      const expectedShape = endpointToShape[viaEndpoint];
      if (
        expectedShape !== undefined &&
        route.upstream.shape !== expectedShape
      ) {
        ctx.addIssue({
          code: "custom",
          message: `route.upstream.shape='${route.upstream.shape}' does not match the natural shape '${expectedShape}' for endpoint family '${viaEndpoint}'. Suggested shape: '${expectedShape}'`,
          path: ["routes", i, "upstream", "shape"],
        });
      }
    }

    // Check #6: dangling endpoints (warn-only).
    const referencedByRoute = new Set<string>(
      cfg.routes.map((r) => r.upstream.via_endpoint),
    );
    const referencedByUpstream = new Set<string>();
    for (const svc of Object.values(cfg.upstreams)) {
      for (const k of Object.keys(svc.paths)) referencedByUpstream.add(k);
    }
    for (const epName of endpointNames) {
      if (!referencedByRoute.has(epName) && !referencedByUpstream.has(epName)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[config] endpoint '${epName}' is defined but not referenced by any route or upstream service (dangling)`,
        );
      }
    }
  });

// ============================================================================
// Legacy preprocess shim (M1a-compat + D37 endpoint-URL → symbolic)
// ============================================================================

/**
 * Map a legacy `route.upstream.endpoint: URL` to symbolic `via` + `via_endpoint`.
 * Returns `null` if the URL doesn't match any canonical pattern (caller leaves
 * the legacy field; the new schema then rejects it with a clear error).
 *
 * **Permissive host matching.** Per M5 spec § F1: `route.upstream.endpoint`
 * was "documentation-only in M5" — service callers hardcode the upstream
 * URL via `copilotBaseUrl(accountType) + suffix`, so the operator-supplied
 * URL host was never authoritative at runtime. We therefore map by
 * path-suffix alone and assume `via: copilot_enterprise`. This preserves
 * operator semantics (the URL was already ignored) while letting the
 * preprocess rewrite legacy fixtures cleanly.
 */
function legacyUpstreamUrlToSymbolic(
  url: string,
): { via: string; via_endpoint: string } | null {
  // Accept any http(s) URL; extract the path suffix.
  const m = /^https?:\/\/[^/]+(\/.+)$/i.exec(url);
  if (m === null) return null;
  const path = m[1];
  if (path === undefined) return null;

  const PATH_TO_ENDPOINT: Record<string, string> = {
    "/v1/messages": "anthropic_messages",
    "/responses": "openai_responses",
    "/v1/responses": "openai_responses",
    "/chat/completions": "openai_chat_completions",
    "/v1/chat/completions": "openai_chat_completions",
    "/embeddings": "embeddings",
    "/v1/embeddings": "embeddings",
    "/models": "models",
    "/v1/models": "models",
  };
  const viaEndpoint = PATH_TO_ENDPOINT[path];
  if (viaEndpoint === undefined) return null;
  return { via: "copilot_enterprise", via_endpoint: viaEndpoint };
}

/**
 * **M5 D-LOCK-3 M1a-compat preprocess + D37 legacy-endpoint shim.**
 *
 * - M1a legacy: maps top-level `debug:` / `trace_dir:` into `logging.*`.
 * - D37 legacy: maps any `route.upstream.endpoint: URL` to symbolic
 *   `via` + `via_endpoint` (with a deprecation `console.warn` per match).
 *   Unmapped URLs are left in place; the new schema rejects them with a
 *   clear "endpoint URL form deprecated" error.
 */
export const ConfigSchema = z.preprocess((input) => {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const obj = input as Record<string, unknown>;

  // ---- M1a-compat: top-level debug/trace_dir → logging.* ------------------
  const out: Record<string, unknown> = { ...obj };
  if ("debug" in out || "trace_dir" in out) {
    const existingLogging =
      typeof out["logging"] === "object" &&
      out["logging"] !== null &&
      !Array.isArray(out["logging"])
        ? (out["logging"] as Record<string, unknown>)
        : {};
    const newLogging: Record<string, unknown> = { ...existingLogging };

    if ("debug" in out && !("level" in newLogging)) {
      newLogging["level"] = out["debug"];
    }
    if ("trace_dir" in out && !("trace_dir" in newLogging)) {
      newLogging["trace_dir"] = out["trace_dir"];
    }

    delete out["debug"];
    delete out["trace_dir"];
    out["logging"] = newLogging;
  }

  // ---- F143-compat: logging.max_size_mb -> logging.warn_size_mb ----------
  // The old key never capped anything: TraceWriter.write keeps writing and
  // emits a debug line per write whenever that write's own bucket is over
  // the threshold (see warn_size_mb above for the exact predicate). It was
  // renamed to say what it does. This alias is
  // MANDATORY rather than a courtesy: nothing in this schema is `.strict()`,
  // so zod would STRIP the old spelling silently and every deployed
  // config.yaml carrying `max_size_mb: 50` would lose its setting with no
  // error at all.
  const legacyLogging = out["logging"];
  if (
    typeof legacyLogging === "object" &&
    legacyLogging !== null &&
    !Array.isArray(legacyLogging) &&
    "max_size_mb" in legacyLogging
  ) {
    const migrated: Record<string, unknown> = {
      ...(legacyLogging as Record<string, unknown>),
    };
    // An explicitly-set new key wins; the legacy one is dropped either way.
    if (!("warn_size_mb" in migrated)) {
      migrated["warn_size_mb"] = migrated["max_size_mb"];
    }
    delete migrated["max_size_mb"];
    // eslint-disable-next-line no-console
    console.warn(
      "[config] DEPRECATED: logging.max_size_mb; use logging.warn_size_mb (it warns and continues - it has never capped anything)",
    );
    out["logging"] = migrated;
  }

  // ---- D37 legacy: route.upstream.endpoint URL → via/via_endpoint ----------
  const routesIn = out["routes"];
  if (Array.isArray(routesIn)) {
    const newRoutes = routesIn.map((r) => {
      if (r === null || typeof r !== "object") return r;
      const route = r as Record<string, unknown>;
      const upstream = route["upstream"];
      if (
        upstream === null ||
        typeof upstream !== "object" ||
        Array.isArray(upstream)
      ) {
        return route;
      }
      const ups = upstream as Record<string, unknown>;
      // If new shape is already present, no rewrite needed.
      if ("via" in ups && "via_endpoint" in ups) return route;
      const endpoint = ups["endpoint"];
      if (typeof endpoint !== "string") return route;
      const mapped = legacyUpstreamUrlToSymbolic(endpoint);
      if (mapped === null) {
        // Leave the legacy `endpoint:` in place; new schema rejects with clear error.
        return route;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[config] DEPRECATED: route.upstream.endpoint URL form ('${endpoint}'); use via/via_endpoint symbolic refs (mapped to via='${mapped.via}', via_endpoint='${mapped.via_endpoint}')`,
      );
      const newUpstream: Record<string, unknown> = { ...ups };
      delete newUpstream["endpoint"];
      newUpstream["via"] = mapped.via;
      newUpstream["via_endpoint"] = mapped.via_endpoint;
      return { ...route, upstream: newUpstream };
    });
    out["routes"] = newRoutes;
  }

  return out;
}, ConfigSchemaInner);

// ============================================================================
// Inferred TS types
// ============================================================================

export type Config = z.infer<typeof ConfigSchema>;
export type Route = z.infer<typeof RouteSchema>;
export type LogLevel = z.infer<typeof LogLevelSchema>;
export type UpstreamShape = z.infer<typeof UpstreamShapeSchema>;
export type EndpointDef = z.infer<typeof EndpointDefSchema>;
export type UpstreamService = z.infer<typeof UpstreamServiceSchema>;
export type AnthropicBetaConfig = z.infer<typeof AnthropicBetaSectionSchema>;

/**
 * **M5 F4 escape hatch.** `RuleSchema` is `z.unknown().superRefine(...)`, so
 * its inferred type is `unknown` (zod cannot statically narrow a dynamic
 * registry-backed superRefine). Downstream consumers that need to access the
 * `use` discriminator + the `name` field can use this minimal alias and
 * re-narrow with the per-rule registered schema:
 *
 *   const reg = ruleRegistry.get(rule.use);
 *   if (reg !== undefined) {
 *     const opts = reg.schema.parse(rule);   // narrowed type
 *   }
 *
 * This trades the per-rule discriminated-union narrowing (impossible against
 * a dynamic registry) for a stable structural lower bound — `use` + `name`
 * are guaranteed by RuleSchema's superRefine, so consumers can rely on them.
 */
export type Rule = { use: string; name: string; [k: string]: unknown };

// ============================================================================
// resolveUpstreamUrl helper (D37)
// ============================================================================

/**
 * Compose the absolute upstream URL for a route by combining
 * `copilotBaseUrl(config.auth.account_type)` (host) with
 * `config.upstreams[route.upstream.via].paths[route.upstream.via_endpoint]`
 * (path). Throws (NOT silent undefined-string-concat) when the symbolic refs
 * cannot be resolved at call time — a defense-in-depth check beyond the
 * load-time `superRefine`.
 */
export function resolveUpstreamUrl(config: Config, route: Route): string {
  const via = route.upstream.via;
  const viaEndpoint = route.upstream.via_endpoint;
  const svc = config.upstreams[via];
  if (svc === undefined) {
    throw new Error(
      `resolveUpstreamUrl: unknown upstream service '${via}'; defined services: ${Object.keys(config.upstreams).join(", ") || "(none)"}`,
    );
  }
  const upstreamPath = svc.paths[viaEndpoint];
  if (upstreamPath === undefined) {
    throw new Error(
      `resolveUpstreamUrl: upstream service '${via}' has no path for endpoint '${viaEndpoint}'; defined endpoints: ${Object.keys(svc.paths).join(", ") || "(none)"}`,
    );
  }
  return `${copilotBaseUrl(config.auth.account_type)}${upstreamPath}`;
}
