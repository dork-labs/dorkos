/**
 * Where a beat turn runs (`beat-seat.ts`): where its chat is while that account
 * has room, on another account when it is out or nearly out, and nowhere (the
 * beat waits) when no account it may use can take it.
 */
import { describe, expect, it, vi } from 'vitest';

// Every account here has a confirmed sign-in; the sign-in check (DOR-3245) has
// its own tests in reseat-accounts.test.ts.
vi.mock('../../../runtimes/claude-code/accounts/account-login-metadata.js', () => ({
  accountLoginIdentity: () => ({ state: 'confirmed' }),
}));
import { CREDITS_ACCOUNT_ID, type AccountUsage } from '@dorkos/shared/account-usage';
import type { RankedAccount } from '../../../core/usage/account-ranking.js';
import { decideBeatSeat } from '../beat-seat.js';

type Window = AccountUsage['windows'][number];

function window(key: string, usedPct: number, resetsAt: string | null = null): Window {
  return {
    key,
    label: key,
    usedPct,
    resetsAt,
    status: null,
    expired: false,
    observedAt: '2026-10-26T00:00:00.000Z',
    source: 'sdk_usage',
  } as Window;
}

function usage(
  id: string,
  opts: { weekly?: number; limitedUntil?: string; weeklyResets?: string } = {}
): AccountUsage {
  const limited = opts.limitedUntil !== undefined;
  return {
    runtime: 'claude-code',
    accountId: id,
    path: `/accounts/${id}`,
    label: id,
    color: '#000000',
    subscriptionType: null,
    plan: null,
    credits: null,
    spend: null,
    windows: [
      window('seven_day', opts.weekly ?? 10, opts.weeklyResets ?? null),
      window('five_hour', 10),
    ],
    state: limited ? 'limited' : 'ok',
    limit: limited ? { window: 'seven_day', resetsAt: opts.limitedUntil ?? null } : null,
    updatedAt: null,
  } as AccountUsage;
}

function ranked(
  id: string,
  opts: { weekly?: number; limitedUntil?: string; noAutoMove?: true } = {}
): RankedAccount {
  return {
    runtime: 'claude-code',
    id,
    label: id,
    color: '#000000',
    eligible: opts.limitedUntil === undefined,
    reason: '',
    ...(opts.noAutoMove ? { noAutoMove: true as const } : {}),
    usage: usage(id, opts),
  };
}

const RESET = '2026-10-27T01:00:00.000Z';

describe('decideBeatSeat', () => {
  it('stays where its chat is while that account has room', () => {
    expect(
      decideBeatSeat({
        runtime: 'claude-code',
        usage: usage('claude3', { weekly: 60 }),
        afterLimit: false,
        ranking: [ranked('claude2'), ranked('claude3', { weekly: 60 })],
      })
    ).toEqual({ kind: 'stay' });
  });

  it('stays when nobody knows the account’s usage yet', () => {
    expect(
      decideBeatSeat({ runtime: 'claude-code', usage: null, afterLimit: false, ranking: [] })
    ).toEqual({ kind: 'stay' });
  });

  it('moves off an account that is out, to the best one that can take work', () => {
    expect(
      decideBeatSeat({
        runtime: 'claude-code',
        usage: usage('claude3', { limitedUntil: RESET }),
        afterLimit: false,
        ranking: [
          ranked('claude3', { limitedUntil: RESET }),
          ranked('claude4', { weekly: 97 }),
          ranked('claude2', { weekly: 40 }),
        ],
      })
    ).toEqual({ kind: 'move', accountId: 'claude2' });
  });

  it('moves off an account that is nearly out', () => {
    expect(
      decideBeatSeat({
        runtime: 'claude-code',
        usage: usage('claude3', { weekly: 96 }),
        afterLimit: false,
        ranking: [ranked('claude3', { weekly: 96 }), ranked('claude5')],
      })
    ).toEqual({ kind: 'move', accountId: 'claude5' });
  });

  it('moves after a limit even when the usage cache has not caught up', () => {
    expect(
      decideBeatSeat({
        runtime: 'claude-code',
        usage: usage('claude3', { weekly: 50 }),
        afterLimit: true,
        ranking: [ranked('claude3', { weekly: 50 }), ranked('claude5')],
      })
    ).toEqual({ kind: 'move', accountId: 'claude5' });
  });

  it('never moves to DorkOS credits or an account kept out of automatic moves', () => {
    expect(
      decideBeatSeat({
        runtime: 'claude-code',
        usage: usage('claude3', { limitedUntil: RESET }),
        afterLimit: false,
        ranking: [
          ranked(CREDITS_ACCOUNT_ID),
          ranked('claude-ab1', { noAutoMove: true }),
          ranked('claude3', { limitedUntil: RESET }),
        ],
      })
    ).toEqual({ kind: 'wait', until: RESET });
  });

  it('waits, with the soonest reset, when no account can take it', () => {
    expect(
      decideBeatSeat({
        runtime: 'claude-code',
        usage: usage('claude3', { limitedUntil: RESET }),
        afterLimit: false,
        ranking: [
          ranked('claude3', { limitedUntil: RESET }),
          ranked('claude5', { limitedUntil: '2026-10-28T00:00:00.000Z' }),
        ],
      })
    ).toEqual({ kind: 'wait', until: RESET });
  });
});
