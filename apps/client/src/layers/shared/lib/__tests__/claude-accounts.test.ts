// @vitest-environment jsdom
/** Naming and validating Claude account paths (spec `claude-code-accounts`). */
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { createMockAccountUsage, createMockSessionLimit } from '@dorkos/test-utils/mock-factories';
import {
  accountIdentity,
  barTone,
  chipState,
  claudeAccountName,
  claudeAccountOptions,
  formatAsOf,
  formatBackIn,
  formatResetTime,
  isAbsoluteAccountPath,
  isStale,
  limitStateOf,
  limitSubject,
  limitText,
  modelBucketName,
  nearestWindow,
  type AccountWindow,
  type LimitState,
  type SessionLimitView,
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
    // `id: null` because nobody registered this root: it can be SHOWN, but nothing can point at
    // it, so a picker whose value is a reference must leave it out.
    expect(options[1]).toEqual({
      id: null,
      path: '/Users/dev/.claude9',
      label: null,
      isAccountRoot: undefined,
    });
  });
});

describe('isAbsoluteAccountPath', () => {
  it('accepts a POSIX path', () => {
    expect(isAbsoluteAccountPath('/Users/dev/.claude2')).toBe(true);
  });

  it('rejects a ~ path, which nothing on the way to the config file expands', () => {
    // The card's own placeholder used to be `~/.claude2`, and typing it registered a folder that
    // does not exist — which then flipped the multi-account badge on for what was really one
    // account.
    expect(isAbsoluteAccountPath('~/.claude2')).toBe(false);
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
});

/** A limit whose server sends `state` and `scope` (S4 5.1). */
function limitIn(state: LimitState, scope: 'account' | 'model' = 'account'): SessionLimitView {
  return { ...createMockSessionLimit('ask'), state, scope };
}

describe('chipState, model scope', () => {
  it.each(['model-limited', 'waiting-reset', 'reset-ready', 'limited'] as const)(
    'a model-scope limit in %s reads model-out, whatever the account reads',
    (state) => {
      expect(chipState(createMockAccountUsage(), limitIn(state, 'model'))).toBe('model-out');
      // A rejected Opus window makes the ACCOUNT read limited; the chip still says model-out.
      expect(chipState(createMockAccountUsage({ state: 'limited' }), limitIn(state, 'model'))).toBe(
        'model-out'
      );
    }
  );
});

describe('limitStateOf and limitScopeOf', () => {
  it('reads the server state when it sends one', () => {
    expect(limitStateOf(limitIn('reset-ready'))).toBe('reset-ready');
  });
});

describe('modelBucketName', () => {
  const models = [
    { value: 'claude-opus-4-8', displayName: 'Opus 4.8' },
    { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6' },
    { value: 'gpt-5-codex', displayName: 'GPT-5 Codex' },
  ];

  it('names the weekly model buckets by family', () => {
    expect(modelBucketName('seven_day_opus', models)).toBe('Opus');
    expect(modelBucketName('seven_day_sonnet', models)).toBe('Sonnet');
  });

  it('names a model:<slug> bucket by that model’s display name', () => {
    expect(modelBucketName('model:gpt-5-codex', models)).toBe('GPT-5 Codex');
  });
});

describe('nearestWindow', () => {
  it('picks the highest reading', () => {
    expect(nearestWindow(createMockAccountUsage())?.key).toBe('seven_day');
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

describe('limitSubject', () => {
  it('names the account when accounts are told apart', () => {
    expect(
      limitSubject({ runtime: 'claude-code', accountLabel: 'Acct 4', identityGate: true })
    ).toBe('Acct 4');
  });
});

describe('accountIdentity', () => {
  const accounts = [
    { id: 'acct-1', path: '/u/.claude-1', label: 'Acct 1' },
    { id: 'acct-2', path: '/u/.claude-2', label: null },
  ];
  const nameFor = (path: string) => claudeAccountName(path, accounts);
  const colors: Record<string, string> = { 'acct-1': '#2f7be0', '/u/.claude-2': '#1d8a4a' };
  const colorFor = (key: string) => colors[key] ?? null;

  it('names and colors a registered account by its id alone', () => {
    expect(
      accountIdentity({ accountId: 'acct-1', path: null, accounts, usage: null, nameFor, colorFor })
    ).toEqual({ path: '/u/.claude-1', name: 'Acct 1', color: '#2f7be0' });
  });

  it('falls back to the folder name and the folder’s color', () => {
    expect(
      accountIdentity({
        accountId: null,
        path: '/u/.claude-2',
        accounts,
        usage: null,
        nameFor,
        colorFor,
      })
    ).toEqual({ path: '/u/.claude-2', name: '.claude-2', color: '#1d8a4a' });
  });

  it('names the standalone default by the host’s label, never its folder (decision §12)', () => {
    const usage = {
      accountId: 'default',
      path: '/u/.claude',
      label: "Main (this computer's sign-in)",
      color: '#2f7be0',
    };
    // By id, with the folder known too.
    expect(
      accountIdentity({
        accountId: 'default',
        path: '/u/.claude',
        accounts,
        usage,
        nameFor,
        colorFor,
      }).name
    ).toBe("Main (this computer's sign-in)");
    // By the reading alone, for a session the server named only by its folder.
    expect(
      accountIdentity({ accountId: null, path: '/u/.claude', accounts, usage, nameFor, colorFor })
        .name
    ).toBe("Main (this computer's sign-in)");
  });
});
