import { defineConfig } from 'eslint/config';
import baseConfig from '@dorkos/eslint-config/base';
import testConfig from '@dorkos/eslint-config/test';

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
  {
    files: ['src/**/*.ts'],
    ignores: ['src/zod-openapi.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@asteasolutions/zod-to-openapi',
              importNames: ['extendZodWithOpenApi'],
              message:
                "Import `extendZodWithOpenApiOnce` from './zod-openapi.js' instead — the raw extender skips the metadata-leak repair (DOR-1577).",
            },
          ],
        },
      ],
    },
  },

  ...testConfig,
]);
