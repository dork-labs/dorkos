import { describe, expect, it } from 'vitest';
import {
  connectionOperationGrants,
  connectorUsageAttempts,
  connectorUsageTerminalReceipts,
  sessionConnectionOverrides,
} from '@dorkos/db';
import { ConnectorExecutionBroker } from '../../execution-broker.js';
import { ConnectorUsageStore } from '../../usage-store.js';
import {
  CONNECTION_ID,
  REVISION_ID,
  useExecutionBrokerHarness,
  openRuntimeTurn,
} from './execution-broker.fixtures.js';

/** Argument checking against the stored schema, and session overrides. */
describe('ConnectorExecutionBroker', () => {
  const h = useExecutionBrokerHarness();

  it('sends the provider exactly the arguments the agent sent, never the schema defaults', async () => {
    const sent = { message: 'hello', label_ids: ['INBOX'] };

    await expect(
      h.execute(h.principal(), 'connectors.execute_write', undefined, {
        ...h.target,
        arguments: sent,
      })
    ).resolves.toMatchObject({ result: { status: 'success' } });
    expect(h.provider.dispatchedCommands.map((command) => command.arguments)).toEqual([sent]);
  });

  it('names the field an agent got wrong without echoing what it sent', async () => {
    const refusal = await h.authorization
      .prepare({
        capabilityId: 'connectors.execute_write',
        target: { ...h.target, arguments: { message: 'hello', max_attempts: 'nine-hundred' } },
        principal: h.principal(),
      })
      .then(
        () => undefined,
        (error: { payload?: { code?: string; error?: string } }) => error.payload
      );

    expect(refusal?.code).toBe('CONNECTOR_ARGUMENTS_INVALID');
    expect(refusal?.error).toMatch(/max_attempts: .*expected number/);
    expect(refusal?.error).not.toContain('nine-hundred');
    expect(h.provider.commands).toEqual([]);
  });

  it('refuses arguments that do not exactly match the immutable schema', async () => {
    await expect(
      h.authorization.prepare({
        capabilityId: 'connectors.execute_write',
        target: { ...h.target, arguments: { message: 'hello', ignored: true } },
        principal: h.principal(),
      })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_ARGUMENTS_INVALID' } });
  });

  it('uses only session grants for an explicit attached override and otherwise inherits agent grants', async () => {
    const actor = h.runtimePrincipal();
    await expect(
      h.authorization.prepare({
        capabilityId: 'connectors.execute_write',
        target: h.target,
        principal: actor,
      })
    ).resolves.toMatchObject({ agentId: 'agent-a', sessionId: 'session-a' });

    h.db
      .insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        state: 'attached',
        updatedAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    await expect(
      h.authorization.prepare({
        capabilityId: 'connectors.execute_write',
        target: h.target,
        principal: actor,
      })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });

    h.db
      .insert(connectionOperationGrants)
      .values({
        id: 'grant-session-a',
        subjectType: 'session',
        subjectId: 'session-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: REVISION_ID,
        createdBy: 'operator',
        createdAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    await expect(
      h.authorization.prepare({
        capabilityId: 'connectors.execute_write',
        target: h.target,
        principal: actor,
      })
    ).resolves.toMatchObject({ agentId: 'agent-a', sessionId: 'session-a' });
  });

  it.each([
    { agentId: 'agent-b', needsReconciliation: false },
    { agentId: 'agent-a', needsReconciliation: true },
  ])(
    'refuses an attached session override owned by $agentId with reconciliation=$needsReconciliation',
    async ({ agentId, needsReconciliation }) => {
      h.db
        .insert(sessionConnectionOverrides)
        .values({
          sessionId: 'session-a',
          agentId,
          connectionId: CONNECTION_ID,
          state: 'attached',
          needsReconciliation,
          updatedAt: '2026-09-06T12:00:00.000Z',
        })
        .run();
      h.db
        .insert(connectionOperationGrants)
        .values({
          id: `grant-session-${agentId}-${needsReconciliation}`,
          subjectType: 'session',
          subjectId: 'session-a',
          agentId: 'agent-a',
          connectionId: CONNECTION_ID,
          operationRevisionId: REVISION_ID,
          createdBy: 'operator',
          createdAt: '2026-09-06T12:00:00.000Z',
        })
        .run();

      await expect(
        h.authorization.prepare({
          capabilityId: 'connectors.execute_write',
          target: h.target,
          principal: h.runtimePrincipal(),
        })
      ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });
    }
  );

  it.each([
    { agentId: 'agent-b', needsReconciliation: false },
    { agentId: 'agent-a', needsReconciliation: true },
  ])(
    'review probe: full broker refuses override owner=$agentId reconciliation=$needsReconciliation',
    async ({ agentId, needsReconciliation }) => {
      const { runtimePrincipals, resolved } = await openRuntimeTurn(h.db, {
        makeBootEpoch: () => 'boot-probe',
        makeBearer: () => 'bearer-probe',
      });
      h.db
        .insert(sessionConnectionOverrides)
        .values({
          sessionId: 'session-a',
          agentId,
          connectionId: CONNECTION_ID,
          state: 'attached',
          needsReconciliation,
          updatedAt: '2026-09-06T12:00:00.000Z',
        })
        .run();
      h.db
        .insert(connectionOperationGrants)
        .values({
          id: `review-probe-session-${agentId}-${needsReconciliation}`,
          subjectType: 'session',
          subjectId: 'session-a',
          agentId: 'agent-a',
          connectionId: CONNECTION_ID,
          operationRevisionId: REVISION_ID,
          createdBy: 'operator',
          createdAt: '2026-09-06T12:00:00.000Z',
        })
        .run();
      const runtimeBroker = new ConnectorExecutionBroker(
        h.authorization,
        new ConnectorUsageStore(h.db),
        { revalidate: (principal) => runtimePrincipals.revalidatePrincipal(principal) },
        () => new Date('2026-09-06T12:00:01.000Z')
      );

      await expect(
        (async () => {
          const authorized = await h.authorization.prepare({
            capabilityId: 'connectors.execute_write',
            target: h.target,
            principal: resolved.principal,
          });
          return runtimeBroker.execute({
            capabilityId: 'connectors.execute_write',
            target: h.target,
            principal: resolved.principal,
            authorityBinding: authorized.authorityBinding,
            surface: 'mcp',
            signal: new AbortController().signal,
          });
        })()
      ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });
      expect(h.db.select().from(connectorUsageAttempts).all()).toEqual([]);
      expect(h.db.select().from(connectorUsageTerminalReceipts).all()).toEqual([]);
      expect(h.provider.commands).toEqual([]);
    }
  );

  it('review probe: full broker keeps a valid attached override exact and executable', async () => {
    const { runtimePrincipals, resolved } = await openRuntimeTurn(h.db, {
      makeBootEpoch: () => 'boot-valid-probe',
      makeBearer: () => 'bearer-valid-probe',
    });
    h.db
      .insert(sessionConnectionOverrides)
      .values({
        sessionId: 'session-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        state: 'attached',
        needsReconciliation: false,
        updatedAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
    h.db
      .insert(connectionOperationGrants)
      .values({
        id: 'review-probe-valid-session',
        subjectType: 'session',
        subjectId: 'session-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: REVISION_ID,
        createdBy: 'operator',
        createdAt: '2026-09-06T12:00:00.000Z',
      })
      .run();
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

    await expect(
      runtimeBroker.execute({
        capabilityId: 'connectors.execute_write',
        target: h.target,
        principal: resolved.principal,
        authorityBinding: authorized.authorityBinding,
        surface: 'mcp',
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ attemptCount: 1, result: { status: 'success' } });
    expect(h.db.select().from(connectorUsageAttempts).all()).toHaveLength(1);
    expect(h.db.select().from(connectorUsageTerminalReceipts).all()).toHaveLength(1);
    expect(h.provider.commands).toHaveLength(1);
  });

  it('rejects a structurally identical but unauthenticated preflight binding', async () => {
    const actor = h.principal();
    const authorized = await h.authorization.prepare({
      capabilityId: 'connectors.execute_write',
      target: h.target,
      principal: actor,
    });

    await expect(
      h.broker.execute({
        capabilityId: 'connectors.execute_write',
        target: h.target,
        principal: actor,
        authorityBinding: {
          approvalScope: { ...authorized.authorityBinding.approvalScope },
        },
        surface: 'mcp',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_PREFLIGHT_REQUIRED' } });
    expect(h.db.select().from(connectorUsageAttempts).all()).toEqual([]);
  });

  it('denies cross-actor destructive approval reuse before intent', async () => {
    const actor = h.principal();
    const authorized = await h.authorization.prepare({
      capabilityId: 'connectors.execute_destructive',
      target: h.destructiveTarget,
      principal: actor,
    });

    await expect(
      h.execute(
        actor,
        'connectors.execute_destructive',
        {
          via: 'approval',
          approvalId: 'approval-for-other-actor',
          authorityBindingDigest: `${authorized.authorityBinding.approvalScope.digest}-other`,
        },
        h.destructiveTarget
      )
    ).rejects.toMatchObject({
      payload: {
        code: 'CONNECTOR_APPROVAL_BINDING_MISMATCH',
        // High risk, never "can't be undone": the class covers forwarding too.
        error:
          'This is a high-risk action, so the person must approve this exact action before it runs.',
      },
    });
    expect(h.db.select().from(connectorUsageAttempts).all()).toEqual([]);
  });
});
