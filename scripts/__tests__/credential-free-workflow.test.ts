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
 * Same shape of guard, for the same reason, as `vitest-flake-reporter.test.ts`
 * beside it: a flag or a trigger whose absence changes no output has to be
 * pinned by a test, because nothing else will ever notice. It reads the
 * workflow as text rather than parsing YAML — this directory has no YAML
 * dependency, the assertions are about the presence of specific lines, and a
 * parser would add a dependency to check less.
 *
 * `.github/workflows/credential-free-build.yml` is inside scripts-test.yml's
 * own path filter, so the one PR shape these regressions take — an edit to that
 * workflow alone — triggers the job that runs this file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const WORKFLOW_REL = '.github/workflows/credential-free-build.yml';
const SCRUB_REL = 'scripts/run-credential-free.sh';

const workflow = readFileSync(path.join(repoRoot, WORKFLOW_REL), 'utf8');

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
        `INSIDE the queue stalls the queue for an hour on every entry (AGENTS.md, CI).`
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
      `${WORKFLOW_REL} has ${commands.length} \`run:\` steps, expected 6. If you added or ` +
        `removed one on purpose, update this number; if you did not, a step went missing.`
    ).toBe(6);
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
});
