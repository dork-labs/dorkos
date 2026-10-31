/**
 * Guard for the opt-in queue runner label (ledger 261031-090000).
 *
 * `test-shard`, `community-pg` and `credential-free-build` may run their
 * `merge_group` leg on the runner named by the repository variable
 * `RUNNER_LABEL`. Every other event stays on `ubuntu-latest`, and that is a
 * security property, not a preference: a `pull_request` run executes the PR's
 * code, a fork's included, and that code must never reach an org runner
 * (Security's Must 1).
 *
 * The obvious "simplification" breaks it silently. `vars.RUNNER_LABEL ||
 * 'ubuntu-latest'` reads the same, passes every run while the variable is
 * unset, and sends every pull request to the org runner the day someone sets
 * it. Nothing would fail. So the exact expression is pinned here, and every
 * other `runs-on` in the two workflows must be the hosted runner.
 *
 * Read as text, like `credential-free-workflow.test.ts` beside it: the
 * assertions are about specific lines, and this directory has no YAML parser.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const WORKFLOWS_DIR = '.github/workflows';

/** The one accepted way to name the opt-in runner. */
const QUEUE_ONLY =
  "${{ github.event_name == 'merge_group' && vars.RUNNER_LABEL || 'ubuntu-latest' }}";

/** Workflows whose required jobs carry the opt-in, and the jobs that must. */
const OPTED_IN: Record<string, string[]> = {
  'test.yml': ['community-pg', 'test-shard'],
  'credential-free-build.yml': ['credential-free-build'],
};

/** Collapses runs of whitespace so formatting cannot hide or fake a match. */
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

/** Every uncommented `runs-on:` value in a workflow, with its job key. */
function runsOnByJob(text: string): Array<{ job: string; runsOn: string }> {
  const found: Array<{ job: string; runsOn: string }> = [];
  let job = '';
  for (const line of text.split('\n')) {
    if (/^\s*#/.test(line)) continue;
    const jobKey = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (jobKey) job = jobKey[1] as string;
    const runsOn = line.match(/^\s+runs-on:\s*(.+)$/);
    if (runsOn) found.push({ job, runsOn: normalize(runsOn[1] as string) });
  }
  return found;
}

/**
 * Whether a `runs-on` value is safe for an untrusted `pull_request` run: the
 * hosted runner, or the exact queue-only expression, which resolves to the
 * hosted runner on every event but `merge_group`.
 */
function isPullRequestSafe(runsOn: string): boolean {
  const value = normalize(runsOn);
  return value === 'ubuntu-latest' || value === QUEUE_ONLY;
}

function read(file: string): string {
  return readFileSync(path.join(repoRoot, WORKFLOWS_DIR, file), 'utf8');
}

describe('merge_group-only runner label', () => {
  it('accepts the hosted runner and the exact queue-only expression', () => {
    expect(isPullRequestSafe('ubuntu-latest')).toBe(true);
    expect(isPullRequestSafe(QUEUE_ONLY)).toBe(true);
  });

  it('rejects a bare RUNNER_LABEL fallback with no event check', () => {
    expect(isPullRequestSafe("${{ vars.RUNNER_LABEL || 'ubuntu-latest' }}")).toBe(false);
    expect(isPullRequestSafe('${{ vars.RUNNER_LABEL }}')).toBe(false);
    // Not pull_request is not the same as merge_group: it lets the scheduled
    // canary and any future event onto the org runner as well.
    expect(
      isPullRequestSafe(
        "${{ github.event_name != 'pull_request' && vars.RUNNER_LABEL || 'ubuntu-latest' }}"
      )
    ).toBe(false);
  });

  for (const [file, jobs] of Object.entries(OPTED_IN)) {
    it(`${file}: every pull_request path runs on ubuntu-latest`, () => {
      const entries = runsOnByJob(read(file));
      expect(entries.length, `${file} has no parseable \`runs-on:\` lines.`).toBeGreaterThan(0);
      const unsafe = entries.filter((e) => !isPullRequestSafe(e.runsOn));
      expect(
        unsafe,
        `${file} has \`runs-on\` values that can reach a non-hosted runner on a pull request: ` +
          `${unsafe.map((e) => `${e.job}: ${e.runsOn}`).join(' | ')}. Use ${QUEUE_ONLY}.`
      ).toEqual([]);
    });

    it(`${file}: ${jobs.join(', ')} carry the queue-only expression`, () => {
      const entries = runsOnByJob(read(file));
      for (const job of jobs) {
        expect(
          entries.find((e) => e.job === job)?.runsOn,
          `${file} job \`${job}\` should pick its runner with ${QUEUE_ONLY} (ledger 261031-090000).`
        ).toBe(QUEUE_ONLY);
      }
    });
  }

  it('no workflow names RUNNER_LABEL except through the queue-only expression', () => {
    const files = readdirSync(path.join(repoRoot, WORKFLOWS_DIR)).filter((f) => /\.ya?ml$/.test(f));
    const offenders: string[] = [];
    for (const file of files) {
      const code = read(file)
        .split('\n')
        .filter((line) => !/^\s*#/.test(line));
      for (const line of code) {
        if (!line.includes('RUNNER_LABEL')) continue;
        const runsOn = line.match(/^\s+runs-on:\s*(.+)$/)?.[1];
        if (runsOn === undefined || normalize(runsOn) !== QUEUE_ONLY) {
          offenders.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      `RUNNER_LABEL is used outside ${QUEUE_ONLY}: ${offenders.join(' | ')}. Pull request ` +
        `code must never reach the org runner.`
    ).toEqual([]);
  });
});
