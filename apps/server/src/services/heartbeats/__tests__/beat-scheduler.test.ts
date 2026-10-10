/**
 * The cadence table, jitter, restart stagger and timers (spec `heartbeats` §3.2).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  BEAT_INTERVALS,
  BeatScheduler,
  beatInterval,
  startupBeatAt,
  systemClock,
  withJitter,
  type CadenceFacts,
} from '../beat-scheduler.js';

const NOW = Date.parse('2026-10-12T10:00:00Z');

/** Facts with nothing unusual: in hours, a change an hour ago. */
function facts(overrides: Partial<CadenceFacts> = {}): CadenceFacts {
  return {
    consecutiveFailures: 0,
    pace: null,
    inFlight: false,
    lastChangeAt: new Date(NOW - 60 * 60_000).toISOString(),
    withinHours: true,
    ...overrides,
  };
}

describe('beatInterval: each row, first match wins', () => {
  it('slows to 2 hours after three failed beat turns, over every other row', () => {
    expect(
      beatInterval(
        facts({
          consecutiveFailures: 3,
          pace: { everyMinutes: 5, untilIso: new Date(NOW + 60_000).toISOString() },
          inFlight: true,
        }),
        NOW
      )
    ).toBe(BEAT_INTERVALS.failing);
    expect(beatInterval(facts({ consecutiveFailures: 2 }), NOW)).toBe(BEAT_INTERVALS.workingHours);
  });

  it('keeps an asked-for pace until it expires', () => {
    const pace = { everyMinutes: 5, untilIso: new Date(NOW + 60_000).toISOString() };
    expect(beatInterval(facts({ pace, inFlight: true }), NOW)).toBe(5 * 60_000);
    expect(beatInterval(facts({ pace }), NOW + 120_000)).toBe(BEAT_INTERVALS.workingHours);
  });

  it('beats every 10 minutes while something it owns is in flight', () => {
    expect(beatInterval(facts({ inFlight: true, withinHours: false }), NOW)).toBe(
      BEAT_INTERVALS.inFlight
    );
  });

  it('backs off to 2 hours after a day with no change', () => {
    const lastChangeAt = new Date(NOW - 25 * 60 * 60_000).toISOString();
    expect(beatInterval(facts({ lastChangeAt }), NOW)).toBe(BEAT_INTERVALS.idle);
  });

  it('beats every 30 minutes in working hours and every 2 hours outside them', () => {
    expect(beatInterval(facts({ withinHours: true }), NOW)).toBe(30 * 60_000);
    expect(beatInterval(facts({ withinHours: false }), NOW)).toBe(2 * 60 * 60_000);
  });
});

describe('withJitter', () => {
  it('stays within ±10%', () => {
    expect(withJitter(1000, () => 0)).toBe(900);
    expect(withJitter(1000, () => 0.9999)).toBe(1100);
    expect(withJitter(1000, () => 0.5)).toBe(1000);
  });
});

describe('startupBeatAt: a restart neither skips a beat for long nor bursts', () => {
  it('staggers 1 to 5 minutes after start when the last beat is long past', () => {
    const long = new Date(NOW - 10 * 60 * 60_000).toISOString();
    expect(startupBeatAt(NOW, long, 30 * 60_000, () => 0)).toBe(NOW + 60_000);
    expect(startupBeatAt(NOW, long, 30 * 60_000, () => 1)).toBe(NOW + 5 * 60_000);
  });

  it('waits out the interval when the last beat was recent', () => {
    const recent = new Date(NOW - 10 * 60_000).toISOString();
    expect(startupBeatAt(NOW, recent, 30 * 60_000, () => 0)).toBe(NOW + 20 * 60_000);
  });

  it('staggers an agent that never beat', () => {
    expect(startupBeatAt(NOW, null, 30 * 60_000, () => 0.5)).toBe(NOW + 3 * 60_000);
  });
});

describe('BeatScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('fires once per armed timer, and a re-arm replaces the old one', () => {
    vi.useFakeTimers({ now: NOW });
    const fired: string[] = [];
    const scheduler = new BeatScheduler(systemClock, (id) => fired.push(id));
    scheduler.armAt('a', NOW + 1000);
    scheduler.armAt('a', NOW + 5000);
    vi.advanceTimersByTime(1500);
    expect(fired).toEqual([]);
    expect(scheduler.nextAt('a')).toBe(NOW + 5000);
    vi.advanceTimersByTime(4000);
    expect(fired).toEqual(['a']);
    expect(scheduler.nextAt('a')).toBeNull();
  });

  it('clears every timer at once, and nothing fires after', () => {
    vi.useFakeTimers({ now: NOW });
    const fired: string[] = [];
    const scheduler = new BeatScheduler(systemClock, (id) => fired.push(id));
    scheduler.armAt('a', NOW + 1000);
    scheduler.armAt('b', NOW + 2000);
    expect(scheduler.size).toBe(2);
    scheduler.clearAll();
    expect(scheduler.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(fired).toEqual([]);
  });
});
