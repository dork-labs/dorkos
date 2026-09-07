import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  runMigrations,
  connectorProviderInstances,
  connections,
  agents,
  connectorEventInbox,
  eq,
  sessionMessageQueue,
  sessionMessageAcceptanceReceipts,
  type Db,
} from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import { ConnectorEventPayloadProtector } from '@dorkos/connector-providers';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ConnectorEventDefinition } from '@dorkos/shared/connector-event-schemas';
import type { ConnectorEventCapability } from '@dorkos/shared/connector-events';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { MessageQueueStore, setMessageQueueStore } from '../../../session/message-queue-store.js';
import {
  PrivateSessionMessageAcceptanceService,
  setPrivateSessionMessageAcceptanceService,
} from '../../../session/private-messages/acceptance.js';
import {
  adoptAcceptedPrivateMessages,
  resetMessageDispatcher,
} from '../../../session/message-dispatcher.js';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../session/session-state-projector.js';
import { ConnectorSubscriptionStore } from '../subscription-store.js';
import { ConnectorSubscriptionService } from '../subscription-service.js';
import { ConnectorEventGrantService } from '../grant-service.js';
import { ConnectorEventInboxStore } from '../../event-inbox-store.js';
import { ConnectorEventSessionSourceAdapter } from '../session-source-adapter.js';
import { CanonicalConnectorEventSessionTarget } from '../session-target.js';

const BASE = '2026-09-07T12:00:00.000Z';
const owner = { kind: 'local_install', installationId: 'owner' } as const;
const definition: ConnectorEventDefinition = {
  eventType: 'GMAIL_NEW_MESSAGE',
  displayName: 'New message',
  toolkit: 'gmail',
  toolkitVersion: '20260901',
  definitionHash: `sha256:${'a'.repeat(64)}`,
  filterSchema: { type: 'object', additionalProperties: false },
  payloadSchema: { type: 'object' },
  deliveryMode: 'webhook',
  expectedCadenceSeconds: null,
};
const disposers: Array<() => void> = [];
const projectorIds = new Set<string>();
afterEach(() => {
  resetMessageDispatcher();
  setPrivateSessionMessageAcceptanceService(undefined);
  setMessageQueueStore(undefined);
  for (const id of projectorIds) disposeProjector(id);
  projectorIds.clear();
  for (const dispose of disposers.splice(0)) dispose();
});

async function settleDispatch(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
}

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dork-event-session-'));
  const path = join(dir, 'events.sqlite');
  const db = createDb(path);
  runMigrations(db);
  disposers.push(() => {
    if (db.$client.open) db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  mkdirSync(join(dir, '.dork'));
  writeFileSync(
    join(dir, '.dork/agent.json'),
    JSON.stringify({
      id: 'agent-one',
      name: 'event-agent',
      runtime: 'claude-code',
      registeredAt: BASE,
      registeredBy: 'owner',
    })
  );
  db.insert(agents)
    .values({
      id: 'agent-one',
      name: 'event-agent',
      runtime: 'claude-code',
      projectPath: dir,
      registeredAt: BASE,
      updatedAt: BASE,
    })
    .run();
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
      createdAt: BASE,
      updatedAt: BASE,
    })
    .run();
  db.insert(connections)
    .values({
      id: 'account-one',
      providerInstanceId: 'provider-one',
      externalAccountRef: 'account-private',
      toolkit: 'gmail',
      label: 'work',
      status: 'active',
      createdAt: BASE,
      updatedAt: BASE,
    })
    .run();
  const store = new ConnectorSubscriptionStore(db);
  const discovered = store.discover(store.connection(owner, 'account-one'), [definition], BASE)[0];
  const events = {
    reconcileTrigger: vi.fn(async () => ({
      status: 'found',
      trigger: {
        providerTriggerRef: 'trigger',
        providerTriggerUuid: 'trigger-uuid',
        externalAccountRef: 'account-private',
        externalAccountUuid: 'account-uuid',
        enabled: true,
      },
    })),
  } as unknown as ConnectorEventCapability;
  const policy = { authorize: () => true };
  const managed = { reconcile: vi.fn(async () => true), ready: vi.fn(() => true) };
  const service = new ConnectorSubscriptionService(
    store,
    { resolveProviderInstance: () => ({ events }) as ConnectorProvider },
    policy,
    () => BASE
  );
  const grants = new ConnectorEventGrantService(store, service, policy, managed, () => BASE);
  const approved = await grants.approve(
    owner,
    {
      reviewId: 'owner-review',
      scopes: [
        {
          connectionId: 'account-one' as never,
          definitionId: discovered.id,
          filter: {},
          agentId: 'agent-one',
          destination: { kind: 'agent', id: 'agent-one' },
        },
      ],
    },
    new AbortController().signal
  );
  expect(approved.state).toBe('ready');
  const subscriptionId = approved.selections[0].subscriptionId;
  const protector = new ConnectorEventPayloadProtector({
    activeKeyId: 'event-key',
    keys: new Map([['event-key', new Uint8Array(32).fill(8)]]),
  });
  let now = BASE;
  const scope = {
    providerInstanceId: 'provider-one',
    subscriptionId,
    providerEventId: 'signed-event',
    expiresAt: '2026-09-14T12:00:00.000Z',
  };
  const inbox = new ConnectorEventInboxStore({ db, bootEpoch: 'boot-one' });
  const queued = inbox.enqueue({
    ...scope,
    providerInstanceId: scope.providerInstanceId as never,
    subscriptionVersion: 1,
    receivedAt: BASE,
    normalizedPayload: protector.protect(
      { version: 1, title: 'Mail arrived', text: 'private message body' },
      scope
    ),
    payloadProtection: 'encrypted',
    payloadSchemaVersion: 1,
  });
  const runtime = new FakeAgentRuntime('claude-code');
  function compose(database: Db, boot = 'boot-one') {
    const registry = new RuntimeRegistry();
    registry.setDb(database);
    registry.register(runtime);
    const target = new CanonicalConnectorEventSessionTarget({
      db: database,
      ownsAgent: (candidate, id) =>
        candidate.kind === owner.kind &&
        candidate.installationId === owner.installationId &&
        !!database.$client.prepare('SELECT id FROM agents WHERE id = ?').get(id),
      sessions: registry,
    });
    const adapter = new ConnectorEventSessionSourceAdapter(
      new ConnectorSubscriptionStore(database),
      { resolve: async () => protector },
      managed,
      target,
      boot,
      () => now
    );
    const queue = new MessageQueueStore(database);
    const acceptance = new PrivateSessionMessageAcceptanceService(
      database,
      queue,
      [adapter],
      boot,
      () => new Date(now)
    );
    return { adapter, queue, acceptance, target, registry };
  }
  const composed = compose(db);
  const lease = inbox.claimNext('lease-one', now, '2026-09-07T12:01:00.000Z')!;
  const ref = {
    kind: 'connector_event' as const,
    inboxId: queued.id,
    sourceGeneration: String(lease.subscriptionVersion),
    leaseOwner: lease.leaseOwner,
  };
  return {
    db,
    path,
    store,
    managed,
    inbox,
    ref,
    subscriptionId,
    runtime,
    compose,
    ...composed,
    setNow: (value: string) => {
      now = value;
    },
  };
}

describe('event source through real durable private acceptance', () => {
  it('persists only a placeholder until a real turn receipt, without warming a runtime', async () => {
    const f = await fixture();
    await f.adapter.prepareTarget(f.ref);
    expect(f.runtime.ensureSession).not.toHaveBeenCalled();
    expect(f.runtime.sendMessage).not.toHaveBeenCalled();
    const accepted = f.adapter.acceptPrepared(f.acceptance, f.ref);
    expect(accepted.created).toBe(true);
    expect(f.db.select().from(sessionMessageQueue).get()?.content).toBe(
      '[Private service notification]'
    );
    expect(
      JSON.stringify(f.db.select().from(sessionMessageAcceptanceReceipts).all())
    ).not.toContain('private message body');
    expect(f.db.select().from(connectorEventInbox).get()?.normalizedPayload).not.toBe('');
    const prepared = await f.acceptance.prepare(accepted.receipt.id);
    expect(f.acceptance.claim(accepted.receipt.id, prepared).content).toContain(
      'private message body'
    );
    expect(() => f.acceptance.claim(accepted.receipt.id, prepared)).toThrow();
    f.acceptance.markTurnStarted(accepted.receipt.id, 7);
    expect(f.db.select().from(connectorEventInbox).get()).toMatchObject({
      state: 'completed',
      normalizedPayload: '',
    });
    expect(f.db.select().from(sessionMessageQueue).all()).toHaveLength(0);
  });

  it('refuses revoked authority between prepare and the final dispatch transaction', async () => {
    const f = await fixture();
    await f.adapter.prepareTarget(f.ref);
    const accepted = f.adapter.acceptPrepared(f.acceptance, f.ref);
    const prepared = await f.acceptance.prepare(accepted.receipt.id);
    f.store.revoke(owner, f.subscriptionId, BASE);
    const dispatch = vi.fn();
    expect(() => {
      f.acceptance.claim(accepted.receipt.id, prepared);
      dispatch();
    }).toThrow();
    expect(dispatch).not.toHaveBeenCalled();
    f.acceptance.cancel(accepted.receipt.id, 'authority_changed');
    expect(f.db.select().from(connectorEventInbox).get()?.normalizedPayload).toBe('');
  });

  it('refuses a stale preparer after another lease claims the same source', async () => {
    const f = await fixture();
    const bind = f.target.bind.bind(f.target);
    vi.spyOn(f.target, 'bind').mockImplementation(async (...args) => {
      await bind(...args);
      f.setNow('2026-09-07T12:01:01.000Z');
      expect(
        f.inbox.claimNext('lease-two', '2026-09-07T12:01:01.000Z', '2026-09-07T12:02:00.000Z')
      ).toBeDefined();
    });
    await expect(f.adapter.prepareTarget(f.ref)).rejects.toMatchObject({
      code: 'event_claim_changed',
    });
    expect(() => f.acceptance.accept(f.ref)).toThrow();
    expect(f.db.select().from(sessionMessageQueue).all()).toHaveLength(0);
  });

  it('converges two preparers and two accepts onto one exact target and one receipt', async () => {
    const f = await fixture();
    const bind = vi.spyOn(f.target, 'bind');
    await Promise.all([f.adapter.prepareTarget(f.ref), f.adapter.prepareTarget(f.ref)]);
    expect(bind).toHaveBeenCalledTimes(1);
    const a = f.adapter.acceptPrepared(f.acceptance, f.ref);
    const b = f.adapter.acceptPrepared(f.acceptance, f.ref);
    expect(b.created).toBe(false);
    expect(b.receipt.sessionId).toBe(a.receipt.sessionId);
    expect(f.db.select().from(sessionMessageQueue).all()).toHaveLength(1);
  });

  it('keeps preparation retryable when the atomic queue insert rolls back', async () => {
    const f = await fixture();
    await f.adapter.prepareTarget(f.ref);
    const enqueue = vi.spyOn(f.queue, 'enqueue').mockImplementationOnce(() => {
      throw new Error('synthetic queue failure');
    });
    expect(() => f.adapter.acceptPrepared(f.acceptance, f.ref)).toThrow('synthetic queue failure');
    expect(f.db.select().from(connectorEventInbox).get()?.state).toBe('leased');
    enqueue.mockRestore();
    expect(f.adapter.acceptPrepared(f.acceptance, f.ref).created).toBe(true);
  });

  it('does not recover preparation as authority after a crash before acceptance', async () => {
    const f = await fixture();
    await f.adapter.prepareTarget(f.ref);
    const reboot = f.compose(f.db, 'boot-two');
    expect(() => reboot.acceptance.accept(f.ref)).toThrow();
    f.setNow('2026-09-07T12:01:01.000Z');
    const resumed = new ConnectorEventInboxStore({ db: f.db, bootEpoch: 'boot-two' });
    const lease = resumed.claimNext(
      'lease-two',
      '2026-09-07T12:01:01.000Z',
      '2026-09-07T12:02:00.000Z'
    )!;
    const ref = { ...f.ref, leaseOwner: lease.leaseOwner };
    await reboot.adapter.prepareTarget(ref);
    expect(reboot.adapter.acceptPrepared(reboot.acceptance, ref).created).toBe(true);
    expect(f.db.select().from(sessionMessageQueue).all()).toHaveLength(1);
    expect(f.runtime.ensureSession).not.toHaveBeenCalled();
  });

  it('recovers accepted content solely from the durable receipt after a real database reopen', async () => {
    const f = await fixture();
    await f.adapter.prepareTarget(f.ref);
    const accepted = f.adapter.acceptPrepared(f.acceptance, f.ref);
    f.db.$client.close();
    const reopened = createDb(f.path);
    disposers.push(() => reopened.$client.close());
    const reboot = f.compose(reopened, 'boot-two');
    const bind = vi.spyOn(reboot.target, 'bind');
    await reboot.adapter.prepareTarget(f.ref);
    expect(bind).not.toHaveBeenCalled();
    const replay = reboot.adapter.acceptPrepared(reboot.acceptance, f.ref);
    expect(replay.created).toBe(false);
    expect(replay.receipt.sessionId).toBe(accepted.receipt.sessionId);
    const prepared = await reboot.acceptance.prepare(replay.receipt.id);
    expect(reboot.acceptance.claim(replay.receipt.id, prepared).content).toContain(
      'private message body'
    );
    expect(f.runtime.ensureSession).not.toHaveBeenCalled();
  });

  it('restarts an accepted event through the shared dispatcher after claiming its receipt', async () => {
    const f = await fixture();
    await f.adapter.prepareTarget(f.ref);
    const accepted = f.adapter.acceptPrepared(f.acceptance, f.ref);
    f.db.$client.close();

    const reopened = createDb(f.path);
    disposers.push(() => reopened.$client.close());
    const reboot = f.compose(reopened, 'boot-two');
    setMessageQueueStore(reboot.queue);
    setPrivateSessionMessageAcceptanceService(reboot.acceptance);
    projectorIds.add(accepted.receipt.sessionId);
    f.runtime.getInternalSessionId.mockReturnValue(undefined);
    let firstEffectState: string | undefined;
    f.runtime.sendMessage.mockImplementation(() => {
      firstEffectState = reopened
        .select({ state: sessionMessageAcceptanceReceipts.state })
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
        .get()?.state;
      return (async function* (): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      })();
    });

    expect(f.runtime.ensureSession).not.toHaveBeenCalled();
    const runtime = await reboot.registry.resolveForSession(accepted.receipt.sessionId);
    const agentPath = await reboot.registry.getSessionAgentPath(accepted.receipt.sessionId);
    expect(agentPath).toBe(f.path.replace(/\/events\.sqlite$/, ''));
    expect(
      adoptAcceptedPrivateMessages({
        sessionId: accepted.receipt.sessionId,
        cwd: agentPath ?? undefined,
        projector: getOrCreateProjector(accepted.receipt.sessionId, agentPath ?? undefined),
        runtime,
      })
    ).toBe(1);
    await settleDispatch();

    expect(firstEffectState).toBe('dispatching');
    expect(f.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.runtime.sendMessage).toHaveBeenCalledWith(
      accepted.receipt.sessionId,
      expect.stringContaining('private message body'),
      expect.objectContaining({ cwd: agentPath })
    );
    expect(
      reopened
        .select()
        .from(sessionMessageAcceptanceReceipts)
        .where(eq(sessionMessageAcceptanceReceipts.id, accepted.receipt.id))
        .get()
    ).toMatchObject({
      state: 'settled',
      settleOutcome: 'completed',
      dispatchBootEpoch: 'boot-two',
    });
    expect(reopened.select().from(connectorEventInbox).get()).toMatchObject({
      state: 'completed',
      normalizedPayload: '',
    });
  });

  it('quarantines crash-after-claim without replay and retains only original-expiry protected content', async () => {
    const f = await fixture();
    await f.adapter.prepareTarget(f.ref);
    const accepted = f.adapter.acceptPrepared(f.acceptance, f.ref);
    f.acceptance.claim(accepted.receipt.id, await f.acceptance.prepare(accepted.receipt.id));
    const reboot = f.compose(f.db, 'boot-two');
    expect(reboot.acceptance.recoverUnobservedAttempts()).toBe(1);
    await expect(reboot.acceptance.prepare(accepted.receipt.id)).rejects.toThrow();
    expect(f.db.select().from(connectorEventInbox).get()).toMatchObject({
      state: 'failed',
      failureCode: 'dispatch_outcome_unknown',
    });
    expect(f.db.select().from(connectorEventInbox).get()?.normalizedPayload).not.toBe('');
    expect(f.inbox.sweepRetention('2026-09-14T12:00:00.000Z').cleared).toBe(1);
  });
});
