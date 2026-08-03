import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';
import {
  AgentConnectorAttachmentStore,
  SessionConnectorAttachmentStore,
} from '../attachment-store.js';

describe('AgentConnectorAttachmentStore', () => {
  let db: Db;
  let store: AgentConnectorAttachmentStore;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
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

  it('MAJOR 6: deleteAgent clears every standing attachment for that agent, and only that agent', () => {
    const gmail = 'gmail:personal' as ConnectedAccountId;
    const slack = 'slack:team' as ConnectedAccountId;
    store.attach('agent-a', gmail);
    store.attach('agent-a', slack);
    store.attach('agent-b', gmail);

    store.deleteAgent('agent-a');

    expect(store.listForAgent('agent-a')).toEqual([]);
    // agent-b's own attachment to the SAME account survives — this is a
    // per-agent cascade, not a per-account one (that's
    // ConnectorRegistry.recordDisconnect's job).
    expect(store.listForAgent('agent-b').map((a) => a.accountId)).toEqual([gmail]);
  });

  it('deleteAgent on an agent with nothing attached is a no-op', () => {
    expect(() => store.deleteAgent('agent-with-nothing')).not.toThrow();
  });

  it('MAJOR 6 (successor scenario): re-registering an agent under the same id after deleteAgent starts with no standing consent', () => {
    const gmail = 'gmail:personal' as ConnectedAccountId;
    store.attach('agent-a', gmail);
    store.deleteAgent('agent-a'); // the unregister cascade

    // A "new" agent registered under the same id (same directory re-pointed,
    // or a coincidental id collision) inherits nothing.
    expect(store.listForAgent('agent-a')).toEqual([]);
  });
});

describe('SessionConnectorAttachmentStore', () => {
  let db: Db;
  let store: SessionConnectorAttachmentStore;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    store = new SessionConnectorAttachmentStore(db);
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
