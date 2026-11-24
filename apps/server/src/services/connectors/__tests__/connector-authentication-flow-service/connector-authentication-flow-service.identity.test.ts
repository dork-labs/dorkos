import { describe, expect, it, vi } from 'vitest';
import {
  connectorAuthenticationFlows,
  connectionOperationGrants,
  connections,
  eq,
} from '@dorkos/db';
import { SIGN_IN_COPY } from '@dorkos/shared/connector-schemas';
import { type ConnectPoll, type ConnectStart } from '@dorkos/shared/connector-provider';
import { ConnectorAuthenticationFlowService } from '../../resources/authentication-flow-service.js';
import { ConnectorRegistry } from '../../registry.js';
import { FetchComposioHttpClient } from '../../providers/composio-client.js';
import { ComposioConnectorProvider } from '../../providers/composio.js';
import {
  OWNER,
  PROVIDER_ID,
  NOW,
  insertActiveConnection,
  useAuthenticationFlowHarness,
  lifecycleFor,
  GMAIL_START,
} from './connector-authentication-flow-service.fixtures.js';

/** Which identity a sign-in lands on, removal fences, pauses and overlapping polls. */
describe('ConnectorAuthenticationFlowService', () => {
  const h = useAuthenticationFlowHarness();

  it('does not let an earlier initial flow reuse an identity acknowledged after it began', async () => {
    const existing = insertActiveConnection(h.db);
    h.registry.recordDisconnect(existing);
    h.db
      .update(connections)
      .set({ externalCleanupState: 'unknown' })
      .where(eq(connections.id, existing))
      .run();
    const pending = await h.service.start(OWNER, {
      ...GMAIL_START,
      label: 'Original',
      idempotencyKey: 'before-ack',
    });
    h.db
      .update(connections)
      .set({ externalCleanupState: 'complete', cleanupGeneration: 1 })
      .where(eq(connections.id, existing))
      .run();
    expect(await h.service.poll(OWNER, pending.flowId)).toMatchObject({ state: 'failed' });
    expect(h.registry.accountBinding(existing)?.status).toBe('revoked');
  });

  it.each(['start', 'poll'] as const)(
    'fences removal while provider %s is pending, including a different returned identity',
    async (phase) => {
      const existing = insertActiveConnection(h.db);
      h.registry.recordDisconnect(existing);
      h.db
        .update(connections)
        .set({ externalCleanupState: 'complete' })
        .where(eq(connections.id, existing))
        .run();
      const lifecycle = lifecycleFor(h);
      let releaseStart!: (value: ConnectStart) => void;
      let releasePoll!: (value: ConnectPoll) => void;
      if (phase === 'start')
        vi.spyOn(h.provider, 'startConnect').mockReturnValue(
          new Promise((resolve) => {
            releaseStart = resolve;
          })
        );
      else
        vi.spyOn(h.provider, 'pollConnect').mockReturnValue(
          new Promise((resolve) => {
            releasePoll = resolve;
          })
        );
      const starting = h.service.reconnect(OWNER, existing, `remove-during-${phase}`);
      let result: Promise<unknown> = starting;
      if (phase === 'poll') result = h.service.poll(OWNER, (await starting).flowId);
      lifecycle.remove(OWNER, existing);
      if (phase === 'start')
        releaseStart({ flowId: 'held-start', authorizeUrl: 'https://provider.example/authorize' });
      else
        releasePoll({
          status: 'connected',
          account: {
            externalAccountRef: 'different-ref' as never,
            toolkit: 'gmail',
            label: 'Different',
            status: 'active',
            custody: 'managed',
          },
        });
      expect(await result).toMatchObject({ state: 'failed' });
      expect(h.db.select().from(connections).all()).toEqual([
        expect.objectContaining({
          id: existing,
          lifecycleState: 'disconnected',
          removedAt: expect.any(String),
        }),
      ]);
    }
  );

  it('rejects an older initial flow after a newer sign-in has reactivated the same identity', async () => {
    const existing = insertActiveConnection(h.db);
    const old = await h.service.start(OWNER, {
      ...GMAIL_START,
      label: 'Original',
      idempotencyKey: 'old-active-flow',
    });
    h.registry.recordDisconnect(existing);
    h.db
      .update(connections)
      .set({ externalCleanupState: 'complete' })
      .where(eq(connections.id, existing))
      .run();
    const fresh = await h.service.reconnect(OWNER, existing, 'fresh-after-disconnect');
    expect(await h.service.poll(OWNER, fresh.flowId)).toMatchObject({
      state: 'connected',
      connectionId: existing,
    });
    expect(await h.service.poll(OWNER, old.flowId)).toMatchObject({ state: 'failed' });
    expect(h.db.select().from(connections).get()).toMatchObject({
      lifecycleState: 'connected',
      cleanupGeneration: 1,
    });
  });

  it('requires a fresh flow after removal before replacing the same provider identity', async () => {
    const existing = insertActiveConnection(h.db);
    h.registry.recordDisconnect(existing);
    h.db
      .update(connections)
      .set({ externalCleanupState: 'complete' })
      .where(eq(connections.id, existing))
      .run();
    const before = await h.service.start(OWNER, {
      ...GMAIL_START,
      label: 'Original',
      idempotencyKey: 'before-remove',
    });
    const lifecycle = lifecycleFor(h);
    lifecycle.remove(OWNER, existing);
    expect(await h.service.poll(OWNER, before.flowId)).toMatchObject({ state: 'failed' });
    const after = await h.service.start(OWNER, {
      ...GMAIL_START,
      label: 'Original',
      idempotencyKey: 'after-remove',
    });
    const connected = await h.service.poll(OWNER, after.flowId);
    expect(connected).toMatchObject({ state: 'connected' });
    expect(connected.state === 'connected' && connected.connectionId).not.toBe(existing);
    expect(h.db.select().from(connections).all()).toHaveLength(2);
    expect(h.db.select().from(connectionOperationGrants).all()).toEqual([]);
  });

  it('refuses a conflicting reconnect key before pausing the connection', async () => {
    const existing = insertActiveConnection(h.db);
    await h.service.start(OWNER, {
      providerInstanceId: PROVIDER_ID,
      toolkit: 'slack',
      idempotencyKey: 'already-claimed',
    });

    await expect(h.service.reconnect(OWNER, existing, 'already-claimed')).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    expect(h.db.select().from(connections).where(eq(connections.id, existing)).get()?.enabled).toBe(
      true
    );
  });

  it('preserves the first terminal result when two polls overlap', async () => {
    const started = await h.service.start(OWNER, {
      ...GMAIL_START,
      label: 'Work',
      idempotencyKey: 'overlapping-polls',
    });
    let releaseFirst!: (value: ConnectPoll) => void;
    const firstResult = new Promise<ConnectPoll>((resolve) => {
      releaseFirst = resolve;
    });
    vi.spyOn(h.provider, 'pollConnect')
      .mockReturnValueOnce(firstResult)
      .mockResolvedValueOnce({
        status: 'connected',
        account: {
          externalAccountRef: 'external:gmail:Work' as never,
          toolkit: 'gmail',
          label: 'Work',
          status: 'active',
          custody: 'managed',
        },
      });

    const slowPoll = h.service.poll(OWNER, started.flowId);
    const winner = await h.service.poll(OWNER, started.flowId);
    releaseFirst({ status: 'failed', error: 'late stale failure' });

    await expect(slowPoll).resolves.toEqual(winner);
    expect(winner).toMatchObject({ state: 'connected' });
    expect(h.db.select().from(connections).all()).toHaveLength(1);
  });

  it('expires a flow that crosses its deadline while provider polling is in flight', async () => {
    let clock = NOW;
    h.service = new ConnectorAuthenticationFlowService({
      db: h.db,
      registry: h.registry,
      now: () => clock,
      flowTtlMs: 1_000,
    });
    const started = await h.service.start(OWNER, {
      ...GMAIL_START,
      idempotencyKey: 'expires-in-flight',
    });
    let release!: (value: ConnectPoll) => void;
    vi.spyOn(h.provider, 'pollConnect').mockReturnValueOnce(
      new Promise<ConnectPoll>((resolve) => {
        release = resolve;
      })
    );
    const pendingPoll = h.service.poll(OWNER, started.flowId);
    clock = new Date(NOW.getTime() + 2_000);
    release({
      status: 'connected',
      account: {
        externalAccountRef: 'external:gmail:default' as never,
        toolkit: 'gmail',
        label: 'default',
        status: 'active',
        custody: 'managed',
      },
    });

    await expect(pendingPoll).resolves.toMatchObject({ state: 'expired' });
    expect(h.db.select().from(connections).all()).toHaveLength(0);
  });

  it('recovers an actual Composio provider flow from its remote handle after restart', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.includes('/auth_configs')) {
        return new Response(JSON.stringify({ items: [{ id: 'auth-config-a' }] }));
      }
      if ((init?.method ?? 'GET') === 'POST') {
        return new Response(
          JSON.stringify({ id: 'ca_restart_a', redirect_url: 'https://provider.example/consent' })
        );
      }
      return new Response(
        JSON.stringify({
          id: 'ca_restart_a',
          status: 'ACTIVE',
          toolkit: { slug: 'gmail' },
          alias: 'Work',
        })
      );
    });
    const actualProvider = () =>
      new ComposioConnectorProvider({
        instanceId: PROVIDER_ID,
        operationClient: null,
        client: new FetchComposioHttpClient({
          apiKey: 'ak-hermetic',
          userId: 'owner-a',
          baseUrl: 'https://composio.example',
          fetchImpl: fetchImpl as typeof fetch,
        }),
      });
    h.registry = new ConnectorRegistry({
      db: h.db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    h.registry.register(actualProvider(), 'same-material');
    h.service = new ConnectorAuthenticationFlowService({
      db: h.db,
      registry: h.registry,
      now: () => NOW,
    });
    const started = await h.service.start(OWNER, {
      ...GMAIL_START,
      label: 'Work',
      idempotencyKey: 'actual-composio-restart',
    });

    const restartedRegistry = new ConnectorRegistry({
      db: h.db,
      configuredOwner: { ownerKind: OWNER.kind, ownerId: OWNER.installationId },
    });
    restartedRegistry.register(actualProvider(), 'same-material');
    const restarted = new ConnectorAuthenticationFlowService({
      db: h.db,
      registry: restartedRegistry,
      now: () => NOW,
    });
    await expect(restarted.poll(OWNER, started.flowId)).resolves.toMatchObject({
      state: 'connected',
      connectionId: expect.any(String),
    });
    expect(calls).toContain('GET /api/v3.1/connected_accounts/ca_restart_a');
  });

  it('rejects a mismatched provider account and never stores raw provider failure text', async () => {
    const started = await h.service.start(OWNER, {
      ...GMAIL_START,
      idempotencyKey: 'safe-provider-failure',
    });
    vi.spyOn(h.provider, 'pollConnect').mockResolvedValue({
      status: 'failed',
      error: 'SECRET_MARKER_FROM_PROVIDER',
    });

    const failed = await h.service.poll(OWNER, started.flowId);
    expect(failed).toMatchObject({
      state: 'failed',
      reason: SIGN_IN_COPY.failed,
    });
    expect(JSON.stringify(failed)).not.toContain('SECRET_MARKER_FROM_PROVIDER');
    expect(JSON.stringify(h.db.select().from(connectorAuthenticationFlows).all())).not.toContain(
      'SECRET_MARKER_FROM_PROVIDER'
    );

    const mismatched = await h.service.start(OWNER, {
      ...GMAIL_START,
      idempotencyKey: 'wrong-toolkit-result',
    });
    vi.spyOn(h.provider, 'pollConnect').mockResolvedValue({
      status: 'connected',
      account: {
        externalAccountRef: 'external:slack:wrong' as never,
        toolkit: 'slack',
        label: 'Wrong',
        status: 'active',
        custody: 'managed',
      },
    });
    await expect(h.service.poll(OWNER, mismatched.flowId)).resolves.toMatchObject({
      state: 'failed',
      reason:
        'This sign-in belongs to a different way of reaching the app. Start again from Connections.',
    });
    expect(h.db.select().from(connections).all()).toHaveLength(0);
  });

  it('does not re-pause a completed reconnect when its idempotency key is replayed', async () => {
    const existing = insertActiveConnection(h.db);
    const started = await h.service.reconnect(OWNER, existing, 'same-account-reconnect');
    const completed = await h.service.poll(OWNER, started.flowId);
    expect(completed).toMatchObject({ state: 'connected', connectionId: existing });
    expect(h.db.select().from(connections).where(eq(connections.id, existing)).get()?.enabled).toBe(
      true
    );

    await expect(h.service.reconnect(OWNER, existing, 'same-account-reconnect')).resolves.toEqual(
      completed
    );
    expect(h.db.select().from(connections).where(eq(connections.id, existing)).get()?.enabled).toBe(
      true
    );
  });

  it('keeps a pause the owner chose when signing in again completes', async () => {
    const existing = insertActiveConnection(h.db);
    const enabled = () =>
      h.db.select().from(connections).where(eq(connections.id, existing)).get()?.enabled;
    h.db.update(connections).set({ enabled: false }).where(eq(connections.id, existing)).run();

    const started = await h.service.reconnect(OWNER, existing, 'paused-reconnect');
    await expect(h.service.poll(OWNER, started.flowId)).resolves.toMatchObject({
      state: 'connected',
      connectionId: existing,
    });
    // Still paused: signing in again never undoes the owner's choice.
    expect(enabled()).toBe(false);
  });

  it('unpauses after a sign-in again that an earlier unfinished one had paused', async () => {
    const existing = insertActiveConnection(h.db);
    const enabled = () =>
      h.db.select().from(connections).where(eq(connections.id, existing)).get()?.enabled;
    // An earlier sign-in again paused the account and then ran out of time.
    const abandoned = await h.service.reconnect(OWNER, existing, 'abandoned-reconnect');
    h.db
      .update(connectorAuthenticationFlows)
      .set({ state: 'expired', completedAt: new Date().toISOString() })
      .where(eq(connectorAuthenticationFlows.id, abandoned.flowId))
      .run();
    expect(enabled()).toBe(false);

    const again = await h.service.reconnect(OWNER, existing, 'second-reconnect');
    await expect(h.service.poll(OWNER, again.flowId)).resolves.toMatchObject({
      state: 'connected',
    });
    // That pause was the abandoned sign-in's, not the owner's.
    expect(enabled()).toBe(true);
  });
});
