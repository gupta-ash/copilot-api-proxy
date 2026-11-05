/**
 * debug.ts — leveled debug emission with strict lazy-eval semantics.
 *
 * 4 levels (numeric, ascending verbosity):
 *   LEVEL_OFF = 0      — silent
 *   LEVEL_ON = 1       — normal info / warn / error
 *   LEVEL_RAW = 2      — captures full request/response bodies
 *   LEVEL_VERBOSE = 3  — captures everything plus per-event SSE detail
 *
 * **LAZY-EVAL CONTRACT (Per L1 + Opus L1 review)**
 *
 * Every emission goes through a thunk: `debug.on(level, () => buildExpensiveMsg())`.
 * The thunk is *only* invoked when the current level threshold is met. This means
 * that callers MUST always wrap any non-trivial message construction (string
 * formatting, JSON.stringify, body inspection) in a closure — never compute it
 * eagerly. For especially expensive guards (large body deep-walk to format a
 * message), prefer the explicit double-guard pattern at the call site so the
 * closure itself isn't allocated:
 *
 *   if (debug.getLevel() >= LEVEL_RAW) debug.on(LEVEL_RAW, () => format(huge));
 *
 * Downstream M2+ subagents: do NOT regress to `consola.debug(format(huge))`.
 * That eagerly evaluates `format(huge)` even when `LEVEL_OFF` is set, defeating
 * the whole point of having a level system.
 *
 * Backed by `consola` for the actual emission so output ergonomics (colors,
 * timestamps, log routing) are consistent with the rest of the stack.
 *
 * **TWO GATES, ONE KEY (F244).** `on()` emits via `consola.debug`, which is a
 * `LogLevels.debug` (4) call - and consola applies its OWN level filter on top
 * of ours. consola defaults to 3, so for as long as nothing raised it, every
 * message that PASSED OUR OWN GATE was then silently discarded by consola.
 * Messages below the configured level never got that far - `on()` returns at
 * `currentLevel < level` before calling the factory - so those two populations
 * are different, and it was only the admitted one that was being thrown away.
 * (An earlier wording here said EVERY `debug.on` message was constructed and
 * passed our gate. That was false, and this same file already said so 100 lines
 * down: "At `LEVEL_OFF` the factory is never called.")
 * The net effect is unchanged and is the reason this matters: 62 call sites
 * across 18 files, unreachable from `config.logging.level` at ANY value, because
 * at every value a site is either blocked by our gate or dropped by consola's. Measured, not inferred - at
 * `CONSOLA_LEVEL=3` the line vanishes, at `4` it prints. The bug was invisible
 * because bootstrap output uses `consola.info/warn/error` (levels 0-3), which
 * were never filtered.
 *
 * `setLevel` therefore drives consola's level too, and that coupling lives HERE
 * rather than at the call sites so the two cannot drift apart again. It also
 * covers the `/admin/logging` runtime toggle (D69) - the one path whose entire
 * purpose is reaching `raw`/`verbose` without a restart, and which a fix
 * applied only in `main.ts` bootstrap would have left just as silent.
 */

import { LogLevels, consola } from "consola";

/** Emit nothing. */
export const LEVEL_OFF = 0 as const;
/** Emit normal info / warn / error. */
export const LEVEL_ON = 1 as const;
/** Emit full request/response bodies (file capture territory). */
export const LEVEL_RAW = 2 as const;
/** Emit per-event SSE detail and other firehose-volume traces. */
export const LEVEL_VERBOSE = 3 as const;

/** Numeric level constants — strictly ordered. */
export type Level =
  | typeof LEVEL_OFF
  | typeof LEVEL_ON
  | typeof LEVEL_RAW
  | typeof LEVEL_VERBOSE;

/** Human-readable level names accepted by `parseLevel`. */
export type LevelName = "off" | "on" | "raw" | "verbose";

let currentLevel: Level = LEVEL_ON;

/**
 * Parse a level name (case-insensitive) into the numeric constant.
 * Returns `LEVEL_ON` if the input is unrecognized (safe default).
 */
export function parseLevel(name: string): Level {
  switch (name.toLowerCase()) {
    case "off":
      return LEVEL_OFF;
    case "on":
      return LEVEL_ON;
    case "raw":
      return LEVEL_RAW;
    case "verbose":
      return LEVEL_VERBOSE;
    default:
      return LEVEL_ON;
  }
}

/**
 * Reverse of `parseLevel`: map a numeric level constant back to its
 * human-readable name. Total over the `Level` union (exhaustive switch), so
 * it needs no fallback. Used by the runtime logging toggle — the
 * `/admin/logging` GET/POST payloads + the switch-on PII warning.
 */
export function levelName(level: Level): LevelName {
  switch (level) {
    case LEVEL_OFF:
      return "off";
    case LEVEL_ON:
      return "on";
    case LEVEL_RAW:
      return "raw";
    case LEVEL_VERBOSE:
      return "verbose";
  }
}

/**
 * The consola level that lets our own gate be the only one that decides.
 *
 * `LEVEL_OFF` maps to `info` (3) and NOT to something quieter, deliberately:
 * consola has sat at 3 unconditionally, so `main.ts`'s nine `consola.info`
 * bootstrap messages - the config-path announce (F-DISC-11) and the
 * `listening on ...` banner at `main.ts:550` - print today even at
 * `logging.level: off`. Dropping below 3 would silently retire them, and both
 * `sigterm.test.ts` and the `:4144` gate harness detect boot by watching for
 * that banner. Quieting the process is not what this fix is for.
 *
 * Every other level maps to `debug` (4) - including `on`, whose 18
 * `debug.on(LEVEL_ON, ...)` sites are exactly as swallowed at consola 3 as the
 * verbose ones. The rule is: raise consola whenever OUR gate could pass
 * something through, and never lower what is visible today.
 */
export function consolaLevelFor(level: Level): number {
  return level === LEVEL_OFF ? LogLevels.info : LogLevels.debug;
}

/** A message factory: invoked lazily, returns the message to emit. */
export type MessageFn = () => string | unknown;

/**
 * The exported debug surface — controllable level, lazy-eval emit,
 * and a small set of helpers. Keep this surface minimal so M2+ rules
 * have one obvious way to wire diagnostics.
 */
export const debug = {
  /**
   * Emit a message at `level`. The message factory `msgFn` is only called
   * when `currentLevel >= level`. At `LEVEL_OFF` the factory is never called.
   */
  on(level: Level, msgFn: MessageFn): void {
    if (level === LEVEL_OFF) return;
    if (currentLevel < level) return;
    consola.debug(msgFn());
  },

  /**
   * Update the active level. Affects all subsequent `on()` calls.
   *
   * Also raises/lowers consola's own level (F244) - `on()` emits through
   * `consola.debug`, so without this our gate is not the deciding one and the
   * message is dropped after we let it through. See `consolaLevelFor`.
   */
  setLevel(level: Level): void {
    currentLevel = level;
    consola.level = consolaLevelFor(level);
  },

  /** Read the active level — useful for explicit double-guard at call sites. */
  getLevel(): Level {
    return currentLevel;
  },
};
