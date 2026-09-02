import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  // Core `eslint:recommended` (DOR-169). `eslint-config-next` brings its own
  // baseline and does NOT include this one, so until now the site was the one
  // package in the monorepo missing it — not just ESLint 10's new arrivals
  // (`preserve-caught-error`, `no-useless-assignment`, `no-unassigned-vars`) but
  // long-standing correctness rules like `no-dupe-keys` and `no-fallthrough`.
  //
  // FIRST in the array, before `nextTs`, and the order is load-bearing: core
  // recommended turns on `no-unused-vars` and `no-undef`, both of which are
  // wrong for TypeScript (the compiler owns them, and `no-undef` cannot see
  // ambient DOM types like `RequestInit`). typescript-eslint's overrides inside
  // `nextTs` switch them back off — but only for config that came before it.
  // Appending this at the end instead produced 170 errors, essentially all of
  // them those two rules firing on TS they should never have judged.
  js.configs.recommended,

  ...nextVitals,
  ...nextTs,
  // `eslint-config-next` pulls in eslint-plugin-react and leaves its version
  // setting unset, which means `'detect'` — and under ESLint 10 that crashes the
  // whole run before a single file is reported (DOR-169). The full explanation
  // lives beside the same setting in `packages/eslint-config/react.js`; the
  // short version is that the plugin resolves the version through
  // `context.getFilename()`, which ESLint 10 removed, and no released version of
  // the plugin fixes it. Keep this in step with `react` in `package.json`.
  { settings: { react: { version: '19.2' } } },

  {
    rules: {
      // Matches the monorepo-wide setting in `@dorkos/eslint-config/base`; see
      // the comment there for why the default is a bypass rather than a default.
      'preserve-caught-error': ['error', { requireCatchParameter: true }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'next-env.d.ts',
    // Generated folders:
    '.source/**',
    'coverage/**',
  ]),
]);

export default eslintConfig;
