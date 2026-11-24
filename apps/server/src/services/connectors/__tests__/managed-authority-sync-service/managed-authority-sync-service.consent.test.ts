import { describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connectorManagedAuthorityOutbox,
  connectorOperationRevisions,
  eq,
} from '@dorkos/db';
import type { ManagedConnectorAuthorityCommand } from '@dorkos/shared/connector-managed-schemas';
import {
  OWNER,
  PROVIDER_ID,
  CONNECTION_ID,
  MANAGED_CONNECTION_ID,
  START,
  statusFor,
  useManagedAuthoritySyncHarness,
} from './managed-authority-sync-service.fixtures.js';

/** Consent applied only through the exact hosted acknowledgement. */
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

    it('keeps a put-back update off until the hosted side confirms its new generation', async () => {
      const f = h.eventReview();
      const person = await f.grants.approve(OWNER, f.review, f.signal);
      if (person.state !== 'ready') throw new Error('Event was not acknowledged');
      const id = person.selections[0]!.subscriptionId;
      expect(row(id)).toMatchObject({ scope_version: 1, enabled: 1 });
      // Its delivery binding is not ready, so it is on but not live, and a pick
      // takes it over instead of using it.
      h.db.$client.prepare("UPDATE connector_event_bindings SET state = 'pending'").run();
      expect(f.store.active(id, 1)).toBeUndefined();
      await f.grants.approve(OWNER, { ...f.review, reviewId: 'agent-request-review' }, f.signal);
      expect(row(id).scope_version).toBe(2);

      f.grants.withdraw(OWNER, 'agent-request-review', new Date(h.clock).toISOString());
      // On again only once the hosted side has the new generation.
      expect(row(id)).toMatchObject({ scope_version: 3, enabled: 0 });
      expect(f.store.active(id, 3)).toBeUndefined();
      await f.sync.recoverPending(f.signal);
      expect(row(id)).toMatchObject({ scope_version: 3, enabled: 1 });
      expect(f.store.active(id, 3)).toBeDefined();
      expect(latestEventCommand()).toMatchObject({ subscriptionVersion: 3, enabled: true });
    });

    it('puts a stopped update back stopped, and stages that stop at the new generation', async () => {
      const f = h.eventReview();
      const person = await f.grants.approve(OWNER, f.review, f.signal);
      if (person.state !== 'ready') throw new Error('Event was not acknowledged');
      const id = person.selections[0]!.subscriptionId;
      f.store.revoke(OWNER, id, new Date(h.clock).toISOString());
      await f.sync.recoverPending(f.signal);
      expect(row(id)).toMatchObject({ scope_version: 2, enabled: 0 });

      // The pick takes the stopped update over and switches it on at v3.
      const pick = await f.grants.approve(
        OWNER,
        { ...f.review, reviewId: 'agent-request-review' },
        f.signal
      );
      expect(pick.state).toBe('ready');
      expect(row(id)).toMatchObject({ scope_version: 3, enabled: 1, revoked_at: null });

      f.grants.withdraw(OWNER, 'agent-request-review', new Date(h.clock).toISOString());
      expect(row(id)).toMatchObject({ scope_version: 4, enabled: 0 });
      expect(row(id).revoked_at).not.toBeNull();
      await f.sync.recoverPending(f.signal);

      expect(latestEventCommand()).toMatchObject({
        subscriptionId: id,
        subscriptionVersion: 4,
        enabled: false,
      });
      expect(f.store.active(id)).toBeUndefined();
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
});
