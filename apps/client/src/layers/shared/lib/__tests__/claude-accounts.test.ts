/**
 * Naming and validating Claude account paths (spec `claude-code-accounts`).
 *
 * These strings are shown to a person — a badge in a list row, an option in the
 * switcher, the rename toast — and they are SERVER-side paths, so the platform
 * they came from is not the platform the cockpit runs on.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createMockAccountUsage, createMockSessionLimit } from '@dorkos/test-utils';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import {
  accountWindow,
  barTone,
  chipState,
  claudeAccountName,
  claudeAccountOptions,
  formatAsOf,
  formatBackIn,
  formatResetDay,
  formatResetTime,
  isAbsoluteAccountPath,
  isStale,
  limitSubject,
  limitText,
  nearestWindow,
  planName,
  windowShortName,
  type AccountWindow,
} from '../claude-accounts';

describe('claudeAccountName', () => {
  it('prefers the operator’s label, because that is the answer they want', () => {
    expect(
      claudeAccountName('/Users/dev/.claude2', [
        { path: '/Users/dev/.claude2', label: 'Acme Corp' },
      ])
    ).toBe('Acme Corp');
  });

  it('falls back to the folder name when the account has no label', () => {
    expect(
      claudeAccountName('/Users/dev/.claude2', [{ path: '/Users/dev/.claude2', label: null }])
    ).toBe('.claude2');
  });

  it('takes the folder name off a WINDOWS path too', () => {
    // Windows x64 is a shipped download target. Splitting on `/` alone returns
    // the whole path here, and it lands in the row badge, its accessible name,
    // the switcher, and the rename toast.
    expect(claudeAccountName('C:\\Users\\dev\\.claude2', [])).toBe('.claude2');
    expect(claudeAccountName('\\\\build-host\\share\\.claude3', [])).toBe('.claude3');
  });

  it('ignores a trailing separator on either platform', () => {
    expect(claudeAccountName('/Users/dev/.claude2/', [])).toBe('.claude2');
    expect(claudeAccountName('C:\\Users\\dev\\.claude2\\', [])).toBe('.claude2');
  });

  it('returns the input when there is no segment to take', () => {
    expect(claudeAccountName('/', [])).toBe('/');
  });
});

describe('claudeAccountOptions', () => {
  it('carries each account’s usability through, so a picker can say what the server found', () => {
    expect(
      claudeAccountOptions(
        [
          { id: 'personal', path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true },
          {
            id: 'acme-corp',
            path: '/Users/dev/.claude2',
            label: 'Acme Corp',
            isAccountRoot: false,
          },
        ],
        null
      )
    ).toEqual([
      { id: 'personal', path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true },
      { id: 'acme-corp', path: '/Users/dev/.claude2', label: 'Acme Corp', isAccountRoot: false },
    ]);
  });

  it('appends the account in use when it was never registered, claiming no verdict about it', () => {
    const options = claudeAccountOptions(
      [{ id: 'personal', path: '/Users/dev/.claude', label: 'Personal', isAccountRoot: true }],
      '/Users/dev/.claude9'
    );

    expect(options).toHaveLength(2);
    // `id: null` because nobody registered this root: it can be SHOWN, but
    // nothing can point at it, so a picker whose value is a reference must leave
    // it out. And not `isAccountRoot: false`: the server reports the structural
    // check for registered accounts only, and "unusable" would be a claim nobody
    // made.
    expect(options[1]).toEqual({
      id: null,
      path: '/Users/dev/.claude9',
      label: null,
      isAccountRoot: undefined,
    });
  });

  it('does not duplicate the account in use when it IS registered', () => {
    expect(
      claudeAccountOptions(
        [{ path: '/Users/dev/.claude2', label: 'Acme Corp', isAccountRoot: true }],
        '/Users/dev/.claude2'
      )
    ).toHaveLength(1);
  });
});

describe('isAbsoluteAccountPath', () => {
  it('accepts a POSIX path', () => {
    expect(isAbsoluteAccountPath('/Users/dev/.claude2')).toBe(true);
  });

  it('accepts a Windows drive or network path', () => {
    expect(isAbsoluteAccountPath('C:\\Users\\dev\\.claude2')).toBe(true);
    expect(isAbsoluteAccountPath('C:/Users/dev/.claude2')).toBe(true);
    expect(isAbsoluteAccountPath('\\\\build-host\\share\\.claude3')).toBe(true);
  });

  it('rejects a ~ path, which nothing on the way to the config file expands', () => {
    // The card's own placeholder used to be `~/.claude2`, and typing it
    // registered a folder that does not exist — which then flipped the
    // multi-account badge on for what was really one account.
    expect(isAbsoluteAccountPath('~/.claude2')).toBe(false);
  });

  it('rejects a relative path and an empty one', () => {
    expect(isAbsoluteAccountPath('.claude2')).toBe(false);
    expect(isAbsoluteAccountPath('claude/accounts')).toBe(false);
    expect(isAbsoluteAccountPath('')).toBe(false);
  });
});

// === Usage display helpers (spec `claude-account-ui` §5) ===

/** A window reading with the given share used and status. */
function win(overrides: Partial<AccountWindow> = {}): AccountWindow {
  return {
    key: 'five_hour',
    label: '5-hour window',
    usedPct: 40,
    resetsAt: null,
    status: 'allowed',
    expired: false,
    observedAt: '2026-09-27T12:00:00.000Z',
    source: 'sdk_event',
    ...overrides,
  };
}

function usageWith(windows: AccountWindow[], state: AccountUsage['state'] = 'ok'): AccountUsage {
  return createMockAccountUsage({ windows, state });
}

describe('accountWindow', () => {
  it('finds a window by key, and null when the account has none', () => {
    const usage = createMockAccountUsage();
    expect(accountWindow(usage, 'seven_day')?.usedPct).toBe(72);
    expect(accountWindow(usage, 'seven_day_opus')).toBeNull();
    expect(accountWindow(null, 'five_hour')).toBeNull();
    expect(accountWindow(undefined, 'five_hour')).toBeNull();
  });
});

describe('barTone', () => {
  it.each([
    ['no window', null, 'unknown'],
    ['no reading', win({ usedPct: null }), 'unknown'],
    ['0%', win({ usedPct: 0 }), 'success'],
    ['69%', win({ usedPct: 69 }), 'success'],
    ['70%', win({ usedPct: 70 }), 'warning'],
    ['99%', win({ usedPct: 99 }), 'warning'],
    ['100%', win({ usedPct: 100 }), 'error'],
    ['rejected with no reading', win({ usedPct: null, status: 'rejected' }), 'error'],
  ] as const)('%s reads %s', (_name, window, tone) => {
    expect(barTone(window)).toBe(tone);
  });
});

describe('chipState', () => {
  it.each(['ask', 'auto', 'waiting'] as const)('a %s limit reads out', (mode) => {
    expect(chipState(createMockAccountUsage(), createMockSessionLimit(mode))).toBe('out');
    expect(chipState(undefined, createMockSessionLimit(mode))).toBe('out');
  });

  it('a limit whose work carried over reads as the account does', () => {
    const moved = createMockSessionLimit('continued');
    expect(chipState(createMockAccountUsage(), moved)).toBe('ok');
    expect(chipState(createMockAccountUsage({ state: 'warning' }), moved)).toBe('near');
  });

  it('reads the account alone when the session has no limit', () => {
    expect(chipState(createMockAccountUsage({ state: 'limited' }), null)).toBe('out');
    expect(chipState(createMockAccountUsage({ state: 'warning' }), null)).toBe('near');
    expect(chipState(createMockAccountUsage({ state: 'unknown' }), null)).toBe('unknown');
    expect(chipState(undefined, undefined)).toBe('unknown');
    expect(chipState(createMockAccountUsage(), null)).toBe('ok');
  });
});

describe('nearestWindow', () => {
  it('picks the highest reading', () => {
    expect(nearestWindow(createMockAccountUsage())?.key).toBe('seven_day');
  });

  it('gives a tie to five_hour, else to the first in server order', () => {
    const tie = usageWith([
      win({ key: 'seven_day', usedPct: 80 }),
      win({ key: 'five_hour', usedPct: 80 }),
      win({ key: 'seven_day_opus', usedPct: 80 }),
    ]);
    expect(nearestWindow(tie)?.key).toBe('five_hour');
    const noFiveHour = usageWith([
      win({ key: 'seven_day', usedPct: 80 }),
      win({ key: 'seven_day_opus', usedPct: 80 }),
    ]);
    expect(nearestWindow(noFiveHour)?.key).toBe('seven_day');
  });

  it('is null when no window has a reading', () => {
    expect(nearestWindow(usageWith([win({ usedPct: null, status: 'rejected' })]))).toBeNull();
    expect(nearestWindow(null)).toBeNull();
  });
});

describe('time wording', () => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    process.env.TZ = originalTz;
  });

  // Sunday 2026-09-27, noon in New York (EDT, UTC-4).
  const now = new Date('2026-09-27T12:00:00-04:00');
  const plus = (ms: number) => new Date(now.getTime() + ms).toISOString();
  const MIN = 60_000;

  describe('formatResetTime', () => {
    it('shows the time on the same day, dropping :00', () => {
      expect(formatResetTime('2026-09-27T14:10:00-04:00', now, 'en-US')).toBe('2:10pm');
      expect(formatResetTime('2026-09-27T15:00:00-04:00', now, 'en-US')).toBe('3pm');
      expect(formatResetTime('2026-09-27T09:05:00-04:00', now, 'en-US')).toBe('9:05am');
    });

    it('shows the weekday within six days, and the date after that', () => {
      expect(formatResetTime('2026-09-29T15:00:00-04:00', now, 'en-US')).toBe('Tue 3pm');
      expect(formatResetTime('2026-10-03T09:30:00-04:00', now, 'en-US')).toBe('Sat 9:30am');
      expect(formatResetTime('2026-10-08T15:00:00-04:00', now, 'en-US')).toBe('Oct 8');
    });

    it('follows the locale for day and month names', () => {
      expect(formatResetTime('2026-10-08T15:00:00-04:00', now, 'de-DE')).toBe('8. Okt.');
    });

    it('is null when the reset is unknown', () => {
      expect(formatResetTime(null, now)).toBeNull();
    });

    it('counts calendar days across the end of daylight saving time', () => {
      // 23:30 Saturday EDT to 23:00 Sunday EST is 24.5 hours but one calendar day.
      const lateSaturday = new Date('2026-10-31T23:30:00-04:00');
      expect(formatResetTime('2026-11-01T23:00:00-05:00', lateSaturday, 'en-US')).toBe('Sun 11pm');
      // Just after midnight on the change day, the afternoon is still today.
      const earlySunday = new Date('2026-11-01T00:30:00-04:00');
      expect(formatResetTime('2026-11-01T15:00:00-05:00', earlySunday, 'en-US')).toBe('3pm');
      // Three hours later, but past midnight: tomorrow, not today.
      expect(formatResetTime('2026-11-01T01:30:00-05:00', lateSaturday, 'en-US')).toBe(
        'Sun 1:30am'
      );
    });

    it('counts calendar days across the start of daylight saving time', () => {
      // Saturday to Sunday spans a 23-hour local day in March.
      const saturday = new Date('2027-03-13T12:00:00-05:00');
      expect(formatResetTime('2027-03-14T15:00:00-04:00', saturday, 'en-US')).toBe('Sun 3pm');
      expect(formatResetTime('2027-03-19T15:00:00-04:00', saturday, 'en-US')).toBe('Fri 3pm');
      expect(formatResetTime('2027-03-20T15:00:00-04:00', saturday, 'en-US')).toBe('Mar 20');
    });
  });

  describe('formatResetDay', () => {
    it('shows the time today, the weekday otherwise, and null when unknown', () => {
      expect(formatResetDay('2026-09-27T15:00:00-04:00', now, 'en-US')).toBe('3pm');
      expect(formatResetDay('2026-10-04T09:00:00-04:00', now, 'en-US')).toBe('Sun');
      expect(formatResetDay(null, now)).toBeNull();
    });
  });

  describe('formatBackIn', () => {
    it.each([
      [47 * MIN, '47 min'],
      [59 * MIN, '59 min'],
      [60 * MIN, '1h'],
      [72 * MIN, '1h 12m'],
      [120 * MIN, '2h'],
      // Rounds up, so a partial minute never reads as less than it is.
      [46.5 * MIN, '47 min'],
      [0, '1 min'],
    ])('%d ms reads %s', (ms, text) => {
      expect(formatBackIn(ms)).toBe(text);
    });
  });

  describe('limitText', () => {
    it('counts down a 5-hour window resetting within a day', () => {
      expect(limitText('five_hour', plus(47 * MIN), now)).toBe('back in 47 min');
    });

    it('names the reset for a 5-hour window a day or more away', () => {
      expect(limitText('five_hour', plus(25 * 60 * MIN), now, 'en-US')).toBe('out until Mon 1pm');
    });

    it('names the reset for every other window, however soon', () => {
      expect(limitText('seven_day', '2026-09-29T15:00:00-04:00', now, 'en-US')).toBe(
        'out until Tue 3pm'
      );
      expect(limitText('seven_day_opus', plus(30 * MIN), now, 'en-US')).toBe('out until 12:30pm');
    });

    it('says only out when the reset is unknown', () => {
      expect(limitText('five_hour', null, now)).toBe('out');
    });
  });

  describe('formatAsOf and isStale', () => {
    const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();

    it.each([
      [30 * 1000, 'just now', false],
      [12 * MIN, 'as of 12 min ago', false],
      [59 * MIN, 'as of 59 min ago', false],
      [61 * MIN, 'as of 1h ago', true],
      [3 * 60 * MIN, 'as of 3h ago', true],
      [2 * 24 * 60 * MIN, 'as of Fri 12pm', true],
    ])('%d ms old reads %s', (ms, text, stale) => {
      expect(formatAsOf(ago(ms), now, 'en-US')).toBe(text);
      expect(isStale(ago(ms), now)).toBe(stale);
    });
  });
});

describe('windowShortName', () => {
  it.each([
    ['five_hour', '5h'],
    ['seven_day', 'week'],
    ['seven_day_opus', 'week (Opus)'],
    ['seven_day_sonnet', 'week (Sonnet)'],
    ['model:fable', 'week (Fable)'],
    ['window:90', 'Server label'],
  ])('%s reads %s', (key, text) => {
    expect(windowShortName(key, 'Server label')).toBe(text);
  });
});

describe('planName', () => {
  it.each([
    ['max', 'Max plan'],
    ['pro', 'Pro plan'],
    ['team', 'Team plan'],
    [null, null],
    [undefined, null],
  ])('%s reads %s', (plan, text) => {
    expect(planName(plan)).toBe(text);
  });
});

describe('limitSubject', () => {
  it('names the account when accounts are told apart', () => {
    expect(
      limitSubject({ runtime: 'claude-code', accountLabel: 'Acct 4', identityGate: true })
    ).toBe('Acct 4');
  });

  it('names the runtime with one account, or an unnamed one', () => {
    expect(
      limitSubject({ runtime: 'claude-code', accountLabel: 'Acct 4', identityGate: false })
    ).toBe('Claude');
    expect(limitSubject({ runtime: 'claude-code', accountLabel: null, identityGate: true })).toBe(
      'Claude'
    );
    expect(limitSubject({ runtime: 'codex', accountLabel: null, identityGate: false })).toBe(
      'Codex'
    );
    expect(limitSubject({ runtime: 'opencode', accountLabel: null, identityGate: false })).toBe(
      'OpenCode'
    );
  });
});
