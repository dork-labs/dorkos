/**
 * The turbo `inputs` override that lets the census see the files it reads.
 *
 * `capabilities-census.test.ts` reads six things that do not belong to
 * `@dorkos/harness`: the contract in `meta/`, the repo's shared comment
 * stripper, the server's harness tests, the harness ROUTE test (where TR-08
 * lives), the two Codex skill readers, and the CLI's `harness-sync*` tests.
 *
 * Two assertions, split by what knows the answer. The contract and the stripper
 * are named here one by one, because nothing else knows they are read at all.
 * The TEST ROOTS are checked against the census's own `TEST_ROOTS` — the same
 * list it walks — so a root added there requires its input here without
 * anybody remembering to edit two files. Turbo's `test`
 * task declares no `inputs`, so it is keyed on the package's own files — meaning
 * a renamed CLI test title, or a whole row deleted from the contract, would
 * change nothing turbo hashes and the merge queue's full sweep would REPLAY a
 * cached green over it. A cached
 * pass is indistinguishable from a real one in the log; that is the failure this
 * override exists to prevent, and `scripts/assert-tests-executed.sh` cannot see
 * it because the task really did execute, once, on the old inputs.
 *
 * So `turbo.json` carries a `"@dorkos/harness#test"` override naming those
 * paths beside `$TURBO_DEFAULT$`, and this file is what keeps it there. Dropping
 * an entry is invisible in every other way: the command still runs, still exits
 * 0, still prints an affected set.
 *
 * ## Why this lives here and not in `scripts/__tests__`
 *
 * The neighbouring turbo guard (`turbo-affected-base-pinned.test.ts`) is there,
 * and `scripts/` belongs to no workspace package — so `turbo test` never reaches
 * it and the one workflow that does is path-filtered to `scripts/**` with no
 * `merge_group:` trigger. `project-seam-guard.test.ts` moved out of that
 * directory for exactly this reason. In `@dorkos/harness`'s own suite this rides
 * `turbo test`, which is a required merge-queue check, and — because of the very
 * override it guards — it re-runs when any of the foreign paths changes.
 *
 * ## Proving it, without pinning a number
 *
 * The hashes themselves are machine-specific — every `globalPassThroughEnv`
 * value folds into them — so quoting one here would be a number that reds on
 * somebody else's laptop and says nothing when it does. What is portable is the
 * RELATIONSHIP, and it is reproducible in a minute:
 *
 * ```sh
 * h() { pnpm exec turbo run test --filter=@dorkos/harness --dry=json \
 *   | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
 *       const j=JSON.parse(s);console.log(j.tasks.find(t=>t.taskId==="@dorkos/harness#test").hash)})'; }
 * h                                                    # baseline
 * echo >> meta/harness-sync-capabilities.md && h       # differs WITH the override
 * sed -i '' -e '$d' meta/harness-sync-capabilities.md  # undo the one appended line
 * ```
 *
 * The undo is a `sed`, not a pathspec checkout: this repo's git-guard hook
 * refuses `git checkout -- <path>` outright, because it silently reverts
 * uncommitted work and has eaten some here (AGENTS.md Hard Rule 6). The first
 * draft of this recipe ended with one, and the hook blocked the very edit that
 * removed it. `echo` appends exactly one line, so dropping the last one puts
 * the file back.
 *
 * Measured 2026-09-08 with each of the six foreign inputs touched one at a
 * time — seven runs counting the baseline: **without the override all seven
 * produce one identical hash** — the contract changed, the stripper changed, a
 * foreign test title changed, and turbo could not tell — **and with it all
 * seven differ.** That, not a digest, is the property. A seventh input joined
 * them with TR-08 (DOR-1895) and was not re-measured: it is the same shape as
 * the entry above it, and the property being demonstrated is about the override
 * existing rather than about any one path in it.
 *
 * @module __tests__/turbo-census-inputs
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { TEST_ROOTS } from './census-test-roots.js';

/** The repository root, four levels above this file. */
const ROOT = resolve(import.meta.dirname, '../../../..');

/** The package-scoped task key the override is written under. */
const TASK = '@dorkos/harness#test';

/**
 * The inputs that are NOT test roots, named one by one because nothing else
 * knows they are read.
 *
 * `$TURBO_DEFAULT$` is not decoration: a package-scoped `inputs` REPLACES the
 * default set rather than adding to it, so without it the package's own source
 * would stop being hashed and every harness change would replay a stale cache —
 * the exact bug this guard exists to prevent, pointed the other way.
 *
 * The test roots are deliberately absent from this list; they are checked
 * against {@link TEST_ROOTS} instead.
 */
const REQUIRED_INPUTS: Readonly<Record<string, string>> = {
  $TURBO_DEFAULT$: "the package's own files, which an explicit `inputs` would otherwise replace",
  '$TURBO_ROOT$/meta/harness-sync-capabilities.md': 'the contract the census parses',
  '$TURBO_ROOT$/scripts/lib/code-only.mjs':
    'the shared stripper the census blanks comments with, so a title in a docstring is not coverage',
};

/**
 * The package this task belongs to. A root inside it is hashed by
 * `$TURBO_DEFAULT$` and needs no `$TURBO_ROOT$` entry of its own.
 */
const OWN_PACKAGE = 'packages/harness/';

/**
 * Whether some declared input makes turbo hash what is under one census root.
 *
 * A prefix test rather than a glob match, and that is the honest comparison: an
 * input may name the directory (`…/__tests__/**`), one file in it
 * (`…/harness.test.ts`), or a wildcard over it (`…/harness-sync*.test.ts`), and
 * all three mean "changes here change this task's hash". What is asserted is
 * that the root is REACHED, not that the glob is spelled a particular way.
 *
 * @param inputs - the override's declared inputs.
 * @param dir - one census root, repo-relative.
 * @returns true when at least one input reaches into that directory.
 */
function isHashed(inputs: readonly string[], dir: string): boolean {
  if (dir.startsWith(OWN_PACKAGE)) return true;
  return inputs.some((input) => input.startsWith(`$TURBO_ROOT$/${dir}/`));
}

/** The shape of the fields this guard reads out of a turbo task definition. */
interface TurboTask {
  /** What must build before the task runs. */
  dependsOn?: string[];
  /** Whether turbo may replay a previous run. */
  cache?: boolean;
  /** The file set the task's hash is computed over. */
  inputs?: string[];
}

/** `turbo.json`, parsed. */
function turbo(): { tasks?: Record<string, TurboTask> } {
  return JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8')) as {
    tasks?: Record<string, TurboTask>;
  };
}

describe('the census can see the files it reads', () => {
  it('is reading the real turbo.json, so a moved file cannot make this vacuous', () => {
    const tasks = turbo().tasks ?? {};
    expect(Object.keys(tasks).length).toBeGreaterThan(5);
    expect(tasks.test).toBeDefined();
  });

  it('names the contract and every foreign test path in @dorkos/harness#test inputs', () => {
    const override = turbo().tasks?.[TASK];

    expect(
      override,
      `${TASK} is gone from turbo.json. Without it the census is keyed on the harness ` +
        `package alone, and a changed contract or a renamed foreign test title replays a ` +
        `cached green in the merge queue.`
    ).toBeDefined();

    for (const [input, why] of Object.entries(REQUIRED_INPUTS)) {
      expect(override?.inputs, `${TASK} must hash ${input} — ${why}`).toContain(input);
    }
  });

  it('hashes every root the census reads titles out of', () => {
    // The half a hand-written list kept getting wrong. A fifth root was added to
    // the census and its turbo input beside it — but this guard's own copy of
    // the list was not, so deleting that input left the guard perfectly green
    // over the very hole it exists to close (DOR-1895 review). Reading the
    // census's own `TEST_ROOTS` makes "every root is hashed" a property rather
    // than a list somebody has to remember to extend twice.
    const inputs = turbo().tasks?.[TASK]?.inputs ?? [];
    expect(TEST_ROOTS.length).toBeGreaterThanOrEqual(5);

    const unhashed = TEST_ROOTS.filter((root) => !isHashed(inputs, root.dir)).map(
      (root) => root.dir
    );

    expect(
      unhashed,
      `The census reads test titles out of these directories and ${TASK} does not hash them, ` +
        `so a renamed title there replays a cached green in the merge queue. Add a ` +
        `\`$TURBO_ROOT$/<dir>/…\` entry to the override's \`inputs\` for each.`
    ).toEqual([]);
  });

  it('restates what the base test task declares, since the override replaces it', () => {
    // Measured, not assumed: a package-scoped `pkg#task` entry does NOT merge
    // with the base `test` definition. Written without these two lines, the
    // override left `@dorkos/harness#test` with an EMPTY `dependsOn` — so its
    // dependencies stopped building first and the suite would run against
    // whatever `dist/` happened to be lying around.
    const base = turbo().tasks?.test;
    const override = turbo().tasks?.[TASK];

    expect(base?.dependsOn).toEqual(['^build']);
    expect(override?.dependsOn).toEqual(base?.dependsOn);
    expect(override?.cache).toBe(base?.cache);
  });
});
