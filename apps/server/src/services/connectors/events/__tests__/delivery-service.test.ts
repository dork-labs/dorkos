import { describe, expect, it, vi } from 'vitest';
import {
  connections,
  connectorProviderInstances,
  connectorEventInbox,
  connectorEventReceipts,
  sessionMessageQueue,
} from '@dorkos/db';
import type { ConnectorProvider } from '@dorkos/shared/connector-provider';
import type { ConnectorEventDefinition } from '@dorkos/shared/connector-event-schemas';
import type { ConnectorEventCapability } from '@dorkos/shared/connector-events';
import { ConnectorEventPayloadProtector } from '@dorkos/connector-providers';
import {
  createRoomHarness,
  agentLookupFor,
  scriptedRunner,
} from '../../../rooms/__tests__/room-test-harness.js';
import { ConnectorSubscriptionStore } from '../subscription-store.js';
import { ConnectorSubscriptionService } from '../subscription-service.js';
import { ConnectorEventInboxStore } from '../../event-inbox-store.js';
import { ConnectorEventDeliveryService } from '../delivery-service.js';
import { ConnectorEventSessionSourceAdapter } from '../session-source-adapter.js';
import { PrivateSessionMessageAcceptanceService } from '../../../session/private-messages/acceptance.js';
import { MessageQueueStore } from '../../../session/message-queue-store.js';

const BASE = '2026-09-07T12:00:00.000Z';
const owner = { kind: 'local_install', installationId: 'owner' } as const;
const definition: ConnectorEventDefinition = {
  eventType: 'GMAIL_NEW_MESSAGE',
  displayName: 'Mail arrived',
  toolkit: 'gmail',
  toolkitVersion: '20260901',
  definitionHash: `sha256:${'a'.repeat(64)}`,
  filterSchema: { type: 'object', additionalProperties: false },
  payloadSchema: { type: 'object' },
  deliveryMode: 'webhook',
  expectedCadenceSeconds: null,
};
async function fixture(destination: 'room' | 'channel' = 'room') {
  const harness = createRoomHarness({
    agents: agentLookupFor({ '/agents/event': { name: 'event', responseMode: 'always' } }),
    runner: scriptedRunner(),
    maxAgentDepth: 3,
  });
  const { db, service: rooms } = harness;
  const room = rooms.createRoom(
    { kind: 'channel', title: 'Event room', members: [], agentPaths: ['/agents/event'] },
    harness.human
  );
  rooms.updateMembership(
    room.id,
    harness.human,
    harness.authors.resolveAgent('/agents/event', 'event').id,
    'always'
  );
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
      externalAccountRef: 'private-account',
      toolkit: 'gmail',
      label: 'work',
      status: 'active',
      createdAt: BASE,
      updatedAt: BASE,
    })
    .run();
  const subscriptions = new ConnectorSubscriptionStore(db);
  const discovered = subscriptions.discover(
    subscriptions.connection(owner, 'account-one'),
    [definition],
    BASE
  )[0];
  const capability = {
    reconcileTrigger: async () => ({
      status: 'found',
      trigger: {
        providerTriggerRef: 'trigger',
        externalAccountRef: 'private-account',
        enabled: true,
      },
    }),
  } as unknown as ConnectorEventCapability;
  const service = new ConnectorSubscriptionService(
    subscriptions,
    { resolveProviderInstance: () => ({ events: capability }) as ConnectorProvider },
    { authorize: () => true },
    () => BASE
  );
  const created = await service.create(
    owner,
    {
      connectionId: 'account-one' as never,
      definitionId: discovered.id,
      agentId: 'agent-one',
      destination: { kind: destination, id: destination === 'room' ? room.id : 'binding-exact' },
      filter: {},
    },
    new AbortController().signal
  );
  const protector = new ConnectorEventPayloadProtector({
    activeKeyId: 'key',
    keys: new Map([['key', new Uint8Array(32).fill(6)]]),
  });
  const protection = { resolve: vi.fn(async () => protector) };
  const inbox = new ConnectorEventInboxStore({ db, bootEpoch: 'boot-one' });
  const scope = {
    providerInstanceId: 'provider-one',
    subscriptionId: created.id,
    providerEventId: 'event-one',
    expiresAt: '2026-09-14T12:00:00.000Z',
  };
  const inserted = inbox.enqueue({
    ...scope,
    providerInstanceId: 'provider-one' as never,
    subscriptionVersion: 1,
    payloadSchemaVersion: 1,
    payloadProtection: 'encrypted',
    normalizedPayload: protector.protect(
      { version: 1, title: 'Mail arrived', text: '@event private notification' },
      scope
    ),
    receivedAt: BASE,
  });
  const managed = { ready: () => true, reconcile: async () => true };
  const target = { resolve: async () => undefined, bind: async () => {}, current: () => false };
  const sessions = new ConnectorEventSessionSourceAdapter(
    subscriptions,
    protection,
    managed,
    target,
    'boot-one',
    () => BASE
  );
  const acceptance = new PrivateSessionMessageAcceptanceService(
    db,
    new MessageQueueStore(db),
    [sessions],
    'boot-one',
    () => new Date(BASE)
  );
  const channels = {
    deliver: vi.fn(async (_scope, _content, guard) =>
      guard()
        ? { state: 'delivered' as const, receiptId: 'relay:exact-message' }
        : { state: 'refused' as const }
    ),
  };
  const options = {
    subscriptions,
    inbox,
    protection,
    managed,
    sessions,
    acceptance,
    nudgeSession: vi.fn(),
    rooms,
    channels,
    authorize: () => true,
    now: () => BASE,
  };
  return {
    ...harness,
    room,
    subscriptions,
    inbox,
    inserted,
    protection,
    channels,
    options,
    worker: new ConnectorEventDeliveryService(options),
  };
}

describe('event destination receipts', () => {
  it('commits room notice and source completion together, without waking an always-on roster', async () => {
    const f = await fixture();
    expect(await f.worker.recover(new AbortController().signal)).toBe(1);
    const entries = f.service.listEntries(f.room.id, f.human, { limit: 100 });
    const notice = entries.find((entry) => entry.body.text.includes('private notification'))!;
    expect(notice).toMatchObject({
      kind: 'notice',
      authorId: f.authors.system().id,
      mentions: [],
      mentionSpans: [],
      cascadeDepth: 3,
    });
    expect(f.runner.turns).toHaveLength(0);
    expect(f.db.select().from(connectorEventInbox).get()).toMatchObject({
      state: 'completed',
      normalizedPayload: '',
    });
    expect(f.db.select().from(connectorEventReceipts).all().at(-1)?.destinationReceiptId).toBe(
      `room:${f.room.id}:${notice.id}`
    );
    expect(await f.worker.recover(new AbortController().signal)).toBe(0);
    expect(f.db.select().from(sessionMessageQueue).all()).toHaveLength(0);
  });

  it('rolls back the room entry when its source receipt cannot commit', async () => {
    const f = await fixture();
    vi.spyOn(f.inbox, 'complete').mockReturnValueOnce(false);
    expect(await f.worker.recover(new AbortController().signal, 1)).toBe(1);
    expect(
      f.service
        .listEntries(f.room.id, f.human, { limit: 100 })
        .some((entry) => entry.body.text.includes('private notification'))
    ).toBe(false);
    expect(f.db.select().from(connectorEventInbox).get()).toMatchObject({
      state: 'received',
      attemptCount: 1,
    });
    expect(f.runner.turns).toHaveLength(0);
  });

  it('refuses room dispatch when receive consent is revoked while decryption keys resolve', async () => {
    const f = await fixture();
    const resolve = f.protection.resolve.getMockImplementation()!;
    f.protection.resolve.mockImplementation(async () => {
      f.subscriptions.revoke(
        owner,
        f.db.select().from(connectorEventInbox).get()!.subscriptionId,
        BASE
      );
      return resolve();
    });
    await f.worker.recover(new AbortController().signal);
    expect(
      f.service
        .listEntries(f.room.id, f.human, { limit: 100 })
        .some((entry) => entry.body.text.includes('private notification'))
    ).toBe(false);
    expect(f.runner.turns).toHaveLength(0);
    expect(f.db.select().from(connectorEventInbox).get()).toMatchObject({
      state: 'failed',
      normalizedPayload: '',
    });
  });

  it('uses the exact selected channel and records only an actual destination receipt', async () => {
    const f = await fixture('channel');
    await f.worker.recover(new AbortController().signal);
    expect(f.channels.deliver).toHaveBeenCalledTimes(1);
    expect(f.channels.deliver.mock.calls[0][0]).toMatchObject({
      destinationKind: 'channel',
      destinationId: 'binding-exact',
    });
    expect(f.db.select().from(connectorEventReceipts).all().at(-1)?.destinationReceiptId).toBe(
      'relay:exact-message'
    );
    expect(f.db.select().from(connectorEventInbox).get()?.normalizedPayload).toBe('');
  });

  it('quarantines uncertain native delivery rather than scheduling a duplicate notification', async () => {
    const f = await fixture('channel');
    f.channels.deliver.mockImplementation(async (_scope, _content, guard) => {
      expect(guard()).toBe(true);
      throw new Error('reply lost');
    });
    await f.worker.recover(new AbortController().signal);
    expect(f.db.select().from(connectorEventInbox).get()).toMatchObject({ state: 'failed' });
    expect(f.db.select().from(connectorEventInbox).get()?.normalizedPayload).not.toBe('');
    expect(await f.worker.recover(new AbortController().signal)).toBe(0);
    expect(f.channels.deliver).toHaveBeenCalledTimes(1);
  });
});
