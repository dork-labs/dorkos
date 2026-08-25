import { defineConfig } from 'eslint/config';
import reactConfig from '@dorkos/eslint-config/react';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  // `.yalc/**` holds local co-dev overlays of published packages (e.g. an
  // in-flight blintz build); it is gitignored and must not be linted.
  { ignores: ['dist/**', '.turbo/**', '.yalc/**'] },
  ...reactConfig,

  // Shadcn vendored components — exempt from max-lines and JSDoc rules
  {
    files: ['src/layers/shared/ui/**/*.{ts,tsx}'],
    rules: {
      'max-lines': 'off',
      'jsdoc/require-jsdoc': 'off',
      'jsdoc/require-description': 'off',
    },
  },

  // process.env carve-outs (client-specific)
  {
    files: ['**/env.ts', '**/*.config.ts', '**/__tests__/**', '**/*.test.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // The Transport port is the ONLY way this package reaches a backend (DOR-691).
  //
  // `DirectTransport` is deliberately in-process, and the temptation it creates
  // is real: the embed's search seam is a server service, so "just import it"
  // looks like one line. It is not — it is the client learning what a backend is,
  // which is the separation `contributing/architecture.md` is built on and the
  // reason a seam is INJECTED by the host instead. Nothing in `apps/client` may
  // name the server, in production code or in a test.
  //
  // The typescript-eslint copy of the rule rather than the base one, because the
  // base `no-restricted-imports` is already configured per-FSD-layer below and a
  // second block would silently replace those patterns rather than add to them.
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@dorkos/server',
                '@dorkos/server/*',
                '**/apps/server/**',
                '**/server/src/**',
              ],
              message:
                'The client never imports the server. Reach a backend through the Transport port; an in-process service is INJECTED by the embedding host (see DirectTransportServices).',
            },
          ],
        },
      ],
    },
  },

  // FSD Layer Enforcement: shared/ cannot import higher layers
  {
    files: ['src/layers/shared/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/layers/entities/*', '@/layers/entities'],
              message: 'FSD violation: shared/ cannot import from entities/',
            },
            {
              group: ['@/layers/features/*', '@/layers/features'],
              message: 'FSD violation: shared/ cannot import from features/',
            },
            {
              group: ['@/layers/widgets/*', '@/layers/widgets'],
              message: 'FSD violation: shared/ cannot import from widgets/',
            },
          ],
        },
      ],
    },
  },

  // FSD Layer Enforcement: entities/ cannot import features or widgets
  {
    files: ['src/layers/entities/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/layers/features/*', '@/layers/features'],
              message: 'FSD violation: entities/ cannot import from features/',
            },
            {
              group: ['@/layers/widgets/*', '@/layers/widgets'],
              message: 'FSD violation: entities/ cannot import from widgets/',
            },
          ],
        },
      ],
    },
  },

  // FSD Layer Enforcement: features/ cannot import widgets
  {
    files: ['src/layers/features/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@/layers/widgets/*', '@/layers/widgets'],
              message: 'FSD violation: features/ cannot import from widgets/',
            },
          ],
        },
      ],
    },
  },

  ...testConfig,
]);
