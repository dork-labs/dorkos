import { describe, it, expect } from 'vitest';
import { UserProfileSchema, WorkingHoursSchema, AwaySchema } from '../config-schema.js';
import {
  DEFAULT_WORKING_HOURS,
  isValidTimeZone,
  isWithinWorkingHours,
  nextWorkingStart,
  resolveWorkingHours,
  zonedDay,
  zonedInstant,
  type ResolvedWorkingHours,
} from '../working-hours.js';

/** New York, Monday to Friday, 09:00 to 17:00. */
const NEW_YORK: ResolvedWorkingHours = {
  timezone: 'America/New_York',
  days: [1, 2, 3, 4, 5],
  start: '09:00',
  end: '17:00',
};

describe('isValidTimeZone', () => {
  it('accepts IANA zones and refuses everything else', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Olympus_Mons')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });
});

describe('resolveWorkingHours', () => {
  it('reads null as Monday to Friday, 9 to 5, in the fallback zone', () => {
    expect(resolveWorkingHours({ timezone: null, workingHours: null }, 'Asia/Tokyo')).toEqual({
      timezone: 'Asia/Tokyo',
      ...DEFAULT_WORKING_HOURS,
    });
    expect(resolveWorkingHours(undefined, 'UTC').timezone).toBe('UTC');
  });

  it('uses the stored zone and window, with days sorted and unique', () => {
    expect(
      resolveWorkingHours(
        { timezone: 'Europe/Berlin', workingHours: { days: [6, 0], start: '10:00', end: '14:00' } },
        'UTC'
      )
    ).toEqual({ timezone: 'Europe/Berlin', days: [0, 6], start: '10:00', end: '14:00' });
  });

  it('falls back when the stored zone is one this runtime cannot read', () => {
    expect(resolveWorkingHours({ timezone: 'Nowhere/Land' }, 'UTC').timezone).toBe('UTC');
  });
});

describe('isWithinWorkingHours', () => {
  it('is inside at the start minute and outside at the end minute', () => {
    // Wednesday 2026-10-14. EDT is UTC-4.
    expect(isWithinWorkingHours(new Date('2026-10-14T13:00:00Z'), NEW_YORK)).toBe(true);
    expect(isWithinWorkingHours(new Date('2026-10-14T12:59:00Z'), NEW_YORK)).toBe(false);
    expect(isWithinWorkingHours(new Date('2026-10-14T20:59:00Z'), NEW_YORK)).toBe(true);
    expect(isWithinWorkingHours(new Date('2026-10-14T21:00:00Z'), NEW_YORK)).toBe(false);
  });

  it('is outside all weekend, even at 10:00', () => {
    expect(isWithinWorkingHours(new Date('2026-10-17T14:00:00Z'), NEW_YORK)).toBe(false); // Sat
    expect(isWithinWorkingHours(new Date('2026-10-18T14:00:00Z'), NEW_YORK)).toBe(false); // Sun
  });

  it('reads the weekday in the person’s zone, not UTC', () => {
    // 02:00 UTC on Saturday is still Friday 22:00 in New York: outside, but on a
    // working day. 23:30 UTC Sunday is 08:30 Monday in Tokyo.
    const tokyo = { ...NEW_YORK, timezone: 'Asia/Tokyo', start: '08:00' };
    expect(isWithinWorkingHours(new Date('2026-10-18T23:30:00Z'), tokyo)).toBe(true);
  });

  it('keeps 09:00 at 09:00 across the autumn clock change', () => {
    // The US falls back on Sunday 2026-11-01. Monday 09:00 is 14:00 UTC (EST),
    // where the Friday before it was 13:00 UTC (EDT).
    expect(isWithinWorkingHours(new Date('2026-10-30T13:00:00Z'), NEW_YORK)).toBe(true);
    expect(isWithinWorkingHours(new Date('2026-11-02T13:30:00Z'), NEW_YORK)).toBe(false);
    expect(isWithinWorkingHours(new Date('2026-11-02T14:00:00Z'), NEW_YORK)).toBe(true);
  });
});

describe('nextWorkingStart', () => {
  it('answers today’s start when it is still ahead', () => {
    expect(nextWorkingStart(new Date('2026-10-14T11:00:00Z'), NEW_YORK)?.toISOString()).toBe(
      '2026-10-14T13:00:00.000Z'
    );
  });

  it('answers the start itself when asked at that instant', () => {
    expect(nextWorkingStart(new Date('2026-10-14T13:00:00Z'), NEW_YORK)?.toISOString()).toBe(
      '2026-10-14T13:00:00.000Z'
    );
  });

  it('answers tomorrow’s start once today’s has passed', () => {
    expect(nextWorkingStart(new Date('2026-10-14T15:00:00Z'), NEW_YORK)?.toISOString()).toBe(
      '2026-10-15T13:00:00.000Z'
    );
  });

  it('skips the weekend from Friday evening to Monday', () => {
    expect(nextWorkingStart(new Date('2026-10-16T22:00:00Z'), NEW_YORK)?.toISOString()).toBe(
      '2026-10-19T13:00:00.000Z'
    );
  });

  it('lands on Monday 09:00 local across the autumn change, an hour later in UTC', () => {
    expect(nextWorkingStart(new Date('2026-10-30T22:00:00Z'), NEW_YORK)?.toISOString()).toBe(
      '2026-11-02T14:00:00.000Z'
    );
  });

  it('lands on Monday 09:00 local across the spring change, an hour earlier in UTC', () => {
    // The US springs forward on Sunday 2026-03-08.
    expect(nextWorkingStart(new Date('2026-03-06T22:00:00Z'), NEW_YORK)?.toISOString()).toBe(
      '2026-03-09T13:00:00.000Z'
    );
  });

  it('opens a start inside the skipped hour the same distance past the gap', () => {
    const sundayEarly = { ...NEW_YORK, days: [0], start: '02:30', end: '05:00' };
    // 02:30 never happens on 2026-03-08 in New York; it opens at 03:30 EDT.
    expect(nextWorkingStart(new Date('2026-03-08T05:00:00Z'), sundayEarly)?.toISOString()).toBe(
      '2026-03-08T07:30:00.000Z'
    );
  });

  it('opens a start inside the repeated hour at its first occurrence', () => {
    const sundayEarly = { ...NEW_YORK, days: [0], start: '01:30', end: '05:00' };
    // 01:30 happens twice on 2026-11-01; the first is 01:30 EDT (05:30 UTC).
    expect(nextWorkingStart(new Date('2026-11-01T03:00:00Z'), sundayEarly)?.toISOString()).toBe(
      '2026-11-01T05:30:00.000Z'
    );
  });

  it('rolls over a month and a year end', () => {
    const utc = { ...NEW_YORK, timezone: 'UTC' };
    // Thursday 2026-12-31 after hours → Friday 2027-01-01.
    expect(nextWorkingStart(new Date('2026-12-31T18:00:00Z'), utc)?.toISOString()).toBe(
      '2027-01-01T09:00:00.000Z'
    );
  });

  it('answers null for a window with no working day', () => {
    expect(nextWorkingStart(new Date(), { ...NEW_YORK, days: [] })).toBeNull();
  });
});

describe('zonedInstant and zonedDay', () => {
  it('reads a calendar day at a wall-clock time in the zone, and back', () => {
    const backOn = zonedInstant('2026-10-20', '00:00', 'Europe/Berlin');
    // Berlin is UTC+2 in October, so local midnight is 22:00 UTC the day before.
    expect(backOn.toISOString()).toBe('2026-10-19T22:00:00.000Z');
    expect(zonedDay(backOn, 'Europe/Berlin')).toBe('2026-10-20');
    expect(zonedDay(backOn, 'UTC')).toBe('2026-10-19');
  });
});

describe('the profile schema', () => {
  it('defaults the three hours fields to null', () => {
    const profile = UserProfileSchema.parse({});
    expect(profile.timezone).toBeNull();
    expect(profile.workingHours).toBeNull();
    expect(profile.away).toBeNull();
  });

  it('refuses a zone Intl does not know', () => {
    expect(UserProfileSchema.safeParse({ timezone: 'Mars/Base' }).success).toBe(false);
    expect(UserProfileSchema.safeParse({ timezone: 'Europe/Lisbon' }).success).toBe(true);
  });

  it('refuses a day that ends before or as it starts, so no overnight window', () => {
    expect(WorkingHoursSchema.safeParse({ days: [1], start: '22:00', end: '06:00' }).success).toBe(
      false
    );
    expect(WorkingHoursSchema.safeParse({ days: [1], start: '09:00', end: '09:00' }).success).toBe(
      false
    );
    expect(WorkingHoursSchema.safeParse({ days: [1], start: '09:00', end: '17:30' }).success).toBe(
      true
    );
  });

  it('refuses bad clocks, out-of-range days, repeats and an empty week', () => {
    expect(WorkingHoursSchema.safeParse({ days: [1], start: '9:00', end: '17:00' }).success).toBe(
      false
    );
    expect(WorkingHoursSchema.safeParse({ days: [7], start: '09:00', end: '17:00' }).success).toBe(
      false
    );
    expect(
      WorkingHoursSchema.safeParse({ days: [1, 1], start: '09:00', end: '17:00' }).success
    ).toBe(false);
    expect(WorkingHoursSchema.safeParse({ days: [], start: '09:00', end: '17:00' }).success).toBe(
      false
    );
  });

  it('takes away until a date or until further notice', () => {
    expect(AwaySchema.safeParse({ until: '2026-10-20T00:00:00.000Z' }).success).toBe(true);
    expect(AwaySchema.safeParse({ until: null, note: 'On holiday' }).success).toBe(true);
    expect(AwaySchema.safeParse({ until: 'monday' }).success).toBe(false);
  });
});
