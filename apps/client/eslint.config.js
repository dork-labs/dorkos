import { defineConfig } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

import reactConfig from '@dorkos/eslint-config/react';
import testConfig from '@dorkos/eslint-config/test';

// The TS preset's `extensions`/`parsers`/`external-module-folders` — the settings
// that let import-x parse a `.ts` dependency — minus its `import-x/resolver` key,
// which the DAG block below replaces with the `resolver-next` form. Deleting it
// rather than letting `resolver-next` outrank it keeps one resolver in the config
// instead of two, only one of which is live.
const importXTypeScriptSettings = { ...importX.flatConfigs.typescript.settings };
delete importXTypeScriptSettings['import-x/resolver'];

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

  // FSD Cross-Entity DAG (DOR-205): entity slices MAY depend on each other, but
  // the dependency graph must stay acyclic. The direction rule — composites
  // consume foundations, always through the barrel — is prose in
  // `.claude/rules/fsd-layers.md`, because a reviewer can judge direction.
  // What a reviewer cannot judge by eye is a circle that closes through three
  // or four slices, so that half is machine-checked here.
  //
  // Scoped to `src/layers/entities/**` deliberately: `no-cycle` walks the whole
  // reachable module graph from every file it lints, so widening it to all of
  // `src` multiplies lint time for no extra protection — a cycle that runs out
  // through features and back is already impossible, because entities may not
  // import features at all (the block above).
  //
  // `allowUnsafeDynamicCyclicDependency` stays off: a lazy `import()` back into
  // a caller is precisely the cycle being banned.
  //
  // The plugin is `eslint-plugin-import-x`, not the older `eslint-plugin-import`:
  // only import-x takes the resolver as an already-imported object, via
  // `resolver-next`. The older plugin can only be given a resolver's NAME, which
  // it then resolves from its own location — a lookup pnpm's strict
  // `node_modules` does not reliably allow.
  //
  // Which matters more than it sounds, because every piece of this block fails
  // OPEN. A missing parser setting, a resolver that does not load, a plugin that
  // cannot see its own dependency — none of them raise an error. They make
  // `no-cycle` skip the import and report success on a graph it never read. So a
  // green `pnpm lint` is NOT evidence this rule works; it is the expected output
  // either way. The evidence is `__tests__/entity-dag-lint.test.ts`, which lints
  // a real cycle through this config and fails if it stops being caught.
  {
    files: ['src/layers/entities/**/*.{ts,tsx}'],
    plugins: { 'import-x': importX },
    settings: {
      // `extensions`/`parsers` are what let the walk read a `.ts` dependency at
      // all; without them it stops at the first import.
      ...importXTypeScriptSettings,
      'import-x/resolver-next': [createTypeScriptImportResolver({ project: './tsconfig.json' })],
    },
    rules: {
      'import-x/no-cycle': [
        'error',
        { ignoreExternal: true, allowUnsafeDynamicCyclicDependency: false },
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
