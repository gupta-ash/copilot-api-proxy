/**
 * Extract an SSE response from an explicitly selected flow JSON file.
 *
 * Usage:
 *   bun run scripts/extract_replay_fixture.ts <flow.json> <upstream.sse>
 *
 * Both paths are required. The flow must contain a text/event-stream response
 * with body_kind="sse". response.body.raw_full is preferred; raw_first_2k is a
 * legacy prefix fallback, reported as truncated when raw_full_size exceeds it.
 * Output is UTF-8 SSE, without JSON wrapping or content redaction.
 *
 * Extraction is not permission to publish a capture. Public replay fixtures
 * must be independently authored synthetic examples, including requests,
 * response text, reasoning summaries, tool arguments, identifiers and metadata.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

interface CapturedFlow {
  response?: {
    status?: number;
    headers?: Record<string, string>;
    body_kind?: string;
    body?: {
      /** Complete SSE body; preferred over the legacy prefix. */
      raw_full?: string;
      /** Legacy prefix used only when raw_full is absent. */
      raw_first_2k?: string;
      raw_full_size?: number;
      total_lines?: number;
      event_counts?: Record<string, number>;
    };
  };
}

function fail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`extract_replay_fixture: ERROR — ${msg}`);
  process.exit(1);
}

function getContentType(headers: Record<string, string> | undefined): string {
  if (headers === undefined) return "";
  // headers may be lower-cased OR title-cased depending on the capture pipeline.
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === "content-type") return String(headers[k] ?? "");
  }
  return "";
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv.length !== 2) {
    fail(
      "usage: bun run scripts/extract_replay_fixture.ts <flow.json> <upstream.sse>",
    );
  }
  const flowPath = isAbsolute(argv[0]!) ? argv[0]! : resolve(argv[0]!);
  const outPath = isAbsolute(argv[1]!) ? argv[1]! : resolve(argv[1]!);

  let raw: string;
  try {
    raw = readFileSync(flowPath, "utf-8");
  } catch (e) {
    fail(`cannot read flow file ${flowPath}: ${(e as Error).message}`);
  }

  let flow: CapturedFlow;
  try {
    flow = JSON.parse(raw) as CapturedFlow;
  } catch (e) {
    fail(`flow file is not valid JSON: ${(e as Error).message}`);
  }

  const response = flow.response;
  if (response === undefined) fail("flow has no `response` field");

  const ct = getContentType(response.headers);
  if (!ct.toLowerCase().includes("text/event-stream")) {
    fail(
      `response content-type is "${ct}" — expected text/event-stream (this script only handles SSE captures)`,
    );
  }

  if (response.body_kind !== "sse") {
    fail(
      `response.body_kind is "${response.body_kind}" — expected "sse" (this script only handles SSE captures)`,
    );
  }

  const body = response.body;
  if (body === undefined) fail("response.body is missing");

  // Truncation applies only to the legacy prefix fallback.
  const sseBytes = body.raw_full ?? body.raw_first_2k;
  if (typeof sseBytes !== "string" || sseBytes.length === 0) {
    fail(
      "response.body.raw_full and response.body.raw_first_2k are both missing or empty — capture pipeline did not preserve SSE bytes",
    );
  }

  // Ensure parent directory exists. Operator may point output at a fresh
  // fixture directory.
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, sseBytes, "utf-8");

  const usedFullCapture = body.raw_full !== undefined;
  const fullSize = body.raw_full_size ?? sseBytes.length;
  // Truncation only applies to the legacy `raw_first_2k` fallback path: a
  // full-capture extraction is the WHOLE body and should never be flagged
  // truncated, even if `raw_full_size` (informational) differs slightly
  // from `raw_full.length` due to capture-pipeline accounting.
  const truncated = !usedFullCapture && fullSize > sseBytes.length;
  const eventTypes = body.event_counts
    ? Object.keys(body.event_counts).length
    : 0;
  const totalLines = body.total_lines ?? 0;

  // eslint-disable-next-line no-console
  console.log(
    `extract_replay_fixture: wrote ${outPath} (${sseBytes.length} bytes, ${eventTypes} event types, ${totalLines} lines${
      truncated
        ? `, TRUNCATED — full upstream body was ${fullSize} bytes; capture pipeline preserved only the first ${sseBytes.length}`
        : ""
    })`,
  );

  if (truncated) {
    // eslint-disable-next-line no-console
    console.log(
      "extract_replay_fixture: NOTE — fixture is a prefix of the full upstream stream. Full-byte parity requires an input containing response.body.raw_full.",
    );
  }
}

main();
