/**
 * Drift guard: the pre-push test gate must stay bounded and must stay visible.
 *
 * DOR-473 was a `git push` that hung. Not a slow gate and not a failing one — a
 * silent one: minutes with an empty terminal and no way to tell a compile from
 * a wedged vitest, killed by hand, re-run with `--no-verify`, twice in one
 * afternoon. Two independent mechanisms produced that, and the fix needs both
 * halves in place at once or the symptom comes straight back:
 *
 *   * `follow: true` on the hook. Without it lefthook buffers a command's
 *     output and prints it only when the command finishes, so a run in progress
 *     and a run that has stopped forever look identical from outside.
 *   * `scripts/pre-push-watchdog.sh` around the run. Without it nothing in
 *     git → lefthook → turbo → vitest carries a timeout, so a suite that never
 *     exits blocks the push with no ceiling at all.
 *
 * This file exists because losing either half is INVISIBLE. Delete the wrapper
 * and every push still passes, a little faster, right up until the day one
 * hangs; drop `follow` and pushes still pass while going quiet again. Nothing
 * in the repo goes red for either, and the fixture suite beside this one
 * (`scripts/test-pre-push-watchdog.sh`) tests the watchdog thoroughly while
 * being entirely blind to whether anything CALLS it. That gap — a working guard
 * wired to nothing — is the same one `shell-suite-parity.test.ts` and
 * `turbo-affected-base-pinned.test.ts` were each written to close.
 *
 * WHY A VITEST TEST RATHER THAN A SHELL FIXTURE — same reasoning as its two
 * neighbours: `scripts/vitest.config.ts` globs every `*.test.ts` under a
 * `__tests__` directory, and that run is the last link of `test:scripts` (what
 * `pnpm verify` runs) and the final `harness` step of `scripts-test.yml`, so
 * this file registers itself in both with no wiring. `lefthook.yml` is already
 * inside that workflow's path filters, so the one PR shape this regression
 * takes — an edit to `lefthook.yml` alone — triggers the job that runs it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const lefthookText = readFileSync(path.join(repoRoot, 'lefthook.yml'), 'utf8');

/** Path the lefthook command names, relative to the repo root it runs from. */
const WATCHDOG_REL = 'scripts/pre-push-watchdog.sh';

/**
 * The body of the `pre-push` hook, from its top-level key to the next one.
 *
 * Scoped deliberately rather than searching the whole file: `follow` is a
 * hook-level setting, and a `follow: true` that had drifted onto `pre-commit`
 * would satisfy a whole-file search while leaving the hook this ticket is about
 * exactly as silent as it was.
 *
 * A small scanner rather than a YAML dependency, for the reason
 * `turbo-affected-base-pinned.test.ts` gives beside it: `scripts/` has no
 * package.json and the `fixtures` job runs without a `pnpm install`, so nothing
 * here may import outside node's stdlib.
 */
function prePushBlock(yaml: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^pre-push:\s*$/.test(l));
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

const prePush = prePushBlock(lefthookText);

describe('the pre-push test gate is bounded and visible', () => {
  it('finds the pre-push hook at all', () => {
    // Without this, every assertion below passes vacuously the day the hook is
    // renamed or the scanner stops matching — the exact way a guard dies
    // quietly.
    expect(prePush).not.toBe('');
    expect(prePush).toContain('turbo test --affected');
  });

  it('runs the gate under the watchdog', () => {
    expect(
      prePush.includes(WATCHDOG_REL),
      `lefthook.yml's pre-push gate no longer routes through ${WATCHDOG_REL}. ` +
        'Nothing else in git -> lefthook -> turbo -> vitest has a timeout, so a ' +
        'suite that never exits blocks the push forever (DOR-473).'
    ).toBe(true);
  });

  it('names a watchdog that is actually there', () => {
    // A path typo fails open in the worst possible way: `bash` exits non-zero
    // on a missing script, so every push would be refused with a message about
    // tests that never ran.
    expect(existsSync(path.join(repoRoot, WATCHDOG_REL))).toBe(true);
  });

  it('streams the gate rather than buffering it', () => {
    expect(
      /^ {2}follow: true$/m.test(prePush),
      "lefthook.yml's pre-push hook dropped `follow: true`. lefthook then holds " +
        "the gate's output until the command exits, so a run in progress and a " +
        'run that has wedged are indistinguishable — the "two minutes with an ' +
        'empty log" half of DOR-473.'
    ).toBe(true);
  });

  it('leaves the turbo invocation and its cache key untouched', () => {
    // The watchdog wraps the run without altering it, and that is load-bearing:
    // turbo hashes the passthrough args after `--` into the task cache key, so
    // a gate whose passthrough is anything other than `-- --run` stops sharing
    // its cache with `pnpm test -- --run` and with CI, and every push pays for
    // a full re-run. Wrapping a command is exactly the kind of edit that
    // tempts someone to "just add a flag while I'm here".
    expect(prePush).toContain('turbo test --affected --concurrency=1 -- --run');
  });

  it('puts the watchdog around turbo, not after it', () => {
    // `watchdog.sh; turbo ...` would satisfy a naive substring check while
    // bounding nothing at all.
    const watchdogAt = prePush.indexOf(WATCHDOG_REL);
    const turboAt = prePush.indexOf('turbo test --affected');
    expect(watchdogAt).toBeGreaterThan(-1);
    expect(watchdogAt).toBeLessThan(turboAt);
  });
});

describe('the watchdog keeps the properties the gate depends on', () => {
  const watchdogText = readFileSync(path.join(repoRoot, WATCHDOG_REL), 'utf8');

  it('fails the push on a timeout rather than waving it through', () => {
    // The single most consequential line in the script, and the easiest to
    // "fix" in the wrong direction the first time a timeout is inconvenient.
    // Exiting 0 here would hand back a green push over code no test ran, by
    // default and in silence — strictly worse than the `--no-verify` habit
    // this whole change exists to end, because at least that one is typed on
    // purpose.
    //
    // The BEHAVIOURAL proof lives in the fixture suite, which runs a real stall
    // through the real script and asserts the exit code is 124 — that is the
    // assertion to trust, and it is the one that would catch a rewrite. This is
    // only the cheap smoke that both timeout paths are still spelled that way,
    // here so that a reader of this file is pointed at the right guarantee
    // rather than assuming this one is it.
    expect(watchdogText.match(/exit 124/g)).toHaveLength(2);
  });

  it('stops the run when it is interrupted, not only when it times out', () => {
    // Ctrl-C is the likeliest way this gate ever ends — it is what everyone did
    // for the whole life of the bug. bash sets SIGINT to SIG_IGN in a command
    // started with `&`, so without these traps an interrupt kills the watchdog
    // and reparents the live turbo+vitest tree to init, and SIGTERM exits 143
    // while leaving the run alive. Measured 5/5 in both directions on the
    // version before them. The fixture suite proves the behaviour; this asserts
    // the traps have not simply been deleted as redundant-looking lines.
    for (const signal of ['INT', 'TERM', 'HUP']) {
      expect(
        new RegExp(`^trap .* ${signal}$`, 'm').test(watchdogText),
        `pre-push-watchdog.sh no longer traps SIG${signal}; an interrupted push ` +
          'leaks the whole test run (DOR-473 review).'
      ).toBe(true);
    }
  });

  it('never kills by name or by process group (Hard Rule 7)', () => {
    // The script stops the process tree it started. Signalling a process GROUP
    // or a name would reach processes it never forked — on this machine, other
    // agents' servers and the operator's own dev stack.
    expect(watchdogText).not.toMatch(/\b(pkill|killall)\b/);
    expect(watchdogText).not.toMatch(/kill\s+(-\w+\s+)?--?\s*-\d/);
    expect(watchdogText).not.toMatch(/kill\s+(-\w+\s+)?"?-\$/);
  });
});
