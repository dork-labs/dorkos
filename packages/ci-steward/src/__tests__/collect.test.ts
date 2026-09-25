/**
 * The collector against a recorded day: what it computes, and that every
 * failure the plan names turns the run red (exit 1, snapshot unhealthy) rather
 * than passing as a quiet day.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../cli.ts';
import * as collectPlan from '../collect.ts';
import { collect } from '../collect.ts';
import { LatestSchema, readData, snapshotPath, SnapshotSchema } from '../data.ts';
import { repeatEjections } from '../ejection-facts.ts';
import { refreshOlderDays } from '../refresh.ts';
import { normaliseQuery, replayGh, type Recording } from '../gh.ts';
import { timelinePageQuery } from '../prs.ts';
import { loadHandFiles } from '../load.ts';
import { loadWorkflows } from '../workflows.ts';
import { baseSpec, writeRepo } from './fixture.ts';
import { DAY, RUNS, RUNS_PATH, dayRecording } from './gh-fixture.ts';

const NOW = '2026-09-19T05:00:00Z';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = (prefix: string) => {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

function writeArtifact(dir: string, rel: string, text: string) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
}

function setup() {
  const root = writeRepo(baseSpec());
  dirs.push(root);
  const { files } = loadHandFiles(root);
  const workflows = loadWorkflows(root, '.github/workflows', () => undefined);
  return { root, files: files!, workflows, data: temp('ci-steward-data-') };
}

function runCollect(rec: Recording, budget = 700, data?: string) {
  const s = setup();
  const dataDir = data ?? s.data;
  const gh = replayGh(rec, budget, writeArtifact);
  const r = collect({
    gh,
    files: s.files,
    workflows: s.workflows,
    dataDir,
    now: new Date(NOW),
    days: [DAY],
    tmpDir: temp('ci-steward-tmp-'),
  });
  return { r, snap: readData(dataDir, snapshotPath(DAY), SnapshotSchema)!, dataDir, gh };
}

describe('collect on a recorded day', () => {
  it('computes the series, queue builds, real catches and health from the recording', () => {
    const { r, snap } = runCollect(dayRecording());
    expect(r.healthy).toBe(true);
    expect(snap.complete).toBe(true);
    expect(snap.health.runs).toMatchObject({ total_count: 7, fetched: 7 });
    expect(snap.health.shas).toEqual({ total: 3, done: 3 });
    // One all-green PR head: first required run created 10:00:00, last finished 10:10:05.
    expect(snap.series.pr_feedback_min).toEqual([[36000, 10.1]]);
    expect(snap.queue_builds.map((b) => [b.sha, b.pr, b.outcome, b.failed_gates])).toEqual([
      ['bbb', 7, 'red', ['wf.test.test', 'wf.test.test-shard']],
      ['ccc', 7, 'green', []],
    ]);
    // PR #7: ejected for failed checks, fixed by a new commit, merged: a real catch, not a waste.
    expect(snap.real_catches).toEqual({ 'wf.test.test': 1, 'wf.test.test-shard': 1 });
    expect(snap.counts).toMatchObject({
      merged_prs: 1,
      ejections_failed_checks: 1,
      wasted_ejections: 0,
    });
    expect(snap.series.lead_time_min).toEqual([[45900, 225]]);
    expect(snap.series.queue_wait_min).toEqual([[45900, 106]]);
    expect(snap.series.queue_build_min).toEqual([]);
    expect(snap.main).toEqual([
      {
        sha: 'ccc',
        at: `${DAY}T13:00:00Z`,
        done: `${DAY}T13:10:00Z`,
        red: false,
        workflows: { 'lint.yml': false },
      },
    ]);
    // PR #7's one ejection had a new commit after it, so nothing repeated.
    expect(snap.counts.repeat_ejections).toBe(0);
    // The non-Actions check run (Vercel) is not a gate.
    // Gate samples are kept per event, so the PR leg and the queue leg stay apart.
    expect(snap.gates['wf.lint.lint@pull_request']!.durations.map((d) => d[1])).toEqual([240]);
    expect(snap.gates['wf.lint.lint@merge_group']!.durations.map((d) => d[1])).toEqual([240, 240]);
    expect(snap.gates['wf.lint.lint@push']!.durations.map((d) => d[1])).toEqual([180]);
    expect(snap.gates['wf.test.test-shard@merge_group']!.conclusions).toEqual({
      success: 3,
      failure: 1,
    });
    expect(snap.releases).toEqual([{ tag: 'v1.0.0', published_at: `${DAY}T15:00:00Z` }]);
    expect(snap.health.ruleset?.ok).toBe(true);
    expect(snap.health.data_rulesets.map((d) => d.ok)).toEqual([true, true]);
    expect(snap.timeouts).toMatchObject({ 'wf.lint.lint': 15, 'wf.test.test-shard': 30 });
  });

  it('turns red on a planted truncation: fewer runs fetched than total_count', () => {
    const rec = dayRecording();
    rec.rest[`${RUNS_PATH}&page=1`] = { total_count: RUNS.length + 1, workflow_runs: RUNS };
    const s = setup();
    let err = '';
    const code = main(
      ['collect', '--data', s.data, '--day', DAY, '--now', NOW],
      { out: () => undefined, err: (x) => (err += x) },
      s.root,
      { gh: (b) => replayGh(rec, b, writeArtifact) }
    );
    expect(code).toBe(1);
    expect(err).toContain('Truncated: runs created');
    const snap = readData(s.data, snapshotPath(DAY), SnapshotSchema)!;
    expect(snap.healthy).toBe(false);
    expect(readData(s.data, 'latest.json', LatestSchema)).toMatchObject({
      healthy: false,
      constraint: { tier: 'tripwire', id: 'collector-health' },
    });
  });

  it('keeps a truncated day incomplete, so the next run fetches it again', () => {
    const s = setup();
    const bad = dayRecording();
    bad.rest[`${RUNS_PATH}&page=1`] = { total_count: RUNS.length + 1, workflow_runs: RUNS };
    const first = runCollect(bad, 700, s.data);
    expect(first.snap).toMatchObject({ complete: false, healthy: false });
    const { planDays } = collectPlan;
    expect(planDays(s.data, s.files, new Date(NOW))).toContain(DAY);
    const second = runCollect(dayRecording(), 700, s.data);
    expect(second.snap).toMatchObject({ complete: true, healthy: true });
    expect(second.snap.health.runs).toMatchObject({ total_count: 7, fetched: 7 });
  });

  it('starts a truncated day over instead of resuming it, so no job is lost', () => {
    const fresh = runCollect(dayRecording()).snap;
    const s = setup();
    const bad = dayRecording();
    // The failing queue run (202) is missing from the list: its check runs are
    // filtered out of bbb's jobs, though bbb itself is fetched and marked done.
    bad.rest[`${RUNS_PATH}&page=1`] = {
      total_count: RUNS.length,
      workflow_runs: RUNS.filter((r) => r.id !== 202),
    };
    const first = runCollect(bad, 700, s.data);
    expect(first.snap).toMatchObject({ complete: false, truncated: true, healthy: false });
    expect(first.snap.shas_done).toContain('bbb');
    const second = runCollect(dayRecording(), 700, s.data);
    expect(second.snap).toMatchObject({ complete: true, truncated: false, healthy: true });
    expect(second.snap.gates).toEqual(fresh.gates);
    expect(second.snap.counts.job_minutes).toBe(fresh.counts.job_minutes);
    expect(second.snap.real_catches).toEqual({ 'wf.test.test': 1, 'wf.test.test-shard': 1 });
    expect(second.snap.queue_builds).toEqual(fresh.queue_builds);
  });

  it('reads a PR timeline past its first 100 events, so the merge and last queue events count', () => {
    const rec = dayRecording();
    const q = Object.keys(rec.graphql!)[0]!;
    const search = rec.graphql![q] as {
      data: { search: { nodes: { timelineItems: { pageInfo: unknown; nodes: unknown[] } }[] } };
    };
    const tl = search.data.search.nodes[0]!.timelineItems;
    const tail = tl.nodes.splice(2);
    tl.pageInfo = { hasNextPage: true, endCursor: 'c1' };
    rec.graphql![normaliseQuery(timelinePageQuery('o/r', 7, 'c1'))] = {
      data: {
        repository: {
          pullRequest: {
            timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: tail },
          },
        },
      },
    };
    const { snap } = runCollect(rec);
    expect(snap.complete).toBe(true);
    expect(snap.real_catches).toEqual({ 'wf.test.test': 1, 'wf.test.test-shard': 1 });
    expect(snap.series.queue_wait_min).toEqual([[45900, 106]]);
  });

  it('never moves latest.json back when a run writes only older days', () => {
    const s = setup();
    const io = { out: () => undefined, err: () => undefined };
    const gh = (b: number) => replayGh(dayRecording(), b, writeArtifact);
    expect(
      main(['collect', '--data', s.data, '--day', DAY, '--now', NOW], io, s.root, { gh })
    ).toBe(0);
    // A backfill run: an older day only (a quiet one, same recording shape).
    const older = '2026-08-20';
    const rec = dayRecording();
    const shift = (x: string) => x.replaceAll(DAY, older);
    rec.rest = Object.fromEntries(
      Object.entries(rec.rest).map(([k, v]) => [shift(k), JSON.parse(shift(JSON.stringify(v)))])
    );
    rec.graphql = Object.fromEntries(
      Object.entries(rec.graphql!).map(([k, v]) => [shift(k), JSON.parse(shift(JSON.stringify(v)))])
    );
    main(['collect', '--data', s.data, '--day', older, '--now', NOW], io, s.root, {
      gh: (b) => replayGh(rec, b, writeArtifact),
    });
    expect(readData(s.data, snapshotPath(older), SnapshotSchema)?.complete).toBe(true);
    expect(readData(s.data, 'latest.json', LatestSchema)?.date).toBe(DAY);
  });

  it('splits a window GitHub reports over 1,000 runs for, and asserts each half', () => {
    const rec = dayRecording();
    rec.rest[`${RUNS_PATH}&page=1`] = { total_count: 1500, workflow_runs: [] };
    const half = (from: string, to: string, runs: typeof RUNS) => ({
      [`repos/o/r/actions/runs?created=${DAY}T${from}Z..${DAY}T${to}Z&per_page=100&page=1`]: {
        total_count: runs.length,
        workflow_runs: runs,
      },
    });
    Object.assign(
      rec.rest,
      half('00:00:00', '11:59:59', RUNS.slice(0, 4)),
      half('12:00:00', '23:59:59', RUNS.slice(4))
    );
    const { r, snap } = runCollect(rec);
    expect(r.healthy).toBe(true);
    expect(snap.health.runs.windows.map((w) => w.created)).toEqual([
      `${DAY}T00:00:00Z..${DAY}T11:59:59Z`,
      `${DAY}T12:00:00Z..${DAY}T23:59:59Z`,
    ]);
    expect(snap.health.runs).toMatchObject({ total_count: 7, fetched: 7 });
  });

  it('degrades to late when the budget runs out, and the next run resumes without double counting', () => {
    const full = runCollect(dayRecording()).snap;
    const s = setup();
    const first = runCollect(dayRecording(), 7, s.data);
    expect(first.r.healthy).toBe(true);
    expect(first.snap.complete).toBe(false);
    expect(first.snap.shas_done).toEqual(['aaa']);
    expect(first.snap.health.warnings.join(' ')).toContain(
      'Late: the request budget ran out after 1 of 3 head SHAs'
    );
    const second = runCollect(dayRecording(), 700, s.data);
    expect(second.snap.complete).toBe(true);
    expect(second.snap.shas_done).toEqual(['aaa', 'bbb', 'ccc']);
    // Resumed, not restarted: only the two missing SHAs were fetched again.
    expect(second.snap.health.api_calls).toBeLessThan(full.health.api_calls);
    expect(second.snap.gates).toEqual(full.gates);
    expect(second.snap.counts.job_minutes).toBe(full.counts.job_minutes);
  });

  it('never spends past what the token has left this hour', () => {
    const rec = { ...dayRecording(), remaining: 57 };
    const s = setup();
    let out = '';
    main(
      ['collect', '--data', s.data, '--day', DAY, '--now', NOW],
      { out: (x) => (out += x), err: () => undefined },
      s.root,
      {
        gh: (b) => replayGh(rec, b, writeArtifact),
      }
    );
    expect(out).toContain('the token has 57 requests left this hour; budget 7 instead of 700');
    expect(readData(s.data, snapshotPath(DAY), SnapshotSchema)!.complete).toBe(false);
  });

  it('turns red when the token is spent and nothing due could be collected', () => {
    const rec = { ...dayRecording(), remaining: 50 };
    const s = setup();
    let err = '';
    const code = main(
      ['collect', '--data', s.data, '--day', DAY, '--now', NOW],
      { out: () => undefined, err: (x) => (err += x) },
      s.root,
      {
        gh: (b) => replayGh(rec, b, writeArtifact),
      }
    );
    expect(code).toBe(1);
    expect(err).toContain('Collected nothing: 1 day due,');
  });

  it('turns red when the merge-queue ruleset drifts or a data-branch safeguard is gone', () => {
    const rec = dayRecording();
    const rs = rec.rest['repos/o/r/rulesets/1'] as {
      rules: { type: string; parameters?: { required_status_checks: unknown[] } }[];
    };
    rs.rules[1]!.parameters!.required_status_checks.pop();
    (rec.rest['repos/o/r/rulesets/2'] as Record<string, unknown>).bypass_actors = [
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
    ];
    rec.rest['repos/o/r/rulesets/3'] = Object.assign(new Error('gh: Not Found (HTTP 404)'), {
      stderr: 'HTTP 404',
    });
    const { r, snap } = runCollect(rec);
    expect(r.healthy).toBe(false);
    expect(snap.health.ruleset?.problems).toEqual([
      'required in ci/required-checks.json but not in the ruleset: test',
    ]);
    expect(snap.health.data_rulesets[0]!.problems).toEqual([
      'it has 1 bypass actor(s); it must have none',
    ]);
    expect(snap.health.data_rulesets[1]).toEqual({
      id: 3,
      ok: false,
      problems: ['ruleset 3 does not exist'],
    });
    expect(r.failures.some((f) => f.startsWith('Data-branch safeguard ruleset 3'))).toBe(true);
  });

  it('counts flaky tests from sampled queue-build reports, and NAMES them', () => {
    const rec = dayRecording();
    rec.artifacts = {
      '302:vitest-shard-report-*': {
        'vitest-shard-report-1/packages/a/vitest-shard-report.json': JSON.stringify({
          numTotalTests: 100,
          numPendingTests: 4,
          numTodoTests: 1,
        }),
        'vitest-shard-report-1/packages/a/vitest-flake-report.json': JSON.stringify({
          cwd: '/home/runner/work/dorkos/dorkos/packages/a',
          flaky: [
            { file: 'src/__tests__/x.test.ts', test: 'x', retries: 1 },
            { file: 'src/__tests__/y.test.ts', test: 'y', retries: 1 },
          ],
        }),
      },
    };
    const { snap } = runCollect(rec);
    expect(snap.counts).toMatchObject({
      test_executions: 95,
      test_flaky: 2,
      flaky_builds_sampled: 1,
    });
    // The counts answer "how much"; only these answer "where", which is the
    // whole input to the quarantine classifier.
    expect(snap.flaky_tests).toEqual([
      {
        runner: 'vitest',
        file: 'packages/a/src/__tests__/x.test.ts',
        title: 'x',
        sha: 'ccc',
      },
      {
        runner: 'vitest',
        file: 'packages/a/src/__tests__/y.test.ts',
        title: 'y',
        sha: 'ccc',
      },
    ]);
    expect(snap.flaky_builds).toEqual([{ sha: 'ccc', runner: 'vitest' }]);
  });
});

describe('repeatEjections (tracked.repeat-ejections)', () => {
  const build = (sha: string, pr: number, at: string, gates: string[]) => ({
    sha,
    pr,
    created_at: at,
    outcome: 'red' as const,
    failed_gates: gates,
  });
  const pr = (ejections: { at: string; head: number }[]) => ({
    number: 1,
    mergedAt: '2026-09-18T20:00:00Z',
    leadTimeMin: 1,
    queueWaitMin: 1,
    queueBuildMin: null,
    ejections: ejections.map((e) => ({ ...e, newCommit: false })),
  });
  const shard = ['wf.browser-test.browser-shard', 'wf.browser-test.browser-test'];
  const builds = [
    build('b1', 1, '2026-09-18T10:00:00Z', shard),
    build('b2', 1, '2026-09-18T11:00:00Z', shard),
    build('b3', 1, '2026-09-18T12:00:00Z', ['wf.lint.lint']),
    build('b4', 1, '2026-09-18T13:00:00Z', ['wf.browser-test.browser-shard']),
  ];
  const count = (ejections: { at: string; head: number }[]) =>
    repeatEjections([pr(ejections)], builds);

  it('counts the same check failing a second build of an unchanged head, once each', () => {
    // b2 repeats b1; b4 repeats b1 and b2 but is ONE repeat.
    expect(
      count([
        { at: '2026-09-18T10:30:00Z', head: 1 },
        { at: '2026-09-18T11:30:00Z', head: 1 },
        { at: '2026-09-18T13:30:00Z', head: 1 },
      ])
    ).toBe(2);
  });

  it('does not count a different check, a new push between, or two removals of one build', () => {
    const first = { at: '2026-09-18T10:30:00Z', head: 1 };
    expect(count([first, { at: '2026-09-18T12:30:00Z', head: 1 }])).toBe(0);
    expect(count([first, { at: '2026-09-18T11:30:00Z', head: 2 }])).toBe(0);
    expect(count([first, { at: '2026-09-18T10:40:00Z', head: 1 }])).toBe(0);
  });
});

describe('refreshOlderDays', () => {
  const PUSH_PATH = `repos/o/r/actions/runs?branch=main&event=push&created=${DAY}T00:00:00Z..${DAY}T23:59:59Z&per_page=100&page=1`;
  const push = RUNS.filter((r) => r.event === 'push');

  /** Collect DAY, then strip it back to what an engine before this change wrote. */
  function legacyDay() {
    const { dataDir } = runCollect(dayRecording());
    const snap = readData(dataDir, snapshotPath(DAY), SnapshotSchema)!;
    delete snap.counts.repeat_ejections;
    snap.main = snap.main.map(({ workflows: _w, ...c }) => c);
    writeFileSync(path.join(dataDir, snapshotPath(DAY)), JSON.stringify(snap));
    return dataDir;
  }

  function refresh(rec: Recording, dataDir: string, budget = 700) {
    const s = setup();
    const gh = replayGh(rec, budget, writeArtifact);
    const days = refreshOlderDays({
      gh,
      files: s.files,
      workflows: s.workflows,
      dataDir,
      now: new Date(NOW),
      tmpDir: temp('ci-steward-tmp-'),
    });
    return { days, gh, snap: readData(dataDir, snapshotPath(DAY), SnapshotSchema)! };
  }

  it('adds per-workflow results and repeat_ejections to a day collected before them', () => {
    const dataDir = legacyDay();
    const rec = dayRecording();
    rec.rest[PUSH_PATH] = { total_count: push.length, workflow_runs: push };
    const { days, gh, snap } = refresh(rec, dataDir);
    expect(days).toEqual([DAY]);
    expect(snap.main).toEqual([
      {
        sha: 'ccc',
        at: `${DAY}T13:00:00Z`,
        done: `${DAY}T13:10:00Z`,
        red: false,
        workflows: { 'lint.yml': false },
      },
    ]);
    expect(snap.counts.repeat_ejections).toBe(0);
    // One run listing and one merged-PR search: never a re-collection.
    expect(gh.calls).toBe(2);
    // Done once: a second pass spends nothing.
    expect(refresh(rec, dataDir).gh.calls).toBe(0);
  });

  it('leaves a day untouched when its run listing comes back short', () => {
    const dataDir = legacyDay();
    const rec = dayRecording();
    rec.rest[PUSH_PATH] = { total_count: 5, workflow_runs: push };
    const { days, snap } = refresh(rec, dataDir);
    expect(days).toEqual([]);
    expect(snap.counts.repeat_ejections).toBeUndefined();
    expect(snap.main[0]!.workflows).toBeUndefined();
  });

  it('stops quietly when the budget runs out', () => {
    const dataDir = legacyDay();
    const rec = dayRecording();
    rec.rest[PUSH_PATH] = { total_count: push.length, workflow_runs: push };
    expect(refresh(rec, dataDir, 5).days).toEqual([]);
  });
});
