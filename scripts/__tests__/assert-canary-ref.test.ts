/**
 * Fixture suite for `scripts/assert-canary-ref.sh` (DOR-2150).
 *
 * That script is the whole reason a `workflow_dispatch` leg on four required
 * workflows is safe. A dispatch is ref-free, so `--ref <a PR's branch>` would
 * run the suite against that branch and post the check run — named `test`,
 * `browser-test`, `typecheck` or `lint`, which are required contexts — on that
 * pull request's head. The script refuses it.
 *
 * Both halves are pinned because both can rot. If the positive half breaks,
 * every canary round fails and the script gets deleted within a week. If the
 * negative half breaks, the refusal stops refusing and nobody finds out.
 *
 * It must FAIL rather than skip: a skipped job posts a skipped check run and
 * GitHub counts skipped as passing, so a skip is how you hand a pull request a
 * green required check that tested a different tree.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, '..', 'assert-canary-ref.sh');

/**
 * Run the script with exactly the two variables it reads and nothing else.
 *
 * A fixed, minimal environment rather than the parent's: the script's whole
 * job is to answer from `EVENT` and `REF`, so a case that accidentally
 * inherited a real `REF` from the shell would pass for the wrong reason.
 *
 * @param env - The variables under test.
 */
function run(env: Record<string, string>): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('a main-canary run is against main, or it is nothing', () => {
  it('passes a scheduled round and an on-demand dispatch on main', () => {
    for (const event of ['schedule', 'workflow_dispatch']) {
      const r = run({ EVENT: event, REF: 'refs/heads/main' });
      expect(r.code).toBe(0);
      expect(r.out).toContain('refs/heads/main');
    }
  });

  it('FAILS a dispatch aimed at any other ref, and says which', () => {
    const r = run({ EVENT: 'workflow_dispatch', REF: 'refs/heads/feat/some-pr' });
    // Exit 1, not 0: a skipped or passing check run on a pull request's head,
    // under a required context's name, is exactly what this prevents.
    expect(r.code).toBe(1);
    expect(r.out).toContain('refs/heads/feat/some-pr');
    expect(r.out).toContain('::error');
  });

  it('is a no-op on the gating events, whatever their ref', () => {
    // pull_request and merge_group refs are whatever GitHub built. Checking
    // them would red the queue; this is why the step needs no `if:` and so no
    // census allowlist entry.
    for (const event of ['pull_request', 'merge_group']) {
      const r = run({ EVENT: event, REF: 'refs/pull/1234/merge' });
      expect(r.code).toBe(0);
    }
  });

  it('refuses a canary event with no ref at all rather than assuming main', () => {
    expect(run({ EVENT: 'schedule', REF: '' }).code).toBe(1);
  });
});
