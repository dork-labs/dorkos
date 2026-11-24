/** DOR-4626: which recovery authority a Claude session gives, live or restored after a restart. */
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  FailedSeatLedger,
  type FailedSeatRecord,
} from '../../../../../rooms/reseat/failed-seat-ledger.js';
import type { AgentSession } from '../../../agent-types.js';
import { failedSeatAuthorityOf } from '../failed-seat-authority.js';

const RECORD: FailedSeatRecord = {
  dispatchId: 'dsp_failed',
  entryId: 'entry-1',
  root: '/fixture/account',
  inference: 'own-account',
  billing: 'subscription',
  carry: {
    externalAuthor: true,
    permissionCeiling: { asks: 'always', reach: 'read', outsider: true },
  },
};

const idle = {
  isLocked: () => false,
  holdsBackgroundWork: () => false,
  isHelperWorking: () => false,
};

/** A database a previous process wrote the record into, read by this process's ledger. */
function restarted() {
  const db = createTestDb();
  new FailedSeatLedger(db, 'earlier-process').record('chat-1', RECORD);
  const ledger = new FailedSeatLedger(db, 'this-process');
  return () => ({ forSession: () => null, hasOwnedAttempt: () => false, failures: ledger });
}

function liveSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    hasStarted: true,
    pendingInteractions: new Map(),
    priorServerFailure: {
      dispatchId: 'dsp_live',
      entryId: 'entry-live',
      root: '/fixture/account',
      inference: 'own-account',
      billing: 'subscription',
    },
    ...overrides,
  } as AgentSession;
}

describe('failedSeatAuthorityOf', () => {
  it('restores an earlier process record only for a cold session this process holds nothing of', () => {
    expect(failedSeatAuthorityOf(idle, 'chat-1', undefined, restarted(), 'cold')).toMatchObject({
      dispatchId: 'dsp_failed',
      entryId: 'entry-1',
      root: '/fixture/account',
      runtime: 'claude-code',
      restored: true,
    });
  });

  it.each([
    ['a live process', 'allows' as const, idle],
    ['a refusing crash policy', 'refuses' as const, idle],
    ['a held lock', 'cold' as const, { ...idle, isLocked: () => true }],
    ['background work', 'cold' as const, { ...idle, holdsBackgroundWork: () => true }],
    ['a working helper', 'cold' as const, { ...idle, isHelperWorking: () => true }],
  ])('restores nothing with %s', (_label, crash, guards) => {
    expect(failedSeatAuthorityOf(guards, 'chat-1', undefined, restarted(), crash)).toBeNull();
  });

  it('restores nothing while a person must answer in the chat', () => {
    const waiting = liveSession({
      priorServerFailure: undefined,
      pendingInteractions: new Map([['ask', {}]]) as AgentSession['pendingInteractions'],
    });
    expect(failedSeatAuthorityOf(idle, 'chat-1', waiting, restarted(), 'cold')).toBeNull();
  });

  it('lets live memory decide alone while it holds the failure, as before', () => {
    const session = liveSession();
    expect(failedSeatAuthorityOf(idle, 'chat-1', session, restarted(), 'allows')).toMatchObject({
      dispatchId: 'dsp_live',
    });
    expect(
      failedSeatAuthorityOf(idle, 'chat-1', session, restarted(), 'allows')
    ).not.toHaveProperty('restored');
    // A cold process refuses the live failure, and the durable record never stands in for it.
    expect(failedSeatAuthorityOf(idle, 'chat-1', session, restarted(), 'cold')).toBeNull();
  });

  it('restores nothing without a launch owner or with unavailable storage', () => {
    expect(failedSeatAuthorityOf(idle, 'chat-1', undefined, undefined, 'cold')).toBeNull();
    const unavailable = () => {
      throw new Error('Recovery launch storage is unavailable.');
    };
    expect(failedSeatAuthorityOf(idle, 'chat-1', undefined, unavailable, 'cold')).toBeNull();
  });
});
