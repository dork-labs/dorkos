/**
 * A level is a promise (ADR 260929-071355): "Read" keeps meaning every action
 * the app lets agents read as the app changes, never more than its class. Over
 * one real database, on this computer's own authority, the app's catalog
 * changes between two reads and each level's grants follow it, while exact
 * actions stay exactly as chosen and a level never brings back access that
 * was taken away some other way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectionOperationGrants,
  connectorOperationRevisions,
  connectorReconciliationCandidates,
  connectorReconciliationPreviews,
  eq,
} from '@dorkos/db';
import { TEST_CONNECTOR_PROVIDER_TYPE } from '../connection-store.js';
import { ConnectorManagementActionService } from '../management-action-service.js';
import { ConnectorReconciliationError } from '../reconciliation-service.js';
import {
  CONNECTION_ID,
  OWNER,
  grantLevels,
  idOf,
  levelHarness,
  levelIds,
  liveActions,
  storedLevels,
  type LevelHarness,
} from './helpers/access-levels-harness.js';

describe('levels follow the app on this computer', () => {
  let h: LevelHarness;

  beforeEach(() => {
    h = levelHarness();
  });

  it('stores the level the owner chose, and shows it back', async () => {
    await grantLevels(h);
    const again = await h.preview();
    expect(again.currentGrants).toEqual([
      { agentId: 'exact', operationRevisionIds: [idOf(again, 'gmail.list')] },
      { agentId: 'reader', operationRevisionIds: levelIds(again, 'read'), level: 'read' },
      {
        agentId: 'writer',
        operationRevisionIds: levelIds(again, 'read-write'),
        level: 'read-write',
      },
    ]);
  });

  it('adds a new read action to Read and to Read and write, never to exact actions', async () => {
    await grantLevels(h);
    h.catalog.push({ slug: 'gmail.search', classification: 'read' });
    const again = await h.preview();

    expect(liveActions(h.db, { agentId: 'reader' })).toEqual([
      'gmail.list:read',
      'gmail.search:read',
    ]);
    expect(liveActions(h.db, { agentId: 'writer' })).toEqual([
      'gmail.list:read',
      'gmail.search:read',
      'gmail.send:write',
    ]);
    expect(liveActions(h.db, { agentId: 'exact' })).toEqual(['gmail.list:read']);
    expect(again.currentGrants.find((grant) => grant.agentId === 'reader')).toEqual({
      agentId: 'reader',
      operationRevisionIds: levelIds(again, 'read'),
      level: 'read',
    });
  });

  it('adds a new write action to Read and write only', async () => {
    await grantLevels(h);
    h.catalog.push({ slug: 'gmail.draft', classification: 'write' });
    await h.preview();

    expect(liveActions(h.db, { agentId: 'reader' })).toEqual(['gmail.list:read']);
    expect(liveActions(h.db, { agentId: 'writer' })).toEqual([
      'gmail.draft:write',
      'gmail.list:read',
      'gmail.send:write',
    ]);
  });

  it('never adds a new destructive action to any level', async () => {
    await grantLevels(h);
    h.catalog.push({ slug: 'gmail.empty_trash', classification: 'destructive' });
    await h.preview();

    expect(liveActions(h.db, { agentId: 'reader' })).toEqual(['gmail.list:read']);
    expect(liveActions(h.db, { agentId: 'writer' })).toEqual([
      'gmail.list:read',
      'gmail.send:write',
    ]);
  });

  it('takes an action reclassified from read to write out of Read, and keeps it in Read and write', async () => {
    await grantLevels(h);
    h.catalog[0] = { slug: 'gmail.list', classification: 'write' };
    await h.preview();

    expect(liveActions(h.db, { agentId: 'reader' })).toEqual([]);
    expect(liveActions(h.db, { agentId: 'writer' })).toEqual([
      'gmail.list:write',
      'gmail.send:write',
    ]);
    // The Read level itself is kept, so a read action that comes back joins again.
    h.catalog[0] = { slug: 'gmail.list', classification: 'read' };
    await h.preview();
    expect(liveActions(h.db, { agentId: 'reader' })).toEqual(['gmail.list:read']);
  });

  it('takes an action reclassified to destructive out of every level', async () => {
    await grantLevels(h);
    h.catalog[0] = { slug: 'gmail.list', classification: 'destructive' };
    h.catalog[1] = { slug: 'gmail.send', classification: 'destructive' };
    await h.preview();

    expect(liveActions(h.db, { agentId: 'reader' })).toEqual([]);
    expect(liveActions(h.db, { agentId: 'writer' })).toEqual([]);
    // An exact pick is never re-pointed: it keeps the revision it was given.
    expect(liveActions(h.db, { agentId: 'exact' })).toEqual(['gmail.list:read']);
  });

  it('refuses a level that names anything beyond its class, or leaves out part of it', async () => {
    const snapshot = await h.preview();
    for (const operationRevisionIds of [
      [...levelIds(snapshot, 'read'), idOf(snapshot, 'gmail.send')],
      [...levelIds(snapshot, 'read'), idOf(snapshot, 'gmail.delete')],
      [],
    ]) {
      await expect(
        h.service.apply(OWNER, {
          previewId: snapshot.previewId,
          grants: [{ agentId: 'reader', operationRevisionIds, level: 'read' }],
        })
      ).rejects.toMatchObject({ code: 'invalid_selection' });
    }
    await expect(
      h.service.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [],
        everyAgent: {
          operationRevisionIds: [
            ...levelIds(snapshot, 'read-write'),
            idOf(snapshot, 'gmail.delete'),
          ],
          level: 'read-write',
        },
      })
    ).rejects.toBeInstanceOf(ConnectorReconciliationError);
    expect(storedLevels(h.db)).toEqual([]);
  });

  it('grants a level from the newest catalog, never an older review left open in another tab', async () => {
    const tabA = await h.preview();
    // Meanwhile the list action starts changing things, and tab B reads that.
    h.catalog[0] = { slug: 'gmail.list', classification: 'write' };
    await h.preview();

    const applied = await h.service.apply(OWNER, {
      previewId: tabA.previewId,
      grants: [{ agentId: 'reader', operationRevisionIds: levelIds(tabA, 'read'), level: 'read' }],
    });
    // Tab A's list action is now a write action: Read gets nothing of it.
    expect(liveActions(h.db, { agentId: 'reader' })).toEqual([]);
    // The answer names what was written, so tab A knows to reload.
    expect(applied.grants).toEqual([
      { agentId: 'reader', operationRevisionIds: [], level: 'read' },
    ]);
  });

  it('turns a level into exact actions when the owner picks actions by hand', async () => {
    const snapshot = await grantLevels(h);
    const again = await h.preview();
    await h.service.apply(OWNER, {
      previewId: again.previewId,
      grants: [{ agentId: 'reader', operationRevisionIds: [idOf(snapshot, 'gmail.list')] }],
    });
    h.catalog.push({ slug: 'gmail.search', classification: 'read' });
    const after = await h.preview();

    expect(liveActions(h.db, { agentId: 'reader' })).toEqual(['gmail.list:read']);
    expect(after.currentGrants.find((grant) => grant.agentId === 'reader')).not.toHaveProperty(
      'level'
    );
  });

  describe('a level never brings back access taken away another way', () => {
    /** After the change under test, a new read action must reach nobody it took. */
    async function expectGone(agentIds: string[]) {
      h.catalog.push({ slug: 'gmail.search', classification: 'read' });
      await h.preview();
      for (const agentId of agentIds) {
        expect(liveActions(h.db, { agentId })).not.toContain('gmail.search:read');
      }
    }

    it('when the agent is removed, or loses this account', async () => {
      await grantLevels(h);
      h.registry.removeAgentConnectionAccess('reader', CONNECTION_ID);
      h.registry.removeAgentAccess('writer');
      expect(storedLevels(h.db)).toEqual([]);
      await expectGone(['reader', 'writer']);
      expect(liveActions(h.db, { agentId: 'reader' })).toEqual([]);
    });

    it('when a reviewed request sets exact actions', async () => {
      const snapshot = await grantLevels(h);
      const actions = new ConnectorManagementActionService({
        db: h.db,
        registry: h.registry,
        authorityCleanup: {
          revokeAgent: vi.fn(),
          revokeAgentConnection: vi.fn(),
          revokeConnection: vi.fn(),
        },
      });
      await actions.apply(OWNER, {
        version: 1,
        kind: 'set_agent_access',
        connectionId: CONNECTION_ID,
        agentId: 'reader',
        operationRevisionIds: [idOf(snapshot, 'gmail.list')],
      });
      expect(storedLevels(h.db)).toEqual(['writer:read-write']);
      await expectGone(['reader']);
      expect(liveActions(h.db, { agentId: 'reader' })).toEqual(['gmail.list:read']);
    });

    it('when the account is disconnected', async () => {
      await grantLevels(h);
      h.registry.recordDisconnect(CONNECTION_ID);
      expect(storedLevels(h.db)).toEqual([]);
    });

    it('when every agent stops being shared', async () => {
      const snapshot = await h.preview();
      await h.service.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [],
        everyAgent: { operationRevisionIds: levelIds(snapshot, 'read'), level: 'read' },
      });
      await h.service.revokeEveryAgent(OWNER, CONNECTION_ID);
      expect(storedLevels(h.db)).toEqual([]);
      await expectGone([]);
      expect(liveActions(h.db, 'every_agent')).toEqual([]);
    });

    it('when the way moves to a DorkOS account', async () => {
      const snapshot = await h.preview();
      await h.service.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [
          { agentId: 'reader', operationRevisionIds: levelIds(snapshot, 'read'), level: 'read' },
        ],
        everyAgent: { operationRevisionIds: levelIds(snapshot, 'read'), level: 'read' },
      });
      h.moveToDorkosAccount();
      // Every agent's grant never reached hosted authority, so it ends with its level.
      expect(storedLevels(h.db)).toEqual(['reader:read']);
      await h.preview();
      expect(liveActions(h.db, 'every_agent')).toEqual([]);
    });

    it('for an agent that is no longer registered', async () => {
      await grantLevels(h);
      h.agents.splice(
        h.agents.findIndex((agent) => agent.agentId === 'reader'),
        1
      );
      await expectGone(['reader']);
      expect(liveActions(h.db, { agentId: 'reader' })).toEqual(['gmail.list:read']);
    });
  });

  it('ends every level when a test way is purged', async () => {
    const purged = levelHarness({ type: TEST_CONNECTOR_PROVIDER_TYPE });
    await grantLevels(purged);
    purged.registry.purgeTestConnectorConnections(purged.provider.instanceId);
    expect(storedLevels(purged.db)).toEqual([]);
  });

  it('keeps every agent on its level as the app changes, and says so in Activity', async () => {
    const snapshot = await h.preview();
    await h.service.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [],
      everyAgent: { operationRevisionIds: levelIds(snapshot, 'read'), level: 'read' },
    });
    h.activity.emit.mockClear();
    h.catalog.push({ slug: 'gmail.search', classification: 'read' });
    h.catalog.push({ slug: 'gmail.draft', classification: 'write' });
    const again = await h.preview();

    expect(liveActions(h.db, 'every_agent')).toEqual(['gmail.list:read', 'gmail.search:read']);
    expect(again.everyAgent).toEqual({
      available: true,
      operationRevisionIds: levelIds(again, 'read'),
      level: 'read',
    });
    expect(h.activity.emit).toHaveBeenCalledOnce();
    expect(h.activity.emit.mock.calls[0]![0]).toMatchObject({
      actorType: 'system',
      actorLabel: 'DorkOS',
      resourceId: CONNECTION_ID,
    });

    // Reading the same catalog again changes nothing and records nothing.
    h.activity.emit.mockClear();
    await h.preview();
    expect(h.activity.emit).not.toHaveBeenCalled();
  });

  describe('without anyone opening the card', () => {
    it('follows the catalog for the owner of the way', async () => {
      await grantLevels(h);
      h.catalog.push({ slug: 'gmail.search', classification: 'read' });
      h.catalog[1] = { slug: 'gmail.send', classification: 'destructive' };
      expect(h.service.levelConnectionIds()).toEqual([CONNECTION_ID]);

      await h.service.followCatalog(CONNECTION_ID, new AbortController().signal, '1.0.0');

      expect(liveActions(h.db, { agentId: 'reader' })).toEqual([
        'gmail.list:read',
        'gmail.search:read',
      ]);
      expect(liveActions(h.db, { agentId: 'writer' })).toEqual([
        'gmail.list:read',
        'gmail.search:read',
      ]);
      expect(liveActions(h.db, { agentId: 'exact' })).toEqual(['gmail.list:read']);
    });

    it('records the catalog it read as a review nobody can apply', async () => {
      await grantLevels(h);
      h.catalog.push({ slug: 'gmail.search', classification: 'read' });
      await h.service.followCatalog(CONNECTION_ID, new AbortController().signal, '1.0.0');
      const recorded = h.db
        .select()
        .from(connectorReconciliationPreviews)
        .where(eq(connectorReconciliationPreviews.connectionId, CONNECTION_ID))
        .all()
        .at(-1)!;
      expect(recorded.consumedAt).not.toBeNull();
      await expect(
        h.service.apply(OWNER, { previewId: recorded.id, grants: [] })
      ).rejects.toMatchObject({ code: 'preview_stale' });
    });

    const follow = (version = '1.0.0') =>
      h.service.followCatalog(CONNECTION_ID, new AbortController().signal, version);
    const reviews = () =>
      h.db
        .select()
        .from(connectorReconciliationPreviews)
        .where(eq(connectorReconciliationPreviews.connectionId, CONNECTION_ID))
        .all();

    it('keeps at most one review of its own per account, and never removes an owner’s', async () => {
      await grantLevels(h);
      const owners = reviews().map((review) => review.id);
      for (let pass = 0; pass < 4; pass += 1) {
        h.catalog.push({ slug: `gmail.read_${pass}`, classification: 'read' });
        await follow();
      }
      const kept = reviews();
      expect(kept.filter((review) => !owners.includes(review.id))).toHaveLength(1);
      expect(kept.map((review) => review.id)).toEqual(expect.arrayContaining(owners));
      expect(liveActions(h.db, { agentId: 'reader' })).toHaveLength(5);
    });

    it('writes no review when the catalog and every level are unchanged', async () => {
      await grantLevels(h);
      h.catalog.push({ slug: 'gmail.search', classification: 'read' });
      await follow();
      const before = {
        reviews: reviews().map((review) => review.id),
        candidates: h.db.select().from(connectorReconciliationCandidates).all().length,
        grants: h.db.select().from(connectionOperationGrants).all(),
      };
      await follow();
      await follow();
      expect(reviews().map((review) => review.id)).toEqual(before.reviews);
      expect(h.db.select().from(connectorReconciliationCandidates).all()).toHaveLength(
        before.candidates
      );
      expect(h.db.select().from(connectionOperationGrants).all()).toEqual(before.grants);
    });

    it('keeps its review when only the catalog changed, so the newest review is the newest catalog', async () => {
      await grantLevels(h);
      const before = reviews().map((review) => review.id);
      // A new delete action joins no level: nothing moves, but the catalog did.
      h.catalog.push({ slug: 'gmail.empty_trash', classification: 'destructive' });
      await follow();
      expect(liveActions(h.db, { agentId: 'reader' })).toEqual(['gmail.list:read']);

      const added = reviews().filter((review) => !before.includes(review.id));
      expect(added).toHaveLength(1);
      const recorded = h.db
        .select({ slug: connectorOperationRevisions.operationSlug })
        .from(connectorReconciliationCandidates)
        .innerJoin(
          connectorOperationRevisions,
          eq(connectorOperationRevisions.id, connectorReconciliationCandidates.operationRevisionId)
        )
        .where(eq(connectorReconciliationCandidates.previewId, added[0]!.id))
        .all()
        .map((row) => row.slug);
      expect(recorded).toContain('gmail.empty_trash');
    });

    it('says when it last followed an account, and under which version', async () => {
      await grantLevels(h);
      const earlier = new Date(Date.parse('2026-09-29T00:00:00.000Z')).toISOString();
      expect(h.service.followedSince(CONNECTION_ID, earlier, '1.0.0')).toBe(false);
      await follow('1.0.0');
      expect(h.service.followedSince(CONNECTION_ID, earlier, '1.0.0')).toBe(true);
      // An update always follows again: it can classify actions differently.
      expect(h.service.followedSince(CONNECTION_ID, earlier, '1.1.0')).toBe(false);
      expect(h.service.followedSince(CONNECTION_ID, '2026-09-30T00:00:00.000Z', '1.0.0')).toBe(
        false
      );
    });

    it('lists only connected accounts with a level on them', async () => {
      expect(h.service.levelConnectionIds()).toEqual([]);
      await grantLevels(h);
      expect(h.service.levelConnectionIds()).toEqual([CONNECTION_ID]);
    });
  });
});
