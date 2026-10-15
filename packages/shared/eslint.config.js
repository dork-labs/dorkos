import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';
import testConfig from '@dorkos/eslint-config/test';

/** The raw zod-openapi extender is banned outside `src/zod-openapi.ts` (DOR-1577). */
const ZOD_OPENAPI_PATHS = [
  {
    name: '@asteasolutions/zod-to-openapi',
    importNames: ['extendZodWithOpenApi'],
    message:
      "Import `extendZodWithOpenApiOnce` from './zod-openapi.js' instead — the raw extender skips the metadata-leak repair (DOR-1577).",
  },
];

/** The config-schema section modules load only through `config-schema.ts`. */
const CONFIG_SCHEMA_SECTIONS = [
  {
    group: ['**/config-schema/*'],
    message:
      "Import from './config-schema.js' (or '@dorkos/shared/config-schema'). Loading a config-schema/ section module first throws a TDZ error through their import cycle.",
  },
];

export default defineConfig([
  { ignores: ['dist/**', '.turbo/**'] },
  ...baseConfig,

  // Zod schema collections — exempt from max-lines
  {
    files: ['src/schemas.ts', 'src/*-schemas.ts'],
    rules: { 'max-lines': 'off' },
  },

  // `extendZodWithOpenApi` has exactly one caller: `src/zod-openapi.ts`, which
  // wraps it in `extendZodWithOpenApiOnce` and repairs the metadata leak the
  // package ships with (DOR-1577 — see that module). Calling the raw extender
  // from a schema module works, which is the problem: it silently skips the
  // repair, and every schema that module annotates is then pinned in memory
  // for the life of the process.
  //
  // The `config-schema/` section modules are reached only through
  // `src/config-schema.ts`, which composes them. They import each other and
  // that file in a cycle that only evaluates cleanly when `config-schema.ts`
  // loads first: importing `config-schema/claude-accounts.js` or
  // `config-schema/runtime-settings.js` directly throws a TDZ ReferenceError at
  // load. ESLint replaces (never merges) a rule's options across blocks, so the
  // composing file and the section modules get their own block below, with the
  // same `paths` and without the pattern.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/zod-openapi.ts', 'src/config-schema.ts', 'src/config-schema/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: ZOD_OPENAPI_PATHS, patterns: CONFIG_SCHEMA_SECTIONS },
      ],
    },
  },
  {
    files: ['src/config-schema.ts', 'src/config-schema/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: ZOD_OPENAPI_PATHS }],
    },
  },

  ...testConfig,
]);
