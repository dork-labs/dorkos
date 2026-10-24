vi.mock('../../../runtimes/claude-code/accounts/account-login-metadata.js', () => ({
  accountLoginIdentity: () => ({ state: 'confirmed' }),
}));
/**
 * Which account a room seat moves to (Security Must 4): only accounts core's
 * own ranking offers for the folder's project (person-set eligibility, never
 * the agent's folder or the advisor), on the same runtime, never DorkOS
 * credits, never one that is out or nearly out. None left: the earliest time
 * any of them is usable again, so the room can say when.
 */
import { describe, expect, it, vi } from 'vitest';
import { CREDITS_ACCOUNT_ID, type AccountUsage } from '@dorkos/shared/account-usage';
import type { RankedAccount } from '../../../core/usage/account-ranking.js';
import { nearlyOut, pickReseatAccount } from '../reseat-accounts.js';

type Window = AccountUsage['windows'][number];

function window(key: string, usedPct: number | null, resetsAt: string | null = null): Window {
  return {
    key,
    label: key,
    usedPct,
    resetsAt,
    status: null,
    expired: false,
    observedAt: '2026-10-20T00:00:00.000Z',
    source: 'sdk_usage',
  } as Window;
}

function row(
  id: string,
  opts: {
    weekly?: number | null;
    fiveHour?: number | null;
    limited?: string | null;
    weeklyResets?: string;
    fiveHourResets?: string;
    runtime?: string;
    notAllowed?: true;
    noAutoMove?: true;
  } = {}
): RankedAccount {
  const limited = opts.limited !== undefined;
  return {
    runtime: opts.runtime ?? 'claude-code',
    id,
    label: id,
    color: '#000000',
    eligible: !limited,
    reason: '',
    ...(opts.notAllowed ? { notAllowed: true as const } : {}),
    ...(opts.noAutoMove ? { noAutoMove: true as const } : {}),
    usage: {
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
        window('five_hour', opts.fiveHour ?? 10, opts.fiveHourResets ?? null),
      ],
      state: limited ? 'limited' : 'ok',
      limit: limited ? { window: 'five_hour', resetsAt: opts.limited ?? null } : null,
      updatedAt: null,
    } as AccountUsage,
  };
}

describe('nearlyOut', () => {
  it('reads 95% of the 5-hour or the weekly window as nearly out', () => {
    expect(nearlyOut(row('a', { fiveHour: 95 }).usage)).toBe(true);
    expect(nearlyOut(row('a', { weekly: 97 }).usage)).toBe(true);
    expect(nearlyOut(row('a', { weekly: 94.9, fiveHour: 80 }).usage)).toBe(false);
  });

  it('reads a limited account as out, and unknown usage as not nearly out', () => {
    expect(nearlyOut(row('a', { limited: null }).usage)).toBe(true);
    expect(nearlyOut(row('a', { weekly: null, fiveHour: null }).usage)).toBe(false);
  });
});

describe('pickReseatAccount', () => {
  it('takes the first account in core’s order that is not the seat’s own', () => {
    const pick = pickReseatAccount([row('claude4'), row('claude3'), row('claude2')], {
      runtime: 'claude-code',
      currentAccountId: 'claude4',
    });
    expect(pick).toMatchObject({ kind: 'move', account: { id: 'claude3' } });
  });

  it('never picks DorkOS credits, even first in the list', () => {
    const pick = pickReseatAccount([row(CREDITS_ACCOUNT_ID), row('claude3')], {
      runtime: 'claude-code',
      currentAccountId: 'claude4',
    });
    expect(pick).toMatchObject({ kind: 'move', account: { id: 'claude3' } });
  });

  it('never picks an account the project does not allow, a limited one or a nearly-out one', () => {
    const pick = pickReseatAccount(
      [
        row('claude-ab1', { notAllowed: true }),
        row('claude2', { limited: '2026-10-20T16:10:00.000Z' }),
        row('claude3', { fiveHour: 96 }),
        row('claude5'),
      ],
      { runtime: 'claude-code', currentAccountId: 'claude4' }
    );
    expect(pick).toMatchObject({ kind: 'move', account: { id: 'claude5' } });
  });

  it('never picks an account kept out of automatic moves, even first and with the most room', () => {
    const pick = pickReseatAccount(
      [
        row('claude-ab1', { noAutoMove: true, weekly: 0, fiveHour: 0 }),
        row('claude3', { weekly: 80, fiveHour: 70 }),
      ],
      { runtime: 'claude-code', currentAccountId: 'claude4' }
    );
    expect(pick).toMatchObject({ kind: 'move', account: { id: 'claude3' } });
  });

  it('moves nowhere rather than onto a kept-out account, and names no reset time for it', () => {
    const pick = pickReseatAccount(
      [
        row('claude-ab1', { noAutoMove: true, limited: '2026-10-20T15:00:00.000Z' }),
        row('claude-ab2', { noAutoMove: true }),
        row('claude4', { limited: '2026-10-20T18:00:00.000Z' }),
      ],
      { runtime: 'claude-code', currentAccountId: 'claude4' }
    );
    expect(pick).toEqual({ kind: 'none', earliestResetAt: '2026-10-20T18:00:00.000Z' });
  });

  it('takes a kept-out account only when a person named it', () => {
    const named = [row('claude-ab1', { noAutoMove: true })];
    const seat = { runtime: 'claude-code', currentAccountId: 'claude4' };
    expect(pickReseatAccount(named, seat).kind).toBe('none');
    expect(pickReseatAccount(named, seat, { keptOut: true })).toMatchObject({
      kind: 'move',
      account: { id: 'claude-ab1' },
    });
  });

  it('never moves to another runtime', () => {
    const pick = pickReseatAccount([row('default', { runtime: 'codex' })], {
      runtime: 'claude-code',
      currentAccountId: 'claude4',
    });
    expect(pick.kind).toBe('none');
  });

  it('with nothing left, answers the earliest time any eligible account is usable again', () => {
    const pick = pickReseatAccount(
      [
        row('claude4', { limited: '2026-10-20T18:00:00.000Z' }),
        row('claude3', { limited: '2026-10-20T16:10:00.000Z' }),
        row('claude2', { weekly: 99, weeklyResets: '2026-10-21T09:00:00.000Z' }),
        row(CREDITS_ACCOUNT_ID),
      ],
      { runtime: 'claude-code', currentAccountId: 'claude4' }
    );
    expect(pick).toEqual({ kind: 'none', earliestResetAt: '2026-10-20T16:10:00.000Z' });
  });

  it('with nothing left and no reset known, says so with null', () => {
    const pick = pickReseatAccount([row('claude4', { limited: null })], {
      runtime: 'claude-code',
      currentAccountId: 'claude4',
    });
    expect(pick).toEqual({ kind: 'none', earliestResetAt: null });
  });
});
