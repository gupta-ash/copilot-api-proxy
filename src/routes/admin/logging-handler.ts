/**
 * admin/logging-handler.ts — runtime logging-level control plane (Feature:
 * dynamic logging toggle — flip trace capture on/off with NO restart).
 *
 * Two handlers, mounted RAW in server.ts (NOT through withMetrics/withTrace,
 * mirroring /metrics — an operator must be able to toggle a struggling proxy
 * the same way they scrape it; no auth/loopback/token guard per operator
 * decision, treated like the already-LAN-open /health + /metrics):
 *
 *   - GET  /admin/logging → `{ level }` — the current level name.
 *   - POST /admin/logging `{ level }` → flip the level live; returns
 *     `{ previous, current }`.
 *
 * The level is a process-global in `debug` (lib/debug.ts). with-trace.ts +
 * forward-stream.ts read `debug.getLevel()` at the START of each request, so
 * a flip to >= raw makes the NEXT request begin capturing (in-flight streams
 * keep their snapshot decision — a mid-flight flip never interrupts a working
 * peer); a flip below raw stops new captures. No config file is touched.
 *
 * **Capture availability (503 on structural unavailability).** The trace
 * writer is composed into the request pipeline (server.ts) only when it was
 * created at boot. If trace-dir creation failed at boot, no writer exists and
 * NO capture is possible until restart. A POST requesting raw/verbose in that
 * state is refused with a 503 (level left unchanged) rather than silently
 * flipping to a level that can never write — see the
 * `makeLoggingHandlers(traceCaptureAvailable)` parameter. Levels below raw
 * (`off`, `on`) need no writer and are always honored.
 *
 * **PII-warning edge.** The raw-enablement PII warning fires ONLY on the
 * below-raw → raw+ transition, so a raw→raw / verbose→raw re-POST does not
 * re-spam it.
 *
 * **Total-safe POST parse.** A malformed / missing / out-of-set body MUST NOT
 * throw a 500 — every bad input maps to a 400 carrying the valid-level list.
 * We validate `level` against an explicit allow-list rather than leaning on
 * `parseLevel`'s silent LEVEL_ON fallback (which would accept junk as "on").
 */

import type { Context } from "hono";
import consola from "consola";

import {
  LEVEL_RAW,
  debug,
  levelName,
  parseLevel,
  type LevelName,
} from "~/lib/debug.ts";

/**
 * The 4 valid level names accepted by POST. Explicit allow-list — we do NOT
 * rely on `parseLevel`'s silent LEVEL_ON default to accept unknown input.
 */
const VALID_LEVELS: readonly LevelName[] = ["off", "on", "raw", "verbose"];

/** Type guard: is `v` one of the 4 valid level names? */
function isValidLevelName(v: unknown): v is LevelName {
  return (
    typeof v === "string" && (VALID_LEVELS as readonly string[]).includes(v)
  );
}

/**
 * The PII warning emitted on the below-raw → raw/verbose enablement edge. Kept
 * verbatim-identical to the boot-time warning in main.ts so operators see the
 * same wording whether raw is enabled at boot or toggled at runtime.
 */
const RAW_PII_WARNING =
  "WARNING: raw mode captures full request/response bodies including " +
  "prompt content. Do not enable raw mode in environments processing " +
  "PII without compensating controls.";

export interface LoggingHandlers {
  getHandler: (c: Context) => Response;
  postHandler: (c: Context) => Promise<Response>;
}

/**
 * Build the GET + POST handlers for `/admin/logging`.
 *
 * @param traceCaptureAvailable Whether a trace writer was created at boot and
 *   composed into the request pipeline (server.ts passes
 *   `traceWriter !== undefined`). When `false`, raw/verbose capture is
 *   structurally impossible until restart, so a POST requesting raw+ is
 *   refused with a 503 instead of a silent false-success flip. Levels below
 *   raw (`off`, `on`) need no writer and are always honored.
 *
 * The level itself lives in the `debug` module global; the handlers are
 * returned as a pair so server.ts can mount each verb independently.
 */
export function makeLoggingHandlers(
  traceCaptureAvailable: boolean,
): LoggingHandlers {
  const getHandler = (c: Context): Response =>
    c.json({ level: levelName(debug.getLevel()) });

  const postHandler = async (c: Context): Promise<Response> => {
    // Total-safe parse: any body-read failure (malformed JSON, empty body,
    // wrong content-type) becomes a 400 — never a 500.
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body", valid: VALID_LEVELS }, 400);
    }

    const requested =
      typeof body === "object" && body !== null
        ? (body as { level?: unknown }).level
        : undefined;

    if (!isValidLevelName(requested)) {
      return c.json({ error: "invalid level", valid: VALID_LEVELS }, 400);
    }

    const previousLevel = debug.getLevel();
    const nextLevel = parseLevel(requested);

    // Honest signaling: raw/verbose need the trace writer, which is composed
    // into the pipeline (server.ts) only when it was created at boot. If it
    // was not (trace-dir creation failed), flipping to raw+ would be a silent
    // false-success — the level would read "raw" but nothing could ever be
    // written until restart. Refuse with a 503, leave the level untouched, and
    // emit NO PII warning (nothing was enabled). Levels below raw need no
    // writer and remain allowed.
    if (nextLevel >= LEVEL_RAW && !traceCaptureAvailable) {
      consola.warn(
        `POST /admin/logging refused: cannot enable "${requested}" — trace ` +
          "capture is structurally unavailable (trace writer not created at " +
          `boot); level left at "${levelName(previousLevel)}".`,
      );
      return c.json(
        {
          error:
            "trace capture unavailable: trace writer was not created at boot " +
            "(trace-dir creation failed); restart the proxy to enable capture",
          requested,
          valid: VALID_LEVELS,
        },
        503,
      );
    }

    const previous = levelName(previousLevel);
    debug.setLevel(nextLevel);
    // PII warning fires ONLY on the below-raw → raw+ enablement edge, so a
    // raw→raw / verbose→raw re-POST does not re-spam it (and a flip below raw
    // never warns).
    if (previousLevel < LEVEL_RAW && nextLevel >= LEVEL_RAW) {
      consola.warn(RAW_PII_WARNING);
    }
    return c.json({ previous, current: requested });
  };

  return { getHandler, postHandler };
}
