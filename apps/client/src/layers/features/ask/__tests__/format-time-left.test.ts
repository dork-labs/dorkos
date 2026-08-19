/**
 * The decision window is hours long, so the countdown has to read in hours as
 * well as minutes — and has to stay honest at both ends of the window.
 */
import { describe, it, expect } from 'vitest';
import { ASK_PARKED_LABEL, formatAskTimeLeft, formatTimeLeft } from '../lib/format-time-left';

/** An ISO timestamp `ms` milliseconds after `now`. */
function inMs(now: number, ms: number): string {
  return new Date(now + ms).toISOString();
}

describe('formatTimeLeft', () => {
  const now = Date.parse('2026-07-25T12:00:00.000Z');

  it('counts down in minutes below the hour', () => {
    expect(formatTimeLeft(inMs(now, 8.5 * 60_000), now)).toBe('8 min left');
    expect(formatTimeLeft(inMs(now, 59 * 60_000), now)).toBe('59 min left');
  });

  it('counts down in hours and minutes above the hour', () => {
    expect(formatTimeLeft(inMs(now, 65 * 60_000), now)).toBe('1 hr 5 min left');
    expect(formatTimeLeft(inMs(now, 119 * 60_000), now)).toBe('1 hr 59 min left');
  });

  it('drops the minutes when a whole number of hours is left', () => {
    expect(formatTimeLeft(inMs(now, 120 * 60_000), now)).toBe('2 hr left');
    expect(formatTimeLeft(inMs(now, 60 * 60_000), now)).toBe('1 hr left');
  });

  it('warns inside the last minute instead of saying zero', () => {
    expect(formatTimeLeft(inMs(now, 30_000), now)).toBe('expiring');
    expect(formatTimeLeft(inMs(now, 1), now)).toBe('expiring');
  });

  it('reports a closed window, including a timestamp it cannot read', () => {
    expect(formatTimeLeft(inMs(now, 0), now)).toBe('expired');
    expect(formatTimeLeft(inMs(now, -60_000), now)).toBe('expired');
    expect(formatTimeLeft('not a date', now)).toBe('expired');
  });
});

describe('formatAskTimeLeft', () => {
  it('counts an Ask down in seconds and minutes', () => {
    expect(formatAskTimeLeft(35)).toBe('35s left');
    expect(formatAskTimeLeft(59)).toBe('59s left');
    expect(formatAskTimeLeft(120)).toBe('2 min left');
  });

  it('reads a countdown at or below zero as waiting, never as expired', () => {
    // The server never lists a prompt whose remainder has run out, so an Ask
    // this client still holds whose countdown is out is one the agent PARKED on
    // and is still waiting for (spec `ask-parks-on-timeout`). "expired" over a
    // live wait is the exact lie that item removes.
    expect(formatAskTimeLeft(0)).toBe(ASK_PARKED_LABEL);
    expect(formatAskTimeLeft(-30)).toBe(ASK_PARKED_LABEL);
    expect(formatAskTimeLeft(Number.NaN)).toBe(ASK_PARKED_LABEL);
    expect(ASK_PARKED_LABEL).toBe('waiting for you');
  });
});
