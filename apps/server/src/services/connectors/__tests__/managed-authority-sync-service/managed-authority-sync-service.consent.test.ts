import { describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connectorManagedAuthorityOutbox,
  connectorOperationRevisions,
  connectorProviderInstances,
  eq,
  connections,
} from '@dorkos/db';
import type {
  ManagedConnectorAuthorityCommand,
  ManagedConnectorAuthorityCommandStatus,
} from '@dorkos/shared/connector-managed-schemas';
import {
  OWNER,
  PROVIDER_ID,
  CONNECTION_ID,
  MANAGED_CONNECTION_ID,
  START,
  statusFor,
  cloudError,
  useManagedAuthoritySyncHarness,
  useRefusedChangesHarness,
  lifecycleChange,
} from './managed-authority-sync-service.fixtures.js';
import { ConnectorLifecycleService } from '../../resources/lifecycle-service.js';
import { ConnectorAuthenticationFlowService } from '../../resources/authentication-flow-service.js';

/** Consent applied only through the exact hosted acknowledgement, and refused hosted changes are never a dead end. */
describe('ManagedAuthoritySyncService', () => {
  const h = useManagedAuthoritySyncHarness();

  describe('an agent’s pick taken back on a managed account (DOR-2503)', () => {
    function row(id: string) {
      return h.db.$client
        .prepare(
          'SELECT scope_version, enabled, revoked_at FROM connector_event_subscriptions WHERE id = ?'
        )
        .get(id) as { scope_version: number; enabled: number; revoked_at: string | null };
    }
    function latestEventCommand() {
      return h.submitted.filter((command) => command.kind === 'set_event_subscription').at(-1) as
        Extract<ManagedConnectorAuthorityCommand, { kind: 'set_event_subscription' }> | undefined;
    }

    it('puts a pending update back at a newer generation the hosted side hears about', async () => {
      const f = h.eventReview();
      // The person's own update is waiting on the hosted side at v1.
      vi.mocked(h.cloud.submitConnectorAuthorityCommand).mockImplementationOnce(async (command) => {
        h.submitted.push(command);
        return statusFor(command, 'pending');
      });
      const person = await f.grants.approve(OWNER, f.review, f.signal);
      expect(person.state).toBe('pending');
      const id = person.selections[0]!.subscriptionId;
      expect(row(id)).toMatchObject({ scope_version: 1, enabled: 0 });

      // An agent's pick of the same update takes it over at v2 and is acknowledged.
      const pick = await f.grants.approve(
        OWNER,
        { ...f.review, reviewId: 'agent-request-review' },
        f.signal
      );
      expect(pick.state).toBe('ready');
      expect(row(id).scope_version).toBe(2);

      // The pick is taken back: never back to v1, which the hosted side has passed.
      f.grants.withdraw(OWNER, 'agent-request-review', new Date(h.clock).toISOString());
      expect(row(id)).toMatchObject({ scope_version: 3, enabled: 0, revoked_at: null });
      await f.sync.recoverPending(f.signal);

      expect(latestEventCommand()).toMatchObject({
        subscriptionId: id,
        subscriptionVersion: 3,
        enabled: true,
      });
      expect(row(id)).toMatchObject({ scope_version: 3, enabled: 1 });
      // Ingress accepts an event only for the exact live generation it names.
      expect(f.store.active(id, 3)).toMatchObject({ mode: 'managed', subscriptionVersion: 3 });
      expect(f.sync.eventSubscriptionReady(id, 3)).toBe(true);
    });
  });

  it('activates managed receive consent only through its exact full outbox ACK', async () => {
    const f = h.eventReview();
    const result = await f.grants.approve(OWNER, f.review, f.signal);
    expect(result.state).toBe('ready');
    if (result.state !== 'ready') throw new Error('Event was not acknowledged');
    expect(h.submitted).toHaveLength(1);
    expect(h.submitted[0]).toMatchObject({
      kind: 'set_event_subscription',
      subscriptionVersion: 1,
      scopeVersion: 1,
      hostedDefinitionId: '10000000-0000-4000-8000-000000000099',
      agentId: 'agent-a',
      destination: { kind: 'agent', id: 'agent-a' },
      filter: {},
      enabled: true,
    });
    expect(f.grants.ready(OWNER, result.selections, result.appliedEventScopeHash)).toBe(true);
    expect(await f.grants.approve(OWNER, f.review, f.signal)).toEqual(result);
    expect(h.submitted).toHaveLength(1);
  });

  it('refuses a successful-looking ACK with a different reviewed destination hash', async () => {
    const f = h.eventReview();
    vi.mocked(h.cloud.submitConnectorAuthorityCommand).mockImplementation(async (command) => ({
      ...statusFor(command),
      appliedEventScopeHash: '0'.repeat(64),
    }));
    const result = await f.grants.approve(OWNER, f.review, f.signal);
    expect(result.state).toBe('pending');
    expect(f.store.active(result.selections[0]!.subscriptionId)).toBeUndefined();
    expect(h.db.select().from(connectorManagedAuthorityOutbox).get()?.state).not.toBe('applied');
  });

  it('stages agent-wide receive revocation through existing recovery and old approval cannot reopen it', async () => {
    const f = h.eventReview();
    const result = await f.grants.approve(OWNER, f.review, f.signal);
    if (result.state !== 'ready') throw new Error('Event was not acknowledged');
    f.sync.stageAgentAccessRemoval({
      connectionId: CONNECTION_ID,
      managedConnectionId: MANAGED_CONNECTION_ID,
      agentId: 'agent-a',
      providerInstanceId: PROVIDER_ID,
      executionConfigGeneration: 1,
      owner: OWNER,
    });
    expect(f.grants.ready(OWNER, result.selections, result.appliedEventScopeHash)).toBe(false);
    expect(await f.grants.approve(OWNER, f.review, f.signal)).toEqual({
      state: 'unavailable',
      selections: result.selections,
    });
    await f.sync.recoverPending(f.signal);
    const disable = h.submitted.find(
      (command) => command.kind === 'set_event_subscription' && !command.enabled
    );
    expect(disable).toMatchObject({
      subscriptionId: result.selections[0]!.subscriptionId,
      subscriptionVersion: 2,
      scopeVersion: 2,
    });
    const count = h.submitted.length;
    await f.sync.recoverPending(f.signal);
    expect(h.submitted).toHaveLength(count);
  });

  it('keeps separately approved event consent when only operation grants are removed', async () => {
    const f = h.eventReview();
    const result = await f.grants.approve(OWNER, f.review, f.signal);
    if (result.state !== 'ready') throw new Error('Event was not acknowledged');
    await h.replace(f.sync);
    await f.sync.replaceAgentGrants({
      connectionId: CONNECTION_ID,
      managedConnectionId: MANAGED_CONNECTION_ID,
      agentId: 'agent-a',
      revisions: [],
      operationRevisionIds: [],
      providerInstanceId: PROVIDER_ID,
      executionConfigGeneration: 1,
      owner: OWNER,
      signal: f.signal,
    });
    expect(f.grants.ready(OWNER, result.selections, result.appliedEventScopeHash)).toBe(true);
    expect(h.submitted.filter((command) => command.kind === 'set_event_subscription')).toHaveLength(
      1
    );
  });

  it('does not apply an old hosted ACK after local receive revocation while the request was in flight', async () => {
    const f = h.eventReview();
    vi.mocked(h.cloud.submitConnectorAuthorityCommand).mockImplementation(async (command) => {
      if (command.kind === 'set_event_subscription')
        f.store.revoke(OWNER, command.subscriptionId, new Date(h.clock).toISOString());
      return statusFor(command);
    });
    const result = await f.grants.approve(OWNER, f.review, f.signal);
    expect(result.state).toBe('unavailable');
    expect(f.store.active(result.selections[0]!.subscriptionId)).toBeUndefined();
  });

  it('activates only the exact hosted revision even when retired metadata matches again', async () => {
    const current = h.db
      .select()
      .from(connectorOperationRevisions)
      .where(eq(connectorOperationRevisions.id, 'revision-send'))
      .get()!;
    h.db
      .insert(connectorOperationRevisions)
      .values({
        ...current,
        id: 'retired-send',
        providerRevisionRef: '10000000-0000-4000-8000-000000000002',
      })
      .run();
    h.db
      .insert(connectionOperationGrants)
      .values({
        id: 'retired-grant',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: CONNECTION_ID,
        operationRevisionId: 'retired-send',
        createdBy: 'operator',
        createdAt: new Date(START).toISOString(),
        revokedAt: new Date(START).toISOString(),
      })
      .run();
    await h.replace();
    expect(
      h.db
        .select()
        .from(connectionOperationGrants)
        .where(eq(connectionOperationGrants.operationRevisionId, 'retired-send'))
        .get()?.revokedAt
    ).toBe(new Date(START).toISOString());
    expect(
      h.db
        .select()
        .from(connectionOperationGrants)
        .where(eq(connectionOperationGrants.operationRevisionId, 'revision-send'))
        .get()?.revokedAt
    ).toBeNull();
  });

  describe('refused changes are never a dead end', () => {
    const r = useRefusedChangesHarness(h);

    // DOR-3265: a change waiting for the owner's approval is not applied yet,
    // so it stays pending and the last applied set stands.
    it('keeps a change awaiting the owner’s approval pending, never applied or refused', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => ({
        version: 1 as const,
        commandId: command.commandId,
        managedConnectionId: command.managedConnectionId,
        scopeVersion: command.scopeVersion,
        state: 'awaiting_approval' as const,
        approvalId: '4b0f6f3e-9a2c-4d71-8c1e-2f5a6b7c8d9e',
        approveUrl: 'https://cloud.example.com/approvals/4b0f6f3e-9a2c-4d71-8c1e-2f5a6b7c8d9e',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }));
      await expect(h.replace()).resolves.toMatchObject({ applied: false });
      expect(h.db.select().from(connectorManagedAuthorityOutbox).get()).toMatchObject({
        state: 'pending',
        rejectionCode: null,
      });
    });

    it('tries a refused change again when the link kept its key (DOR-2620)', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      h.cloud.isLinked = () => true;
      await h.replace();
      expect(h.db.select().from(connectorManagedAuthorityOutbox).get()).toMatchObject({
        state: 'pending',
        rejectionCode: null,
        nextAttemptAt: expect.any(String),
        safeReason: 'DorkOS’s servers turned the request down.',
      });
    });

    it('sends a change the old link refused again once the account is linked again', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      const sync = h.service();
      await h.replace(sync);
      expect(r.grants()).toEqual([
        { operationRevisionId: 'revision-send', revokedAt: expect.any(String) },
      ]);

      // Linked again: the instance's setup moves on, and the hosted side answers.
      h.db
        .update(connectorProviderInstances)
        .set({ executionConfigGeneration: 2 })
        .where(eq(connectorProviderInstances.id, PROVIDER_ID))
        .run();
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return statusFor(command);
      });
      await expect(
        sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal)
      ).resolves.toBe(1);

      expect(h.submitted.at(-1)).toMatchObject({
        kind: 'replace_agent_grants',
        agentId: 'agent-a',
        scopeVersion: 2,
        revisions: [expect.objectContaining({ operationSlug: 'gmail.send' })],
      });
      // The access the owner gave now works.
      expect(r.grants()).toEqual([{ operationRevisionId: 'revision-send', revokedAt: null }]);
      // Nothing is left to send again.
      await expect(
        sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal)
      ).resolves.toBe(0);
    });

    it('never sends a change refused for another reason just because of a relink', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        r.rejected(command, 'scope_conflict')
      );
      const sync = h.service();
      await h.replace(sync);
      await expect(
        sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal)
      ).resolves.toBe(0);
    });

    it('settles a refused change with exactly the access the owner was shown, never the refused one', async () => {
      // The owner gave agent-a Send; the hosted side refused. The review shows
      // agent-a with nothing (the refused grant never opened).
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return r.rejected(command, 'scope_conflict');
      });
      const sync = h.service();
      await h.replace(sync);
      const [commandId] = h.db.transaction((tx) =>
        sync.restageRefused(tx, { connectionId: CONNECTION_ID, why: 'confirmed' })
      );
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return statusFor(command);
      });
      await sync.deliverAgentGrantReplacement(commandId!, new AbortController().signal);
      // Confirming "nothing" sends nothing: the refused Send is not granted.
      expect(h.submitted.at(-1)).toMatchObject({ kind: 'replace_agent_grants', revisions: [] });
      expect(r.grants().every((grant) => grant.revokedAt !== null)).toBe(true);
    });

    it('closes an account whose connection the hosted side no longer has, with its end unconfirmed', async () => {
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        r.rejected(command, 'connection_unavailable')
      );
      const sync = h.service();
      await h.replace(sync);
      expect(h.db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'disconnected',
        enabled: false,
        closedBecause: 'service_gone',
        // Never "nothing owed": whether the sign-in lives on isn't known.
        externalCleanupState: 'unknown',
      });
      expect(r.grants().every((grant) => grant.revokedAt !== null)).toBe(true);
      // Never sent again, even when the owner confirms.
      expect(
        h.db.transaction((tx) =>
          sync.restageRefused(tx, { connectionId: CONNECTION_ID, why: 'confirmed' })
        )
      ).toEqual([]);
    });

    it('never closes an account because a resume was refused: it asks for a sign-in instead', async () => {
      h.db
        .update(connections)
        .set({ enabled: false, pausedBy: 'owner' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        r.rejected(command, 'connection_unavailable')
      );
      await h.service().transition(lifecycleChange('active'));
      expect(h.db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'connected',
        enabled: false,
        closedBecause: null,
        status: 'expired',
      });
    });

    it('ends the Resume, Sign in again loop: a resume refused again after a sign-in closes it as gone', async () => {
      h.db
        .update(connections)
        .set({ enabled: false, pausedBy: 'owner' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        r.rejected(command, 'connection_unavailable')
      );
      const resume = () => h.service().transition(lifecycleChange('active'));
      await resume();
      expect(h.db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'connected',
        status: 'expired',
      });
      // The person signs in again; the account reads signed in once more.
      h.db
        .update(connections)
        .set({ status: 'active' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      h.clock += 60_000;
      await resume();
      // Signing in can't fix it: gone, with "connect it again" and its end unconfirmed.
      expect(h.db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'disconnected',
        closedBecause: 'service_gone',
        externalCleanupState: 'unknown',
      });
    });

    it('never closes a healthy account on its first refusal after an earlier resume applied', async () => {
      h.db
        .update(connections)
        .set({ enabled: false, pausedBy: 'owner' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      let refuse = true;
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) =>
        refuse ? r.rejected(command, 'connection_unavailable') : statusFor(command)
      );
      const lifecycle = (to: 'active' | 'paused') =>
        h.service().transition({
          connectionId: CONNECTION_ID,
          managedConnectionId: MANAGED_CONNECTION_ID,
          lifecycle: to,
          providerInstanceId: PROVIDER_ID,
          executionConfigGeneration: 1,
          owner: OWNER,
          signal: new AbortController().signal,
        });
      // Refused once; the person signs in again; the next resume applies.
      await lifecycle('active');
      h.db
        .update(connections)
        .set({ status: 'active' })
        .where(eq(connections.id, CONNECTION_ID))
        .run();
      refuse = false;
      h.clock += 60_000;
      await lifecycle('active');
      expect(h.db.select().from(connections).get()).toMatchObject({ enabled: true });
      // Weeks later: paused, then one refused resume. Signing in may fix it.
      h.clock += 21 * 24 * 60 * 60_000;
      await lifecycle('paused');
      refuse = true;
      await lifecycle('active');
      expect(h.db.select().from(connections).get()).toMatchObject({
        lifecycleState: 'connected',
        status: 'expired',
        closedBecause: null,
      });
    });

    it('finishes a disconnect the ended link refused even after the account was removed', async () => {
      // The live incident: the link ended, Disconnect was refused, the person
      // removed the app, then linked the same DorkOS account again.
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async () => {
        throw cloudError('unauthorized');
      });
      const sync = h.service();
      const lifecycle = new ConnectorLifecycleService({
        db: h.db,
        registry: h.registry,
        authenticationFlows: new ConnectorAuthenticationFlowService({
          db: h.db,
          registry: h.registry,
        }),
        authorityCleanup: {
          revokeConnection: vi.fn(),
          revokeAgent: vi.fn(),
          revokeAgentConnection: vi.fn(),
        },
        managed: sync,
      });
      await lifecycle.disconnect(OWNER, CONNECTION_ID, new AbortController().signal);
      lifecycle.remove(OWNER, CONNECTION_ID);
      expect(h.db.select().from(connections).get()).toMatchObject({
        removedAt: expect.any(String),
        externalCleanupState: 'pending',
      });

      h.db
        .update(connectorProviderInstances)
        .set({ executionConfigGeneration: 2 })
        .where(eq(connectorProviderInstances.id, PROVIDER_ID))
        .run();
      h.cloud.submitConnectorAuthorityCommand = vi.fn(async (command) => {
        h.submitted.push(command);
        return {
          ...statusFor(command),
          externalCleanup: 'complete',
        } as ManagedConnectorAuthorityCommandStatus;
      });
      await expect(
        sync.restageAfterRelink(PROVIDER_ID, new AbortController().signal)
      ).resolves.toBe(1);
      expect(h.submitted.at(-1)).toMatchObject({
        kind: 'set_connection_lifecycle',
        lifecycle: 'disconnected',
      });
      expect(h.db.select().from(connections).get()?.externalCleanupState).toBe('complete');
    });
  });
});
