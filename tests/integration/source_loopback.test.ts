import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { TokenManager } from "../../src/auth/token-manager.ts";
import { startServer, type ServerHandle } from "../../src/server.ts";
import { ConfigSchema } from "../../src/types/config-schema.ts";

// Real ephemeral loopback listener, not packaged main.ts and not a production port.
// Only token exchange is injected, through the existing TokenManager test interface.
test("source server reports its own identity and injected-auth readiness over loopback", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "copilot-source-loopback-"));
  const tokenPath = path.join(scratch, "github_token");
  let manager: TokenManager | undefined;
  let server: ServerHandle | undefined;
  try {
    await writeFile(tokenPath, "synthetic-source-loopback-token", { mode: 0o600 });
    manager = new TokenManager({
      githubTokenPath: tokenPath,
      accountType: "enterprise",
      vsCodeVersion: "1.95.0",
      fetchCopilotToken: async () => ({
        token: "synthetic-copilot-token",
        refresh_in: 3540,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });
    await manager.start();
    server = await startServer({
      host: "127.0.0.1",
      port: 0,
      config: ConfigSchema.parse({}),
      tokenManager: manager,
    });
    expect(server.port).toBeGreaterThan(0);
    const response = await fetch(`${server.url}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      proxy: "copilot-proxy",
      status: "ok",
      auth_status: "ready",
    });
    const metrics = await fetch(`${server.url}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toContain("text/plain");
    await metrics.text();
  } finally {
    manager?.dispose();
    try {
      await server?.close({ graceMs: 100 });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
});
