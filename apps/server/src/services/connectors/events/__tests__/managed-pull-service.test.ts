import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDb,
  runMigrations,
  connectorProviderInstances,
  connections,
  connectorEventInbox,
} from '@dorkos/db';
import { ConnectorEventPayloadProtector } from '@dorkos/connector-providers';
import type { ManagedConnectorEventPullResponse } from '@dorkos/shared/connector-event-schemas';
import { ConnectorSubscriptionStore } from '../subscription-store.js';
import { ConnectorEventIngressService } from '../ingress-service.js';
import { ConnectorEventInboxStore } from '../../event-inbox-store.js';
import { ManagedConnectorEventPullService } from '../managed-pull-service.js';

const now = '2026-09-07T12:00:00.000Z';
const owner = { kind: 'local_install', installationId: 'owner' } as const;
const disposers: Array<() => void> = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'event-managed-pull-'));
  const db = createDb(join(dir, 'db.sqlite'));
  runMigrations(db);
  disposers.push(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  // Persist a hosted authority ACK's local state; provider bootstrap has separate
  // real registry coverage. This fixture exercises handoff and receipt durability.
  db.insert(connectorProviderInstances)
    .values({
      id: 'managed-one',
      type: 'dorkos-managed',
      mode: 'managed',
      displayName: 'Managed',
      custody: 'managed',
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
      id: 'account',
      providerInstanceId: 'managed-one',
      externalAccountRef: 'hosted-account',
      toolkit: 'gmail',
      label: 'Mail',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const subscriptions = new ConnectorSubscriptionStore(db);
  const [definition] = subscriptions.discover(
    subscriptions.connection(owner, 'account'),
    [
      {
        eventType: 'MAIL',
        displayName: 'New mail',
        toolkit: 'gmail',
        toolkitVersion: 'v1',
        definitionHash: `sha256:${'a'.repeat(64)}`,
        filterSchema: { type: 'object', additionalProperties: false },
        payloadSchema: {},
        deliveryMode: 'unknown',
        expectedCadenceSeconds: null,
      },
    ],
    now
  );
  const proposed = subscriptions.propose(
    owner,
    {
      connectionId: 'account' as never,
      definitionId: definition.id,
      agentId: 'agent',
      destination: { kind: 'agent', id: 'agent' },
      filter: {},
    },
    now
  );
  db.$client
    .prepare("UPDATE connector_event_bindings SET state = 'ready' WHERE id = ?")
    .run(proposed.bindingId);
  db.$client
    .prepare('UPDATE connector_event_subscriptions SET enabled = 1 WHERE id = ?')
    .run(proposed.subscriptionId);
  const key = new ConnectorEventPayloadProtector({
    activeKeyId: 'one',
    keys: new Map([['one', new Uint8Array(32).fill(3)]]),
  });
  const protection = {
    resolve: vi.fn(async () => key as ConnectorEventPayloadProtector | undefined),
  };
  const ingress = new ConnectorEventIngressService(
    subscriptions,
    new ConnectorEventInboxStore({ db, bootEpoch: 'boot' }),
    protection,
    () => now
  );
  const delivery: ManagedConnectorEventPullResponse['events'][number] = {
    id: '10000000-0000-4000-8000-000000000001',
    subscriptionId: proposed.subscriptionId,
    subscriptionVersion: 1,
    providerEventId: 'signed-event',
    leaseToken: '20000000-0000-4000-8000-000000000001',
    receivedAt: now,
    expiresAt: '2026-09-14T12:00:00.000Z',
    content: { version: 1, title: 'New mail', text: 'Protected content' },
  };
  const cloud = {
    pullManagedConnectorEvents: vi.fn(async () => ({ events: [delivery] })),
    acknowledgeManagedConnectorEvents: vi.fn(async () => ({ acknowledged: 1 })),
  };
  let generation = 'link-one';
  const current = () => ({
    providerInstanceId: 'managed-one' as never,
    providerGeneration: 1,
    linkGeneration: generation,
  });
  return {
    db,
    subscriptions,
    protection,
    ingress,
    delivery,
    cloud,
    rotate: () => {
      generation = 'link-two';
    },
    worker: new ManagedConnectorEventPullService(cloud, ingress, current),
  };
}

describe('managed handoff durability', () => {
  it('commits protected content before ACK and recovers only the exact stored receipt after revocation and lost ACK', async () => {
    const f = fixture();
    f.cloud.acknowledgeManagedConnectorEvents.mockImplementationOnce(async () => {
      expect(f.db.select().from(connectorEventInbox).get()?.normalizedPayload).not.toContain(
        'Protected content'
      );
      throw new Error('ACK response lost');
    });
    await expect(f.worker.recover(new AbortController().signal)).rejects.toThrow(
      'ACK response lost'
    );
    const original = f.db.select().from(connectorEventInbox).get()!;
    f.subscriptions.revoke(owner, f.delivery.subscriptionId, now);
    f.protection.resolve.mockResolvedValue(undefined);
    expect(await f.worker.recover(new AbortController().signal)).toEqual({
      accepted: 1,
      acknowledged: 1,
    });
    expect(f.db.select().from(connectorEventInbox).all()).toEqual([original]);
    expect(f.subscriptions.active(f.delivery.subscriptionId)).toBeUndefined();
    f.delivery.providerEventId = 'new-ungranted-event';
    expect(await f.worker.recover(new AbortController().signal)).toEqual({
      accepted: 0,
      acknowledged: 0,
    });
    expect(f.cloud.acknowledgeManagedConnectorEvents).toHaveBeenCalledTimes(2);
  });

  it('refuses a changed original expiry or generation instead of extending the receipt', async () => {
    const f = fixture();
    await f.worker.recover(new AbortController().signal);
    f.subscriptions.revoke(owner, f.delivery.subscriptionId, now);
    f.delivery.expiresAt = '2026-09-15T12:00:00.000Z';
    expect(await f.worker.recover(new AbortController().signal)).toEqual({
      accepted: 0,
      acknowledged: 0,
    });
    f.delivery.expiresAt = '2026-09-14T12:00:00.000Z';
    f.delivery.subscriptionVersion = 2;
    expect(await f.worker.recover(new AbortController().signal)).toEqual({
      accepted: 0,
      acknowledged: 0,
    });
    expect(f.db.select().from(connectorEventInbox).get()?.expiresAt).toBe(
      '2026-09-14T12:00:00.000Z'
    );
  });

  it('does not accept or ACK through a link rotated during encryption preparation', async () => {
    const f = fixture();
    f.protection.resolve.mockImplementation(async () => {
      f.rotate();
      return new ConnectorEventPayloadProtector({
        activeKeyId: 'two',
        keys: new Map([['two', new Uint8Array(32).fill(4)]]),
      });
    });
    expect(await f.worker.recover(new AbortController().signal)).toEqual({
      accepted: 0,
      acknowledged: 0,
    });
    expect(f.db.select().from(connectorEventInbox).all()).toHaveLength(0);
    expect(f.cloud.acknowledgeManagedConnectorEvents).not.toHaveBeenCalled();
  });
});
