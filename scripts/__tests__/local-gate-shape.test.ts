/**
 * Drift guard: what the local hooks are allowed to be (DOR-2160).
 *
 * This replaces `pre-push-gate-bounded.test.ts`, which guarded a pre-push test
 * sweep and the watchdog that bounded it. Both are gone, and the decision that
 * removed them is the thing now worth guarding, because it is the kind of
 * decision a later session undoes in one well-meaning line.
 *
 * WHAT WAS MEASURED, so the guard carries its own reason. 49 pre-push runs on
 * the operator machine over 2026-09-19/20, from the time-wrap's own records:
 *
 *   58 `tests` command runs finished in under 50 seconds — pushes whose
 *      affected set was empty or trivial, where the gate proved nothing.
 *   10 ran over 579 seconds, the worst 2604, and 2 were killed outright.
 *   NOTHING IN BETWEEN. Not one run landed between 50 s and 579 s.
 *
 * A cliff, not a slope. Any budget you put on that gate lands in the empty
 * middle: it returns no verdict on a single push that had real work to do,
 * while charging the budget to every one of them. So the gate left the push
 * path, and what a push now guarantees is one formatting check — which is
 * cheap, deterministic, and preempts a REQUIRED CI gate that seven PRs in one
 * week went red on. The merge queue is the test gate.
 *
 * TWO REGRESSIONS, both silent:
 *
 *   * A test command comes back to `pre-push`. Everything still passes, just
 *     slower, and the machine goes back to load 500. `ci/**` and `lefthook.yml`
 *     are both ledger-covered paths, so restoring it legitimately means writing
 *     an entry that argues against the numbers above; this test is what makes
 *     that argument happen instead of being skipped.
 *
 *   * The heavy-run cap stops wrapping the commit gates. `bash lock.sh; turbo
 *     lint` looks almost exactly like `bash lock.sh turbo lint` and caps
 *     nothing at all, and nothing anywhere goes red for the difference.
 *
 * WHY A VITEST TEST RATHER THAN A SHELL FIXTURE — the same reasoning its
 * neighbours give: `scripts/vitest.config.ts` globs every `*.test.ts` under a
 * `__tests__` directory, and that run is the last link of `test:scripts` (what
 * `pnpm verify` runs) and the final `harness` step of `scripts-test.yml`, so
 * this file registers itself in both with no wiring. `lefthook.yml` is already
 * inside that workflow's path filters.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const lefthookText = readFileSync(path.join(repoRoot, 'lefthook.yml'), 'utf8');

/** The machine-wide cap the heavy commit gates run under. */
const LOCK_REL = 'scripts/heavy-run-lock.sh';

/**
 * One top-level hook's body, from its key to the next one at column 0.
 *
 * A small scanner rather than a YAML dependency, for the reason its neighbours
 * give: `scripts/` has no package.json and the `fixtures` job runs without a
 * `pnpm install`, so nothing here may import outside node's stdlib.
 */
function hookBlock(yaml: string, hook: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l === `${hook}:`);
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[A-Za-z]/.test(lines[i] as string)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * A hook's block with its comment lines removed.
 *
 * Every assertion about what a hook RUNS has to read this rather than the raw
 * block. The comments in `lefthook.yml` quote the commands they are explaining
 * — the `pre-push` block argues at length about the `turbo test` command it no
 * longer has — so a search over the raw text finds the prose and answers a
 * question about behaviour with a fact about paragraphs. That is not
 * hypothetical: it is how the previous version of this guard went vacuous.
 */
const codeOf = (block: string) =>
  block
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

const prePush = codeOf(hookBlock(lefthookText, 'pre-push'));
const preCommit = codeOf(hookBlock(lefthookText, 'pre-commit'));

describe('a push runs a formatting check and nothing else', () => {
  it('finds both hooks at all', () => {
    // Without this, every assertion below passes vacuously the day a hook is
    // renamed or the scanner stops matching.
    expect(prePush).not.toBe('');
    expect(preCommit).not.toBe('');
    expect(prePush).toContain('scripts/pre-push-format-check.sh');
  });

  it('runs no test suite at push time', () => {
    for (const forbidden of ['turbo test', 'vitest', 'pnpm test']) {
      expect(
        prePush.includes(forbidden),
        `lefthook.yml's pre-push hook runs \`${forbidden}\` again. On this machine that ` +
          'command either proved nothing (58 of 68 runs finished under 50s, with an empty ' +
          'affected set) or could not finish (10 runs over 579s, worst 2604s, 2 killed) — ' +
          'there was nothing in between, so no budget on it returns a verdict. The merge ' +
          'queue is the test gate. Restoring this needs a ledger entry that argues against ' +
          'those numbers (DOR-2160, ci/ledger/260919-175505-*).'
      ).toBe(false);
    }
  });

  it('leaves no reference to the watchdog it no longer needs', () => {
    // The watchdog bounded the test sweep and was deleted with it. A lefthook
    // command naming a script that is not there fails every push with a
    // message about tests that never ran.
    expect(prePush).not.toContain('pre-push-watchdog');
    expect(existsSync(path.join(repoRoot, 'scripts/pre-push-watchdog.sh'))).toBe(false);
  });
});

describe('the heavy commit gates run under the machine-wide cap', () => {
  it('names a lock script that is actually there', () => {
    // A path typo fails closed in the worst way: `bash` exits non-zero on a
    // missing script, so every commit would be refused with a message about
    // lint that never ran.
    expect(existsSync(path.join(repoRoot, LOCK_REL))).toBe(true);
  });

  it.each(['lint', 'typecheck'])(
    'wraps turbo %s rather than running it beside the lock',
    (task) => {
      // ONE REGEX OVER ONE CONTINUED COMMAND LINE, deliberately. Three separate
      // `indexOf` comparisons would be satisfied by `bash lock.sh; turbo lint` —
      // the lock running, exiting, and turbo running afterwards with no slot held
      // at all — which is the precise mutation that caps nothing while looking
      // right. `[^\n;&|]*` is what refuses it: turbo has to be reachable from the
      // lock invocation without an intervening command separator.
      const nested = new RegExp(`bash ${LOCK_REL}[^\\n;&|]*\\bturbo ${task}\\b`);
      expect(
        nested.test(preCommit),
        `lefthook.yml's pre-commit \`${task}\` command no longer runs turbo AS AN ARGUMENT to ` +
          `${LOCK_REL}. Several agents each running a full affected sweep on 14 cores is what ` +
          'measured a load average of 500 with the kernel killing processes for memory.'
      ).toBe(true);
    }
  );

  it('rejects the un-nested command shapes it exists to catch', () => {
    // The assertion above is only worth its lines if it can fail. These are the
    // exact mutants that would otherwise slip past: every one of them leaves a
    // lefthook.yml that mentions the lock, runs the gate, exits 0 and caps
    // nothing at all.
    const nested = new RegExp(`bash ${LOCK_REL}[^\\n;&|]*\\bturbo lint\\b`);
    const cmd = 'pnpm exec turbo lint --affected';
    expect(nested.test(`TURBO_SCM_BASE="x" bash ${LOCK_REL} ${cmd}`)).toBe(true);
    expect(nested.test(`bash ${LOCK_REL}; ${cmd}`)).toBe(false);
    expect(nested.test(`bash ${LOCK_REL} && ${cmd}`)).toBe(false);
    expect(nested.test(`bash ${LOCK_REL} | ${cmd}`)).toBe(false);
    expect(nested.test(`bash ${LOCK_REL} true\n${cmd}`)).toBe(false);
    expect(nested.test(cmd)).toBe(false);
  });

  it('never kills by name or by process group (Hard Rule 7)', () => {
    // The lock removes directories and asks whether pids exist. Signalling a
    // process GROUP or a name would reach processes it never started — on this
    // machine, other agents' servers and the operator's own dev stack.
    const lockText = readFileSync(path.join(repoRoot, LOCK_REL), 'utf8');
    expect(lockText).not.toMatch(/\b(pkill|killall)\b/);
    expect(lockText).not.toMatch(/kill\s+(-\w+\s+)?--?\s*-\d/);
    expect(lockText).not.toMatch(/kill\s+(-\w+\s+)?"?-\$/);
  });
});
