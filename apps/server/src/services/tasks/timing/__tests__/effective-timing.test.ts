/**
 * The one rule for when a schedule runs, once a person can override a
 * package's timing (DOR-2302). Pure functions over the four timing columns.
 *
 * @module services/tasks/timing/__tests__/effective-timing
 */
import { describe, it, expect } from 'vitest';
import {
  effectiveContentKey,
  effectiveTiming,
  timingColumnWrites,
  type TimingColumns,
} from '../effective-timing.js';
import { scheduleContentKey } from '../../schedule-permission-clamp.js';

/** Settings every key carries (DOR-2323); held constant in these cases. */
const SETTINGS = {
  name: 'drain',
  runtime: null,
  model: null,
  effort: null,
  maxRuntime: null,
  sticky: false,
  account: null,
};

/** A package's schedule on its own timing: hourly, UTC, nothing overridden. */
const PACKAGE_TIMING: TimingColumns = {
  cron: '0 * * * *',
  timezone: 'UTC',
  cronOverride: null,
  timezoneOverride: null,
};

describe('effectiveTiming', () => {
  it.each<[string, Partial<TimingColumns>, { cron: string; timezone: string }]>([
    ['nothing overridden runs the file', {}, { cron: '0 * * * *', timezone: 'UTC' }],
    // Overriding one half must not blank the other.
    [
      'a timezone alone',
      { timezoneOverride: 'Europe/Berlin' },
      { cron: '0 * * * *', timezone: 'Europe/Berlin' },
    ],
    // `''` is a real choice (off the timer), not "no override".
    ["an override of '' is on demand", { cronOverride: '' }, { cron: '', timezone: 'UTC' }],
  ])('%s', (_name, overrides, expected) => {
    expect(effectiveTiming({ ...PACKAGE_TIMING, ...overrides })).toEqual(expected);
  });
});

describe('effectiveContentKey', () => {
  it('keys the grant on the cron and timezone that run (DOR-2307)', () => {
    // A grant on the package's timing while the person's runs would cover work
    // nobody approved; the same cron in another zone runs at another time.
    expect(
      effectiveContentKey({
        ...SETTINGS,
        ...PACKAGE_TIMING,
        cronOverride: '0 9 * * *',
        timezoneOverride: 'Asia/Tokyo',
        prompt: 'Drain.',
      })
    ).toBe(
      scheduleContentKey({
        ...SETTINGS,
        prompt: 'Drain.',
        cron: '0 9 * * *',
        timezone: 'Asia/Tokyo',
      })
    );
  });
});

describe('timingColumnWrites', () => {
  const OVERRIDDEN: TimingColumns = {
    ...PACKAGE_TIMING,
    cronOverride: '0 9 * * *',
    timezoneOverride: 'Asia/Tokyo',
  };

  it.each<
    [string, TimingColumns, Parameters<typeof timingColumnWrites>[1], 'row' | 'file', object]
  >([
    // A package's schedule: the person's timing goes beside the file's, never over it.
    [
      'row: writes the override only',
      PACKAGE_TIMING,
      { cron: '0 9 * * *' },
      'row',
      { cronOverride: '0 9 * * *' },
    ],
    [
      "row: the package's own value is no override",
      OVERRIDDEN,
      { cron: '0 * * * *', timezone: 'UTC' },
      'row',
      { cronOverride: null, timezoneOverride: null },
    ],
    // null means "no timer"; NULL in the column would mean "the package's timer".
    ["row: cron null is stored as ''", PACKAGE_TIMING, { cron: null }, 'row', { cronOverride: '' }],
    [
      'row: a reset clears both',
      OVERRIDDEN,
      { resetTiming: true },
      'row',
      { cronOverride: null, timezoneOverride: null },
    ],
    // Judged against what runs after the reset, or the reset would silently win.
    [
      'row: an explicit timing beside a reset survives it',
      OVERRIDDEN,
      { resetTiming: true, cron: '0 9 * * *' },
      'row',
      { cronOverride: '0 9 * * *', timezoneOverride: null },
    ],
    [
      'file: writes the file columns as an update always has',
      { ...PACKAGE_TIMING, timezone: 'Asia/Tokyo' },
      { cron: null, timezone: null },
      'file',
      { cron: '', cronOverride: null, timezone: 'UTC', timezoneOverride: null },
    ],
    // A cron written to the file is the new timing; a stale override would beat it.
    [
      'file: clears only the override of the field it writes',
      OVERRIDDEN,
      { cron: '0 6 * * *' },
      'file',
      { cron: '0 6 * * *', cronOverride: null },
    ],
    // A re-sent current timing must not copy the override over the default.
    [
      'file: nothing for a value already running',
      OVERRIDDEN,
      { cron: '0 9 * * *', timezone: 'Asia/Tokyo' },
      'file',
      {},
    ],
    ['file: nothing for a request without timing', PACKAGE_TIMING, {}, 'file', {}],
  ])('%s', (_name, columns, request, lands, expected) => {
    expect(timingColumnWrites(columns, request, lands)).toEqual(expected);
  });
});
