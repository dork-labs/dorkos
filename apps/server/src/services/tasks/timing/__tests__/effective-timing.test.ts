/**
 * The one rule for when a schedule runs, once a person can override a
 * package's timing (DOR-2302).
 *
 * Pure functions over the four timing columns, so each case states one
 * column combination and what must come out of it.
 *
 * @module services/tasks/timing/__tests__/effective-timing
 */
import { describe, it, expect } from 'vitest';
import {
  conflictingTimingRequest,
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
  it("runs on the file's timing when nothing is overridden", () => {
    // Purpose: the ordinary case for every schedule must not change.
    expect(effectiveTiming(PACKAGE_TIMING)).toEqual({ cron: '0 * * * *', timezone: 'UTC' });
  });

  it("runs on the person's cron and timezone when they set them", () => {
    // Purpose: the override is what runs, not the package's value.
    expect(
      effectiveTiming({
        ...PACKAGE_TIMING,
        cronOverride: '0 9 * * 1',
        timezoneOverride: 'Asia/Tokyo',
      })
    ).toEqual({ cron: '0 9 * * 1', timezone: 'Asia/Tokyo' });
  });

  it('takes each half on its own, so a timezone alone can be changed', () => {
    // Purpose: overriding one half must not blank the other.
    expect(effectiveTiming({ ...PACKAGE_TIMING, timezoneOverride: 'Europe/Berlin' })).toEqual({
      cron: '0 * * * *',
      timezone: 'Europe/Berlin',
    });
  });

  it("treats an override of '' as on demand, not as no override", () => {
    // Purpose: `''` is a real choice (off the timer); reading it as absent
    // would put the package's timer back without anyone asking.
    expect(effectiveTiming({ ...PACKAGE_TIMING, cronOverride: '' }).cron).toBe('');
  });
});

describe('effectiveContentKey', () => {
  it('keys the grant on the cron that runs', () => {
    // Purpose: a grant recorded against the package's cron while the person's
    // runs would cover work nobody approved.
    expect(
      effectiveContentKey({
        ...SETTINGS,
        ...PACKAGE_TIMING,
        cronOverride: '0 9 * * *',
        prompt: 'Drain.',
      })
    ).toBe(
      scheduleContentKey({ ...SETTINGS, prompt: 'Drain.', cron: '0 9 * * *', timezone: 'UTC' })
    );
  });

  it('keys the grant on the timezone that runs too (DOR-2307)', () => {
    // Purpose: the same cron in another zone runs at another time — up to a
    // day away — so a timezone-only change is new work to approve.
    expect(
      effectiveContentKey({
        ...SETTINGS,
        ...PACKAGE_TIMING,
        timezoneOverride: 'Asia/Tokyo',
        prompt: 'Drain.',
      })
    ).toBe(
      scheduleContentKey({
        ...SETTINGS,
        prompt: 'Drain.',
        cron: '0 * * * *',
        timezone: 'Asia/Tokyo',
      })
    );
    expect(effectiveContentKey({ ...SETTINGS, ...PACKAGE_TIMING, prompt: 'Drain.' })).not.toBe(
      effectiveContentKey({
        ...SETTINGS,
        ...PACKAGE_TIMING,
        timezoneOverride: 'Asia/Tokyo',
        prompt: 'Drain.',
      })
    );
  });
});

describe('timingColumnWrites — a package schedule (lands on the row)', () => {
  it('writes the override and leaves the file columns alone', () => {
    // Purpose: the file's timing is the default the sync keeps writing; the
    // person's goes beside it, never over it.
    expect(timingColumnWrites(PACKAGE_TIMING, { cron: '0 9 * * *' }, 'row')).toEqual({
      cronOverride: '0 9 * * *',
    });
  });

  it("stores the package's own value as no override", () => {
    // Purpose: choosing the package's timing is not a custom timing, so the
    // Schedules page must not mark it as one.
    expect(
      timingColumnWrites(
        { ...PACKAGE_TIMING, cronOverride: '0 9 * * *' },
        { cron: '0 * * * *', timezone: 'UTC' },
        'row'
      )
    ).toEqual({ cronOverride: null });
  });

  it("stores cron: null as '' — the person took it off its timer", () => {
    // Purpose: null here means "no timer", and NULL in the column would mean
    // "the package's timer" — the opposite.
    expect(timingColumnWrites(PACKAGE_TIMING, { cron: null }, 'row')).toEqual({ cronOverride: '' });
  });

  it('stores timezone: null as no override, since the default IS the file’s', () => {
    // Purpose: a cleared timezone must fall back to the package's, not UTC.
    expect(
      timingColumnWrites(
        { ...PACKAGE_TIMING, timezoneOverride: 'Asia/Tokyo' },
        { timezone: null },
        'row'
      )
    ).toEqual({ timezoneOverride: null });
  });

  it('stores choosing the package’s own timezone as no override', () => {
    // Purpose: picking the package's timezone back is not a custom timing, so
    // the row must stop saying "Your timing".
    expect(
      timingColumnWrites(
        { ...PACKAGE_TIMING, timezoneOverride: 'Asia/Tokyo' },
        { timezone: 'UTC' },
        'row'
      )
    ).toEqual({ timezoneOverride: null });
  });

  it('writes a timezone override on its own', () => {
    // Purpose: the second half lands on its own column, not the file's.
    expect(timingColumnWrites(PACKAGE_TIMING, { timezone: 'Asia/Tokyo' }, 'row')).toEqual({
      timezoneOverride: 'Asia/Tokyo',
    });
  });
});

describe('timingColumnWrites — a reset', () => {
  it('clears both overrides', () => {
    // Purpose: "Reset to the package's default" is both halves at once.
    expect(
      timingColumnWrites(
        { ...PACKAGE_TIMING, cronOverride: '0 9 * * *', timezoneOverride: 'Asia/Tokyo' },
        { resetTiming: true },
        'row'
      )
    ).toEqual({ cronOverride: null, timezoneOverride: null });
  });

  it('applies an explicit timing on top of a reset rather than dropping it', () => {
    // Purpose: the doors refuse this pairing, but the store must still not
    // throw away something the caller said if one reaches it.
    expect(
      timingColumnWrites(
        { ...PACKAGE_TIMING, cronOverride: '0 9 * * *', timezoneOverride: 'Asia/Tokyo' },
        { resetTiming: true, cron: '*/5 * * * *' },
        'row'
      )
    ).toEqual({ cronOverride: '*/5 * * * *', timezoneOverride: null });
  });

  it('judges the explicit timing against what runs after the reset, not before it', () => {
    // Purpose: re-sending the override that was running, beside a reset, is an
    // explicit timing — measured against the pre-reset value it would look
    // unchanged and the reset would silently win.
    expect(
      timingColumnWrites(
        { ...PACKAGE_TIMING, cronOverride: '0 9 * * *' },
        { resetTiming: true, cron: '0 9 * * *' },
        'row'
      )
    ).toEqual({ cronOverride: '0 9 * * *', timezoneOverride: null });
  });
});

describe('timingColumnWrites — a schedule whose file DorkOS writes (lands on the file)', () => {
  it('writes the file columns exactly as an update always has', () => {
    // Purpose: ordinary schedules keep their existing behavior, `''` for no
    // cron and UTC for no timezone.
    expect(
      timingColumnWrites(
        { ...PACKAGE_TIMING, timezone: 'Asia/Tokyo' },
        { cron: null, timezone: null },
        'file'
      )
    ).toEqual({ cron: '', cronOverride: null, timezone: 'UTC', timezoneOverride: null });
  });

  it('clears only the override of the field it writes', () => {
    // Purpose: a cron written to the file is the new timing, and an override
    // left behind would silently beat it; the other half is not the caller's
    // business.
    expect(
      timingColumnWrites(
        { ...PACKAGE_TIMING, cronOverride: '0 9 * * *', timezoneOverride: 'Asia/Tokyo' },
        { cron: '0 6 * * *' },
        'file'
      )
    ).toEqual({ cron: '0 6 * * *', cronOverride: null });
  });

  it('writes nothing for a value that is already what runs, even with an override in place', () => {
    // Purpose: a re-sent current cron on a package's schedule changes no field,
    // so it arrives as `file` without anyone asking who owns it. Writing it
    // would copy the person's timing over the package's default and drop the
    // override — the next sync would then run the package's timing again.
    const overridden = {
      ...PACKAGE_TIMING,
      cronOverride: '0 9 * * *',
      timezoneOverride: 'Asia/Tokyo',
    };
    expect(
      timingColumnWrites(overridden, { cron: '0 9 * * *', timezone: 'Asia/Tokyo' }, 'file')
    ).toEqual({});
    expect(
      timingColumnWrites(overridden, { cron: '0 9 * * *', timezone: 'Asia/Tokyo' }, 'row')
    ).toEqual({});
  });

  it('writes nothing for a request that says nothing about timing', () => {
    // Purpose: an unrelated edit must never touch the timing columns.
    expect(timingColumnWrites(PACKAGE_TIMING, {}, 'file')).toEqual({});
    expect(timingColumnWrites(PACKAGE_TIMING, {}, 'row')).toEqual({});
  });
});

describe('conflictingTimingRequest', () => {
  it('refuses a reset sent with a cron or a timezone', () => {
    // Purpose: the two ask for different timings; picking one silently would
    // do something the caller did not ask for.
    expect(conflictingTimingRequest({ resetTiming: true, cron: '0 9 * * *' })).toMatch(
      /resetTiming/
    );
    expect(conflictingTimingRequest({ resetTiming: true, timezone: 'UTC' })).toMatch(/resetTiming/);
  });

  it('lets a reset alone, or a timing alone, through', () => {
    // Purpose: the refusal must not catch the two ordinary requests.
    expect(conflictingTimingRequest({ resetTiming: true })).toBeNull();
    expect(conflictingTimingRequest({ cron: '0 9 * * *', timezone: 'UTC' })).toBeNull();
  });
});
