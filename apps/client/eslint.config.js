import { defineConfig } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';

import reactConfig from '@dorkos/eslint-config/react';
import testConfig from '@dorkos/eslint-config/test';

import fsd from './eslint-rules/fsd.js';

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

  // `sidebar.tsx` started as upstream shadcn's sidebar block, kept close to it
  // so an upstream fix stays easy to compare and replay — though DOR-1761 gave
  // it this repo's required TSDoc and edited two call sites, so "diff-able" is
  // now approximate, not literal. At 645 counted lines it is over the
  // `max-lines` bar for a reason that is not this repo's to fix.
  //
  // It is the ONLY carve-out now (DOR-1761). This block used to switch
  // `max-lines` AND both TSDoc rules off across `src/layers/shared/ui/**` on the
  // premise that the whole directory was vendored shadcn — true of maybe a third
  // of it. The rest is the client's most-imported public API, authored here:
  // `SidebarRow`, `IdentityAvatar`, `TrustDial`, `NavigationLayout`, `DataTable`,
  // the five `Responsive*` wrappers and ~60 more. Hard Rule 4 was off over
  // exactly the code that needed it most, and the bill came due as 63
  // undocumented exports and sixteen empty doc blocks.
  {
    files: ['src/layers/shared/ui/sidebar.tsx'],
    rules: { 'max-lines': 'off' },
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

  // FSD Layer Enforcement: shared/ cannot import higher layers, and inside
  // shared/ the lib barrel is not the way in (DOR-1761).
  //
  // `shared/lib/index.ts` re-exports ~150 symbols from ~60 modules, including
  // `HttpTransport`, `playCelebration`, `CelebrationEngine` and `queryClient`.
  // So `import { cn } from '@/layers/shared/lib'` inside a 20-line `OptionRow`
  // pulls a module graph that has nothing to do with merging class names — and
  // the barrel already documents that cost itself, at the line explaining why
  // `overnightBoundary` is deliberately left off it. The barrel is the contract
  // for consumers in `entities/`, `features/` and `widgets/`; within `shared/`,
  // import the leaf module. `cn` had three spellings before this and the one the
  // written rule endorsed was the expensive one.
  //
  // Tests are exempt: a spec may name the barrel as a string fixture, and one
  // (`lib/__tests__/one-verb-source.test.ts`) does.
  {
    files: ['src/layers/shared/**/*.{ts,tsx}'],
    ignores: ['src/layers/shared/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // `paths`, not `patterns`: a pattern group matches the barrel's
          // SUBPATHS too, which would ban the leaf modules this rule exists to
          // send people to. These are exact specifiers.
          paths: ['@/layers/shared/lib', './lib', '../lib', '../../lib'].map((name) => ({
            name,
            message:
              'Inside shared/, import the leaf module — `@/layers/shared/lib/utils` for cn. The lib barrel pulls the transport, the sound player and ~60 other modules in with it.',
          })),
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
            // Barrel-only, the other half of the DAG rule below. A sibling's
            // barrel is its contract; reaching past it couples you to its file
            // layout and hides the edge from anyone reading the graph.
            //
            // This does NOT reach `vi.mock('@/layers/entities/x/model/y')`,
            // which is a call rather than an import declaration — deliberate,
            // and the carve-out is written down in `.claude/rules/fsd-layers.md`.
            {
              group: ['@/layers/entities/*/**'],
              message:
                'FSD violation: import a sibling entity through its barrel (@/layers/entities/<slice>), never an internal path.',
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

  // FSD Slice Encapsulation (DOR-1010): a relative path may not leave its slice.
  //
  // Every `no-restricted-imports` block above matches the SPECIFIER as a string,
  // so it only ever sees the aliased spelling of a deep import. The identical
  // violation written relatively — `../../composer/ui/ClearArmedHint` from
  // `features/chat/ui/` — was reported by nobody, and two of them shipped in
  // test files before the DOR-946 review caught them by eye.
  //
  // A string pattern cannot close that hole, because whether `../../x` leaves
  // the slice depends on how deep the IMPORTING file sits, which the pattern
  // never sees: from `chat/ui/Foo.tsx` it is a neighbour's internals, from
  // `chat/ui/status/Foo.tsx` it is still `chat/`. That path arithmetic is the
  // whole rule, and it is why this one is local code rather than another entry
  // in the lists above.
  //
  // Unlike `import-x/no-cycle`, this rule resolves nothing and loads no plugin,
  // so it has no way to fail open — but `__tests__/cross-slice-import-lint.test.ts`
  // lints a real fixture through this config anyway, on the same reasoning: the
  // evidence that a guard works is a violation it catches, never a green run.
  {
    files: ['src/layers/**/*.{ts,tsx}'],
    plugins: { fsd },
    rules: { 'fsd/no-cross-slice-relative-import': 'error' },
  },

  ...testConfig,
]);
