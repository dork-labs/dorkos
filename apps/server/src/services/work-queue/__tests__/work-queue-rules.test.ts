/**
 * Who may do what to a work queue (DOR-3462), and which account it picks. The
 * point of these: an agent works on its own queue only, and has no tool that turns
 * a queue on, raises its target or cap, or lifts the stop on every queue.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AccountUsage } from '@dorkos/shared/account-usage';
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import type { RankedAccount } from '../../core/usage/account-ranking.js';
import { accountFull, pickQueueAccount } from '../work-queue-limits.js';
import { chatStateFromStatus, startResultFrom } from '../work-queue-wiring.js';

vi.mock('../../../lib/logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
  logError: () => ({}),
  createTaggedLogger: () => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../runtimes/claude-code/accounts/account-login-metadata.js', () => ({
  mayAutoPickClaudeRoot: () => true,
}));

/** An account's usage at one share of its weekly window. */
function usage(usedPct: number | null, state: AccountUsage['state'] = 'ok'): AccountUsage {
  return {
    state,
    path: '/accounts/one',
    windows: [{ key: 'seven_day', usedPct, expired: false, resetsAt: null }],
  } as unknown as AccountUsage;
}

/** A ranked account row. */
function row(id: string, over: Partial<RankedAccount> = {}): RankedAccount {
  return {
    runtime: 'claude-code',
    id,
    label: id,
    color: null,
    usage: usage(10),
    eligible: true,
    reason: '',
    ...over,
  } as RankedAccount;
}

describe('which account a queue picks', () => {
  it('takes the first with room, skipping one at 80%', () => {
    const picked = pickQueueAccount(
      [row('full', { usage: usage(80) }), row('roomy', { usage: usage(79) })],
      'claude-code'
    );
    expect(picked?.id).toBe('roomy');
  });

  it('never picks credits, a kept-out account, or an ineligible one', () => {
    expect(
      pickQueueAccount(
        [
          row(CREDITS_ACCOUNT_ID),
          row('kept', { noAutoMove: true }),
          row('barred', { eligible: false }),
        ],
        'claude-code'
      )
    ).toBeNull();
  });

  it('still tries an account nobody has measured', () => {
    expect(accountFull(usage(null))).toBe(false);
  });

  it('treats a limited account as full, whatever its windows say', () => {
    expect(accountFull(usage(5, 'limited'))).toBe(true);
  });
});

describe('reading a chat and a start', () => {
  it('a chat waiting on a person is still running', () => {
    expect(chatStateFromStatus({ lifecycle: 'blocked' } as never)).toEqual({ kind: 'live' });
  });

  it('maps how a chat ended', () => {
    expect(chatStateFromStatus(null)).toEqual({ kind: 'ended', outcome: 'finished' });
    expect(chatStateFromStatus({ lifecycle: 'error' } as never)).toEqual({
      kind: 'ended',
      outcome: 'failed',
    });
    expect(chatStateFromStatus({ lifecycle: 'interrupted' } as never)).toEqual({
      kind: 'ended',
      outcome: 'stopped',
    });
  });

  /** A session_start answer. */
  const answer = (body: unknown, isError = false) => ({
    content: [{ text: JSON.stringify(body) }],
    isError,
  });

  it('reads a started chat with the account it was given', () => {
    expect(startResultFrom(answer({ sessionId: 's1' }), 'acct')).toEqual({
      kind: 'started',
      sessionId: 's1',
      accountId: 'acct',
    });
  });

  it.each([
    ['LAUNCH_CAP_FULL', 'chat-cap'],
    ['AGENT_PAUSED', 'agent-paused'],
    ['ACCOUNT_REFUSED', 'accounts'],
  ])('keeps the item in line on %s', (code, hold) => {
    expect(startResultFrom(answer({ code, error: 'no' }, true), null)).toEqual({
      kind: 'held',
      hold,
    });
  });

  it('ends the item on any other refusal', () => {
    expect(
      startResultFrom(answer({ code: 'OUTSIDE_BOUNDARY', error: 'Not there.' }, true), null)
    ).toEqual({ kind: 'refused', message: 'Not there.' });
  });
});
