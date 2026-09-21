/**
 * Every SLO's number, pinned by one recorded week (the `fixture` each
 * definition in ci/slos.yaml names). The week was collected from the real
 * GitHub API on 2026-09-19 by the phase-1 dry run; it is replayed here through
 * the real ci/slos.yaml, so a change to a definition, or to how a snapshot is
 * read, shows up as a changed number rather than a silent drift.
 *
 * The readings also agree with the research that set "today" in ci/slos.yaml
 * (research/20260919_ci-pipeline-02-timings.md): queue-green 75%, wasted builds
 * in the 17-21% band's neighbourhood, queue-build p50 30 min, lead time p50
 * 58 min and p90 3.0 h.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { SnapshotSchema } from '../data.ts';
import { floorValues } from '../floors.ts';
import { loadHandFiles } from '../load.ts';
import { computeSlos } from '../slo.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const slos = loadHandFiles(REPO).files!.slos!;
const recorded = JSON.parse(
  gunzipSync(
    readFileSync(path.join(import.meta.dirname, 'fixtures', 'week-2026-09-12.snapshots.json.gz'))
  ).toString('utf8')
) as { days: Record<string, unknown> };
const snapshots = Object.values(recorded.days).map((d) => SnapshotSchema.parse(d));

const readings = computeSlos(slos, floorValues(slos, null), {
  snapshots,
  local: [],
  toolCeilingSeconds: 600,
  from: '2026-09-12',
  to: '2026-09-18',
});
const byId = new Map(readings.map((r) => [r.id, r]));

describe('SLOs over the recorded week 2026-09-12..18', () => {
  it('computes every SLO in ci/slos.yaml', () => {
    expect(readings.map((r) => r.id)).toEqual(slos.slos.map((s) => s.id));
  });

  // headroom is 7772 and not 7773 because one recorded run of a gate that also
  // runs on the merge path came in on a canary event; `onMergePath` keeps that
  // gate's population to what merging costs. Gates that run on NOTHING but a
  // schedule (merge-tail's arm, evals, CodeQL) keep every sample, which is why
  // the number moved by one and not by the 56 canary-event samples in the week.
  it.each([
    ['headroom', 'ok', 7772, { p95_over_timeout: 0.651 }],
    ['queue-green', 'ok', 160, { share: 0.75 }],
    ['wasted-queue-builds', 'ok', 160, { share: 0.1625 }],
    ['flaky-test-runs', 'met', 20507, { share: 0.005 }],
    ['main-green', 'ok', 108, { red_episodes: 2, restore_p90: 26.3 }],
    ['review-completes', 'ok', 107, { share: 0.9065 }],
    ['review-recovery', 'met', 5, { p90: 27 }],
    ['pr-feedback', 'ok', 99, { p50: 14.1, p90: 19.4 }],
    ['queue-build', 'ok', 85, { p50: 29.5, p90: 43.6 }],
    ['lead-time', 'ok', 111, { p50: 54.8, p90: 179.4 }],
  ] as const)('%s: %s, n=%i', (id, status, n, stats) => {
    expect(byId.get(id)).toMatchObject({ status, n, stats });
  });

  it('local-commit and local-push are unmeasured until a clone exports', () => {
    expect(byId.get('local-commit')?.status).toBe('unmeasured');
    expect(byId.get('local-push')?.status).toBe('unmeasured');
  });

  it('ranks lead-time as the constraint by excess wait-hours', () => {
    const ranked = readings
      .filter((r) => (r.excess_hours ?? 0) > 0)
      .sort((a, b) => b.excess_hours! - a.excess_hours!);
    expect(ranked.map((r) => r.id)).toEqual([
      'lead-time',
      'wasted-queue-builds',
      'queue-build',
      'pr-feedback',
    ]);
  });
});
