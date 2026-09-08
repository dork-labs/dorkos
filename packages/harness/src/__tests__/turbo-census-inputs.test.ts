/**
 * The turbo `inputs` override that lets the census see the files it reads.
 *
 * `capabilities-census.test.ts` reads five things that do not belong to
 * `@dorkos/harness`: the contract in `meta/`, the repo's shared comment
 * stripper, the server's harness tests, the two Codex skill readers, and the
 * CLI's `harness-sync*` tests. Turbo's `test`
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
 * Measured 2026-09-08 with each of the SIX foreign inputs touched one at a
 * time — seven runs counting the baseline: **without the override all seven
 * produce one identical hash** — the contract changed, the stripper changed, a
 * foreign test title changed, and turbo could not tell — **and with it all
 * seven differ.** That, not a digest, is the property.
 *
 * @module __tests__/turbo-census-inputs
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The repository root, four levels above this file. */
const ROOT = resolve(import.meta.dirname, '../../../..');

/** The package-scoped task key the override is written under. */
const TASK = '@dorkos/harness#test';

/**
 * Every input the override must name, and why.
 *
 * `$TURBO_DEFAULT$` is not decoration: a package-scoped `inputs` REPLACES the
 * default set rather than adding to it, so without it the package's own source
 * would stop being hashed and every harness change would replay a stale cache —
 * the exact bug this guard exists to prevent, pointed the other way.
 */
const REQUIRED_INPUTS: Readonly<Record<string, string>> = {
  $TURBO_DEFAULT$: "the package's own files, which an explicit `inputs` would otherwise replace",
  '$TURBO_ROOT$/meta/harness-sync-capabilities.md': 'the contract the census parses',
  '$TURBO_ROOT$/scripts/lib/code-only.mjs':
    'the shared stripper the census blanks comments with, so a title in a docstring is not coverage',
  '$TURBO_ROOT$/apps/server/src/services/harness/__tests__/**':
    'the server test titles the census reads',
  '$TURBO_ROOT$/apps/server/src/services/runtimes/codex/__tests__/scan-skill-commands.test.ts':
    "SK-08's titles, in the Codex palette reader",
  '$TURBO_ROOT$/apps/server/src/services/runtimes/codex/__tests__/skill-parity.test.ts':
    "J-15's titles, in the Codex parity reader",
  '$TURBO_ROOT$/packages/cli/src/__tests__/harness-sync*.test.ts':
    'the CLI test titles the census reads',
};

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
