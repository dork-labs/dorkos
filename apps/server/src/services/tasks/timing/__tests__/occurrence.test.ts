/**
 * Which scheduled occurrence a cron fire stands for, and whether it is still
 * worth running (DOR-2718).
 *
 * Every case drives REAL croner: the occurrence arithmetic is croner's own
 * (`previousRuns`, `nextRuns`) in the job's own timezone, and croner is the
 * subject here, so a mock would only encode the hypothesis under test.
 *
 * @module services/tasks/timing/tests/occurrence
 */
import { describe, it, expect } from 'vitest';
import { Cron } from 'croner';
import { MISSED_TICKS_CAP, resolveOccurrence } from '../occurrence.js';

/** A croner evaluator that never schedules a timer — the shape the scheduler builds. */
function evaluator(cron: string, timezone = 'UTC'): Cron {
  return new Cron(cron, { paused: true, timezone });
}

/**
 * The dedupe key every build before DOR-2718 wrote, copied verbatim from the
 * retired `scheduledTickKey`. It is here as the yardstick for the
 * backward-compatibility claim: an on-time fire must key exactly as it did, so
 * the `pulse_dispatch_log` rows written by an older build keep deduping.
 */
function legacyTickKey(cron: string, firedAt: Date): number {
  const hasSecondsField = cron.trim().split(/\s+/).length >= 6;
  const resolutionMs = hasSecondsField ? 1000 : 60_000;
  return Math.floor(firedAt.getTime() / resolutionMs) * resolutionMs;
}

const at = (iso: string): Date => new Date(iso);

describe('resolveOccurrence', () => {
  describe('an on-time fire keys exactly as it always did (no dedupe-log migration)', () => {
    // Purpose: the claim key moved from "the fire's wall-clock minute" to "the
    // occurrence". On every on-time fire those must be the same number, or an
    // upgrade mid-tick would let the new build re-run an occurrence the old
    // build already claimed. Covers 5-field, 6-field, an alias, and a
    // non-UTC zone across both DST changes.
    const cases: Array<{ cron: string; tz: string; from: string }> = [
      { cron: '* * * * *', tz: 'UTC', from: '2026-10-05T11:58:00Z' },
      { cron: '*/30 * * * * *', tz: 'UTC', from: '2026-10-05T11:59:00Z' },
      { cron: '@hourly', tz: 'Asia/Kolkata', from: '2026-10-05T08:00:00Z' },
      // Spring forward (02:00 → 03:00 local) and fall back (01:00 twice).
      { cron: '0 * * * *', tz: 'America/New_York', from: '2026-03-08T04:00:00Z' },
    ];

    for (const { cron, tz, from } of cases) {
      it(`${cron} in ${tz}`, () => {
        const job = evaluator(cron, tz);
        const boundaries = job.nextRuns(6, at(from));
        expect(boundaries).toHaveLength(6);
        for (const boundary of boundaries) {
          // Croner fires a few milliseconds after the boundary on an on-time
          // fire; 0, 2 and 999 ms bracket it.
          for (const jitter of [0, 2, 999]) {
            const firedAt = new Date(boundary.getTime() + jitter);
            const occurrence = resolveOccurrence(job, boundary, firedAt);
            expect(occurrence.intendedFor.getTime()).toBe(boundary.getTime());
            expect(occurrence.intendedFor.getTime()).toBe(legacyTickKey(cron, firedAt));
            expect(occurrence.missed).toBe(0);
            expect(occurrence.stale).toBe(false);
          }
        }
      });
    }
  });

  // Staleness, missed counts and the on-time grace are pinned through the
  // scheduler in late-runs, sleep-during-run and task-scheduler tests.
  it('falls back to the awaited occurrence where croner cannot walk backwards', () => {
    // croner 10.0.1's `previousRuns` throws from inside its backward walk for a
    // reference outside the months a day-of-month pattern can match. A leap-day
    // task on a computer asleep from Feb 29 to Mar 1 fires exactly there; the
    // fire must still resolve (to a skipped record), never throw out of dispatch.
    const job = evaluator('0 0 29 2 *');
    const boundary = at('2028-02-29T00:00:00Z');
    const firedAt = at('2028-03-01T00:00:00.005Z');
    expect(() => job.previousRuns(1, at('2028-03-01T00:00:01Z'))).toThrow(TypeError);

    const occurrence = resolveOccurrence(job, boundary, firedAt);
    expect(occurrence.intendedFor.getTime()).toBe(boundary.getTime());
    expect(occurrence.stale).toBe(true);
    expect(occurrence.missed).toBe(0);
  });

  describe('missed ticks', () => {
    it(`caps a per-second schedule asleep for a day at ${MISSED_TICKS_CAP}`, () => {
      const job = evaluator('* * * * * *');
      const o = resolveOccurrence(job, at('2026-10-04T12:00:00Z'), at('2026-10-05T12:00:00.400Z'));
      expect(o.missed).toBe(MISSED_TICKS_CAP);
      expect(o.intendedFor.toISOString()).toBe('2026-10-05T12:00:00.000Z');
    });
  });
});
