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
import { MISSED_TICKS_CAP, STALE_CEILING_MS, resolveOccurrence } from '../occurrence.js';

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
const MIN = 60_000;

describe('resolveOccurrence', () => {
  describe('an on-time fire keys exactly as it always did (no dedupe-log migration)', () => {
    // Purpose: the claim key moved from "the fire's wall-clock minute" to "the
    // occurrence". On every on-time fire those must be the same number, or an
    // upgrade mid-tick would let the new build re-run an occurrence the old
    // build already claimed. Covers 5-field, 6-field, an alias, and a
    // non-UTC zone across both DST changes.
    const cases: Array<{ cron: string; tz: string; from: string }> = [
      { cron: '* * * * *', tz: 'UTC', from: '2026-10-05T11:58:00Z' },
      { cron: '*/5 * * * *', tz: 'UTC', from: '2026-10-05T11:00:00Z' },
      { cron: '*/30 * * * * *', tz: 'UTC', from: '2026-10-05T11:59:00Z' },
      { cron: '15 * * * * *', tz: 'UTC', from: '2026-10-05T11:59:00Z' },
      { cron: '@hourly', tz: 'UTC', from: '2026-10-05T08:00:00Z' },
      { cron: '@hourly', tz: 'Asia/Kolkata', from: '2026-10-05T08:00:00Z' },
      // Spring forward (02:00 → 03:00 local) and fall back (01:00 twice).
      { cron: '0 * * * *', tz: 'America/New_York', from: '2026-03-08T04:00:00Z' },
      { cron: '30 1 * * *', tz: 'America/New_York', from: '2026-10-30T00:00:00Z' },
      { cron: '30 2 * * *', tz: 'America/New_York', from: '2026-03-06T00:00:00Z' },
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

  it('names the occurrence a late fire stands for, not the minute it fired in', () => {
    // The bug (spec Part C): a daily 09:00 fire that lands at 09:21:00.1 used to
    // key on 09:21, an instant that is no occurrence of the schedule at all.
    const job = evaluator('0 9 * * *');
    const occurrence = resolveOccurrence(
      job,
      at('2026-10-05T09:00:00Z'),
      at('2026-10-05T09:21:00.100Z')
    );
    expect(occurrence.intendedFor.toISOString()).toBe('2026-10-05T09:00:00.000Z');
    expect(occurrence.lateByMs).toBe(21 * MIN + 100);
    expect(occurrence.stale).toBe(false);
  });

  it('agrees on one occurrence for two fires either side of a minute boundary', () => {
    const job = evaluator('0 9 * * *');
    const expected = at('2026-10-05T09:00:00Z');
    const a = resolveOccurrence(job, expected, at('2026-10-05T09:20:59.900Z'));
    const b = resolveOccurrence(job, expected, at('2026-10-05T09:21:00.100Z'));
    expect(a.intendedFor.getTime()).toBe(b.intendedFor.getTime());
  });

  describe('staleness: runs only under an hour late AND under halfway to the next tick', () => {
    it('a daily run 59 minutes late still runs', () => {
      const job = evaluator('0 9 * * *');
      const o = resolveOccurrence(job, at('2026-10-05T09:00:00Z'), at('2026-10-05T09:59:00Z'));
      expect(o.stale).toBe(false);
    });

    it('a daily run 61 minutes late is stale', () => {
      const job = evaluator('0 9 * * *');
      const o = resolveOccurrence(job, at('2026-10-05T09:00:00Z'), at('2026-10-05T10:01:00Z'));
      expect(o.stale).toBe(true);
    });

    it('the hour ceiling itself is stale ("under one hour" means under)', () => {
      const job = evaluator('0 9 * * *');
      const o = resolveOccurrence(
        job,
        at('2026-10-05T09:00:00Z'),
        new Date(at('2026-10-05T09:00:00Z').getTime() + STALE_CEILING_MS)
      );
      expect(o.stale).toBe(true);
    });

    it('a daily 09:00 opened at 09:40 runs; opened at 11:00 it is stale', () => {
      const job = evaluator('0 9 * * *');
      const expected = at('2026-10-05T09:00:00Z');
      expect(resolveOccurrence(job, expected, at('2026-10-05T09:40:00Z')).stale).toBe(false);
      expect(resolveOccurrence(job, expected, at('2026-10-05T11:00:00Z')).stale).toBe(true);
    });

    it('every 5 minutes: 2m29s late runs, 2m31s late is stale (halfway is 2m30s)', () => {
      const job = evaluator('*/5 * * * *');
      const expected = at('2026-10-05T12:00:00Z');
      const runs = resolveOccurrence(job, expected, at('2026-10-05T12:02:29Z'));
      const stale = resolveOccurrence(job, expected, at('2026-10-05T12:02:31Z'));
      expect(runs.stale).toBe(false);
      expect(stale.stale).toBe(true);
      expect(stale.intendedFor.toISOString()).toBe('2026-10-05T12:00:00.000Z');
    });

    it('exactly halfway is stale ("less than halfway" means less)', () => {
      const job = evaluator('*/5 * * * *');
      const o = resolveOccurrence(job, at('2026-10-05T12:00:00Z'), at('2026-10-05T12:02:30Z'));
      expect(o.stale).toBe(true);
    });

    it('hourly: 12 minutes late runs, 45 minutes late is stale', () => {
      const job = evaluator('0 * * * *');
      const expected = at('2026-10-05T12:00:00Z');
      expect(resolveOccurrence(job, expected, at('2026-10-05T12:12:00Z')).stale).toBe(false);
      expect(resolveOccurrence(job, expected, at('2026-10-05T12:45:00Z')).stale).toBe(true);
    });
  });

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
    it('counts the occurrences between the one croner waited for and the one that fired', () => {
      // Asleep from before 09:00 until 12:12: 09:00, 10:00 and 11:00 never
      // fired; 12:00 is the one that runs, 12 minutes late.
      const job = evaluator('0 * * * *');
      const o = resolveOccurrence(job, at('2026-10-05T09:00:00Z'), at('2026-10-05T12:12:00Z'));
      expect(o.intendedFor.toISOString()).toBe('2026-10-05T12:00:00.000Z');
      expect(o.missed).toBe(3);
      expect(o.stale).toBe(false);
    });

    it('counts nothing for a late fire of the very occurrence croner waited for', () => {
      const job = evaluator('0 * * * *');
      const o = resolveOccurrence(job, at('2026-10-05T12:00:00Z'), at('2026-10-05T12:12:00Z'));
      expect(o.missed).toBe(0);
    });

    it('counts nothing when nobody knows which occurrence croner was waiting for', () => {
      const job = evaluator('0 * * * *');
      const o = resolveOccurrence(job, null, at('2026-10-05T12:12:00Z'));
      expect(o.missed).toBe(0);
    });

    it(`caps a per-second schedule asleep for a day at ${MISSED_TICKS_CAP}`, () => {
      const job = evaluator('* * * * * *');
      const o = resolveOccurrence(job, at('2026-10-04T12:00:00Z'), at('2026-10-05T12:00:00.400Z'));
      expect(o.missed).toBe(MISSED_TICKS_CAP);
      expect(o.intendedFor.toISOString()).toBe('2026-10-05T12:00:00.000Z');
    });
  });
});
