import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
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

  // The three rules ESLint 10 added to `eslint:recommended`, enabled by hand
  // (DOR-169). Every other package in this monorepo gets them through
  // `js.configs.recommended` in `@dorkos/eslint-config/base`; this app is the
  // one that does not extend it, because `eslint-config-next` brings its own
  // baseline and does NOT include core recommended. Without this block the
  // error-cause gate would cover the whole repo except the marketing site,
  // which is the kind of hole that only shows up the day it matters.
  {
    rules: {
      'preserve-caught-error': 'error',
      'no-useless-assignment': 'error',
      'no-unassigned-vars': 'error',
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
