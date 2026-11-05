/**
 * Extract request.body from an explicitly selected, SHA-256-bound flow file.
 *
 * Usage:
 *   bun run scripts/extract_fixture.ts <capture.json> <output.json> <expected-upstream-sha256>
 *
 * The digest binds the exact input bytes; it does not establish permission to
 * publish them. This tool copies request content without redaction. Never use
 * capture extraction as a privacy gate: public fixtures must be independently
 * authored synthetic examples, not conversations with identifiers replaced.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function main(): void {
  const [capture, output, expectedSha, ...extra] = process.argv.slice(2);
  if (
    capture === undefined ||
    output === undefined ||
    expectedSha === undefined ||
    extra.length > 0 ||
    !/^[0-9a-f]{64}$/i.test(expectedSha)
  ) {
    throw new Error(
      "usage: bun run scripts/extract_fixture.ts <capture.json> <output.json> <expected-upstream-sha256> (64 hexadecimal digits)",
    );
  }
  const capturePath = resolve(capture);
  const outputPath = resolve(output);
  if (capturePath === outputPath) {
    throw new Error("capture input and output must be different files");
  }
  const bytes = readFileSync(capturePath);
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== expectedSha.toLowerCase()) {
    throw new Error(
      `upstream capture SHA-256 mismatch: expected=${expectedSha.toLowerCase()} got=${actualSha}`,
    );
  }
  const flow = JSON.parse(bytes.toString("utf-8")) as {
    request?: { body?: unknown };
  };
  const body = flow?.request?.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("expected capture request.body to be a JSON object");
  }
  writeFileSync(outputPath, JSON.stringify(body, null, 2) + "\n", "utf-8");
  // eslint-disable-next-line no-console
  console.log(`extract_fixture: wrote ${outputPath}; input SHA-256=${actualSha}`);
}

main();
