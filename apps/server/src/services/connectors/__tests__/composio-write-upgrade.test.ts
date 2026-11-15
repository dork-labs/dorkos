/** Existing level choices never silently acquire writes after the catalog policy changes. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  activityEvents,
  connectionAccessLevels,
  connectionOperationGrants,
  connectorOperationRevisions,
  connections,
  eq,
  notifications,
} from '@dorkos/db';
import { createConnectorAccess } from '../access/connector-access.js';
import { upgradeComposioWriteLevels } from '../access/composio-write-upgrade.js';
import {
  CONNECTION_ID,
  grantLevels,
  levelHarness,
  liveActions,
  NOW,
  storedLevels,
} from './helpers/access-levels-harness.js';

const opened: ReturnType<typeof levelHarness>[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.db.$client.close();
});
async function setup(toolkit: string, type = 'composio', managed = false) {
  const h = levelHarness({ type, managed });
  opened.push(h);
  await grantLevels(h);
  h.db.update(connections).set({ toolkit }).where(eq(connections.id, CONNECTION_ID)).run();
  return h;
}

describe('one-time Composio write upgrade', () => {
  it('runs from connector startup before any catalog following can start', async () => {
    const h = await setup('linear');
    createConnectorAccess({
      db: h.db,
      registry: h.registry,
      bootEpoch: 'boot-upgrade',
      agents: () => [],
      config: { get: () => undefined, set: () => {} } as never,
    });
    expect(storedLevels(h.db)).toEqual(['reader:read', 'writer:read']);
    expect(h.db.select().from(notifications).all()).toHaveLength(1);
  });
  it('lowers a stored Linear write level and queues one notice and one Activity row', async () => {
    const h = await setup('linear');
    expect(upgradeComposioWriteLevels(h.db, NOW.toISOString())).toBe(1);
    expect(storedLevels(h.db)).toEqual(['reader:read', 'writer:read']);
    expect(liveActions(h.db, { agentId: 'writer' })).toEqual(['gmail.list:read']);
    expect(h.db.select().from(notifications).all()).toMatchObject([
      { kind: 'connector.write_available', subjectId: CONNECTION_ID, readAt: null },
    ]);
    expect(
      h.db
        .select()
        .from(activityEvents)
        .all()
        .filter((x) => x.eventType === 'connectors.write_upgrade')
    ).toMatchObject([
      {
        resourceId: CONNECTION_ID,
        metadata: JSON.stringify({
          subjectType: 'agent',
          subjectId: 'writer',
          before: 'read-write',
          after: 'read',
        }),
      },
    ]);
  });
  it.each(['gmail', 'googlecalendar'])('leaves %s levels untouched', async (toolkit) => {
    const h = await setup(toolkit);
    expect(upgradeComposioWriteLevels(h.db, NOW.toISOString())).toBe(0);
    expect(storedLevels(h.db)).toEqual(['reader:read', 'writer:read-write']);
    expect(h.db.select().from(notifications).all()).toEqual([]);
  });
  it('leaves exact grants untouched', async () => {
    const h = await setup('linear');
    const writeRevision = h.db
      .select()
      .from(connectorOperationRevisions)
      .all()
      .find((row) => row.capabilityClassification === 'write');
    if (!writeRevision) throw new Error('The fixture must offer a write action.');
    const writeGrant = h.db
      .select()
      .from(connectionOperationGrants)
      .all()
      .find((row) => row.subjectId === 'writer' && row.operationRevisionId === writeRevision.id);
    if (!writeGrant) throw new Error('The fixture writer must hold that write action.');
    h.db
      .insert(connectionOperationGrants)
      .values({ ...writeGrant, id: 'exact-write', subjectId: 'exact', agentId: 'exact' })
      .run();
    const before = h.db
      .select()
      .from(connectionOperationGrants)
      .all()
      .filter((x) => x.subjectId === 'exact');
    upgradeComposioWriteLevels(h.db, NOW.toISOString());
    expect(before).toHaveLength(2);
    expect(
      h.db
        .select()
        .from(connectionOperationGrants)
        .all()
        .filter((x) => x.subjectId === 'exact')
    ).toEqual(before);
    expect(liveActions(h.db, { agentId: 'exact' })).toEqual([
      'gmail.list:read',
      'gmail.send:write',
    ]);
  });
  it('lowers every-agent sharing too, with one notice per connection and one row per level', async () => {
    const h = await setup('linear');
    h.db
      .insert(connectionAccessLevels)
      .values({
        subjectType: 'every_agent',
        subjectId: 'every_agent',
        agentId: null,
        connectionId: CONNECTION_ID,
        level: 'read-write',
        createdBy: 'install-a',
        updatedAt: NOW.toISOString(),
      })
      .run();
    const grants = h.db
      .select()
      .from(connectionOperationGrants)
      .all()
      .filter((x) => x.subjectId === 'writer');
    for (const grant of grants)
      h.db
        .insert(connectionOperationGrants)
        .values({
          ...grant,
          id: `shared-${grant.id}`,
          subjectType: 'every_agent',
          subjectId: 'every_agent',
          agentId: null,
        })
        .run();
    expect(upgradeComposioWriteLevels(h.db, NOW.toISOString())).toBe(2);
    expect(storedLevels(h.db)).toEqual(['every_agent:read', 'reader:read', 'writer:read']);
    expect(liveActions(h.db, 'every_agent')).toEqual(['gmail.list:read']);
    expect(h.db.select().from(notifications).all()).toHaveLength(1);
    expect(
      h.db
        .select()
        .from(activityEvents)
        .all()
        .filter((x) => x.eventType === 'connectors.write_upgrade')
    ).toHaveLength(2);
  });
  it('runs only once, preserving a later choice to allow writes', async () => {
    const h = await setup('linear');
    expect(upgradeComposioWriteLevels(h.db, NOW.toISOString())).toBe(1);
    h.db
      .update(connectionAccessLevels)
      .set({ level: 'read-write' })
      .where(eq(connectionAccessLevels.subjectId, 'writer'))
      .run();
    expect(upgradeComposioWriteLevels(h.db, NOW.toISOString())).toBe(0);
    expect(storedLevels(h.db)).toEqual(['reader:read', 'writer:read-write']);
    expect(h.db.select().from(notifications).all()).toHaveLength(1);
  });
  it('retires pending hosted writes so recovery cannot reopen them', async () => {
    const h = await setup('linear', 'dorkos-managed', true);
    h.answer('pending');
    h.db
      .update(connections)
      .set({ toolkit: 'gmail' })
      .where(eq(connections.id, CONNECTION_ID))
      .run();
    await grantLevels(h);
    h.db
      .update(connections)
      .set({ toolkit: 'linear' })
      .where(eq(connections.id, CONNECTION_ID))
      .run();
    expect(upgradeComposioWriteLevels(h.db, '2026-11-15T23:00:00.000Z')).toBe(1);
    await h.applyPending();
    expect(storedLevels(h.db)).toEqual(['reader:read', 'writer:read']);
    expect(liveActions(h.db, { agentId: 'writer' })).toEqual(['gmail.list:read']);
  });
  it('leaves other ways of connecting untouched', async () => {
    const h = await setup('linear', 'nango');
    expect(upgradeComposioWriteLevels(h.db, NOW.toISOString())).toBe(0);
    expect(storedLevels(h.db)).toEqual(['reader:read', 'writer:read-write']);
  });
  it('rolls back levels and the marker if the notice cannot be stored', async () => {
    const h = await setup('linear');
    h.db.$client.exec(
      "CREATE TRIGGER refuse_notice BEFORE INSERT ON notifications BEGIN SELECT RAISE(ABORT, 'notice unavailable'); END;"
    );
    expect(() => upgradeComposioWriteLevels(h.db, NOW.toISOString())).toThrow('notice unavailable');
    expect(storedLevels(h.db)).toEqual(['reader:read', 'writer:read-write']);
    h.db.$client.exec('DROP TRIGGER refuse_notice');
    expect(upgradeComposioWriteLevels(h.db, NOW.toISOString())).toBe(1);
  });
});
