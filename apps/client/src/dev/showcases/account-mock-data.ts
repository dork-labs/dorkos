/**
 * Account usage fixtures for the playground (spec `claude-account-ui` §13):
 * one Claude account per usage state, a Codex account and an OpenCode
 * spend-only account, plus the continue options and limit history the
 * playground transport answers with.
 *
 * Kept apart from `settings-mock-data.ts` (which re-exports
 * {@link MOCK_ACCOUNT_USAGE}) because the playground transport reads these, and
 * that module already imports the transport. Built locally rather than with
 * `createMockAccountUsage` from `@dorkos/test-utils`, which imports `vitest`
 * and `node:crypto` and so cannot run in the browser; the shape is the same.
 *
 * @module dev/showcases/account-mock-data
 */
import {
  DEFAULT_ACCOUNT_COLORS,
  type AccountUsage,
  type ContinueOptionsResponse,
  type FoundClaudeFolder,
  type LimitHistoryEntry,
} from '@dorkos/shared/account-usage';

type UsageWindow = AccountUsage['windows'][number];

const HOUR_MS = 60 * 60 * 1000;

/** Readings were observed five minutes ago, so nothing reads as stale. */
const OBSERVED_AT = new Date(Date.now() - 5 * 60 * 1000).toISOString();

/** Two hours from now: the 5-hour window's reset. */
const FIVE_HOUR_RESET = new Date(Date.now() + 2 * HOUR_MS).toISOString();

/** Four days from now: the weekly window's reset. */
const WEEK_RESET = new Date(Date.now() + 4 * 24 * HOUR_MS).toISOString();

/** The next Tuesday at 3pm local time: when the limited account's week resets. */
const NEXT_TUESDAY_3PM = (() => {
  const date = new Date();
  date.setHours(15, 0, 0, 0);
  const daysAhead = (2 - date.getDay() + 7) % 7 || 7;
  date.setDate(date.getDate() + daysAhead);
  return date.toISOString();
})();

/** A window reading from the SDK. */
function usageWindow(
  key: string,
  label: string,
  usedPct: number | null,
  resetsAt: string | null,
  status: UsageWindow['status'] = 'allowed'
): UsageWindow {
  return {
    key,
    label,
    usedPct,
    resetsAt,
    status,
    expired: false,
    observedAt: OBSERVED_AT,
    source: 'sdk_event',
  };
}

/** A registered Claude Code account on the Max plan, `n` from 1. */
function claudeAccount(n: number, overrides: Partial<AccountUsage>): AccountUsage {
  return {
    runtime: 'claude-code',
    accountId: `acct-${n}`,
    path: `/Users/dev/.claude-acct-${n}`,
    label: `Acct ${n}`,
    color: DEFAULT_ACCOUNT_COLORS[n - 1]!,
    subscriptionType: 'max',
    plan: null,
    credits: null,
    spend: null,
    windows: [],
    state: 'ok',
    limit: null,
    updatedAt: OBSERVED_AT,
    ...overrides,
  };
}

/**
 * Usage for the playground, one Claude account per state (ok, near, limited,
 * unknown, and one with an Opus window), then a Codex and an OpenCode account.
 */
export const MOCK_ACCOUNT_USAGE: AccountUsage[] = [
  claudeAccount(1, {
    windows: [
      usageWindow('five_hour', '5-hour window', 40, FIVE_HOUR_RESET),
      usageWindow('seven_day', 'Weekly', 72, WEEK_RESET),
    ],
  }),
  claudeAccount(2, {
    state: 'warning',
    windows: [
      usageWindow('five_hour', '5-hour window', 35, FIVE_HOUR_RESET),
      usageWindow('seven_day', 'Weekly', 91, WEEK_RESET),
    ],
  }),
  claudeAccount(3, {
    state: 'limited',
    limit: { window: 'seven_day', resetsAt: NEXT_TUESDAY_3PM },
    windows: [
      usageWindow('five_hour', '5-hour window', 12, FIVE_HOUR_RESET),
      usageWindow('seven_day', 'Weekly', 100, NEXT_TUESDAY_3PM, 'rejected'),
    ],
  }),
  claudeAccount(4, {
    state: 'unknown',
    subscriptionType: null,
    updatedAt: null,
  }),
  claudeAccount(5, {
    windows: [
      usageWindow('five_hour', '5-hour window', 20, FIVE_HOUR_RESET),
      usageWindow('seven_day', 'Weekly', 45, WEEK_RESET),
      usageWindow('seven_day_opus', 'Weekly (Opus)', 60, WEEK_RESET),
    ],
  }),
  {
    runtime: 'codex',
    accountId: 'default',
    path: '/Users/dev/.codex',
    label: null,
    color: DEFAULT_ACCOUNT_COLORS[0]!,
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [{ ...usageWindow('seven_day', 'Weekly', 35, WEEK_RESET), source: 'rollout' }],
    state: 'ok',
    limit: null,
    updatedAt: OBSERVED_AT,
  },
  {
    runtime: 'opencode',
    accountId: 'default',
    path: '/Users/dev/.local/share/opencode',
    label: null,
    color: DEFAULT_ACCOUNT_COLORS[0]!,
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: {
      periodStart: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
      costUsd: 4.2,
      limitUsd: null,
      observedAt: OBSERVED_AT,
      source: 'sidecar',
    },
    windows: [],
    state: 'ok',
    limit: null,
    updatedAt: OBSERVED_AT,
  },
];

/** The Claude account at `n` (from 1) in {@link MOCK_ACCOUNT_USAGE}. */
function claudeUsage(n: number): AccountUsage {
  return MOCK_ACCOUNT_USAGE[n - 1]!;
}

/**
 * Where a session limited on Acct 3 can carry over to: Acct 1 recommended,
 * Acct 5 also eligible, Acct 2 near its limit, Acct 4 unknown.
 */
export const MOCK_CONTINUE_OPTIONS: ContinueOptionsResponse = {
  plan: { mode: 'ask' },
  ranking: {
    accounts: [1, 5, 2, 4].map((n) => {
      const usage = claudeUsage(n);
      return {
        id: usage.accountId!,
        label: usage.label,
        color: usage.color,
        usage,
        eligible: n !== 4,
        reason: n === 4 ? 'No usage reading yet.' : 'Has usage left.',
        ...(n === 1 ? { badge: 'recommended' as const } : {}),
      };
    }),
    recommendedId: 'acct-1',
  },
  advised: false,
};

/** When each playground episode's turn stopped: an hour ago. */
export const MOCK_LIMIT_STOPPED_AT = new Date(Date.now() - HOUR_MS).toISOString();

/** One resolved episode of session `sessionId`, hit a minute after its turn stopped. */
function episode(
  sessionId: string,
  resolution: LimitHistoryEntry['resolution'],
  extra: Partial<LimitHistoryEntry> = {}
): LimitHistoryEntry {
  return {
    id: `limit-history-${sessionId}`,
    sessionId,
    since: new Date(Date.parse(MOCK_LIMIT_STOPPED_AT) + 60 * 1000).toISOString(),
    runtime: 'claude-code',
    accountId: 'acct-3',
    window: 'seven_day',
    scope: 'account',
    resetsAt: NEXT_TUESDAY_3PM,
    resolution,
    resolvedAt: new Date(Date.now() - 55 * 60 * 1000).toISOString(),
    toSessionId: null,
    toAccountId: null,
    modelFrom: null,
    modelTo: null,
    ...extra,
  };
}

/**
 * Resolved episodes, one session per way an episode ends (spec
 * `claude-account-ui` §6.7's marker table): moved from Acct 3 to Acct 1,
 * resumed after the reset, resumed on Sonnet after Opus ran out, and resumed
 * early; plus a Codex session resumed early. The playground transport answers
 * each session with its own.
 */
export const MOCK_LIMIT_HISTORY: LimitHistoryEntry[] = [
  episode('playground-marker-moved', 'moved', {
    toSessionId: 'session-moved',
    toAccountId: 'acct-1',
  }),
  episode('playground-marker-reset', 'resumed-reset'),
  episode('playground-marker-model', 'resumed-model', {
    scope: 'model',
    window: 'seven_day_opus',
    modelFrom: 'claude-opus-4-6',
    modelTo: 'claude-sonnet-4-6',
  }),
  episode('playground-marker-early', 'resumed-early'),
  episode('playground-marker-codex', 'resumed-early', { runtime: 'codex', accountId: 'default' }),
];

/**
 * Account folders found on this computer (spec `claude-account-ui` §6.9):
 * one used today, one used days ago, an org-managed one, and one whose last
 * use is unknown.
 */
export const MOCK_FOUND_CLAUDE_FOLDERS: FoundClaudeFolder[] = [
  {
    path: '/Users/you/.claude2',
    name: '.claude2',
    lastUsedAt: new Date(Date.now() - 2 * 24 * HOUR_MS).toISOString(),
    orgManaged: false,
    orgMarker: null,
  },
  {
    path: '/Users/you/.claude4',
    name: '.claude4',
    lastUsedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    orgManaged: false,
    orgMarker: null,
  },
  {
    path: '/Users/you/.claude-ab1',
    name: '.claude-ab1',
    lastUsedAt: new Date(Date.now() - 9 * 24 * HOUR_MS).toISOString(),
    orgManaged: true,
    orgMarker: 'remote-settings.json',
  },
  {
    path: '/Users/you/.claude-old',
    name: '.claude-old',
    lastUsedAt: null,
    orgManaged: false,
    orgMarker: null,
  },
];
