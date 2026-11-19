/**
 * Telling a live owner from a gone one (DOR-4209): `ps` start times read the
 * same in every time zone, and a poll costs at most one `ps` per pid.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  START_TIME_CACHE_MS,
  createHolderProbe,
  holderIsLive,
  parseUtcLstart,
} from '../holder-identity.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('parseUtcLstart', () => {
  const expected = Date.UTC(2026, 10, 8, 9, 5, 7) / 1_000;

  it('reads what `ps` printed as UTC, whatever zone this process is in', () => {
    for (const zone of ['UTC', 'America/Chicago', 'Pacific/Auckland', 'Asia/Kolkata']) {
      vi.stubEnv('TZ', zone);
      // Padded the way `ps` pads a one-digit day.
      expect(parseUtcLstart('Sun Nov  8 09:05:07 2026\n'), zone).toBe(expected);
    }
  });

  it('answers null for anything that is not an lstart time', () => {
    expect(parseUtcLstart('')).toBeNull();
    expect(parseUtcLstart('Sun Foo  8 09:05:07 2026')).toBeNull();
    expect(parseUtcLstart('2026-11-08T09:05:07Z')).toBeNull();
  });
});

describe('the start-time cache', () => {
  it('asks once per pid within one poll, and again once the poll has passed', () => {
    let now = 1_000_000;
    const lookup = vi.fn((pid: number) => (pid === 41 ? 500 : 900));
    const probe = createHolderProbe({
      lookupStartedAt: lookup,
      isAlive: () => true,
      now: () => now,
    });
    const self = { pid: 1, startedAt: 1 };

    // Several checks of the same two owners inside one poll.
    for (let check = 0; check < 5; check += 1) {
      expect(holderIsLive({ pid: 41, startedAt: 500 }, probe, self)).toBe(true);
      expect(holderIsLive({ pid: 42, startedAt: 100 }, probe, self)).toBe(false);
    }
    expect(lookup).toHaveBeenCalledTimes(2);

    now += START_TIME_CACHE_MS;
    holderIsLive({ pid: 41, startedAt: 500 }, probe, self);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('never asks about this process, or a pid that is not running', () => {
    const lookup = vi.fn(() => 1);
    const probe = createHolderProbe({ lookupStartedAt: lookup, isAlive: (pid) => pid !== 43 });
    const self = { pid: 7, startedAt: 70 };
    expect(holderIsLive({ pid: 7, startedAt: 71 }, probe, self)).toBe(true);
    expect(holderIsLive({ pid: 7, startedAt: 90 }, probe, self)).toBe(false);
    expect(holderIsLive({ pid: 43, startedAt: 1 }, probe, self)).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });
});
