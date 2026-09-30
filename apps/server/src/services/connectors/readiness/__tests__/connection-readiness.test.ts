import { describe, expect, it } from 'vitest';
import {
  CONNECT_ANOTHER_WAY_COPY,
  CONNECTION_READINESS_COPY,
  WAY_CHECKING_COPY,
  TURN_ON_FOR_THIS_CHAT_COPY,
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
      '1 closed because the service no longer has the account',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'not_required',
        closedBecause: 'service_gone',
        mode: 'managed',
      },
      'gone',
      'gone_at_service',
      'connect_new',
      'person',
    ],
    [
      '2 disconnected, nothing owed, way up',
      { lifecycle: 'disconnected', externalCleanup: 'complete' },
      'gone',
      'disconnected',
      'connect_again',
      'person',
    ],
    [
      '2 disconnected, not required',
      { lifecycle: 'disconnected', externalCleanup: 'not_required' },
      'gone',
      'disconnected',
      'connect_again',
      'person',
    ],
    [
      '3 disconnected, nothing owed, way down',
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
      '4 disconnect retrying through the DorkOS account, way up',
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
      '4 own-key disconnect DorkOS retries on its own, way up',
      { lifecycle: 'disconnected', externalCleanup: 'pending', cleanupRetryAt: RETRY_AT },
      'gone',
      'disconnect_finishing',
      'retry',
      'dorkos',
    ],
    [
      '5 disconnect owed, DorkOS account being re-checked',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        authoritySync: { status: 'pending' },
        way: { ...down('dorkos_account_unavailable'), nextCheckAt: RETRY_AT },
      },
      'gone',
      'disconnect_finishing',
      'wait',
      'dorkos',
    ],
    [
      '5 disconnect owed, own key being checked right now',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        way: { ...down('own_key_unavailable'), checking: true },
      },
      'gone',
      'disconnect_finishing',
      'wait',
      'dorkos',
    ],
    [
      '6 disconnect owed, own key refused or removed',
      { lifecycle: 'disconnected', externalCleanup: 'pending', way: down('own_key_unavailable') },
      'gone',
      'disconnect_stuck',
      'fix_key',
      'person',
    ],
    [
      '7 disconnect owed, DorkOS account unlinked (sync failed)',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        authoritySync: { status: 'failed', reason: 'Not linked.' },
        way: down('dorkos_account_unlinked'),
      },
      'gone',
      'disconnect_stuck',
      'remove',
      'person',
    ],
    [
      '7 disconnect owed, DorkOS account unlinked (still pending)',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        authoritySync: { status: 'pending' },
        way: down('dorkos_account_unlinked'),
      },
      'gone',
      'disconnect_stuck',
      'remove',
      'person',
    ],
    [
      '7 disconnect owed, DorkOS account unavailable and no longer re-checked',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        authoritySync: { status: 'pending' },
        way: down('dorkos_account_unavailable'),
      },
      'gone',
      'disconnect_stuck',
      'remove',
      'person',
    ],
    [
      '7 disconnect owed, way unreachable',
      { lifecycle: 'disconnected', externalCleanup: 'pending', way: down('unreachable') },
      'gone',
      'disconnect_stuck',
      'remove',
      'person',
    ],
    [
      '7 closed by a new DorkOS account link',
      { lifecycle: 'disconnected', externalCleanup: 'unknown', mode: 'managed' },
      'gone',
      'disconnect_stuck',
      'remove',
      'person',
    ],
    [
      '7 disconnect refused by the service, way up',
      {
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        authoritySync: { status: 'failed', reason: 'Refused.' },
      },
      'gone',
      'disconnect_stuck',
      'remove',
      'person',
    ],
    [
      '7 own-key cleanup out of tries',
      { lifecycle: 'disconnected', externalCleanup: 'failed' },
      'gone',
      'disconnect_stuck',
      'remove',
      'person',
    ],
    [
      '7 own-key cleanup unknown',
      { lifecycle: 'disconnected', externalCleanup: 'unknown' },
      'gone',
      'disconnect_stuck',
      'remove',
      'person',
    ],
    [
      '8 off for this chat, the owner can turn it on',
      { offForThisChat: true, canTurnOnForThisChat: true, way: down('own_key_unavailable') },
      'unavailable',
      'off_for_this_chat',
      'turn_on_for_this_chat',
      'person',
    ],
    [
      '8b off for this chat, nothing to put back',
      { offForThisChat: true, way: down('own_key_unavailable') },
      'unavailable',
      'off_for_this_chat',
      undefined,
    ],
    [
      '9 DorkOS account unlinked',
      { way: down('dorkos_account_unlinked'), lifecycle: 'paused' },
      'needs_you',
      'dorkos_account_unlinked',
      'connect_new',
      'person',
    ],
    [
      '10 own key being checked right now',
      { way: { ...down('own_key_unavailable'), checking: true } },
      'unavailable',
      'own_key_unavailable',
      'wait',
      'dorkos',
    ],
    [
      '10 DorkOS account being checked right now',
      { way: { ...down('dorkos_account_unavailable'), checking: true } },
      'unavailable',
      'dorkos_account_unavailable',
      'wait',
      'dorkos',
    ],
    [
      '11 DorkOS account unavailable, re-check scheduled',
      { way: { ...down('dorkos_account_unavailable'), nextCheckAt: RETRY_AT } },
      'unavailable',
      'dorkos_account_unavailable',
      'retry',
      'dorkos',
    ],
    [
      '12 DorkOS account unavailable, DorkOS stopped re-checking',
      { way: down('dorkos_account_unavailable') },
      'unavailable',
      'dorkos_account_unavailable',
      'retry',
      'person',
    ],
    [
      '13 own key, re-check scheduled',
      { way: { ...down('own_key_unavailable'), nextCheckAt: RETRY_AT } },
      'unavailable',
      'own_key_unavailable',
      'wait',
      'dorkos',
    ],
    [
      '14 own key gone',
      { way: down('own_key_unavailable'), authenticationStatus: 'expired' },
      'needs_you',
      'own_key_unavailable',
      'fix_key',
      'person',
    ],
    [
      '15 way unreachable, re-check scheduled',
      { way: { ...down('unreachable'), nextCheckAt: RETRY_AT } },
      'unavailable',
      'way_unreachable',
      'wait',
      'dorkos',
    ],
    [
      '16 way unreachable',
      { way: down('unreachable') },
      'unavailable',
      'way_unreachable',
      undefined,
    ],
    [
      '17 account key cannot run actions',
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
      '16 way unreachable, another way works',
      { way: down('unreachable', true) },
      'unavailable',
      'way_unreachable',
      'connect_new',
      'person',
    ],
    [
      '18 self-hosted way cannot run actions',
      { way: { status: 'up', canRunActions: false, keyCanFix: false, anotherWayWorks: false } },
      'unavailable',
      'cannot_run_actions',
      undefined,
    ],
    [
      '18 self-hosted way cannot run actions, another way works',
      { way: { status: 'up', canRunActions: false, keyCanFix: false, anotherWayWorks: true } },
      'unavailable',
      'cannot_run_actions',
      'connect_new',
      'person',
    ],
    [
      '19 paused and signed out: sign in again first (it resumes too)',
      { lifecycle: 'paused', authenticationStatus: 'expired' },
      'needs_you',
      'signed_out',
      'sign_in_again',
      'person',
    ],
    [
      '20 paused with an unfinished sign-in',
      { lifecycle: 'paused', authenticationStatus: 'pending' },
      'needs_you',
      'sign_in_unfinished',
      'sign_in_again',
      'person',
    ],
    [
      '21 paused while a sign-in again runs',
      { lifecycle: 'paused', pausedBy: 'sign_in' },
      'needs_you',
      'signing_in',
      'sign_in_again',
      'person',
    ],
    [
      '22 paused by the owner',
      { lifecycle: 'paused', pausedBy: 'owner' },
      'paused',
      'paused',
      'resume',
      'person',
    ],
    [
      '22 paused (no record of who)',
      { lifecycle: 'paused' },
      'paused',
      'paused',
      'resume',
      'person',
    ],
    [
      '19 expired',
      { authenticationStatus: 'expired' },
      'needs_you',
      'signed_out',
      'sign_in_again',
      'person',
    ],
    [
      '19 revoked',
      { authenticationStatus: 'revoked' },
      'needs_you',
      'signed_out',
      'sign_in_again',
      'person',
    ],
    [
      '20 sign-in pending',
      { authenticationStatus: 'pending' },
      'needs_you',
      'sign_in_unfinished',
      'sign_in_again',
      'person',
    ],
    [
      '23 needs review',
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
      '24 access update failed',
      { authoritySync: { status: 'failed', reason: 'Refused.' } },
      'needs_you',
      'access_update_failed',
      'review_access',
      'person',
    ],
    [
      '25 access updating',
      { authoritySync: { status: 'pending' } },
      'finishing',
      'access_updating',
      'wait',
      'dorkos',
    ],
    ['26 ready', {}, 'ready', 'usable', undefined],
    [
      '26 ready without access sync (an agent view)',
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

  it('offers removing, never a retry, for a disconnect whose DorkOS account link ended', () => {
    // The live incident: Gmail connected through the DorkOS account, the link
    // ended overnight, and Disconnect offered a retry that could never work.
    const stuck = deriveConnectionReadiness(
      facts({
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        toolkit: 'gmail',
        authoritySync: {
          status: 'failed',
          reason: 'This computer isn’t linked to your DorkOS account anymore.',
        },
        way: down('dorkos_account_unlinked'),
      })
    );
    expect(stuck.fix).toEqual({ action: 'remove', fixableBy: 'person' });
    expect(stuck.copy.owner).toContain('isn’t linked anymore');
    expect(stuck.copy.owner).toContain('own account settings');
    // Where the person can end the access themselves, when the page is known.
    expect(stuck.serviceAccessPage).toEqual({
      service: 'Google',
      url: 'https://myaccount.google.com/connections',
    });
    // An app whose page isn't known gets the line alone.
    const unknownPage = deriveConnectionReadiness(
      facts({
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        toolkit: 'notion',
        way: down('dorkos_account_unlinked'),
      })
    );
    expect(unknownPage.serviceAccessPage).toBeUndefined();
    // Fixing the key lets DorkOS finish, so no service page competes with it.
    const ownKey = deriveConnectionReadiness(
      facts({
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        toolkit: 'gmail',
        way: down('own_key_unavailable'),
      })
    );
    expect(ownKey.fix?.action).toBe('fix_key');
    expect(ownKey.serviceAccessPage).toBeUndefined();
  });

  it('shows an account the DorkOS account no longer has as gone, with where to be sure it ended', () => {
    const gone = deriveConnectionReadiness(
      facts({
        lifecycle: 'disconnected',
        externalCleanup: 'unknown',
        closedBecause: 'service_gone',
        mode: 'managed',
        toolkit: 'gmail',
      })
    );
    expect(gone).toMatchObject({
      state: 'gone',
      reason: 'gone_at_service',
      fix: { action: 'connect_new', fixableBy: 'person' },
      serviceAccessPage: { service: 'Google' },
    });
    expect(gone.copy.owner).toContain('remove it in that app’s own account settings');
  });

  it('says linking the same DorkOS account again, or adding the same key again, lets DorkOS finish', () => {
    const unlinked = deriveConnectionReadiness(
      facts({
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        mode: 'managed',
        way: down('dorkos_account_unlinked'),
      })
    );
    expect(unlinked.copy.owner).toContain('Link this computer to the same DorkOS account again');
    const ownKey = deriveConnectionReadiness(
      facts({
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        way: down('own_key_unavailable'),
      })
    );
    expect(ownKey.copy.owner).toContain('Add that same key again');
  });

  describe('never promises a cleanup DorkOS won’t run', () => {
    const neverRetried: Array<[string, Partial<ConnectionReadinessFacts>]> = [
      ['own key out of tries', { mode: 'byo', externalCleanup: 'failed' }],
      ['own key unconfirmed', { mode: 'byo', externalCleanup: 'unknown' }],
      ['DorkOS account unconfirmed', { mode: 'managed', externalCleanup: 'unknown' }],
    ];
    const ways: Array<[string, ConnectionWayHealth]> = [
      ['way up', UP],
      ['own key refused', down('own_key_unavailable')],
      ['own key re-checked soon', { ...down('own_key_unavailable'), nextCheckAt: RETRY_AT }],
      ['own key being checked', { ...down('own_key_unavailable'), checking: true }],
      ['DorkOS account unlinked', down('dorkos_account_unlinked')],
      [
        'DorkOS account re-checked soon',
        { ...down('dorkos_account_unavailable'), nextCheckAt: RETRY_AT },
      ],
      ['way unreachable', down('unreachable')],
    ];
    it.each(
      neverRetried.flatMap(([cleanup, f]) => ways.map(([way, w]) => [cleanup, way, f, w] as const))
    )('%s, %s: remove it, with no promise DorkOS finishes', (_cleanup, _way, cleanupFacts, way) => {
      const r = deriveConnectionReadiness(
        facts({ lifecycle: 'disconnected', toolkit: 'gmail', ...cleanupFacts, way })
      );
      expect(r).toMatchObject({
        state: 'gone',
        reason: 'disconnect_stuck',
        fix: { action: 'remove', fixableBy: 'person' },
        serviceAccessPage: { service: 'Google' },
      });
      expect(r.copy.owner).toContain('couldn’t confirm its access ended');
      expect(r.copy.owner).not.toMatch(/finishes it on its own|still removing|same key/);
    });

    it('keeps DorkOS’s promise only for a cleanup it will try again', () => {
      // An own-key cleanup still pending waits for that same key.
      expect(
        deriveConnectionReadiness(
          facts({
            lifecycle: 'disconnected',
            externalCleanup: 'pending',
            way: down('own_key_unavailable'),
          })
        ).fix?.action
      ).toBe('fix_key');
      // A DorkOS-account cleanup the hosted side said failed goes again on a relink.
      expect(
        deriveConnectionReadiness(
          facts({
            lifecycle: 'disconnected',
            externalCleanup: 'failed',
            mode: 'managed',
            way: down('dorkos_account_unlinked'),
          })
        ).copy.owner
      ).toContain('Link this computer to the same DorkOS account again');
    });
  });

  it('carries when DorkOS next tries an own-key cleanup on its own', () => {
    const finishing = deriveConnectionReadiness(
      facts({ lifecycle: 'disconnected', externalCleanup: 'pending', cleanupRetryAt: RETRY_AT })
    );
    expect(finishing.fix).toEqual({ action: 'retry', fixableBy: 'dorkos', retryAt: RETRY_AT });
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

  it('tells the owner, never the agent, that an app turned off for a chat can be turned on', () => {
    const offered = deriveConnectionReadiness(
      facts({ offForThisChat: true, canTurnOnForThisChat: true })
    );
    expect(offered.copy.owner).toBe(
      `${CONNECTION_READINESS_COPY.off_for_this_chat.owner} ${TURN_ON_FOR_THIS_CHAT_COPY.owner}`
    );
    expect(offered.copy.agent).toBe(CONNECTION_READINESS_COPY.off_for_this_chat.agent);
    const agentView = deriveConnectionReadiness(facts({ offForThisChat: true }));
    expect(agentView.fix).toBeUndefined();
    expect(agentView.copy).toEqual(CONNECTION_READINESS_COPY.off_for_this_chat);
    // The switch only undoes "off": it offers nothing on an account that isn't off here.
    expect(deriveConnectionReadiness(facts({ canTurnOnForThisChat: true })).state).toBe('ready');
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
    // A disconnect waiting on a key DorkOS re-checks on its own is DorkOS's
    // to finish too, when the key answers again.
    const finishing = deriveConnectionReadiness(
      facts({
        lifecycle: 'disconnected',
        externalCleanup: 'pending',
        way: { ...down('own_key_unavailable'), nextCheckAt: RETRY_AT },
      })
    );
    expect(finishing).toMatchObject({
      reason: 'disconnect_finishing',
      fix: { action: 'wait', fixableBy: 'dorkos', retryAt: RETRY_AT },
    });
  });

  it('shows a check in progress as a wait, not a fix that isn’t needed yet', () => {
    // A key being checked right now (just saved, or an automatic re-check)
    // must not read as "Fix the key" for the moment it runs.
    const checking = deriveConnectionReadiness(
      facts({ way: { ...down('own_key_unavailable'), checking: true } })
    );
    expect(checking).toEqual({
      state: 'unavailable',
      reason: 'own_key_unavailable',
      fix: { action: 'wait', fixableBy: 'dorkos' },
      copy: WAY_CHECKING_COPY,
    });
  });

  it('names the true cause of a review: how DorkOS reaches the account changed', () => {
    const review = deriveConnectionReadiness(
      facts({ reconciliationStatus: 'migration_needs_reconcile' })
    );
    expect(review.copy.owner).toContain('How DorkOS reaches it changed');
    expect(review.copy.owner).not.toMatch(/actions changed/i);
  });

  it('says linking again with the same account can bring an unlinked account back, never that it will (DOR-2521)', () => {
    const { copy } = deriveConnectionReadiness(facts({ way: down('dorkos_account_unlinked') }));
    for (const line of [copy.owner, copy.agent]) {
      expect(line).toContain('isn’t linked anymore');
      expect(line).toContain('Linking this computer again with the same');
      expect(line).toContain('can bring it back');
      expect(line).not.toMatch(/(?<!can |not )brings? it back/);
      expect(line).toContain('unless its earlier link was removed from that account');
    }
    expect(copy.owner).toContain('Otherwise, connect it again.');
    // The agent is told every case where it cannot, and what the person does then.
    expect(copy.agent).toContain('A different account, or a link made on another computer');
    expect(copy.agent).toContain('connect this app again');
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

  it('says a way that is down is being checked, and when it is checked again', () => {
    expect(
      wayHealthOf(
        undefined,
        () => 'own_key_unavailable',
        () => false,
        () => ({ checking: true, nextCheckAt: RETRY_AT })
      )
    ).toEqual({ ...down('own_key_unavailable'), checking: true, nextCheckAt: RETRY_AT });
    // A way that is up is never "being checked": it answered.
    expect(
      wayHealthOf(
        provider('composio', true),
        () => undefined,
        () => false,
        () => ({ checking: true })
      )
    ).toEqual(UP);
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
