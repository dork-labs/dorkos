import { describe, expect, it } from 'vitest';
import {
  CONNECT_ANOTHER_WAY_COPY,
  CONNECTION_READINESS_COPY,
  WAY_RECHECK_COPY,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import {
  deriveConnectionReadiness,
  wayHealthOf,
  type ConnectionReadinessFacts,
  type ConnectionWayHealth,
} from '../connection-readiness.js';

const UP: ConnectionWayHealth = { status: 'up', canRunActions: true };
const RETRY_AT = '2026-09-28T12:48:00.000Z';

/** A healthy, connected account; each case changes only what it tests. */
function facts(overrides: Partial<ConnectionReadinessFacts> = {}): ConnectionReadinessFacts {
  return {
    lifecycle: 'connected',
    authenticationStatus: 'active',
    reconciliationStatus: 'ready',
    authoritySync: { status: 'ready' },
    externalCleanup: 'not_required',
    mode: 'byo',
    way: UP,
    ...overrides,
  };
}

const down = (
  problem: Extract<ConnectionWayHealth, { status: 'down' }>['problem'],
  anotherWayWorks = false
) => ({ status: 'down', problem, anotherWayWorks }) as const;

describe('deriveConnectionReadiness truth table', () => {
  // [row, facts, state, reason, fix action (undefined = no fix), fixableBy]
  const table: Array<
    [string, Partial<ConnectionReadinessFacts>, string, string, string | undefined, string?]
  > = [
    [
      '1 disconnected, nothing owed, way up',
      { lifecycle: 'disconnected', externalCleanup: 'complete' },
      'gone',
      'disconnected',
      'connect_again',
      'person',
    ],
    [
      '1 disconnected, not required',
      { lifecycle: 'disconnected', externalCleanup: 'not_required' },
      'gone',
      'disconnected',
      'connect_again',
      'person',
    ],
    [
      '2 disconnected, nothing owed, way down',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'complete',
        way: down('dorkos_account_unlinked'),
      },
      'gone',
      'disconnected',
      'connect_new',
      'person',
    ],
    [
      '3 disconnect retrying, way up',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        authoritySync: { status: 'pending', reason: 'Waiting.', retryAt: RETRY_AT },
      },
      'gone',
      'disconnect_finishing',
      'retry',
      'dorkos',
    ],
    [
      '4 disconnect retrying, DorkOS account not answering',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        authoritySync: { status: 'pending' },
        way: down('dorkos_account_unavailable'),
      },
      'gone',
      'disconnect_finishing',
      'wait',
      'dorkos',
    ],
    [
      '5 disconnect owed, own key gone',
      { lifecycle: 'disconnected', externalCleanup: 'failed', way: down('own_key_unavailable') },
      'gone',
      'disconnect_stuck',
      'fix_key',
      'person',
    ],
    [
      '6 disconnect owed, DorkOS account unlinked (sync failed)',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        authoritySync: { status: 'failed', reason: 'Not linked.' },
        way: down('dorkos_account_unlinked'),
      },
      'gone',
      'disconnect_stuck',
      undefined,
    ],
    [
      '6 disconnect owed, DorkOS account unlinked (still pending)',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        authoritySync: { status: 'pending' },
        way: down('dorkos_account_unlinked'),
      },
      'gone',
      'disconnect_stuck',
      undefined,
    ],
    [
      '6 disconnect owed, way unreachable',
      { lifecycle: 'disconnected', externalCleanup: 'failed', way: down('unreachable') },
      'gone',
      'disconnect_stuck',
      undefined,
    ],
    [
      '7 closed by a new DorkOS account link',
      { lifecycle: 'disconnected', externalCleanup: 'unknown', mode: 'managed' },
      'gone',
      'disconnect_stuck',
      undefined,
    ],
    [
      '8 disconnect failed, own key works',
      { lifecycle: 'disconnected', externalCleanup: 'failed' },
      'gone',
      'disconnect_failed',
      'retry',
      'person',
    ],
    [
      '8 disconnect refused, relinked',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        authoritySync: { status: 'failed', reason: 'Refused.' },
      },
      'gone',
      'disconnect_failed',
      'retry',
      'person',
    ],
    [
      '8 own key cleanup unknown',
      { lifecycle: 'disconnected', externalCleanup: 'unknown' },
      'gone',
      'disconnect_failed',
      'retry',
      'person',
    ],
    [
      '9 off for this chat',
      { offForThisChat: true, way: down('own_key_unavailable') },
      'unavailable',
      'off_for_this_chat',
      undefined,
    ],
    [
      '10 DorkOS account unlinked',
      { way: down('dorkos_account_unlinked'), lifecycle: 'paused' },
      'needs_you',
      'dorkos_account_unlinked',
      'connect_new',
      'person',
    ],
    [
      '11 DorkOS account unavailable',
      { way: down('dorkos_account_unavailable') },
      'unavailable',
      'dorkos_account_unavailable',
      'retry',
      'dorkos',
    ],
    [
      '12 own key gone',
      { way: down('own_key_unavailable'), authenticationStatus: 'expired' },
      'needs_you',
      'own_key_unavailable',
      'fix_key',
      'person',
    ],
    [
      '13 way unreachable',
      { way: down('unreachable') },
      'unavailable',
      'way_unreachable',
      undefined,
    ],
    [
      '14 account key cannot run actions',
      {
        way: { status: 'up', canRunActions: false, keyCanFix: true, anotherWayWorks: false },
        lifecycle: 'paused',
      },
      'needs_you',
      'own_key_cannot_run_actions',
      'fix_key',
      'person',
    ],
    [
      '13 way unreachable, another way works',
      { way: down('unreachable', true) },
      'unavailable',
      'way_unreachable',
      'connect_new',
      'person',
    ],
    [
      '15 self-hosted way cannot run actions',
      { way: { status: 'up', canRunActions: false, keyCanFix: false, anotherWayWorks: false } },
      'unavailable',
      'cannot_run_actions',
      undefined,
    ],
    [
      '15 self-hosted way cannot run actions, another way works',
      { way: { status: 'up', canRunActions: false, keyCanFix: false, anotherWayWorks: true } },
      'unavailable',
      'cannot_run_actions',
      'connect_new',
      'person',
    ],
    [
      '16 paused and signed out: sign in again first (it resumes too)',
      { lifecycle: 'paused', authenticationStatus: 'expired' },
      'needs_you',
      'signed_out',
      'sign_in_again',
      'person',
    ],
    [
      '17 paused with an unfinished sign-in',
      { lifecycle: 'paused', authenticationStatus: 'pending' },
      'needs_you',
      'sign_in_unfinished',
      'sign_in_again',
      'person',
    ],
    ['18 paused', { lifecycle: 'paused' }, 'paused', 'paused', 'resume', 'person'],
    [
      '17 expired',
      { authenticationStatus: 'expired' },
      'needs_you',
      'signed_out',
      'sign_in_again',
      'person',
    ],
    [
      '17 revoked',
      { authenticationStatus: 'revoked' },
      'needs_you',
      'signed_out',
      'sign_in_again',
      'person',
    ],
    [
      '18 sign-in pending',
      { authenticationStatus: 'pending' },
      'needs_you',
      'sign_in_unfinished',
      'sign_in_again',
      'person',
    ],
    [
      '19 needs review',
      {
        reconciliationStatus: 'migration_needs_reconcile',
        authoritySync: { status: 'failed', reason: 'x' },
      },
      'needs_you',
      'needs_review',
      'review_access',
      'person',
    ],
    [
      '20 access update failed',
      { authoritySync: { status: 'failed', reason: 'Refused.' } },
      'needs_you',
      'access_update_failed',
      'review_access',
      'person',
    ],
    [
      '21 access updating',
      { authoritySync: { status: 'pending' } },
      'finishing',
      'access_updating',
      'wait',
      'dorkos',
    ],
    ['22 ready', {}, 'ready', 'usable', undefined],
    [
      '22 ready without access sync (an agent view)',
      { authoritySync: undefined },
      'ready',
      'usable',
      undefined,
    ],
  ];

  it.each(table)('%s', (_row, overrides, state, reason, action, fixableBy) => {
    const readiness = deriveConnectionReadiness(facts(overrides));
    expect(readiness.state).toBe(state);
    expect(readiness.reason).toBe(reason);
    expect(readiness.fix?.action).toBe(action);
    if (fixableBy) expect(readiness.fix?.fixableBy).toBe(fixableBy);
    expect(readiness.copy.owner.length).toBeGreaterThan(0);
    expect(readiness.copy.agent.length).toBeGreaterThan(0);
  });

  it('carries when DorkOS tries again', () => {
    const updating = deriveConnectionReadiness(
      facts({ authoritySync: { status: 'pending', reason: 'Waiting.', retryAt: RETRY_AT } })
    );
    expect(updating.fix).toEqual({ action: 'wait', fixableBy: 'dorkos', retryAt: RETRY_AT });
  });

  it('never offers a retry for a disconnect whose DorkOS account link ended', () => {
    const stuck = deriveConnectionReadiness(
      facts({
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        authoritySync: { status: 'failed', reason: 'This instance is no longer linked.' },
        way: down('dorkos_account_unlinked'),
      })
    );
    expect(stuck.fix).toBeUndefined();
    expect(stuck.copy.owner).toContain('isn’t linked anymore');
    expect(stuck.copy.owner).toContain('own account settings');
  });

  it('tells the agent what the person must do, never internal names', () => {
    const reasons = table.map(([, overrides]) => deriveConnectionReadiness(facts(overrides)));
    for (const readiness of reasons) {
      for (const line of [readiness.copy.owner, readiness.copy.agent]) {
        expect(line).not.toMatch(/instance|authority|provider|connector|synchroniz|—/i);
      }
    }
    expect(deriveConnectionReadiness(facts({ lifecycle: 'paused' })).copy).toEqual(
      CONNECTION_READINESS_COPY.paused
    );
  });

  it('says to connect it again another way only when another way works', () => {
    const withWay = deriveConnectionReadiness(facts({ way: down('unreachable', true) }));
    expect(withWay.copy.owner).toBe(
      `${CONNECTION_READINESS_COPY.way_unreachable.owner} ${CONNECT_ANOTHER_WAY_COPY.owner}`
    );
    // With a concrete fix, the agent is told that fix, not "tell the person".
    expect(withWay.copy.agent).not.toContain('Tell the person.');
    expect(withWay.copy.agent).toContain(CONNECT_ANOTHER_WAY_COPY.agent);
    const without = deriveConnectionReadiness(facts({ way: down('unreachable') }));
    expect(without.copy.owner).toBe(CONNECTION_READINESS_COPY.way_unreachable.owner);
    expect(without.copy.agent).toBe(
      `${CONNECTION_READINESS_COPY.way_unreachable.agent} Tell the person.`
    );
  });

  it('leaves a way that failed for a reason that may pass to DorkOS, with when it checks again', () => {
    const transientKey = deriveConnectionReadiness(
      facts({ way: { ...down('own_key_unavailable'), nextCheckAt: RETRY_AT } })
    );
    expect(transientKey).toMatchObject({
      state: 'unavailable',
      reason: 'own_key_unavailable',
      fix: { action: 'wait', fixableBy: 'dorkos', retryAt: RETRY_AT },
      copy: WAY_RECHECK_COPY,
    });
    // A refused key waits for the person.
    expect(deriveConnectionReadiness(facts({ way: down('own_key_unavailable') })).fix).toEqual({
      action: 'fix_key',
      fixableBy: 'person',
    });
    const account = deriveConnectionReadiness(
      facts({ way: { ...down('dorkos_account_unavailable'), nextCheckAt: RETRY_AT } })
    );
    expect(account.fix).toEqual({ action: 'retry', fixableBy: 'dorkos', retryAt: RETRY_AT });
    // A disconnect can't be finished by fixing a key DorkOS is only waiting to re-check.
    const stuck = deriveConnectionReadiness(
      facts({
        lifecycle: 'disconnected',
        externalCleanup: 'failed',
        way: { ...down('own_key_unavailable'), nextCheckAt: RETRY_AT },
      })
    );
    expect(stuck).toMatchObject({ reason: 'disconnect_stuck' });
    expect(stuck.fix).toBeUndefined();
  });

  it('never promises an automatic re-check it doesn’t make', () => {
    const unavailable = deriveConnectionReadiness(
      facts({ way: down('dorkos_account_unavailable') })
    );
    expect(unavailable.copy.owner).not.toMatch(/keep checking|will check/i);
  });
});

describe('wayHealthOf', () => {
  const provider = (type: string, execution: boolean) =>
    ({
      type,
      getCapabilities: () => ({
        capabilities: {
          execution: execution ? { status: 'available' } : { status: 'unsupported', reason: 'x' },
        },
      }),
    }) as unknown as ConnectorProvider;

  it('is down with the named problem, or unreachable, when nothing is registered', () => {
    expect(wayHealthOf(undefined, () => 'own_key_unavailable')).toEqual(
      down('own_key_unavailable')
    );
    expect(wayHealthOf(undefined, () => undefined)).toEqual(down('unreachable'));
  });

  it('says whether agents can act, and whether a key would fix it', () => {
    expect(wayHealthOf(provider('composio', true), () => undefined)).toEqual(UP);
    expect(wayHealthOf(provider('composio', false), () => undefined)).toEqual({
      status: 'up',
      canRunActions: false,
      keyCanFix: true,
      anotherWayWorks: false,
    });
    expect(
      wayHealthOf(
        provider('nango', false),
        () => undefined,
        () => true
      )
    ).toEqual({
      status: 'up',
      canRunActions: false,
      keyCanFix: false,
      anotherWayWorks: true,
    });
    expect(
      wayHealthOf(
        undefined,
        () => undefined,
        () => true
      )
    ).toEqual(down('unreachable', true));
  });
});
