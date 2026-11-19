/** Existing level choices never silently acquire writes after the catalog policy changes. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  activityEvents,
  connectionAccessLevels,
  connectionOperationGrants,
  connectorManagedAuthorityOutbox,
  connectorOperationRevisions,
  connections,
  eq,
  notifications,
} from '@dorkos/db';
import { ConnectorProviderInstanceIdSchema } from '@dorkos/shared/connector-schemas';
import { createConnectorAccess } from '../access/connector-access.js';
import {
  upgradeComposioWriteLevels,
  WRITE_UPGRADE_SET_ASIDE,
} from '../access/composio-write-upgrade.js';
import {
  CONNECTION_ID,
  grantLevels,
  hostedRef,
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
  it.each([
    ['Work', 'Linear (Work) access changed to Read'],
    ['Linear', 'Linear access changed to Read'],
    [' linear ', 'Linear access changed to Read'],
  ])('names the access change without repeating the app label %j', async (label, title) => {
    const h = await setup('linear');
    h.db.update(connections).set({ label }).where(eq(connections.id, CONNECTION_ID)).run();
    upgradeComposioWriteLevels(h.db, NOW.toISOString());
    expect(h.db.select().from(notifications).all()).toMatchObject([
      {
        title,
        body: 'Linear now allows changes. Your agents stay on Read until you choose Read and write.',
      },
    ]);
  });
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
  // A relink resends commands the old link never applied. What the upgrade set
  // aside it took away on purpose, so a resend must not bring it back, whether
  // the upgrade's clock reads later, the same or earlier than the command's
  // (DOR-4510). Before the fix only a strict timestamp comparison stopped it.
  it.each([
    ['later than', '2026-11-15T23:00:00.000Z'],
    ['the same as', NOW.toISOString()],
    ['earlier than', '2026-09-29T11:00:00.000Z'],
  ])(
    'keeps writes away after a relink, with the upgrade clock %s the command',
    async (_when, upgradedAt) => {
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
      expect(upgradeComposioWriteLevels(h.db, upgradedAt)).toBe(1);
      h.answer('applied');
      const sent = h.submitted.length;
      const { providerInstanceId } = h.db
        .select({ providerInstanceId: connections.providerInstanceId })
        .from(connections)
        .where(eq(connections.id, CONNECTION_ID))
        .get()!;
      await h.sync!.restageAfterRelink(
        ConnectorProviderInstanceIdSchema.parse(providerInstanceId),
        new AbortController().signal
      );
      await h.applyPending();
      expect(storedLevels(h.db)).toEqual(['reader:read', 'writer:read']);
      expect(liveActions(h.db, { agentId: 'writer' })).toEqual(['gmail.list:read']);
      // The relink still narrows the hosted side: it sends what Writer holds
      // now, read only, never the selection the upgrade set aside.
      const resent = h.submitted
        .slice(sent)
        .filter(
          (command) => command.kind === 'replace_agent_grants' && command.agentId === 'writer'
        );
      expect(resent).not.toEqual([]);
      for (const command of resent) {
        if (command.kind !== 'replace_agent_grants') continue;
        expect(command.revisions.map((revision) => revision.hostedRevisionId)).toEqual([
          hostedRef('gmail.list', 'read'),
        ]);
      }
    }
  );
  it('marks each hosted command it sets aside with its own reason', async () => {
    const h = await setup('linear', 'dorkos-managed', true);
    h.answer('pending');
    await grantLevels(h);
    upgradeComposioWriteLevels(h.db, NOW.toISOString());
    const setAside = h.db
      .select({ safeReason: connectorManagedAuthorityOutbox.safeReason })
      .from(connectorManagedAuthorityOutbox)
      .where(eq(connectorManagedAuthorityOutbox.state, 'superseded'))
      .all();
    expect(setAside.length).toBeGreaterThan(0);
    expect(setAside.every((row) => row.safeReason === WRITE_UPGRADE_SET_ASIDE)).toBe(true);
  });
  // 0.136.0 ran the upgrade before the stamp existed, so what it set aside on
  // those installs carries no reason. A relink must still keep the writes away
  // (DOR-4735), and must still send the saved choice for anything else.
  describe('commands set aside before the stamp existed', () => {
    function writerSelections(commands: ReturnType<typeof levelHarness>['submitted']) {
      const selections: string[][] = [];
      for (const command of commands) {
        if (command.kind !== 'replace_agent_grants' || command.agentId !== 'writer') continue;
        selections.push(command.revisions.map((revision) => revision.hostedRevisionId));
      }
      return selections;
    }
    async function relinkWriterCommands(h: Awaited<ReturnType<typeof setup>>) {
      h.answer('applied');
      const sent = h.submitted.length;
      const { providerInstanceId } = h.db
        .select({ providerInstanceId: connections.providerInstanceId })
        .from(connections)
        .where(eq(connections.id, CONNECTION_ID))
        .get()!;
      await h.sync!.restageAfterRelink(
        ConnectorProviderInstanceIdSchema.parse(providerInstanceId),
        new AbortController().signal
      );
      await h.applyPending();
      return writerSelections(h.submitted.slice(sent));
    }

    it.each([
      ['the same as', NOW.toISOString()],
      ['earlier than', '2026-09-29T11:00:00.000Z'],
    ])(
      'keeps writes away after a relink, with the upgrade clock %s the command',
      async (_when, upgradedAt) => {
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
        expect(upgradeComposioWriteLevels(h.db, upgradedAt)).toBe(1);
        // Leave the set-aside rows as 0.136.0 did: superseded, no reason.
        const unstamped = h.db
          .update(connectorManagedAuthorityOutbox)
          .set({ safeReason: null })
          .where(eq(connectorManagedAuthorityOutbox.state, 'superseded'))
          .run().changes;
        expect(unstamped).toBeGreaterThan(0);
        const resent = await relinkWriterCommands(h);
        expect(storedLevels(h.db)).toEqual(['reader:read', 'writer:read']);
        expect(liveActions(h.db, { agentId: 'writer' })).toEqual(['gmail.list:read']);
        expect(resent).not.toEqual([]);
        for (const revisions of resent)
          expect(revisions).toEqual([hostedRef('gmail.list', 'read')]);
      }
    );
    it('still sends the saved choice for a change set aside at another time', async () => {
      const h = await setup('gmail', 'dorkos-managed', true);
      h.answer('pending');
      await grantLevels(h);
      // The upgrade ran and lowered nothing here (Gmail keeps its writes).
      expect(upgradeComposioWriteLevels(h.db, NOW.toISOString())).toBe(0);
      const saved = writerSelections(h.submitted).at(-1)!;
      expect(saved).not.toEqual([hostedRef('gmail.list', 'read')]);
      // Set aside by something else, later, with no reason: not the upgrade.
      h.db
        .update(connectorManagedAuthorityOutbox)
        .set({ state: 'superseded', resolvedAt: '2026-11-16T09:00:00.000Z', safeReason: null })
        .where(eq(connectorManagedAuthorityOutbox.state, 'pending'))
        .run();
      const resent = await relinkWriterCommands(h);
      expect(resent).toEqual([saved]);
      expect(storedLevels(h.db)).toEqual(['reader:read', 'writer:read-write']);
    });
    it('still sends the saved choice when the upgrade never ran', async () => {
      const h = await setup('gmail', 'dorkos-managed', true);
      h.answer('pending');
      await grantLevels(h);
      const saved = writerSelections(h.submitted).at(-1)!;
      expect(saved).not.toEqual([hostedRef('gmail.list', 'read')]);
      // No marker at all, so nothing can match its completion time.
      h.db
        .update(connectorManagedAuthorityOutbox)
        .set({ state: 'superseded', resolvedAt: NOW.toISOString(), safeReason: null })
        .where(eq(connectorManagedAuthorityOutbox.state, 'pending'))
        .run();
      expect(await relinkWriterCommands(h)).toEqual([saved]);
    });
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
