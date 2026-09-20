/**
 * The main canary's own population rules (DOR-2150, plan §4.9).
 *
 * The canary runs the required workflows against `main` HEAD on a schedule, so
 * its runs look like every other run of those workflows except for their event.
 * Two things therefore have to hold, and both are the kind that break silently:
 * only the configured workflows count as canary results, and `main-green` never
 * sees a canary run.
 */
import { describe, expect, it } from 'vitest';
import type { Run } from '../collect.ts';
import { emptySnapshot, gateDays, gateKey, onMergePath, type GateDay } from '../data.ts';
import { canaryRuns, mainCommits } from '../series.ts';

const CANARY_WORKFLOWS = ['test.yml', 'browser-test.yml', 'typecheck.yml', 'lint.yml'];

function run(over: Partial<Run> & { path: string; event: string }): Run {
  return {
    id: 1,
    status: 'completed',
    conclusion: 'success',
    created_at: '2026-09-19T00:37:00Z',
    updated_at: '2026-09-19T01:05:00Z',
    run_attempt: 1,
    head_branch: 'main',
    head_sha: 'a'.repeat(40),
    ...over,
  };
}

describe('which runs are canary results', () => {
  it('takes a configured workflow on a canary event against the default branch', () => {
    const runs = [
      run({ path: '.github/workflows/test.yml', event: 'schedule' }),
      run({ path: '.github/workflows/lint.yml', event: 'workflow_dispatch' }),
    ];
    expect(canaryRuns(runs, 'main', CANARY_WORKFLOWS).map((c) => c.workflow)).toEqual([
      'lint.yml',
      'test.yml',
    ]);
  });

  it('takes no other scheduled workflow, however it is spelt', () => {
    // The collector, the evals and CodeQL all run on `schedule` against `main`.
    // Reading the collector's own tick as a canary result would report the
    // pipeline healthy on the strength of the run that said so.
    const runs = [
      run({ path: '.github/workflows/ci-steward.yml', event: 'schedule' }),
      run({ path: '.github/workflows/evals.yml', event: 'schedule' }),
      run({ path: '.github/workflows/codeql.yml', event: 'schedule' }),
      // The same suite, on the merge path: the queue's leg is not the canary.
      run({
        path: '.github/workflows/test.yml',
        event: 'merge_group',
        head_branch: 'gh-readonly-queue/main/pr-1-abc',
      }),
      run({ path: '.github/workflows/test.yml', event: 'pull_request', head_branch: 'feature' }),
      // A canary leg dispatched against a branch is not a statement about main.
      run({ path: '.github/workflows/test.yml', event: 'workflow_dispatch', head_branch: 'spike' }),
    ];
    expect(canaryRuns(runs, 'main', CANARY_WORKFLOWS)).toEqual([]);
  });

  it('records a failure as red, and drops a cancelled or unfinished run rather than calling it green', () => {
    const runs = [
      run({ path: '.github/workflows/test.yml', event: 'schedule', conclusion: 'failure' }),
      run({ path: '.github/workflows/lint.yml', event: 'schedule', conclusion: 'timed_out' }),
      run({ path: '.github/workflows/typecheck.yml', event: 'schedule', conclusion: 'cancelled' }),
      run({
        path: '.github/workflows/browser-test.yml',
        event: 'schedule',
        status: 'in_progress',
        conclusion: null,
      }),
    ];
    const out = canaryRuns(runs, 'main', CANARY_WORKFLOWS);
    expect(out.map((c) => [c.workflow, c.red])).toEqual([
      ['lint.yml', true],
      ['test.yml', true],
    ]);
  });
});

describe('main-green never sees the canary', () => {
  it('counts push runs only, so a red canary is not a red commit', () => {
    // `mainCommits` feeds the main-green SLO. The canary runs the same
    // workflows against the same branch, and folding them in would redefine
    // the SLO in the middle of the experiment that added it (plan §4.9,
    // round-5 follow-up 4).
    const sha = 'b'.repeat(40);
    const runs = [
      run({
        path: '.github/workflows/test.yml',
        event: 'schedule',
        conclusion: 'failure',
        head_sha: sha,
      }),
      run({ path: '.github/workflows/scripts-test.yml', event: 'push', head_sha: sha }),
    ];
    expect(mainCommits(runs, 'main')).toEqual([
      {
        sha: sha.slice(0, 12),
        at: '2026-09-19T00:37:00Z',
        done: '2026-09-19T01:05:00Z',
        red: false,
      },
    ]);
  });
});

describe('a gate that runs on both paths is measured over the merge path', () => {
  const day = (gates: Record<string, GateDay>) => {
    const s = emptySnapshot('2026-09-19', '2026-09-19T23:00:00Z', 700);
    s.gates = gates;
    return s;
  };
  const gateDay = (runs: number, failed = 0): GateDay => ({
    durations: [[3600, 600]],
    conclusions: { success: runs - failed, failure: failed },
    retried: 0,
    runs,
  });

  it('drops the canary leg of a gate that also runs in the queue', () => {
    const s = day({
      [gateKey('wf.test.test-shard', 'merge_group')]: gateDay(10),
      [gateKey('wf.test.test-shard', 'schedule')]: gateDay(4, 4),
    });
    expect(gateDays(s.gates, 'wf.test.test-shard')).toHaveLength(1);
    expect(onMergePath(s.gates, gateKey('wf.test.test-shard', 'schedule'))).toBe(false);
    // Named explicitly, the canary leg is still readable: `…@schedule` in a
    // hypothesis is how an experiment measures the canary itself.
    expect(gateDays(s.gates, 'wf.test.test-shard', 'schedule')).toHaveLength(1);
  });

  it('keeps every sample of a gate that runs on nothing but a schedule', () => {
    // merge-tail's arm, the evals, CodeQL and the collector are all this shape.
    // Dropping them would make `headroom` blind to the four jobs whose timeouts
    // nothing else looks at.
    const s = day({ [gateKey('wf.merge-tail.arm', 'schedule')]: gateDay(47) });
    expect(gateDays(s.gates, 'wf.merge-tail.arm')).toHaveLength(1);
    expect(onMergePath(s.gates, gateKey('wf.merge-tail.arm', 'schedule'))).toBe(true);
  });
});
