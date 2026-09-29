/**
 * Levels on an app connected through a DorkOS account (ADR 260929-071355):
 * a level follows the app through the same close-first staging as any owner
 * change, so nothing widens before hosted authority applies it, and a level
 * hosted authority refuses for good ends rather than promising access the
 * agent does not have.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { and, connectionOperationGrants, eq, isNull } from '@dorkos/db';
import { ConnectionIdSchema } from '@dorkos/shared/connector-schemas';
import { ConnectorManagementActionService } from '../management-action-service.js';
import {
  CONNECTION_ID,
  OWNER,
  grantLevels,
  hostedRef,
  idOf,
  levelHarness,
  levelIds,
  liveActions,
  storedLevels,
  type LevelHarness,
} from './helpers/access-levels-harness.js';

describe('levels follow the app through a DorkOS account', () => {
  let h: LevelHarness;

  beforeEach(() => {
    h = levelHarness({ managed: true });
  });

  async function giveReaderRead() {
    const snapshot = await h.preview();
    await h.service.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [
        { agentId: 'reader', operationRevisionIds: levelIds(snapshot, 'read'), level: 'read' },
      ],
    });
    return snapshot;
  }

  it('stages a new read action through hosted authority, and opens it only once it applies', async () => {
    await giveReaderRead();
    expect(liveActions(h.db, { agentId: 'reader' })).toEqual(['gmail.list:read']);

    h.answer('pending');
    h.submitted.length = 0;
    h.catalog.push({ slug: 'gmail.search', classification: 'read' });
    await h.preview();
    expect(h.submitted).toEqual([
      expect.objectContaining({
        kind: 'replace_agent_grants',
        agentId: 'reader',
        revisions: expect.arrayContaining([
          expect.objectContaining({ hostedRevisionId: hostedRef('gmail.list', 'read') }),
          expect.objectContaining({ hostedRevisionId: hostedRef('gmail.search', 'read') }),
        ]),
      }),
    ]);
    // Not wider before hosted authority confirms it.
    expect(liveActions(h.db, { agentId: 'reader' })).toEqual(['gmail.list:read']);

    // Reading the catalog again while it waits stages nothing new.
    await h.preview();
    expect(h.submitted).toHaveLength(1);

    await h.applyPending();
    expect(liveActions(h.db, { agentId: 'reader' })).toEqual([
      'gmail.list:read',
      'gmail.search:read',
    ]);
  });

  it('closes an action reclassified out of Read at once, before hosted authority answers', async () => {
    await giveReaderRead();
    h.answer('pending');
    h.catalog[0] = { slug: 'gmail.list', classification: 'write' };
    await h.preview();
    expect(liveActions(h.db, { agentId: 'reader' })).toEqual([]);
    expect(h.submitted.at(-1)).toMatchObject({ kind: 'replace_agent_grants', revisions: [] });
  });

  it('moves Read and write onto a reclassified action, keeps the old one closed, and settles', async () => {
    const before = await grantLevels(h);
    const oldList = idOf(before, 'gmail.list');
    h.catalog[0] = { slug: 'gmail.list', classification: 'write' };
    await h.preview();
    // The reclassified action is a new hosted revision; Read and write holds that one.
    expect(h.submitted.at(-1)).toMatchObject({
      kind: 'replace_agent_grants',
      agentId: 'writer',
      revisions: expect.arrayContaining([
        expect.objectContaining({ hostedRevisionId: hostedRef('gmail.list', 'write') }),
      ]),
    });
    expect(liveActions(h.db, { agentId: 'writer' })).toEqual([
      'gmail.list:write',
      'gmail.send:write',
    ]);
    // The old read revision stays closed for it, even after hosted authority applied.
    expect(
      h.db
        .select()
        .from(connectionOperationGrants)
        .where(
          and(
            eq(connectionOperationGrants.subjectId, 'writer'),
            eq(connectionOperationGrants.operationRevisionId, oldList),
            isNull(connectionOperationGrants.revokedAt)
          )
        )
        .all()
    ).toEqual([]);
    // Reading the same catalog again sends nothing new.
    const sent = h.submitted.length;
    await h.preview();
    expect(h.submitted).toHaveLength(sent);
  });

  describe('a level hosted authority refuses for good', () => {
    it('ends, so the card shows what the agent really holds, and picking it again sends it again', async () => {
      h.answer('rejected');
      const snapshot = await h.preview();
      await h.service.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [
          {
            agentId: 'writer',
            operationRevisionIds: levelIds(snapshot, 'read-write'),
            level: 'read-write',
          },
        ],
      });
      expect(liveActions(h.db, { agentId: 'writer' })).toEqual([]);
      expect(storedLevels(h.db)).toEqual([]);
      const after = await h.preview();
      expect(after.currentGrants.find((grant) => grant.agentId === 'writer')).toBeUndefined();

      h.answer('applied');
      const sent = h.submitted.length;
      await h.service.apply(OWNER, {
        previewId: after.previewId,
        grants: [
          {
            agentId: 'writer',
            operationRevisionIds: levelIds(after, 'read-write'),
            level: 'read-write',
          },
        ],
      });
      expect(h.submitted.length).toBe(sent + 1);
      expect(liveActions(h.db, { agentId: 'writer' })).toEqual([
        'gmail.list:read',
        'gmail.send:write',
      ]);
      expect(storedLevels(h.db)).toEqual(['writer:read-write']);
    });

    it('ends for every agent too, and sharing the same level again goes through', async () => {
      h.answer('rejected');
      const snapshot = await h.preview();
      await h.service.apply(OWNER, {
        previewId: snapshot.previewId,
        grants: [],
        everyAgent: { operationRevisionIds: levelIds(snapshot, 'read-write'), level: 'read-write' },
      });
      const after = await h.preview();
      expect(after.everyAgent).toEqual({ available: true, operationRevisionIds: [] });

      h.answer('applied');
      await h.service.apply(OWNER, {
        previewId: after.previewId,
        grants: [],
        everyAgent: { operationRevisionIds: levelIds(after, 'read-write'), level: 'read-write' },
      });
      expect(liveActions(h.db, 'every_agent')).toEqual(['gmail.list:read', 'gmail.send:write']);
    });

    it('keeps a level DorkOS was following on its own, and sends it again next time', async () => {
      await giveReaderRead();
      h.answer('rejected');
      h.catalog.push({ slug: 'gmail.search', classification: 'read' });
      await h.preview();
      // The refused change was DorkOS following the app, not the owner's choice.
      expect(storedLevels(h.db)).toEqual(['reader:read']);
      expect(liveActions(h.db, { agentId: 'reader' })).toEqual(['gmail.list:read']);

      h.answer('applied');
      const sent = h.submitted.length;
      await h.service.followCatalog(CONNECTION_ID, new AbortController().signal, '1.0.0');
      expect(h.submitted.length).toBe(sent + 1);
      expect(liveActions(h.db, { agentId: 'reader' })).toEqual([
        'gmail.list:read',
        'gmail.search:read',
      ]);
    });

    it('keeps the level when this computer’s link to the DorkOS account lapses', async () => {
      h.answer('unauthorized');
      await giveReaderRead();
      expect(storedLevels(h.db)).toEqual(['reader:read']);
    });

    it('ends when the command fails for good on the way there', async () => {
      h.answer('conflict');
      await giveReaderRead();
      expect(storedLevels(h.db)).toEqual([]);
      expect(liveActions(h.db, { agentId: 'reader' })).toEqual([]);
    });
  });

  it('sends a level hosted authority never heard of, such as one kept from the owner’s own key', async () => {
    const byo = levelHarness();
    const snapshot = await byo.preview();
    await byo.service.apply(OWNER, {
      previewId: snapshot.previewId,
      grants: [
        { agentId: 'reader', operationRevisionIds: levelIds(snapshot, 'read'), level: 'read' },
      ],
    });
    byo.moveToDorkosAccount();
    await byo.preview();
    expect(byo.submitted).toEqual([
      expect.objectContaining({
        kind: 'replace_agent_grants',
        agentId: 'reader',
        revisions: [expect.objectContaining({ hostedRevisionId: hostedRef('gmail.list', 'read') })],
      }),
    ]);
  });

  describe('a level never brings back access taken away another way', () => {
    function actions() {
      return new ConnectorManagementActionService({
        db: h.db,
        registry: h.registry,
        authorityCleanup: {
          revokeAgent: vi.fn(),
          revokeAgentConnection: vi.fn(),
          revokeConnection: vi.fn(),
        },
        managedAuthority: h.sync!,
      });
    }

    it('when a reviewed request sets exact actions', async () => {
      const snapshot = await grantLevels(h);
      await actions().apply(OWNER, {
        version: 1,
        kind: 'set_agent_access',
        connectionId: CONNECTION_ID,
        agentId: 'reader',
        operationRevisionIds: [idOf(snapshot, 'gmail.list')],
      });
      expect(storedLevels(h.db)).toEqual(['writer:read-write']);
      h.catalog.push({ slug: 'gmail.search', classification: 'read' });
      await h.preview();
      expect(liveActions(h.db, { agentId: 'reader' })).toEqual(['gmail.list:read']);
    });

    it('when the agent loses this account', async () => {
      await grantLevels(h);
      await actions().apply(OWNER, {
        version: 1,
        kind: 'remove_agent_access',
        connectionId: CONNECTION_ID,
        agentId: 'reader',
      });
      expect(storedLevels(h.db)).toEqual(['writer:read-write']);
      h.catalog.push({ slug: 'gmail.search', classification: 'read' });
      await h.preview();
      expect(liveActions(h.db, { agentId: 'reader' })).toEqual([]);
    });

    it('when the account is disconnected', async () => {
      await grantLevels(h);
      await h.sync!.transition({
        connectionId: ConnectionIdSchema.parse(CONNECTION_ID),
        managedConnectionId: 'external-a',
        lifecycle: 'disconnected',
        providerInstanceId: h.provider.instanceId,
        executionConfigGeneration: 1,
        owner: OWNER,
        signal: new AbortController().signal,
      });
      expect(storedLevels(h.db)).toEqual([]);
    });
  });
});
