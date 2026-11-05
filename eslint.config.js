// eslint.config.js — ESLint 9 flat config (CJS for max compatibility per M1b
// spec; we deliberately avoid eslint.config.ts to skip a tsx parser dep).
//
// Rules enforce the discipline already implicit in tsconfig.json:
//   - no-explicit-any (matches strict mode)
//   - no-unused-vars (matches noUnusedLocals/noUnusedParameters)
//   - no-floating-promises (catches lib code that forgets to await)
//   - import/order (predictable import grouping for diffs)
//   - no-console: warn (use lib/debug.ts, not console.log)
//
// Type-aware rules need parserOptions.project pointing at tsconfig.json.

import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import importPlugin from "eslint-plugin-import";

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".husky/**",
      ".github/**",
      "config/**",
      "eslint.config.js",
    ],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      import: importPlugin,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "import/order": [
        "error",
        {
          "newlines-between": "always",
          groups: [
            "builtin",
            "external",
            "internal",
            "parent",
            "sibling",
            "index",
          ],
        },
      ],
      "no-console": "warn",
    },
  },
];
