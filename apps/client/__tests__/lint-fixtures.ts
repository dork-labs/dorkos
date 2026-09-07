/**
 * The lint guards' fixture slices, written once per run instead of once per suite.
 *
 * Two suites — `entity-dag-lint.test.ts` and `cross-slice-import-lint.test.ts` —
 * prove that rules in `eslint.config.js` really fire, and both rules are scoped
 * by PATH (`src/layers/entities/**`, `src/layers/**`) and resolve `@/` through
 * the app's own tsconfig. A fixture outside `src/` is matched by no `files:`
 * glob, so every assertion would pass on a file the rule never read — which is
 * the exact fail-open both suites exist to catch. The fixtures therefore have to
 * live in the real source tree, and that is not the part being fixed here.
 *
 * **What was wrong was the timing** (DOR-1821). Each suite created its slices in
 * `beforeAll` and removed them in `afterAll`, so `src/` gained and lost
 * directories WHILE other test files were running. Eight guard suites walk
 * `src/` with `readdirSync` + `statSync` — `one-config-query-key`,
 * `one-error-one-toast`, `no-transition-all`, `one-verb-source`,
 * `surface-enablement`, `no-inline-session-panel`, `agent-overload-sweep` and
 * `tour-anchors` — and a walker that has already listed a directory and then
 * stats it after the teardown removed it dies on `ENOENT`. Measured on `main`:
 * `ENOENT: no such file or directory, stat '…/src/layers/features/__slice-fixture-a__'`.
 * The failure lands in whichever file happened to be walking, so it reddens a
 * run with no relationship to what changed.
 *
 * Creation was never the hazard — `readdirSync` returns a snapshot, so an entry
 * that appears afterwards is simply not in it. Only REMOVAL can invalidate a
 * name a walker is already holding. So the fix is to move both halves outside
 * the window in which any test file runs: Vitest's `globalSetup` writes the
 * slices before a single worker starts and removes them after the last one has
 * finished. Within one invocation no walker, present or future, can observe the
 * transition — a stronger guarantee than teaching each of the eight walkers to
 * skip a name, because it needs nothing of a walker that has not been written
 * yet.
 *
 * **Within one invocation is the whole of the guarantee, and the rest is worth
 * writing down.** Two concurrent client runs in one checkout still collide:
 * measured, run B's `setup` and `teardown` delete the slices under run A, and
 * run A fails two tests. Nothing here serializes them, and nothing here can —
 * the fixtures are a fixed path in a shared tree. The realistic way to meet it
 * is a targeted `pnpm vitest run apps/client/…` started while the lefthook
 * pre-push gate is already running the client suite, so prefer waiting for the
 * gate. This is not a regression: two runs raced over these same paths before,
 * on a narrower window. It is the residual the repo's "one checkout, one
 * writer" rule already covers, and a lockfile was judged more machinery than
 * that residual is worth.
 *
 * The fixture CONTENT is byte-for-byte what the two suites wrote themselves, so
 * neither guard's meaning changed. What did change is how long the slices are
 * resident, and every OTHER consumer of `src/` had to be told:
 *
 * - `vite.config.ts` excludes them from test collection — one of them is a
 *   `.test.ts` on purpose, to prove the rule reads `vi.mock` specifiers.
 * - `eslint.config.js` ignores them, or a `pnpm lint` overlapping a run reports
 *   seven errors nobody wrote. The two guards still lint them, through an
 *   `ESLint` constructed with `ignore: false`.
 * - `tsconfig.json` excludes them, or `tsc --noEmit` exits 2 on three: the cycle
 *   gives `x` and `y` implicit `any` returns, and `vi` is a global only Vitest
 *   supplies. A run killed before its teardown leaves those behind indefinitely.
 *
 * `.gitignore` carries both fixture globs, so an interrupted run cannot leave
 * anything committable, and `setup` clears leftovers before writing.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `apps/client`.
 *
 * From `import.meta.url` rather than `__dirname`, which this module cannot rely
 * on: Vitest loads a `globalSetup` file as an ES module in the main process, not
 * through the test transform that gives the suites beside it a CommonJS shim.
 */
const CLIENT_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

/** `apps/client/src/layers`. */
const LAYERS = resolve(CLIENT_ROOT, 'src/layers');

/**
 * Every fixture slice root, for teardown and for the leftover sweep.
 *
 * Kept in sync with `.gitignore`, which carries a glob for each shape.
 */
const FIXTURE_ROOTS = [
  resolve(LAYERS, 'entities/__dag-fixture-x__'),
  resolve(LAYERS, 'entities/__dag-fixture-y__'),
  resolve(LAYERS, 'entities/__dag-fixture-ok__'),
  resolve(LAYERS, 'features/__slice-fixture-a__'),
  resolve(LAYERS, 'features/__slice-fixture-b__'),
  resolve(LAYERS, 'shared/__slice-fixture-segment__'),
];

/**
 * Every fixture file, as a path under `src/layers/` and its exact source text.
 *
 * The DAG slices come first.
 *
 * x and y close a circle through each other's BARRELS, via the `@/` alias, and
 * that shape is the point: a two-file relative cycle (`a.ts` <-> `b.ts`) is
 * depth 1 and would stay green under a `maxDepth: 1` rule option while every
 * genuine cycle went undetected. Every real cross-entity cycle closes through
 * the alias and two barrels, so this one does too — a depth-4 walk that also
 * proves alias resolution works.
 *
 * The slices sit at the TOP level of `entities/`, not nested under one fixture
 * root, because a nested `@/layers/entities/__dag-fixture__/y` would itself trip
 * the barrel-only restriction in `eslint.config.js`. Real slices are top-level;
 * the fixture matches.
 *
 * The slice-encapsulation fixtures follow. Each one is a DISCRIMINATION, not a
 * smoke test: a rule that simply banned `../../` would pass `Bad.ts` and
 * `mock.test.ts` while breaking `Ok.ts`, `Deep.ts` and `uses-lib.ts` — and those
 * three are ordinary, deliberate, and everywhere in this codebase.
 */
const FIXTURE_FILES: ReadonlyArray<readonly [path: string, source: string]> = [
  // The cycle, and the control that closes no circle back.
  ['entities/__dag-fixture-x__/index.ts', "export { x } from './model/x';\n"],
  [
    'entities/__dag-fixture-x__/model/x.ts',
    "import { y } from '@/layers/entities/__dag-fixture-y__';\nexport const x = () => y();\n",
  ],
  ['entities/__dag-fixture-y__/index.ts', "export { y } from './model/y';\n"],
  [
    'entities/__dag-fixture-y__/model/y.ts',
    "import { x } from '@/layers/entities/__dag-fixture-x__';\nexport const y = () => x();\n",
  ],
  ['entities/__dag-fixture-ok__/index.ts', "export { ok } from './model/ok';\n"],
  [
    'entities/__dag-fixture-ok__/model/ok.ts',
    "import { sessionKeys } from '@/layers/entities/session';\nexport const ok = () => sessionKeys;\n",
  ],
  // The direction rule's other machine-checked half: siblings are reachable only
  // via their barrel, so a deep import past one is an error.
  [
    'entities/__dag-fixture-ok__/model/deep.ts',
    "import { sessionKeys } from '@/layers/entities/session/api/query-keys';\nexport const deep = () => sessionKeys;\n",
  ],

  // The neighbour being reached into. Real, so the fixture is a genuine
  // resolvable import and not a dangling string.
  ['features/__slice-fixture-b__/ui/Thing.ts', 'export const thing = 1;\n'],
  ['features/__slice-fixture-b__/model/rule.ts', 'export const rule = 2;\n'],
  [
    'features/__slice-fixture-b__/index.ts',
    "export { thing } from './ui/Thing';\nexport { rule } from './model/rule';\n",
  ],
  // Slice A's own internals, at two depths.
  ['features/__slice-fixture-a__/model/state.ts', 'export const state = 1;\n'],
  [
    'features/__slice-fixture-a__/ui/Bad.ts',
    "import { thing } from '../../__slice-fixture-b__/ui/Thing';\nexport const bad = () => thing;\n",
  ],
  [
    'features/__slice-fixture-a__/ui/Ok.ts',
    "import { state } from '../model/state';\nimport { thing } from '@/layers/features/__slice-fixture-b__';\nexport const ok = () => state + thing;\n",
  ],
  // A path to the repo-root `scripts/` directory, which is what the four
  // source-scanning guards here do to reach the shared stripper. There is no
  // slice at the other end, so there is nothing for the rule to be about.
  [
    'features/__slice-fixture-a__/ui/OutsideSrc.ts',
    "import { codeOnly } from '../../../../../../../scripts/lib/code-only.mjs';\nexport const outside = codeOnly;\n",
  ],
  // Its discriminator, and the reason that exemption is a PREFIX and not
  // "anything outside src/": this leaves `src/` by the identical number of
  // hops, and it is a deep relative import into another workspace package with
  // a correct aliased spelling to be redirected to.
  [
    'features/__slice-fixture-a__/ui/OutsidePackage.ts',
    "import type { Transport } from '../../../../../../../packages/shared/src/transport';\nexport type T = Transport;\n",
  ],
  // Nested one segment deeper, so `../../` still lands inside slice A. This is
  // the case a depth-counting string pattern gets wrong.
  [
    'features/__slice-fixture-a__/ui/status/Deep.ts',
    "import { state } from '../../model/state';\nexport const deep = () => state;\n",
  ],
  [
    'features/__slice-fixture-a__/__tests__/mock.test.ts',
    "vi.mock('../../__slice-fixture-b__/ui/Thing', () => ({ thing: 2 }));\nexport const mocked = 1;\n",
  ],
  // Feature model isolation (DOR-1284). Four fixtures, because the rule has to
  // separate the sibling's private wiring from three things that are ordinary:
  // the same feature's own model reached by the alias, the sibling's public
  // barrel, and a UI file doing the very thing model code may not.
  [
    'features/__slice-fixture-a__/model/CrossFeatureModel.ts',
    "import { rule } from '@/layers/features/__slice-fixture-b__/model/rule';\nexport const bad = () => rule;\n",
  ],
  [
    'features/__slice-fixture-a__/model/OwnModelByAlias.ts',
    "import { state } from '@/layers/features/__slice-fixture-a__/model/state';\nexport const own = () => state;\n",
  ],
  [
    'features/__slice-fixture-a__/model/SiblingBarrel.ts',
    "import { rule } from '@/layers/features/__slice-fixture-b__';\nexport const viaBarrel = () => rule;\n",
  ],
  [
    'features/__slice-fixture-a__/model/ReachesWidget.ts',
    "import { AppLayout } from '@/layers/widgets/app-layout';\nexport const reaches = AppLayout;\n",
  ],
  [
    'features/__slice-fixture-a__/ui/UiReachesSiblingModel.ts',
    "import { rule } from '@/layers/features/__slice-fixture-b__/model/rule';\nexport const fromUi = () => rule;\n",
  ],

  // `shared/` is sliceless: its top-level directories are segments, so a
  // relative hop between them stays inside the unit.
  [
    'shared/__slice-fixture-segment__/uses-lib.ts',
    "import { cn } from '../lib/utils';\nexport const usesLib = cn;\n",
  ],
];

/** Remove every fixture slice, whether or not this run wrote it. */
function clear(): void {
  for (const root of FIXTURE_ROOTS) rmSync(root, { recursive: true, force: true });
}

/**
 * Write every fixture slice into the source tree, before any worker starts.
 *
 * Vitest calls this once per run. Leftovers from a run that was killed before
 * its teardown are cleared first, so a stale slice can never make a guard read
 * yesterday's fixture.
 */
export function setup(): void {
  clear();
  for (const [path, source] of FIXTURE_FILES) {
    const absolute = resolve(LAYERS, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, source, 'utf-8');
  }
}

/**
 * Remove every fixture slice, after the last worker has finished.
 *
 * This is the half that used to race: the removal is what invalidates a name a
 * concurrent `readdirSync` walk is already holding, and here there is no
 * concurrent walk left to invalidate.
 */
export function teardown(): void {
  clear();
}
