import { describe, it, expect, beforeEach } from 'vitest';
import {
  connections,
  connectorProviderInstances,
  createDb,
  runMigrations,
  type Db,
} from '@dorkos/db';
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';
import {
  AgentConnectorAttachmentStore,
  SessionConnectorAttachmentStore,
} from '../attachment-store.js';

/** Seed the canonical parents required by attachment foreign keys. */
function seedConnections(db: Db): void {
  const now = new Date(0).toISOString();
  db.insert(connectorProviderInstances)
    .values({
      id: 'provider_instance_test',
      type: 'test',
      mode: 'byo',
      displayName: 'Test',
      custody: 'managed',
      capabilityJson: '{}',
      status: 'available',
      createdAt: now,
      updatedAt: now,
    })
    .run();
  for (const id of ['gmail:personal', 'slack:team']) {
    db.insert(connections)
      .values({
        id,
        providerInstanceId: 'provider_instance_test',
        externalAccountRef: `private:${id}`,
        toolkit: id.split(':')[0]!,
        label: id.split(':')[1]!,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

describe('AgentConnectorAttachmentStore', () => {
  let db: Db;
  let store: AgentConnectorAttachmentStore;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    seedConnections(db);
    store = new AgentConnectorAttachmentStore(db);
  });

  it('attach/detach/listForAgent round-trip', () => {
    const gmail = 'gmail:personal' as ConnectedAccountId;
    store.attach('agent-a', gmail);
    expect(store.listForAgent('agent-a').map((a) => a.accountId)).toEqual([gmail]);
    store.detach('agent-a', gmail);
    expect(store.listForAgent('agent-a')).toEqual([]);
  });

  it('attach is idempotent — a re-attach does not reset attachedAt', () => {
    const gmail = 'gmail:personal' as ConnectedAccountId;
    store.attach('agent-a', gmail);
    const first = store.listForAgent('agent-a')[0]!.attachedAt;
    store.attach('agent-a', gmail);
    expect(store.listForAgent('agent-a')[0]!.attachedAt).toBe(first);
  });
});

describe('SessionConnectorAttachmentStore', () => {
  let db: Db;
  let store: SessionConnectorAttachmentStore;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    seedConnections(db);
    store = new SessionConnectorAttachmentStore(db, () => 'agent-a');
  });

  it('refuses to create an ownerless canonical override', () => {
    const strictStore = new SessionConnectorAttachmentStore(db);
    const gmail = 'gmail:personal' as ConnectedAccountId;

    expect(() => strictStore.setState('unknown-session', gmail, 'attached')).toThrow(
      /no agent owner/i
    );
    expect(strictStore.listForSession('unknown-session')).toEqual([]);
  });

  it('setState/listForSession round-trip, and a re-set replaces the state', () => {
    const gmail = 'gmail:personal' as ConnectedAccountId;
    store.setState('session-1', gmail, 'attached');
    expect(store.listForSession('session-1')).toMatchObject([
      { accountId: gmail, state: 'attached' },
    ]);
    store.setState('session-1', gmail, 'detached');
    expect(store.listForSession('session-1')).toMatchObject([
      { accountId: gmail, state: 'detached' },
    ]);
    expect(store.listForSession('session-1')).toHaveLength(1);
  });

  describe('rekey()', () => {
    it('moves every override row to the new session id', () => {
      const gmail = 'gmail:personal' as ConnectedAccountId;
      const slack = 'slack:team' as ConnectedAccountId;
      store.setState('old-id', gmail, 'detached');
      store.setState('old-id', slack, 'attached');

      store.rekey('old-id', 'new-id');

      expect(store.listForSession('old-id')).toEqual([]);
      expect(store.listForSession('new-id')).toHaveLength(2);
      expect(store.listForSession('new-id')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ accountId: gmail, state: 'detached' }),
          expect.objectContaining({ accountId: slack, state: 'attached' }),
        ])
      );
    });

    it("when the new id already has its own override for an account, the new id's row wins", () => {
      const gmail = 'gmail:personal' as ConnectedAccountId;
      store.setState('old-id', gmail, 'attached');
      store.setState('new-id', gmail, 'detached');

      store.rekey('old-id', 'new-id');

      expect(store.listForSession('new-id')).toMatchObject([
        { accountId: gmail, state: 'detached' },
      ]);
      expect(store.listForSession('new-id')).toHaveLength(1);
    });

    it('is a no-op when the ids match', () => {
      const gmail = 'gmail:personal' as ConnectedAccountId;
      store.setState('same-id', gmail, 'attached');
      store.rekey('same-id', 'same-id');
      expect(store.listForSession('same-id')).toMatchObject([
        { accountId: gmail, state: 'attached' },
      ]);
    });
  });
});
