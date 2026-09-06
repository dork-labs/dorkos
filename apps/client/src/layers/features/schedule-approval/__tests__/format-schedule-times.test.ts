/**
 * Saying when a proposed schedule would run.
 *
 * A cron expression is the one part of a proposal an operator cannot verify by
 * reading it, so everything here is about turning it into something checkable —
 * and about refusing to invent anything when it cannot.
 */
import { describe, it, expect } from 'vitest';
import { formatCadence, formatFirstRuns, formatRunMoment } from '../lib/format-schedule-times';

/** A fixed "now": 2026-08-21, 09:00 local. */
const NOW = new Date(2026, 7, 21, 9, 0, 0).getTime();

/** An ISO timestamp `hours` from {@link NOW}. */
function hoursFromNow(hours: number): string {
  return new Date(NOW + hours * 3_600_000).toISOString();
}

describe('formatCadence', () => {
  it('says the cadence in words, anchored to its timezone', () => {
    expect(formatCadence('0 3 * * *', 'America/Chicago')).toBe('At 03:00 AM (America/Chicago)');
  });

  it('leaves the zone off when the schedule carries none', () => {
    // A parenthetical with nothing in it reads as a missing value; saying only
    // what is known is the honest shape.
    expect(formatCadence('0 3 * * *', null)).toBe('At 03:00 AM');
  });

  it('falls back to the raw expression for a cron it cannot parse', () => {
    // The literal thing the scheduler will run, so somebody can paste it
    // somewhere that CAN read it. Seeded defect: return '' or 'Unknown' in the
    // catch and the operator is told nothing about when this fires.
    expect(formatCadence('every other tuesday', 'UTC')).toBe('every other tuesday (UTC)');
  });

  it('says a task with no cron is on demand', () => {
    expect(formatCadence(null, 'UTC')).toBe('On demand. It only runs when something asks it to');
  });
});

describe('formatRunMoment', () => {
  it('names today rather than dating it', () => {
    expect(formatRunMoment(hoursFromNow(3), NOW)).toMatch(/^today at /);
  });

  it('names tomorrow rather than dating it', () => {
    expect(formatRunMoment(hoursFromNow(24), NOW)).toMatch(/^tomorrow at /);
  });

  it('compares calendar days, not a span of hours', () => {
    // Eight hours from 09:00 is the same day; eight hours from 23:00 is not.
    // A span-of-hours implementation calls both "today", which is the bug this
    // pins — and the reason the helper builds local midnights.
    const lateNight = new Date(2026, 7, 21, 23, 0, 0).getTime();
    expect(formatRunMoment(new Date(lateNight + 8 * 3_600_000).toISOString(), lateNight)).toMatch(
      /^tomorrow at /
    );
  });

  it('dates anything further out, because a bare weekday is not a time', () => {
    const phrase = formatRunMoment(hoursFromNow(24 * 9), NOW);
    expect(phrase).not.toMatch(/^(today|tomorrow) at /);
    expect(phrase).toMatch(/ at /);
  });

  it('answers null for a timestamp it cannot read', () => {
    // Degrades to nothing rather than to "Invalid Date at Invalid Date".
    expect(formatRunMoment('not a date', NOW)).toBeNull();
  });
});

describe('formatFirstRuns', () => {
  it('splits the first run from the ones that follow', () => {
    const runs = formatFirstRuns([hoursFromNow(3), hoursFromNow(27), hoursFromNow(51)], NOW);

    expect(runs?.first).toMatch(/^today at /);
    expect(runs?.then).toHaveLength(2);
  });

  it('answers null when the server sent nothing', () => {
    // The real state for an unparseable cron. Inventing a first run here would
    // put a fabricated time on the card somebody approves on.
    expect(formatFirstRuns([], NOW)).toBeNull();
  });

  it('drops unreadable timestamps rather than the whole list', () => {
    const runs = formatFirstRuns(['nonsense', hoursFromNow(3)], NOW);

    expect(runs?.first).toMatch(/^today at /);
    expect(runs?.then).toEqual([]);
  });

  it('answers null when every timestamp is unreadable', () => {
    expect(formatFirstRuns(['nonsense', 'also nonsense'], NOW)).toBeNull();
  });

  it('handles a schedule with exactly one upcoming run', () => {
    const runs = formatFirstRuns([hoursFromNow(3)], NOW);

    // `then` empty is what makes the card leave off the "· then …" clause
    // entirely rather than drawing a dangling separator.
    expect(runs?.then).toEqual([]);
  });
});
