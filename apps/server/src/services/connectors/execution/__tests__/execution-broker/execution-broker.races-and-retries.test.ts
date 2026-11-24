import { CONNECTION_READINESS_COPY } from '@dorkos/shared/connector-schemas';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  connectionOperationGrants,
  connections,
  connectorUsageAttempts,
  connectorUsageTerminalReceipts,
  eq,
} from '@dorkos/db';
import { ConnectorExecutionBroker } from '../../execution-broker.js';
import { ConnectorUsageStore } from '../../usage-store.js';
import {
  OWNER,
  CONNECTION_ID,
  REVISION_ID,
  RETRY_REVISION_ID,
  useExecutionBrokerHarness,
  openRuntimeTurn,
} from './execution-broker.fixtures.js';

/** Authority that changes mid-call, the destructive hold, safe retries and ended sign-ins. */
describe('ConnectorExecutionBroker', () => {
  const h = useExecutionBrokerHarness();

  it('rechecks a grant revoked after preflight and creates no intent', async () => {
    const actor = h.principal();
    const authorized = await h.authorization.prepare({
      capabilityId: 'connectors.execute_write',
      target: h.target,
      principal: actor,
    });
    h.db
      .update(connectionOperationGrants)
      .set({ revokedAt: '2026-09-06T12:00:00.500Z' })
      .where(eq(connectionOperationGrants.id, `grant-${REVISION_ID}`))
      .run();

    await expect(
      h.broker.execute({
        capabilityId: 'connectors.execute_write',
        target: h.target,
        principal: actor,
        authorityBinding: authorized.authorityBinding,
        surface: 'mcp',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });
    expect(h.db.select().from(connectorUsageAttempts).all()).toEqual([]);
  });

  it('refuses a dispatch when authority changes during provider preflight', async () => {
    h.provider.beforeDispatch = async () => {
      await Promise.resolve();
      h.db
        .update(connectionOperationGrants)
        .set({ revokedAt: '2026-09-06T12:00:00.500Z' })
        .where(eq(connectionOperationGrants.id, `grant-${REVISION_ID}`))
        .run();
      h.db
        .update(connections)
        .set({ lifecycleState: 'disconnected', status: 'revoked' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
    };

    await expect(h.execute()).resolves.toMatchObject({
      attemptCount: 1,
      result: { status: 'error', code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
    });
    expect(h.provider.commands).toHaveLength(1);
    expect(h.provider.dispatchedCommands).toEqual([]);
    expect(h.db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
    expect(h.db.select().from(connectorUsageTerminalReceipts).all()).toMatchObject([
      { outcome: 'error', errorCode: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
    ]);
  });

  it.each(['grant', 'connection'] as const)(
    'refuses dispatch when the %s changes during the last principal authority await',
    async (change) => {
      let providerPreflightStarted = false;
      let finalAuthorityChecks = 0;
      let reachedLastAuthorityCheck!: () => void;
      let releaseLastAuthorityCheck!: () => void;
      const lastAuthorityCheckReached = new Promise<void>((resolve) => {
        reachedLastAuthorityCheck = resolve;
      });
      const lastAuthorityCheckReleased = new Promise<void>((resolve) => {
        releaseLastAuthorityCheck = resolve;
      });
      const { runtimePrincipals, resolved } = await openRuntimeTurn(h.db, {
        authority: {
          authorizeTurn: async () => ({ owner: OWNER, agentId: 'agent-a' }),
          revalidateTurn: async () => {
            if (providerPreflightStarted) {
              finalAuthorityChecks += 1;
              if (finalAuthorityChecks === 2) {
                reachedLastAuthorityCheck();
                await lastAuthorityCheckReleased;
              }
            }
            return true;
          },
        },
        makeBootEpoch: () => `boot-final-${change}`,
        makeBearer: () => `bearer-final-${change}`,
      });

      const runtimeBroker = new ConnectorExecutionBroker(
        h.authorization,
        new ConnectorUsageStore(h.db),
        { revalidate: (principal) => runtimePrincipals.revalidatePrincipal(principal) },
        () => new Date('2026-09-06T12:00:01.000Z')
      );
      const authorized = await h.authorization.prepare({
        capabilityId: 'connectors.execute_write',
        target: h.target,
        principal: resolved.principal,
      });
      h.provider.beforeDispatch = () => {
        providerPreflightStarted = true;
      };

      const execution = runtimeBroker.execute({
        capabilityId: 'connectors.execute_write',
        target: h.target,
        principal: resolved.principal,
        authorityBinding: authorized.authorityBinding,
        surface: 'mcp',
        signal: new AbortController().signal,
      });
      await lastAuthorityCheckReached;
      if (change === 'grant') {
        h.db
          .update(connectionOperationGrants)
          .set({ revokedAt: '2026-09-06T12:00:00.500Z' })
          .where(eq(connectionOperationGrants.id, `grant-${REVISION_ID}`))
          .run();
      } else {
        h.db
          .update(connections)
          .set({ enabled: false })
          .where(eq(connections.id, CONNECTION_ID))
          .run();
      }
      releaseLastAuthorityCheck();

      await expect(execution).resolves.toMatchObject({
        attemptCount: 1,
        result: { status: 'error', code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
      });
      expect(finalAuthorityChecks).toBe(2);
      expect(h.provider.commands).toHaveLength(1);
      expect(h.provider.dispatchedCommands).toEqual([]);
      expect(h.db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
      expect(h.db.select().from(connectorUsageTerminalReceipts).all()).toMatchObject([
        { outcome: 'error', errorCode: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
      ]);
    }
  );

  describe('a destructive action held through its cancel window', () => {
    /** Run the destructive target on a `hold` approval carrying `digest`. */
    async function executeHeld(approval: {
      via: 'hold';
      holdId: string;
      authorityBindingDigest: string;
    }) {
      const actor = h.principal();
      const authorized = await h.authorization.prepare({
        capabilityId: 'connectors.execute_destructive',
        target: h.destructiveTarget,
        principal: actor,
      });
      return h.broker.execute({
        capabilityId: 'connectors.execute_destructive',
        target: h.destructiveTarget,
        principal: actor,
        authorityBinding: authorized.authorityBinding,
        approval,
        surface: 'mcp',
        signal: new AbortController().signal,
      });
    }

    async function liveDigest(): Promise<string> {
      const authorized = await h.authorization.prepare({
        capabilityId: 'connectors.execute_destructive',
        target: h.destructiveTarget,
        principal: h.principal(),
      });
      return authorized.authorityBinding.approvalScope.digest;
    }

    it('runs on a hold bound to the exact authority it was held with', async () => {
      await expect(
        executeHeld({ via: 'hold', holdId: 'hold-a', authorityBindingDigest: await liveDigest() })
      ).resolves.toMatchObject({ result: { status: 'success' } });
      expect(h.provider.dispatchedCommands).toHaveLength(1);
    });

    it('refuses a hold held for a different authority before intent', async () => {
      await expect(
        executeHeld({
          via: 'hold',
          holdId: 'hold-a',
          authorityBindingDigest: `${await liveDigest()}-other`,
        })
      ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_APPROVAL_BINDING_MISMATCH' } });
      expect(h.db.select().from(connectorUsageAttempts).all()).toEqual([]);
      expect(h.provider.commands).toEqual([]);
    });

    it('refuses, at the final dispatch check, a hold whose binding no longer matches', async () => {
      const approval = {
        via: 'hold' as const,
        holdId: 'hold-a',
        authorityBindingDigest: await liveDigest(),
      };
      // The first check passes; the binding is then changed before dispatch, so
      // only the second check (inside `authorizeDispatch`) can stop it.
      h.provider.beforeDispatch = () => {
        approval.authorityBindingDigest = 'digest-of-another-action';
      };
      await expect(executeHeld(approval)).resolves.toMatchObject({
        result: { status: 'error', code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH' },
      });
      expect(h.provider.commands).toHaveLength(1);
      expect(h.provider.dispatchedCommands).toEqual([]);
    });
  });

  it('retries only a pinned idempotent operation and reuses one upstream key', async () => {
    h.provider.results.push(
      { status: 'error', code: 'temporary', message: 'Try again', retryable: true },
      { status: 'success', data: { delivered: true } }
    );

    await expect(
      h.execute(h.principal(), 'connectors.execute_write', undefined, h.retryTarget)
    ).resolves.toMatchObject({ attemptCount: 2, result: { status: 'success' } });
    expect(h.provider.commands).toHaveLength(2);
    expect(h.provider.commands[0]!.upstreamIdempotencyKey).toBe(
      h.provider.commands[1]!.upstreamIdempotencyKey
    );
    expect(h.db.select().from(connectorUsageAttempts).all()).toHaveLength(2);
    expect(h.db.select().from(connectorUsageTerminalReceipts).all()).toHaveLength(2);
  });

  it('never retries an unknown transport outcome even under an idempotent policy', async () => {
    h.provider.results.push(new Error('socket reset'));

    await expect(
      h.execute(h.principal(), 'connectors.execute_write', undefined, h.retryTarget)
    ).resolves.toMatchObject({
      attemptCount: 1,
      result: { status: 'outcome_unknown', code: 'PROVIDER_TRANSPORT_OUTCOME_UNKNOWN' },
    });
    expect(h.provider.commands).toHaveLength(1);
  });

  it.each(['revoked', 'expired'] as const)(
    'revalidates a %s durable runtime binding before a safe retry',
    async (terminal) => {
      let principalNowMs = Date.parse('2026-09-06T12:00:00.000Z');
      const { runtimePrincipals, opened, resolved } = await openRuntimeTurn(h.db, {
        makeBootEpoch: () => 'boot-a',
        makeBearer: () => 'bearer-a',
        bindingTtlMs: 1_000,
        now: () => new Date(principalNowMs),
      });

      const runtimeBroker = new ConnectorExecutionBroker(
        h.authorization,
        new ConnectorUsageStore(h.db),
        { revalidate: (principal) => runtimePrincipals.revalidatePrincipal(principal) },
        () => new Date('2026-09-06T12:00:01.000Z')
      );
      h.provider.results.push(
        { status: 'error', code: 'temporary', message: 'Try again', retryable: true },
        { status: 'success', data: { delivered: true } }
      );
      let revoked = false;
      h.provider.afterExecute = async () => {
        if (revoked) return;
        revoked = true;
        if (terminal === 'revoked') {
          await runtimePrincipals.revoke(opened.bindingId, 'runtime_failed');
        } else {
          principalNowMs += 1_000;
        }
      };
      const authorized = await h.authorization.prepare({
        capabilityId: 'connectors.execute_write',
        target: h.retryTarget,
        principal: resolved.principal,
      });

      await expect(
        runtimeBroker.execute({
          capabilityId: 'connectors.execute_write',
          target: h.retryTarget,
          principal: resolved.principal,
          authorityBinding: authorized.authorityBinding,
          surface: 'mcp',
          signal: new AbortController().signal,
        })
      ).resolves.toMatchObject({
        attemptCount: 1,
        result: { status: 'error', code: 'temporary' },
      });
      expect(h.provider.commands).toHaveLength(1);
    }
  );

  it('records a provider result that settles after the lease expires without repeating it', async () => {
    let principalNowMs = Date.parse('2026-09-06T12:00:00.000Z');
    const { runtimePrincipals, resolved } = await openRuntimeTurn(h.db, {
      makeBootEpoch: () => 'boot-cross-expiry',
      makeBearer: () => 'bearer-cross-expiry',
      bindingTtlMs: 1_000,
      now: () => new Date(principalNowMs),
    });

    const runtimeBroker = new ConnectorExecutionBroker(
      h.authorization,
      new ConnectorUsageStore(h.db),
      { revalidate: (principal) => runtimePrincipals.revalidatePrincipal(principal) },
      () => new Date(principalNowMs)
    );
    h.provider.results.push({ status: 'success', data: { delivered: true } });
    h.provider.afterExecute = () => {
      principalNowMs += 1_000;
    };
    const authorized = await h.authorization.prepare({
      capabilityId: 'connectors.execute_write',
      target: h.retryTarget,
      principal: resolved.principal,
    });

    await expect(
      runtimeBroker.execute({
        capabilityId: 'connectors.execute_write',
        target: h.retryTarget,
        principal: resolved.principal,
        authorityBinding: authorized.authorityBinding,
        surface: 'mcp',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({
      attemptCount: 1,
      result: { status: 'success', data: { delivered: true } },
    });
    expect(h.provider.commands).toHaveLength(1);
    expect(h.db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
    expect(h.db.select().from(connectorUsageTerminalReceipts).all()).toHaveLength(1);
  });

  it('stops a retry when the live grant changes after the first attempt', async () => {
    h.provider.results.push({
      status: 'error',
      code: 'temporary',
      message: 'Try again',
      retryable: true,
    });
    h.provider.afterExecute = () => {
      h.db
        .update(connectionOperationGrants)
        .set({ revokedAt: '2026-09-06T12:00:00.500Z' })
        .where(eq(connectionOperationGrants.id, `grant-${RETRY_REVISION_ID}`))
        .run();
    };

    await expect(
      h.execute(h.principal(), 'connectors.execute_write', undefined, h.retryTarget)
    ).resolves.toMatchObject({
      attemptCount: 1,
      result: { status: 'error', code: 'temporary' },
    });
    expect(h.provider.commands).toHaveLength(1);
    expect(h.db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
    expect(h.db.select().from(connectorUsageTerminalReceipts).all()).toHaveLength(1);
  });

  describe('a sign-in the service says has ended', () => {
    const signInOf = () =>
      h.db
        .select({ status: connections.status, lastVerifiedAt: connections.lastVerifiedAt })
        .from(connections)
        .where(eq(connections.id, CONNECTION_ID))
        .get();

    beforeEach(() => {
      h.broker = new ConnectorExecutionBroker(
        h.authorization,
        new ConnectorUsageStore(h.db),
        { revalidate: () => true },
        () => new Date('2026-09-06T12:00:01.000Z'),
        undefined,
        h.registry
      );
    });

    it.each([
      ['ACCOUNT_SIGN_IN_EXPIRED', 'expired'],
      ['ACCOUNT_SIGN_IN_REVOKED', 'revoked'],
    ] as const)(
      'records %s on the connection at once and tells the agent to ask for a new sign-in',
      async (code, status) => {
        h.provider.results.push({
          status: 'error',
          code,
          message: CONNECTION_READINESS_COPY.signed_out.agent,
          retryable: false,
        });

        await expect(h.execute()).resolves.toMatchObject({
          result: { status: 'error', code, message: CONNECTION_READINESS_COPY.signed_out.agent },
        });
        expect(signInOf()).toEqual({ status, lastVerifiedAt: expect.any(String) });

        // The next call is refused before it reaches the service, with the same one fix.
        await expect(h.execute()).rejects.toMatchObject({
          payload: {
            code: 'CONNECTOR_SIGN_IN_ENDED',
            error: CONNECTION_READINESS_COPY.signed_out.agent,
          },
        });
        expect(h.provider.commands).toHaveLength(1);
      }
    );
  });
});
