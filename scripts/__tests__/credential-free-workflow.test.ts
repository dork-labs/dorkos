/**
 * Drift guard for `.github/workflows/credential-free-build.yml` (DOR-2081).
 *
 * That workflow is the only proof this repo has that it clones, builds, tests
 * and runs with no hosted-side credentials — the promise the open-source app
 * makes and the one the hosted-side programme is gated on. Two ways of breaking
 * it are completely silent, and neither is caught by anything else in CI:
 *
 *  1. **Losing a trigger.** A required status check whose workflow has no
 *     `merge_group:` trigger never reports inside the merge queue, so every
 *     pull request waits for it until `check_response_timeout_minutes` expires
 *     — the queue stalls rather than going red. Losing `pull_request:` is the
 *     mirror image: GitHub refuses to enqueue a PR whose required check never
 *     succeeded on the PR itself (measured on PR #1246, which sat armed, green
 *     and unqueueable for 15 hours). Either edit leaves a perfectly valid
 *     workflow file that keeps passing on the event it still has.
 *
 *  2. **Running a command outside the scrub.** The job's whole content is
 *     "these commands, in an environment with the hosted-side variables
 *     removed". Drop the `scripts/run-credential-free.sh` prefix from one step
 *     and that step runs in the ambient environment: nothing fails, the check
 *     stays green, and it silently stops being a credential-free build. On a
 *     runner with no secrets wired in, the two are indistinguishable from the
 *     log — which is exactly why it has to be asserted from the file.
 *
 *  3. **Letting the ceiling drift past the queue's own window.** A ceiling
 *     above the queue's `check_response_timeout_minutes` stalls every PR for
 *     the whole window instead of going red. It is a one-character edit that
 *     changes no output until the day a run hangs, so it is pinned below.
 *
 *  4. **Losing the ground the unit suites stand on.** This job no longer runs
 *     the unit suites (ledger 260919-175501): test.yml runs them, on runners
 *     where no hosted-side variable is set. That is true only while test.yml
 *     sets none and reads no secret, so that is pinned too. If it ever has to
 *     change, the unit suites belong back under the scrub, here or there.
 *
 * Same shape of guard, for the same reason, as `vitest-flake-reporter.test.ts`
 * beside it: a flag or a trigger whose absence changes no output has to be
 * pinned by a test, because nothing else will ever notice. It reads the
 * workflow as text rather than parsing YAML — this directory has no YAML
 * dependency, the assertions are about the presence of specific lines, and a
 * parser would add a dependency to check less.
 *
 * `.github/workflows/credential-free-build.yml` is in the scope list that
 * starts scripts-test.yml's `harness` job (scripts/scripts-test-scope.sh), so
 * the one PR shape these regressions take — an edit to that workflow alone —
 * triggers the job that runs this file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const WORKFLOW_REL = '.github/workflows/credential-free-build.yml';
const SCRUB_REL = 'scripts/run-credential-free.sh';

const TEST_WORKFLOW_REL = '.github/workflows/test.yml';

const workflow = readFileSync(path.join(repoRoot, WORKFLOW_REL), 'utf8');

/**
 * The scrub's variable-name patterns, read from `CLOUD_ENV_PATTERNS` in
 * scripts/run-credential-free.sh and turned into anchored regexes (`*` is the
 * only glob character the list uses).
 */
function scrubPatterns(): RegExp[] {
  const script = readFileSync(path.join(repoRoot, SCRUB_REL), 'utf8');
  const block = script.match(/^CLOUD_ENV_PATTERNS=\(\n([\s\S]*?)^\)/m)?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map(
    (m) => new RegExp(`^${(m[1] as string).replace(/\*/g, '.*')}$`)
  );
}

/**
 * Every `run:` command in the workflow, as single-line strings.
 *
 * Deliberately naive: each `run:` here is a one-liner, and the assertion below
 * is that they all start with the scrub. A multi-line `run: |` block would read
 * as a single entry whose first line is `|`, which fails this test rather than
 * passing it by accident — the safe direction, and a prompt to think about
 * whether a block script belongs in scripts/ with fixtures of its own.
 */
function runCommands(): string[] {
  return [...workflow.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => (m[1] as string).trim());
}

describe('credential-free-build workflow', () => {
  it('declares both the pull_request and merge_group triggers', () => {
    // Matched against the `on:` block specifically, so a `merge_group` word
    // appearing in the header prose cannot satisfy this.
    const onBlock = workflow.match(/^on:\n((?:[ \t]+.*\n|\n)*)/m)?.[1] ?? '';
    expect(
      onBlock,
      `${WORKFLOW_REL} has no parseable \`on:\` block — this guard cannot check its triggers.`
    ).not.toBe('');
    expect(
      /^\s+pull_request:/m.test(onBlock),
      `${WORKFLOW_REL} lost its \`pull_request:\` trigger. A required check that never ` +
        `succeeds ON the pull request keeps that PR out of the merge queue entirely (PR #1246).`
    ).toBe(true);
    expect(
      /^\s+merge_group:/m.test(onBlock),
      `${WORKFLOW_REL} lost its \`merge_group:\` trigger. A required check that never reports ` +
        `INSIDE the queue stalls the queue for an hour on every entry (contributing/ci.md).`
    ).toBe(true);
    // Having both triggers is not enough, and this is the half a "did it
    // declare merge_group?" check misses: a workflow SKIPPED by a path filter
    // reports NOTHING — not success — so the required context never arrives and
    // the queue waits it out, which is the same stall by another route. The
    // scope decision belongs inside the job, as a step `if:`, where a skipped
    // step still leaves the context reported (site-build.yml's header).
    expect(
      /^\s+paths(-ignore)?:/m.test(onBlock),
      `${WORKFLOW_REL} gained a workflow-level \`paths:\` filter. A path-filtered workflow ` +
        `reports nothing at all rather than success, so the check never arrives and the merge ` +
        `queue waits for it. Scope inside the job with a step \`if:\` instead.`
    ).toBe(false);
  });

  it('runs every command through the credential-free scrub', () => {
    const commands = runCommands();
    // An exact count, not a lower bound: the number is knowable, and a bound
    // would let three scrubbed steps be deleted while this assertion stayed
    // green. Change it deliberately when you add or remove a step.
    expect(
      commands.length,
      `${WORKFLOW_REL} has ${commands.length} \`run:\` steps, expected 5. If you added or ` +
        `removed one on purpose, update this number; if you did not, a step went missing.`
    ).toBe(5);
    const unscrubbed = commands.filter((c) => !c.startsWith(`bash ${SCRUB_REL}`));
    expect(
      unscrubbed,
      `${unscrubbed.length} step(s) in ${WORKFLOW_REL} do not run through \`bash ${SCRUB_REL}\`: ` +
        `${unscrubbed.join(' | ')}. Each one runs in the ambient environment, so the check ` +
        `keeps passing while it silently stops proving anything about an unset variable.`
    ).toEqual([]);
  });

  it('runs the boot probe on both events, not only in the queue', () => {
    // The probe is this job's unique coverage — nothing else in CI starts the
    // server without credentials — so a future cost trim that gates it to
    // `merge_group` would leave the pull-request leg with no boot path at all.
    // The step is identified by the script it runs; its `if:` would sit on the
    // line above it, so an unconditional step is one whose preceding line is
    // the step's own `name:`.
    const probeStep = workflow.match(
      /^\s+- name: [^\n]*\n(?:\s+if: [^\n]*\n)?\s+run: .*credential-free-smoke\.sh.*$/m
    );
    expect(
      probeStep,
      `${WORKFLOW_REL} no longer runs scripts/credential-free-smoke.sh — the boot probe is the ` +
        `only place in CI that starts the server with no hosted-side variable set.`
    ).not.toBeNull();
    expect(
      /\n\s+if: /.test(probeStep?.[0] ?? ''),
      `the boot-probe step in ${WORKFLOW_REL} gained an \`if:\` condition. It must run on both ` +
        `\`pull_request\` and \`merge_group\`: gating this job's unique coverage to the queue ` +
        `leaves the author's own PR with no credential-free boot signal at all.`
    ).toBe(false);
  });

  // A queue run that can be cancelled by a newer one is the stall this whole
  // workflow's header argues against, wearing a different hat: the context
  // never arrives, so the queue waits out `check_response_timeout_minutes`
  // instead of going red. Today two queue runs cannot share the group at all
  // (the `gh-readonly-queue/main/pr-<n>-<sha>` ref is unique per batch), but
  // that is a property of GitHub's ref naming, not of this file, and the line
  // that makes it safe HERE is the event-conditional `cancel-in-progress`.
  // Flatten that to a bare `true` — the obvious "simplification" — and every
  // one of those properties goes at once, silently, on a workflow that still
  // passes.
  it('keeps a job ceiling that is under the merge queue`s own check window', () => {
    // The queue's `check_response_timeout_minutes` is 120, read off the live
    // branch ruleset. A job permitted to outlive it does not go red — it holds
    // every PR behind it for the full window, which is strictly worse than
    // failing. The lower bound keeps a cold, whole-monorepo build+typecheck+lint
    // (estimated near 16 minutes on a runner, plus the CLI build and the boot
    // probe) well inside the ceiling, so a hang goes red and a slow run does not.
    // There is exactly one uncommented `timeout-minutes:` in this workflow and
    // it is the job's. Asserting the count keeps that true: a step-level
    // timeout added above the job key would otherwise silently retarget this.
    const all = [...workflow.matchAll(/^\s*timeout-minutes:\s*(\d+)\s*$/gm)];
    expect(
      all.length,
      `${WORKFLOW_REL} declares ${all.length} \`timeout-minutes\` keys; this pin assumes exactly one, the job's.`
    ).toBe(1);
    const declared = all[0]?.[1];

    expect(
      declared,
      `${WORKFLOW_REL} declares no job-level \`timeout-minutes\` — an untimed job can stall the queue.`
    ).toBeDefined();
    // The floor is about twice that estimate; the roof is the queue's window.
    expect(Number(declared)).toBeGreaterThanOrEqual(30);
    expect(Number(declared)).toBeLessThan(120);
  });

  it('does not re-run the unit suites, and test.yml runs them with no hosted variable', () => {
    // The unit suites run in test.yml's `test-shard`, which in the queue
    // retries once, names every retried test and applies the quarantine lane.
    // A second, unprotected copy here only re-ran the same suites in the same
    // environment and ejected queue builds on flakes the shards had absorbed
    // (ledger 260919-175501). This keeps it from coming back by accident.
    const testSteps = runCommands().filter((c) => /\bturbo\b.*\btest\b/.test(c));
    expect(
      testSteps,
      `${WORKFLOW_REL} runs the unit suites again (${testSteps.join(' | ')}). test.yml ` +
        `already runs them; see "WHY THE UNIT SUITES ARE NOT RUN HERE" in its header.`
    ).toEqual([]);

    // What makes that safe: test.yml's runners have no hosted-side variable,
    // because the workflow sets none and reads no secret. A `secrets.` or
    // `vars.` line, or an `env:` key from the scrub's list, would let a unit
    // test pass only because a hosted credential was present, and nothing
    // would say so. The patterns come from the scrub script itself, so the
    // two lists cannot drift apart.
    const testWorkflow = readFileSync(path.join(repoRoot, TEST_WORKFLOW_REL), 'utf8');
    const code = testWorkflow
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const secretRefs = [...code.matchAll(/\b(?:secrets|vars)\.[A-Za-z0-9_]+/g)].map((m) => m[0]);
    expect(
      secretRefs,
      `${TEST_WORKFLOW_REL} now reads ${secretRefs.join(', ')}. The unit suites no longer run ` +
        `under the credential-free scrub, so they are credential-free only while test.yml ` +
        `reads no secret. Put the suites back under scripts/run-credential-free.sh first.`
    ).toEqual([]);
    const patterns = scrubPatterns();
    expect(patterns.length, `could not read the scrub patterns from ${SCRUB_REL}.`).toBeGreaterThan(
      5
    );
    const envKeys = [...code.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1] as string);
    const hosted = envKeys.filter((name) => patterns.some((re) => re.test(name)));
    expect(
      hosted,
      `${TEST_WORKFLOW_REL} sets hosted-side variable(s) ${hosted.join(', ')}. The unit suites ` +
        `run there without the credential-free scrub, so this would let a test depend on one.`
    ).toEqual([]);
  });

  it('never cancels a merge-group run in progress', () => {
    const block = workflow.match(/^concurrency:\n((?:[ \t]+.*\n)+)/m)?.[1] ?? '';
    expect(
      block,
      `${WORKFLOW_REL} has no parseable \`concurrency:\` block — this guard cannot check it.`
    ).not.toBe('');
    const cancel = block.match(/^\s+cancel-in-progress:\s*(.+)$/m)?.[1]?.trim() ?? '';
    expect(
      cancel.replace(/\s+/g, ' '),
      `${WORKFLOW_REL} set \`cancel-in-progress: ${cancel}\`. It must stay conditional on the ` +
        `event: a cancelled merge-group run never reports \`credential-free-build\` inside the ` +
        `queue, and an unreported check is a stall rather than a red.`
    ).toBe("${{ github.event_name == 'pull_request' }}");
  });

  // The cache is the only reason this job finishes at all — before it, every
  // run logged `Cached: 0 cached` and was torn down mid-build. Two ways to
  // break it leave a green workflow: drop the save (nothing is ever written,
  // every run is cold, and the only symptom is slowness) or loosen the
  // restore-keys past the lockfile hash (entries from before a dependency bump
  // start being downloaded into a tree whose dependencies have moved).
  it('caches turbo locally, keyed so a lockfile change cannot restore a stale entry', () => {
    const KEY = "turbo-credential-free-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}";
    for (const action of ['actions/cache/restore@v6', 'actions/cache/save@v6']) {
      expect(
        workflow.includes(`uses: ${action}`),
        `${WORKFLOW_REL} no longer uses \`${action}\`. Without BOTH halves the local turbo ` +
          `cache is never restored or never written, and this job goes back to rebuilding the ` +
          `whole affected set on every run — the reason it had never once finished.`
      ).toBe(true);
    }
    const keys = [...workflow.matchAll(/^\s+key:\s*(.+)$/gm)].map((m) => (m[1] as string).trim());
    expect(
      keys,
      `the cache keys in ${WORKFLOW_REL} are ${JSON.stringify(keys)}. Restore and save must use ` +
        `the SAME key, and it must carry the runner OS, the lockfile hash and \`github.sha\` — ` +
        `the SHA is what keeps the primary key from ever hitting, so the save always writes.`
    ).toEqual([`${KEY}-\${{ github.sha }}`, `${KEY}-\${{ github.sha }}`]);
    // `\1[ \t]+` rather than `\s+`: the fallback lines are indented deeper
    // than `restore-keys:` itself, and a bare `\s+` would swallow the blank
    // line and the comment block that follow the step.
    const restoreKeys =
      workflow.match(/^([ \t]+)restore-keys:[ \t]*\|\n((?:\1[ \t]+\S.*\n)+)/m)?.[2] ?? '';
    expect(
      restoreKeys
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
      `the \`restore-keys\` in ${WORKFLOW_REL} are ${JSON.stringify(restoreKeys)}. Exactly one ` +
        `fallback, and it must stop at the lockfile hash: a looser prefix restores entries ` +
        `built against different dependencies.`
    ).toEqual([`${KEY}-`]);
    // The save's `if:` has to survive a cancel and has to stay off the queue
    // leg. A bare `actions/cache/save` skips on cancellation, and every
    // failing run of this job so far ended in one, so a save without
    // `always()` would leave the cache permanently empty while the workflow
    // stayed green. A save that DOES run on `merge_group` writes ~180 MB into
    // the `gh-readonly-queue/...` scope the queue deletes on merge — an entry
    // nothing can ever restore, evicting entries other workflows do read.
    //
    // `[ \t]+(?!- )` rather than `\s+`: `\s` matches newlines and every line
    // in the steps region is indented, so a lazy `(?:\s+.*\n)*?` has no
    // barrier — it starts at the FIRST step header in the job and swallows
    // everything down to the save, which made an earlier version of this
    // assertion pass with `if: always()` sitting on an unrelated step. The
    // negative lookahead stops the block at the next step's `- `.
    const saveStep =
      workflow.match(
        /^[ \t]+- name:[^\n]*\n(?:[ \t]+(?!- )[^\n]*\n)*?[ \t]+uses: actions\/cache\/save@v6\n/m
      )?.[0] ?? '';
    expect(
      saveStep,
      `${WORKFLOW_REL} has no single step that both names itself and uses actions/cache/save@v6 ` +
        `— this guard cannot check the save's conditions.`
    ).not.toBe('');
    expect(
      saveStep.match(/^[ \t]+if: (.+)$/m)?.[1]?.trim(),
      `the cache-save step in ${WORKFLOW_REL} does not carry the expected \`if:\`. It must be ` +
        `\`always()\` (every failing run of this job so far ended in a cancel, and a save that ` +
        `skips on cancel never writes anything) AND restricted to \`pull_request\` (a merge-group ` +
        `save writes into a scope the queue deletes on merge, so it is unreadable waste against ` +
        `the repo's 10GB cache budget).`
    ).toBe("always() && github.event_name == 'pull_request'");
  });
});
