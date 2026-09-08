import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  runMigrations,
  connectorProviderInstances,
  connections,
  type Db,
} from '@dorkos/db';
import type { ConnectorEventDefinition } from '@dorkos/shared/connector-event-schemas';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import type { ConnectorEventCapability } from '@dorkos/shared/connector-events';
import { ConnectionStore } from '../../connection-store.js';
import { ConnectorSubscriptionStore } from '../subscription-store.js';
import { ConnectorSubscriptionService } from '../subscription-service.js';
import { ConnectorEventGrantService } from '../grant-service.js';

const now = '2026-09-07T12:00:00.000Z';
const owner = { kind: 'local_install', installationId: 'owner-install' } as const;
const definition: ConnectorEventDefinition = {
  eventType: 'GMAIL_NEW_MESSAGE',
  displayName: 'New message',
  toolkit: 'gmail',
  toolkitVersion: '20260901',
  definitionHash: `sha256:${'a'.repeat(64)}`,
  filterSchema: {
    type: 'object',
    properties: { label: { type: 'string' } },
    additionalProperties: false,
  },
  payloadSchema: { type: 'object' },
  deliveryMode: 'polling',
  expectedCadenceSeconds: null,
};
const disposers: Array<() => void> = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dork-event-consent-'));
  const db = createDb(join(dir, 'db.sqlite'));
  runMigrations(db);
  const accounts = new ConnectionStore({ db });
  disposers.push(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.insert(connectorProviderInstances)
    .values({
      id: 'provider-one',
      type: 'test',
      mode: 'byo',
      displayName: 'Test',
      custody: 'self-host',
      capabilityJson: '{}',
      status: 'available',
      ownerKind: owner.kind,
      ownerId: owner.installationId,
      executionConfigGeneration: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(connections)
    .values({
      id: 'account-one',
      providerInstanceId: 'provider-one',
      externalAccountRef: 'private-account',
      toolkit: 'gmail',
      label: 'work',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const store = new ConnectorSubscriptionStore(db);
  const discovered = store.discover(store.connection(owner, 'account-one'), [definition], now)[0];
  const trigger = {
    providerTriggerRef: 'trigger-shared',
    providerTriggerUuid: 'trigger-uuid',
    externalAccountRef: 'private-account',
    externalAccountUuid: 'account-uuid',
    enabled: true,
  };
  const events: ConnectorEventCapability = {
    listDefinitions: vi.fn<ConnectorEventCapability['listDefinitions']>(async () => ({
      status: 'ok',
      definitions: [definition],
    })),
    reconcileTrigger: vi.fn<ConnectorEventCapability['reconcileTrigger']>(async () => ({
      status: 'found',
      trigger,
    })),
    createTrigger: vi.fn<ConnectorEventCapability['createTrigger']>(async (input) =>
      (await input.authorizeDispatch())
        ? { status: 'ready', providerTriggerRef: trigger.providerTriggerRef, ownership: 'unproven' }
        : { status: 'denied', code: 'AUTHORITY_CHANGED' }
    ),
    setTriggerEnabled: vi.fn<ConnectorEventCapability['setTriggerEnabled']>(async (input) =>
      (await input.authorizeDispatch())
        ? { status: 'ok' }
        : { status: 'denied', code: 'AUTHORITY_CHANGED' }
    ),
    deleteTrigger: vi.fn<ConnectorEventCapability['deleteTrigger']>(async (input) =>
      (await input.authorizeDispatch())
        ? { status: 'ok' }
        : { status: 'denied', code: 'AUTHORITY_CHANGED' }
    ),
    verifyWebhook: vi.fn<ConnectorEventCapability['verifyWebhook']>(async () => ({
      status: 'rejected',
      code: 'not_used',
    })),
  };
  const registry = { resolveProviderInstance: () => ({ events }) as ConnectorProvider };
  const policy = {
    authorize: vi.fn<
      import('../subscription-service.js').ConnectorEventDestinationPolicy['authorize']
    >(() => true),
  };
  const service = new ConnectorSubscriptionService(store, registry, policy, () => now);
  const request = {
    connectionId: 'account-one' as never,
    definitionId: discovered.id,
    filter: { label: 'work' },
    agentId: 'agent-one',
    destination: { kind: 'room' as const, id: 'room-one' },
  };
  return { db, accounts, store, service, request, events, trigger, policy, registry };
}
function row(db: Db, id: string) {
  return db.$client
    .prepare('SELECT * FROM connector_event_subscriptions WHERE id = ?')
    .get(id) as Record<string, unknown>;
}
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

describe('explicit event receive authority', () => {
  it('shares borrowed upstream resources without modifying or deleting them', async () => {
    const f = fixture();
    const a = await f.service.create(owner, f.request, new AbortController().signal);
    const b = await f.service.create(
      owner,
      { ...f.request, destination: { kind: 'room', id: 'room-two' } },
      new AbortController().signal
    );
    expect(a.state).toBe('active');
    expect(b.state).toBe('active');
    expect(row(f.db, a.id).binding_id).toBe(row(f.db, b.id).binding_id);
    await f.service.revoke(owner, a.id, new AbortController().signal);
    expect(f.store.active(a.id)).toBeUndefined();
    expect(f.store.active(b.id)?.subscriptionId).toBe(b.id);
    expect(f.events.deleteTrigger).not.toHaveBeenCalled();
    expect(f.events.createTrigger).not.toHaveBeenCalled();
    expect(f.events.setTriggerEnabled).not.toHaveBeenCalled();
    expect(f.events.reconcileTrigger).toHaveBeenCalledTimes(2);
  });
  it('never re-enables an existing disabled borrowed trigger without explicit review', async () => {
    const f = fixture();
    f.trigger.enabled = false;
    const created = await f.service.create(owner, f.request, new AbortController().signal);
    expect(created.state).toBe('needs_review');
    expect(f.store.active(created.id)).toBeUndefined();
    expect(f.events.reconcileTrigger).toHaveBeenCalledTimes(1);
    expect(f.events.setTriggerEnabled).not.toHaveBeenCalled();
    expect(f.events.createTrigger).not.toHaveBeenCalled();
  });
  it('deletes an explicitly managed trigger only after the last logical subscriber revokes', async () => {
    const f = fixture();
    const a = await f.service.create(owner, f.request, new AbortController().signal, true);
    const b = await f.service.create(
      owner,
      { ...f.request, destination: { kind: 'room', id: 'room-two' } },
      new AbortController().signal
    );
    await f.service.revoke(owner, a.id, new AbortController().signal);
    expect(f.events.deleteTrigger).not.toHaveBeenCalled();
    await f.service.revoke(owner, b.id, new AbortController().signal);
    expect(f.events.deleteTrigger).toHaveBeenCalledTimes(1);
  });
  it('reconciles an unknown cleanup to an absent receipt without repeating deletion', async () => {
    const f = fixture();
    const a = await f.service.create(owner, f.request, new AbortController().signal, true);
    vi.mocked(f.events.deleteTrigger).mockResolvedValue({
      status: 'outcome_unknown',
      code: 'PROVIDER_OUTCOME_UNKNOWN',
    });
    await f.service.revoke(owner, a.id, new AbortController().signal);
    expect(f.events.deleteTrigger).toHaveBeenCalledTimes(1);
    vi.mocked(f.events.reconcileTrigger).mockResolvedValue({ status: 'absent' });
    await f.service.recoverCleanup(new AbortController().signal);
    expect(f.events.deleteTrigger).toHaveBeenCalledTimes(1);
    expect(f.db.$client.prepare('SELECT state FROM connector_event_bindings').get()).toEqual({
      state: 'retired',
    });
    await f.service.recoverCleanup(new AbortController().signal);
    expect(f.events.deleteTrigger).toHaveBeenCalledTimes(1);
  });
  it('refuses cleanup when readback names a different trigger or remains ambiguous', async () => {
    const f = fixture();
    const a = await f.service.create(owner, f.request, new AbortController().signal, true);
    vi.mocked(f.events.reconcileTrigger).mockResolvedValue({
      status: 'found',
      trigger: { ...f.trigger, providerTriggerRef: 'another-trigger' },
    });
    await f.service.revoke(owner, a.id, new AbortController().signal);
    expect(f.events.deleteTrigger).not.toHaveBeenCalled();
    vi.mocked(f.events.reconcileTrigger).mockResolvedValue({ status: 'ambiguous' });
    await f.service.recoverCleanup(new AbortController().signal);
    expect(f.events.deleteTrigger).not.toHaveBeenCalled();
    expect(f.store.active(a.id)).toBeUndefined();
  });
  it.each(['paused', 'disconnected'] as const)(
    'revokes an owned %s account without requiring provider availability',
    async (lifecycle) => {
      const f = fixture();
      const a = await f.service.create(owner, f.request, new AbortController().signal);
      f.db.$client
        .prepare('UPDATE connections SET enabled = 0, lifecycle_state = ?')
        .run(lifecycle === 'paused' ? 'connected' : 'disconnected');
      f.db.$client.prepare("UPDATE connector_provider_instances SET status = 'unavailable'").run();
      await f.service.revoke(owner, a.id, new AbortController().signal);
      expect(row(f.db, a.id)).toMatchObject({ enabled: 0, revoked_at: now, scope_version: 2 });
    }
  );
  it('rejects cross-owner requests before modifying any subscription', async () => {
    const f = fixture();
    const a = await f.service.create(owner, f.request, new AbortController().signal);
    await expect(
      f.service.revoke(
        { kind: 'local_install', installationId: 'another-owner' },
        a.id,
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(f.store.active(a.id)?.subscriptionId).toBe(a.id);
  });
  it('invalidates prior consent on definition changes and never resurrects A-B-A grants', async () => {
    const f = fixture();
    const a = await f.service.create(owner, f.request, new AbortController().signal);
    const connection = f.store.connection(owner, 'account-one');
    f.store.discover(
      connection,
      [{ ...definition, definitionHash: `sha256:${'b'.repeat(64)}` }],
      now
    );
    const reverted = f.store.discover(connection, [definition], now)[0];
    expect(reverted.id).not.toBe(f.request.definitionId);
    expect(f.store.active(a.id)).toBeUndefined();
    expect(row(f.db, a.id).revoked_at).toBe(now);
  });
  it('keeps a missing prior unknown mutation pending rather than blindly creating again', async () => {
    const f = fixture();
    const proposed = f.store.propose(owner, f.request, now);
    f.db.$client
      .prepare("UPDATE connector_event_bindings SET state = 'outcome_unknown' WHERE id = ?")
      .run(proposed.bindingId);
    vi.mocked(f.events.reconcileTrigger).mockResolvedValue({ status: 'absent' });
    const result = await f.service.create(owner, f.request, new AbortController().signal);
    expect(result.state).toBe('pending');
    expect(f.events.createTrigger).not.toHaveBeenCalled();
    expect(f.events.reconcileTrigger).toHaveBeenCalledTimes(1);
  });
  it('closes authorization if the destination disappears while provider reconciliation awaits', async () => {
    const f = fixture();
    vi.mocked(f.events.reconcileTrigger).mockImplementation(async () => {
      f.policy.authorize.mockReturnValue(false);
      return { status: 'found', trigger: f.trigger };
    });
    const result = await f.service.create(owner, f.request, new AbortController().signal);
    expect(result.state).toBe('pending');
    expect(f.store.active(result.id)).toBeUndefined();
  });
});

describe('durable owner event approval receipts', () => {
  function reviewedFixture() {
    const f = fixture();
    const managed = { reconcile: vi.fn(async () => false), ready: vi.fn(() => false) };
    const grants = new ConnectorEventGrantService(f.store, f.service, f.policy, managed, () => now);
    return {
      ...f,
      grants,
      managed,
      review: { reviewId: 'server-review-one', scopes: [f.request] },
      signal: new AbortController().signal,
    };
  }
  it.each(['connection', 'agent', 'agent_connection'] as const)(
    'actual %s removal cannot be revived by a prior event approval',
    async (kind) => {
      const f = reviewedFixture();
      const prepared = await f.grants.approve(owner, f.review, f.signal);
      if (prepared.state !== 'ready') throw new Error('fixture was not ready');
      const accounts = f.accounts;
      if (kind === 'connection') {
        accounts.revokeConnection(f.request.connectionId);
        f.db.$client.prepare("UPDATE connections SET lifecycle_state = 'connected'").run();
      } else if (kind === 'agent') accounts.removeAgentAccess(f.request.agentId);
      else accounts.removeAgentConnectionAccess(f.request.agentId, f.request.connectionId);
      expect(f.grants.ready(owner, prepared.selections, prepared.appliedEventScopeHash)).toBe(
        false
      );
      expect(await f.grants.approve(owner, f.review, f.signal)).toEqual({
        state: 'unavailable',
        selections: prepared.selections,
      });
      expect(row(f.db, prepared.selections[0]!.subscriptionId)).toMatchObject({
        enabled: 0,
        scope_version: 2,
      });
      expect(f.events.reconcileTrigger).toHaveBeenCalledTimes(1);
    }
  );
  it('rechecks a revoke between preparation and final dispatch in the same transaction', async () => {
    const f = reviewedFixture();
    const prepared = await f.grants.approve(owner, f.review, f.signal);
    if (prepared.state !== 'ready') throw new Error('fixture was not ready');
    expect(f.grants.ready(owner, prepared.selections, prepared.appliedEventScopeHash)).toBe(true);
    const send = vi.fn();
    f.store.revoke(owner, prepared.selections[0]!.subscriptionId, now);
    f.db.transaction(() => {
      if (f.grants.ready(owner, prepared.selections, prepared.appliedEventScopeHash)) send();
    });
    expect(send).not.toHaveBeenCalled();
    expect(f.grants.ready(owner, prepared.selections, prepared.appliedEventScopeHash)).toBe(false);
    expect(f.events.reconcileTrigger).toHaveBeenCalledTimes(1);
  });
  it('requires a complete same-owner persisted selection set and exact aggregate hash', async () => {
    const f = reviewedFixture();
    const prepared = await f.grants.approve(
      owner,
      {
        ...f.review,
        scopes: [f.request, { ...f.request, destination: { kind: 'room', id: 'second' } }],
      },
      f.signal
    );
    if (prepared.state !== 'ready') throw new Error('fixture was not ready');
    expect(
      f.grants.ready(owner, [...prepared.selections].reverse(), prepared.appliedEventScopeHash)
    ).toBe(true);
    expect(
      f.grants.ready(owner, prepared.selections.slice(0, 1), prepared.appliedEventScopeHash)
    ).toBe(false);
    expect(
      f.grants.ready(
        owner,
        [prepared.selections[0]!, prepared.selections[0]!],
        prepared.appliedEventScopeHash
      )
    ).toBe(false);
    expect(f.grants.ready(owner, prepared.selections, '0'.repeat(64))).toBe(false);
    expect(
      f.grants.ready(
        { kind: 'local_install', installationId: 'other' },
        prepared.selections,
        prepared.appliedEventScopeHash
      )
    ).toBe(false);
    f.db.$client.prepare('DELETE FROM connector_event_consent_commands').run();
    expect(f.grants.ready(owner, prepared.selections, prepared.appliedEventScopeHash)).toBe(false);
  });
  it('invalidates final readiness when the stored destination or owner changes', async () => {
    const f = reviewedFixture();
    const prepared = await f.grants.approve(owner, f.review, f.signal);
    if (prepared.state !== 'ready') throw new Error('fixture was not ready');
    f.db.$client
      .prepare("UPDATE connector_event_subscriptions SET destination_id = 'other-room'")
      .run();
    expect(f.grants.ready(owner, prepared.selections, prepared.appliedEventScopeHash)).toBe(false);
    f.db.$client
      .prepare('UPDATE connector_event_subscriptions SET destination_id = ?')
      .run(f.request.destination.id);
    expect(f.grants.ready(owner, prepared.selections, prepared.appliedEventScopeHash)).toBe(true);
    f.db.$client
      .prepare("UPDATE connector_provider_instances SET owner_id = 'replacement-owner'")
      .run();
    expect(f.grants.ready(owner, prepared.selections, prepared.appliedEventScopeHash)).toBe(false);
  });
  it('invalidates final readiness across a definition A-B-A transition', async () => {
    const f = reviewedFixture();
    const prepared = await f.grants.approve(owner, f.review, f.signal);
    if (prepared.state !== 'ready') throw new Error('fixture was not ready');
    const connection = f.store.connection(owner, 'account-one');
    f.store.discover(
      connection,
      [{ ...definition, definitionHash: `sha256:${'b'.repeat(64)}` }],
      now
    );
    f.store.discover(connection, [definition], now);
    expect(f.grants.ready(owner, prepared.selections, prepared.appliedEventScopeHash)).toBe(false);
  });
  it('derives proposed event slugs from the owned current immutable definition without writing consent', () => {
    const f = reviewedFixture();
    expect(f.grants.describe(owner, [f.request])).toEqual([
      { definitionId: f.request.definitionId, eventType: definition.eventType },
    ]);
    expect(
      f.db.$client.prepare('SELECT count(*) AS n FROM connector_event_subscriptions').get()
    ).toEqual({ n: 0 });
    expect(() =>
      f.grants.describe({ kind: 'local_install', installationId: 'other' }, [f.request])
    ).toThrow();
  });
  it('recovers durable owner approval after transient unavailability and service reconstruction', async () => {
    const f = reviewedFixture();
    vi.mocked(f.events.reconcileTrigger).mockResolvedValueOnce({
      status: 'unavailable',
    });
    const result = await f.grants.approve(owner, f.review, f.signal);
    expect(result.state).toBe('pending');
    const restarted = new ConnectorEventGrantService(
      new ConnectorSubscriptionStore(f.db),
      f.service,
      f.policy,
      f.managed,
      () => now
    );
    await restarted.recoverPending(f.signal, 1);
    expect(f.store.active(result.selections[0]!.subscriptionId)).toBeDefined();
    expect(
      f.db.$client.prepare('SELECT count(*) AS n FROM connector_event_consent_commands').get()
    ).toEqual({ n: 1 });
  });

  it.each([false, true])(
    'recovery preserves the original upstream management consent: %s',
    async (manageExistingTriggers) => {
      const f = reviewedFixture();
      f.trigger.enabled = false;
      vi.mocked(f.events.reconcileTrigger).mockResolvedValueOnce({
        status: 'unavailable',
      });
      const result = await f.grants.approve(
        owner,
        { ...f.review, manageExistingTriggers },
        f.signal
      );
      expect(result.state).toBe('pending');
      vi.mocked(f.events.setTriggerEnabled).mockImplementation(async (input) => {
        if (!(await input.authorizeDispatch()))
          return { status: 'denied', code: 'AUTHORITY_CHANGED' };
        f.trigger.enabled = true;
        return { status: 'ok' };
      });
      const restarted = new ConnectorEventGrantService(
        new ConnectorSubscriptionStore(f.db),
        new ConnectorSubscriptionService(f.store, f.registry, f.policy, () => now),
        f.policy,
        f.managed,
        () => now
      );
      await restarted.recoverPending(f.signal, 1);
      expect(f.events.setTriggerEnabled).toHaveBeenCalledTimes(manageExistingTriggers ? 1 : 0);
      expect(Boolean(f.store.active(result.selections[0]!.subscriptionId))).toBe(
        manageExistingTriggers
      );
      expect(f.events.createTrigger).not.toHaveBeenCalled();
    }
  );

  it.each(['missing', 'changed'] as const)(
    'does not infer management consent from a %s stored decision',
    async (change) => {
      const f = reviewedFixture();
      vi.mocked(f.events.reconcileTrigger).mockResolvedValueOnce({
        status: 'unavailable',
      });
      await f.grants.approve(owner, f.review, f.signal);
      const stored = f.db.$client
        .prepare('SELECT selections_json FROM connector_event_consent_commands')
        .get() as { selections_json: string };
      const entries = JSON.parse(stored.selections_json);
      if (change === 'missing') delete entries[0].manageExistingTriggers;
      else entries[0].manageExistingTriggers = true;
      f.db.$client
        .prepare('UPDATE connector_event_consent_commands SET selections_json = ?')
        .run(JSON.stringify(entries));
      vi.mocked(f.events.reconcileTrigger).mockClear();
      await f.grants.recoverPending(f.signal, 1);
      expect(f.events.reconcileTrigger).not.toHaveBeenCalled();
      expect(f.events.setTriggerEnabled).not.toHaveBeenCalled();
    }
  );

  it.each(['revoked', 'provider', 'destination'] as const)(
    'does not recover stale %s receive authority',
    async (change) => {
      const f = reviewedFixture();
      vi.mocked(f.events.reconcileTrigger).mockResolvedValueOnce({
        status: 'unavailable',
      });
      const result = await f.grants.approve(owner, f.review, f.signal);
      if (change === 'revoked') f.store.revoke(owner, result.selections[0]!.subscriptionId, now);
      if (change === 'provider')
        f.db.$client.exec(
          'UPDATE connector_provider_instances SET execution_config_generation = 2'
        );
      if (change === 'destination') f.policy.authorize.mockReturnValue(false);
      vi.mocked(f.events.reconcileTrigger).mockClear();
      await f.grants.recoverPending(f.signal, 1);
      expect(f.events.reconcileTrigger).not.toHaveBeenCalled();
      expect(f.store.active(result.selections[0]!.subscriptionId)).toBeUndefined();
    }
  );

  it('persists fair bounded retry progress across reconstruction and only retries after the deadline', async () => {
    const f = reviewedFixture();
    vi.mocked(f.events.reconcileTrigger).mockResolvedValue({
      status: 'unavailable',
    });
    const a = await f.grants.approve(owner, { ...f.review, reviewId: 'a-blocked' }, f.signal);
    const b = await f.grants.approve(
      owner,
      {
        ...f.review,
        reviewId: 'b-ready',
        scopes: [{ ...f.request, destination: { kind: 'room', id: 'room-two' } }],
      },
      f.signal
    );
    f.policy.authorize.mockImplementation(
      (_owner, _agentId, destination) => destination.id !== 'room-one'
    );
    vi.mocked(f.events.reconcileTrigger).mockResolvedValue({ status: 'found', trigger: f.trigger });
    expect(await f.grants.recoverPending(f.signal, 1)).toEqual({ examined: 1, ready: 0 });
    const restarted = new ConnectorEventGrantService(
      new ConnectorSubscriptionStore(f.db),
      f.service,
      f.policy,
      f.managed,
      () => now
    );
    expect(await restarted.recoverPending(f.signal, 1)).toEqual({ examined: 1, ready: 1 });
    expect(f.store.active(b.selections[0]!.subscriptionId)).toBeDefined();
    expect(f.store.active(a.selections[0]!.subscriptionId)).toBeUndefined();
    f.policy.authorize.mockReturnValue(true);
    expect(await restarted.recoverPending(f.signal, 1)).toEqual({ examined: 0, ready: 0 });
    const later = new ConnectorEventGrantService(f.store, f.service, f.policy, f.managed, () =>
      new Date(Date.parse(now) + 30_001).toISOString()
    );
    expect(await later.recoverPending(f.signal, 1)).toEqual({ examined: 1, ready: 1 });
    expect(f.store.active(a.selections[0]!.subscriptionId)).toBeDefined();
  });

  it('claims each durable pending review before async reconciliation so concurrent workers do not repeat it', async () => {
    const f = reviewedFixture();
    vi.mocked(f.events.reconcileTrigger).mockResolvedValueOnce({
      status: 'unavailable',
    });
    await f.grants.approve(owner, f.review, f.signal);
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(f.events.reconcileTrigger).mockImplementation(async () => {
      entered();
      await blocked;
      return { status: 'found', trigger: f.trigger };
    });
    const first = f.grants.recoverPending(f.signal, 1);
    await started;
    const other = new ConnectorEventGrantService(
      f.store,
      f.service,
      f.policy,
      f.managed,
      () => now
    );
    expect(await other.recoverPending(f.signal, 1)).toEqual({ examined: 0, ready: 0 });
    release();
    expect(await first).toEqual({ examined: 1, ready: 1 });
    expect(f.events.reconcileTrigger).toHaveBeenCalledTimes(2);
  });

  it('never recreates a review or subscription that disappears during recovery authorization', async () => {
    const f = reviewedFixture();
    vi.mocked(f.events.reconcileTrigger).mockResolvedValueOnce({ status: 'unavailable' });
    const original = await f.grants.approve(owner, f.review, f.signal);
    const prepare = vi.spyOn(f.store, 'prepareReview');
    const propose = vi.spyOn(f.store, 'propose');
    f.policy.authorize.mockImplementationOnce(async () => {
      await Promise.resolve();
      f.db.$client.exec('DELETE FROM connector_event_consent_commands');
      return true;
    });
    vi.mocked(f.events.reconcileTrigger).mockClear();
    expect(await f.grants.recoverPending(f.signal, 1)).toEqual({ examined: 1, ready: 0 });
    expect(prepare).not.toHaveBeenCalled();
    expect(propose).not.toHaveBeenCalled();
    expect(f.events.reconcileTrigger).not.toHaveBeenCalled();
    expect(f.store.active(original.selections[0]!.subscriptionId)).toBeUndefined();
    expect(
      f.db.$client.prepare('SELECT count(*) AS n FROM connector_event_consent_commands').get()
    ).toEqual({ n: 0 });
  });

  it('returns identical reviewed generations and ready hash across retries without another mutation', async () => {
    const f = reviewedFixture();
    const first = await f.grants.approve(owner, f.review, f.signal);
    expect(first.state).toBe('ready');
    const retry = await f.grants.approve(owner, f.review, f.signal);
    expect(retry).toEqual(first);
    expect(row(f.db, first.selections[0].subscriptionId).scope_version).toBe(1);
    expect(f.events.reconcileTrigger).toHaveBeenCalledTimes(1);
    expect(f.managed.reconcile).not.toHaveBeenCalled();
    expect(
      f.db.$client.prepare('SELECT count(*) AS n FROM connector_event_consent_commands').get()
    ).toEqual({ n: 1 });
  });
  it('replaying a reviewed but revoked subscription returns unavailable without reviving receive authority', async () => {
    const f = reviewedFixture();
    const first = await f.grants.approve(owner, f.review, f.signal);
    await f.service.revoke(owner, first.selections[0].subscriptionId, f.signal);
    const retry = await f.grants.approve(owner, f.review, f.signal);
    expect(retry).toEqual({ state: 'unavailable', selections: first.selections });
    expect(row(f.db, first.selections[0].subscriptionId)).toMatchObject({
      enabled: 0,
      scope_version: 2,
      revoked_at: now,
    });
    expect(f.events.reconcileTrigger).toHaveBeenCalledTimes(1);
  });
  it.each(['filter', 'destination', 'management'] as const)(
    'rejects changed %s under the same review identity',
    async (field) => {
      const f = reviewedFixture();
      const first = await f.grants.approve(owner, f.review, f.signal);
      const changed =
        field === 'filter'
          ? { ...f.review, scopes: [{ ...f.request, filter: { label: 'other' } }] }
          : field === 'destination'
            ? {
                ...f.review,
                scopes: [
                  { ...f.request, destination: { kind: 'room' as const, id: 'room-other' } },
                ],
              }
            : { ...f.review, manageExistingTriggers: true };
      await expect(f.grants.approve(owner, changed, f.signal)).rejects.toMatchObject({
        code: 'review_conflict',
      });
      expect(row(f.db, first.selections[0].subscriptionId).scope_version).toBe(1);
      expect(f.events.reconcileTrigger).toHaveBeenCalledTimes(1);
    }
  );
  it('selects several destinations atomically and rejects duplicate receive scopes without partial writes', async () => {
    const f = reviewedFixture();
    await expect(
      f.grants.approve(owner, { ...f.review, scopes: [f.request, f.request] }, f.signal)
    ).rejects.toMatchObject({ code: 'review_conflict' });
    expect(
      f.db.$client.prepare('SELECT count(*) AS n FROM connector_event_subscriptions').get()
    ).toEqual({ n: 0 });
    expect(
      f.db.$client.prepare('SELECT count(*) AS n FROM connector_event_consent_commands').get()
    ).toEqual({ n: 0 });
    expect(f.events.reconcileTrigger).not.toHaveBeenCalled();
  });
  it('a definition transition invalidates old review replay even if metadata later returns to its old value', async () => {
    const f = reviewedFixture();
    const first = await f.grants.approve(owner, f.review, f.signal);
    const connection = f.store.connection(owner, 'account-one');
    f.store.discover(
      connection,
      [{ ...definition, definitionHash: `sha256:${'b'.repeat(64)}` }],
      now
    );
    f.store.discover(connection, [definition], now);
    expect(await f.grants.approve(owner, f.review, f.signal)).toEqual({
      state: 'unavailable',
      selections: first.selections,
    });
    expect(f.events.reconcileTrigger).toHaveBeenCalledTimes(1);
  });
});

describe('owner notification projections', () => {
  it('returns only safe metadata and keeps revoked history visible beneath its owner', async () => {
    const f = fixture();
    const created = await f.service.create(owner, f.request, new AbortController().signal);
    const projected = f.store.get(owner, f.request.connectionId, created.id);
    expect(projected).toMatchObject({
      id: created.id,
      state: 'active',
      eventType: definition.eventType,
      deliveryMode: 'polling',
      expectedCadenceSeconds: null,
    });
    expect(JSON.stringify(projected)).not.toContain('trigger-one');
    expect(Object.keys(projected)).not.toEqual(
      expect.arrayContaining([
        'bindingId',
        'externalAccountRef',
        'providerDefinitionRef',
        'content',
      ])
    );
    await f.service.revoke(owner, created.id, new AbortController().signal);
    const revoked = f.store.get(owner, f.request.connectionId, created.id);
    await f.service.revoke(owner, created.id, new AbortController().signal);
    expect(f.store.get(owner, f.request.connectionId, created.id)).toEqual(revoked);
    expect(f.store.list(owner, f.request.connectionId).subscriptions[0]?.state).toBe('revoked');
    expect(() =>
      f.store.list({ kind: 'local_install', installationId: 'other' }, f.request.connectionId)
    ).toThrow();
    expect(() => f.store.get(owner, 'different-account', created.id)).toThrow();
  });
  it('pages all subscriptions without exposing private rows or skipping the last page', () => {
    const f = fixture();
    for (let i = 0; i < 101; i++)
      f.store.propose(owner, { ...f.request, destination: { kind: 'room', id: `room-${i}` } }, now);
    const first = f.store.list(owner, f.request.connectionId);
    expect(first.subscriptions).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    const last = f.store.list(owner, f.request.connectionId, first.nextCursor);
    expect(last.subscriptions).toHaveLength(1);
    expect(last.nextCursor).toBeUndefined();
    expect(new Set([...first.subscriptions, ...last.subscriptions].map((row) => row.id)).size).toBe(
      101
    );
  });
  it('reports paused and superseded receive authority as unavailable', async () => {
    const f = fixture();
    const created = await f.service.create(owner, f.request, new AbortController().signal);
    f.db.$client.prepare('UPDATE connections SET enabled = 0').run();
    expect(f.store.get(owner, f.request.connectionId, created.id).state).toBe('unavailable');
  });
});
