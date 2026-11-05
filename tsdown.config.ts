import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  outDir: "dist",
  target: "node20",
  clean: true,
  dts: false,
  sourcemap: true,
  // Keep node_modules external; the proxy is run with `bun` or `node` and
  // installs its own deps. Bundling them produces a 10MB+ artifact for no gain.
  external: [/^[a-z@]/],
});
