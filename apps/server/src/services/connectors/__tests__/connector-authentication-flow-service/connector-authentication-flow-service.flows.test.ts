import { describe, expect, it, vi } from 'vitest';
import {
  connectorAuthenticationFlows,
  connectorOperationRevisions,
  connectionOperationGrants,
  connections,
  eq,
} from '@dorkos/db';
import { SIGN_IN_COPY } from '@dorkos/shared/connector-schemas';
import {
  ConnectorAuthenticationFlowError,
  ConnectorAuthenticationFlowService,
} from '../../resources/authentication-flow-service.js';
import { ConnectorRegistry } from '../../registry.js';
import {
  OWNER,
  FOREIGN_OWNER,
  PROVIDER_ID,
  NOW,
  RestartSafeProvider,
  insertActiveConnection,
  useAuthenticationFlowHarness,
  lifecycleFor,
  GMAIL_START,
} from './connector-authentication-flow-service.fixtures.js';

/** Starting and polling a sign-in: idempotency, restarts, refusals and cleanup fences. */
describe('ConnectorAuthenticationFlowService', () => {
  const h = useAuthenticationFlowHarness();

  it('claims idempotency before provider create and returns the same durable flow', async () => {
    const start = vi.spyOn(h.provider, 'startConnect');
    const input = { ...GMAIL_START, label: 'Work', idempotencyKey: 'connect-work-gmail' };
    const first = await h.service.start(OWNER, input);
    const repeated = await h.service.start(OWNER, input);

    expect(first).toEqual(repeated);
    expect(first).toMatchObject({ state: 'pending', providerInstanceId: PROVIDER_ID });
    expect(start).toHaveBeenCalledTimes(1);
    await expect(h.service.start(OWNER, { ...input, toolkit: 'slack' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    } satisfies Partial<ConnectorAuthenticationFlowError>);
  });

  it('reads an owner-bound durable status by id or idempotency claim without polling the provider', async () => {
    const poll = vi.spyOn(h.provider, 'pollConnect');
    const started = await h.service.start(OWNER, {
      ...GMAIL_START,
      idempotencyKey: 'owner-status',
    });

    expect(h.service.status(OWNER, started.flowId)).toEqual(started);
    expect(h.service.findByIdempotencyKey(OWNER, 'owner-status')).toEqual(started);
    expect(h.service.findByIdempotencyKey(OWNER, 'absent')).toBeUndefined();
    expect(() => h.service.status(FOREIGN_OWNER, started.flowId)).toThrowError(
      expect.objectContaining({ code: 'flow_not_found' })
    );
    expect(poll).not.toHaveBeenCalled();
  });

  it('polls the private provider handle after a server restart and stores a stable connection', async () => {
    const started = await h.service.start(OWNER, {
      ...GMAIL_START,
      label: 'Work',
      idempotencyKey: 'restart-safe',
    });

    const restartedRegistry = new ConnectorRegistry({
      db: h.db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    restartedRegistry.register(new RestartSafeProvider({ instanceId: PROVIDER_ID }), 'material-a');
    const restarted = new ConnectorAuthenticationFlowService({
      db: h.db,
      registry: restartedRegistry,
      now: () => NOW,
    });
    const completed = await restarted.poll(OWNER, started.flowId);

    expect(completed).toMatchObject({ state: 'connected', connectionId: expect.any(String) });
    expect(h.db.select().from(connections).all()).toHaveLength(1);
    expect(h.db.select().from(connectorAuthenticationFlows).get()).toMatchObject({
      providerFlowId: null,
      authorizeUrl: null,
      state: 'connected',
    });
    await expect(restarted.poll(FOREIGN_OWNER, started.flowId)).rejects.toMatchObject({
      code: 'flow_not_found',
    });
  });

  it('fails a pending authentication flow when the provider deployment mode changes', async () => {
    const started = await h.service.start(OWNER, { ...GMAIL_START, idempotencyKey: 'mode-change' });

    h.registry.register(h.provider, 'material-a', 'managed');

    expect(h.service.status(OWNER, started.flowId)).toMatchObject({
      state: 'failed',
      reason: SIGN_IN_COPY.wayChanged,
    });
  });

  it('never replays a provider create whose outcome was ambiguous', async () => {
    const start = vi
      .spyOn(h.provider, 'startConnect')
      .mockRejectedValue(new Error('socket closed'));
    const input = { ...GMAIL_START, idempotencyKey: 'ambiguous-start' };
    const first = await h.service.start(OWNER, input);
    const repeated = await h.service.start(OWNER, input);

    expect(first).toMatchObject({ state: 'start_unknown' });
    expect(repeated).toEqual(first);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('invalidates only interrupted start claims during boot recovery', () => {
    h.db
      .insert(connectorAuthenticationFlows)
      .values({
        id: 'starting-flow',
        ownerKind: OWNER.kind,
        ownerId: OWNER.installationId,
        idempotencyKey: 'starting',
        requestHash: 'hash-starting',
        providerInstanceId: PROVIDER_ID,
        executionConfigGeneration: 1,
        providerFlowId: null,
        toolkit: 'gmail',
        state: 'starting',
        createdAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        updatedAt: NOW.toISOString(),
      })
      .run();
    expect(h.service.invalidateInterruptedStarts()).toBe(1);
    expect(
      h.db
        .select()
        .from(connectorAuthenticationFlows)
        .where(eq(connectorAuthenticationFlows.id, 'starting-flow'))
        .get()
    ).toMatchObject({ state: 'start_unknown', providerFlowId: null });
  });

  it('starts disconnected-account sign-in once without reopening local authority', async () => {
    const existing = insertActiveConnection(h.db);
    h.registry.recordDisconnect(existing);
    h.db
      .update(connections)
      .set({ externalCleanupState: 'complete' })
      .where(eq(connections.id, existing))
      .run();
    const start = vi.spyOn(h.provider, 'startConnect');

    const pending = await h.service.reconnect(OWNER, existing, 'disconnected-reconnect');
    expect(pending.state).toBe('pending');
    expect(h.registry.accountBinding(existing)?.status).toBe('revoked');
    await expect(h.service.reconnect(OWNER, existing, 'disconnected-reconnect')).resolves.toEqual(
      pending
    );
    expect(start).toHaveBeenCalledTimes(1);
    await expect(
      h.service.reconnect(FOREIGN_OWNER, existing, 'foreign-reconnect')
    ).rejects.toMatchObject({
      code: 'connection_not_found',
    });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('reconnects a different returned identity without reviving the disconnected account or grants', async () => {
    const existing = insertActiveConnection(h.db);
    h.db
      .insert(connectorOperationRevisions)
      .values({
        id: 'read-v1',
        providerInstanceId: PROVIDER_ID,
        toolkit: 'gmail',
        operationSlug: 'GMAIL_FETCH_EMAILS',
        toolkitVersion: 'v1',
        schemaHash: 'read-schema',
        capabilityClassification: 'read',
        retryPolicy: 'never',
        inputSchemaJson: '{"type":"object"}',
        discoveredAt: NOW.toISOString(),
      })
      .run();
    h.db
      .insert(connectionOperationGrants)
      .values({
        id: 'old-grant',
        subjectType: 'agent',
        subjectId: 'agent-a',
        agentId: 'agent-a',
        connectionId: existing,
        operationRevisionId: 'read-v1',
        createdBy: 'owner',
        createdAt: NOW.toISOString(),
      })
      .run();
    h.registry.recordDisconnect(existing);
    h.db
      .update(connections)
      .set({ externalCleanupState: 'complete', cleanupGeneration: 1 })
      .where(eq(connections.id, existing))
      .run();
    vi.spyOn(h.provider, 'pollConnect').mockResolvedValue({
      status: 'connected',
      account: {
        externalAccountRef: 'external:gmail:Different' as never,
        toolkit: 'gmail',
        label: 'Different',
        status: 'active',
        custody: 'managed',
      },
    });

    const started = await h.service.reconnect(OWNER, existing, 'reconnect-with-different-account');
    const completed = await h.service.poll(OWNER, started.flowId);
    expect(completed).toMatchObject({ state: 'connected' });
    expect(completed.state === 'connected' && completed.connectionId).not.toBe(existing);
    expect(
      h.db.select().from(connections).where(eq(connections.id, existing)).get()?.lifecycleState
    ).toBe('disconnected');
    expect(h.db.select().from(connectionOperationGrants).all()).toEqual([
      expect.objectContaining({
        id: 'old-grant',
        connectionId: existing,
        revokedAt: expect.any(String),
      }),
    ]);
  });

  it('refuses unknown cleanup before provider dispatch and fences a later cleanup generation', async () => {
    const existing = insertActiveConnection(h.db);
    h.registry.recordDisconnect(existing);
    h.db
      .update(connections)
      .set({ externalCleanupState: 'unknown' })
      .where(eq(connections.id, existing))
      .run();
    const start = vi.spyOn(h.provider, 'startConnect');
    await expect(h.service.reconnect(OWNER, existing, 'unknown-cleanup')).rejects.toMatchObject({
      code: 'connection_cleanup_pending',
    });
    expect(start).not.toHaveBeenCalled();
    h.db
      .update(connections)
      .set({ externalCleanupState: 'complete', cleanupGeneration: 1 })
      .where(eq(connections.id, existing))
      .run();
    const pending = await h.service.reconnect(OWNER, existing, 'after-ack');
    h.db
      .update(connections)
      .set({ cleanupGeneration: 2 })
      .where(eq(connections.id, existing))
      .run();
    expect(await h.service.poll(OWNER, pending.flowId)).toMatchObject({ state: 'failed' });
    expect(h.registry.accountBinding(existing)?.status).toBe('revoked');
  });

  it('never lets a new sign-in cancel a cleanup DorkOS is sending at that moment', async () => {
    const existing = insertActiveConnection(h.db);
    h.db
      .update(connections)
      .set({ accountKey: 'material-a' })
      .where(eq(connections.id, existing))
      .run();
    let release!: () => void;
    const sent = vi.spyOn(h.provider, 'disconnect').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const lifecycle = lifecycleFor(h);
    const disconnecting = lifecycle.disconnect(OWNER, existing, new AbortController().signal);
    await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(1));

    // The same account signs in again while the delete is still out: it could
    // land after the new sign-in and end it, so the sign-in waits.
    const started = await h.service.start(OWNER, {
      ...GMAIL_START,
      label: 'Original',
      idempotencyKey: 'while-sending',
    });
    await expect(h.service.poll(OWNER, started.flowId)).resolves.toMatchObject({
      state: 'failed',
    });
    expect(
      h.db
        .select({ state: connections.externalCleanupState })
        .from(connections)
        .where(eq(connections.id, existing))
        .get()
    ).toEqual({ state: 'pending' });

    release();
    await expect(disconnecting).resolves.toMatchObject({ externalCleanup: 'complete' });
  });
});
