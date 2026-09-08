/** @vitest-environment node */
import { createHmac } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectorEventPayloadProtector } from '@dorkos/connector-providers';
import type {
  ConnectorEventCapability,
  ConnectorVerifiedEvent,
} from '@dorkos/shared/connector-events';
import {
  CONNECTOR_EVENT_DELIVERY_WINDOW_MS,
  CONNECTOR_EVENT_METADATA_WINDOW_MS,
} from '@dorkos/shared/connector-event-schemas';
import * as eventConfig from '../config';
import * as eventProtection from '../event-protection';
import * as dbClient from '@/db/client';
import { POST as receiveSignedEvent } from '@/app/api/connectors/managed/events/route';
import * as schema from '@/db/schema';
import {
  applyManagedAuthorityCommand,
  managedRequestHash,
  resolveConnectorTenant,
  registerManagedProvider,
  type ManagedAuthorityProviderContext,
  type ManagedConnectorDatabase,
} from '../authority-service';
import { listManagedEventDefinitions } from '../event-discovery-service';
import * as eventCleanup from '../event-cleanup-service';
import * as authModule from '@/lib/auth';
import * as cleanupModule from '@/lib/cleanup-service';
import { env } from '@/env';
import { GET as cleanupCron } from '@/app/api/cron/cleanup/route';
import { recoverManagedEventCleanup } from '../event-cleanup-service';
import { acceptManagedConnectorEvent } from '../event-ingress-service';
import {
  acknowledgeManagedConnectorEvents,
  pullManagedConnectorEvents,
  sweepManagedConnectorEventRetention,
} from '../event-delivery-service';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../../drizzle/', import.meta.url));
const now = new Date('2026-09-07T12:00:00.000Z');
const definition = {
  eventType: 'GMAIL_NEW_GMAIL_MESSAGE',
  displayName: 'New email',
  toolkit: 'gmail',
  toolkitVersion: '20260901_00',
  definitionHash: `sha256:${'a'.repeat(64)}`,
  filterSchema: { type: 'object', additionalProperties: false },
  payloadSchema: {},
  deliveryMode: 'webhook' as const,
  expectedCadenceSeconds: null,
};
const protector = new ConnectorEventPayloadProtector({
  activeKeyId: 'k1',
  keys: new Map([['k1', Buffer.alloc(32, 7)]]),
});
async function provisionBase(client: PGlite, recovery = true): Promise<void> {
  await client.exec(`
    CREATE TABLE "user" (
      "id" text PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "email" text NOT NULL,
      "email_verified" boolean DEFAULT false NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "updated_at" timestamp DEFAULT now() NOT NULL
    );
    CREATE TABLE "instance" (
      "id" text PRIMARY KEY NOT NULL,
      "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
      "name" text NOT NULL,
      "platform" text NOT NULL,
      "dorkos_version" text NOT NULL,
      "created_at" timestamp DEFAULT now() NOT NULL,
      "last_seen_at" timestamp DEFAULT now() NOT NULL,
      "revoked_at" timestamp
    );
    CREATE TABLE "apikey" (
      "id" text PRIMARY KEY NOT NULL,
      "reference_id" text NOT NULL,
      "enabled" boolean DEFAULT true,
      "expires_at" timestamp,
      "permissions" text,
      "metadata" text
    );
    INSERT INTO "user" ("id", "name", "email") VALUES
      ('owner-a', 'Owner A', 'a@dork.test'),
      ('owner-b', 'Owner B', 'b@dork.test');
    INSERT INTO "instance" ("id", "user_id", "name", "platform", "dorkos_version") VALUES
      ('instance-a', 'owner-a', 'A', 'darwin', '1.0.0'),
      ('instance-c', 'owner-a', 'C', 'darwin', '1.0.0'),
      ('instance-b', 'owner-b', 'B', 'linux', '1.0.0');
    INSERT INTO "apikey" ("id", "reference_id", "enabled", "permissions", "metadata") VALUES
      ('key-a', 'owner-a', true, '{"instance":["link"],"connectors":["authority","execute","usage","events"]}', '{"instanceId":"instance-a","scope":"instance"}'),
      ('key-c', 'owner-a', true, '{"instance":["link"],"connectors":["authority","execute","usage","events"]}', '{"instanceId":"instance-c","scope":"instance"}'),
      ('key-b', 'owner-b', true, '{"instance":["link"],"connectors":["authority","execute","usage","events"]}', '{"instanceId":"instance-b","scope":"instance"}');
  `);
  for (const prefix of recovery ? ['0011_', '0012_', '0013_'] : ['0011_', '0012_']) {
    const name = readdirSync(MIGRATIONS_DIR).find(
      (value) => value.startsWith(prefix) && value.endsWith('.sql')
    );
    if (!name) throw new Error('Event migration missing.');
    await client.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
  }
}

describe('managed signed event persistence and handoff', () => {
  let client: PGlite;
  let db: ManagedConnectorDatabase;
  beforeEach(async () => {
    client = new PGlite();
    await provisionBase(client);
    db = drizzle(client, { schema }) as unknown as ManagedConnectorDatabase;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await client.close();
  });

  async function seed(ownerId = 'owner-a', instanceId = 'instance-a') {
    const tenant = await resolveConnectorTenant(db, ownerId);
    const generation = await registerManagedProvider(db, {
      tenantId: tenant.id,
      providerInstanceId: 'managed:composio',
      configurationDigest: 'event-config',
    });
    await db.insert(schema.managedConnectorConnection).values({
      tenantId: tenant.id,
      id: 'gmail',
      originatingInstanceId: instanceId,
      providerInstanceId: 'managed:composio',
      providerUserId: tenant.providerUserId,
      externalAccountRef: `ca_${ownerId}`,
      toolkit: 'gmail',
      authConfigId: 'ac_gmail',
      label: 'Email',
      lifecycle: 'active',
      authenticationStatus: 'active',
      materialGeneration: generation,
    });
    const [d] = await db
      .insert(schema.managedConnectorEventDefinition)
      .values({
        tenantId: tenant.id,
        providerInstanceId: 'managed:composio',
        toolkit: 'gmail',
        eventType: definition.eventType,
        definitionHash: definition.definitionHash,
        definition,
      })
      .returning();
    const [binding] = await db
      .insert(schema.managedConnectorEventBinding)
      .values({
        tenantId: tenant.id,
        providerInstanceId: 'managed:composio',
        providerGeneration: generation,
        externalAccountRef: `ca_${ownerId}`,
        definitionId: d.id,
        filterHash: managedRequestHash({}),
        filter: {},
        providerTriggerRef: `tr_${ownerId}`,
        providerTriggerUuid: `trigger-uuid-${ownerId}`,
        externalAccountUuid: `account-uuid-${ownerId}`,
        state: 'ready',
      })
      .returning();
    await db.insert(schema.managedConnectorEventSubscription).values({
      tenantId: tenant.id,
      id: 'subscription',
      connectionId: 'gmail',
      targetInstanceId: instanceId,
      bindingId: binding.id,
      agentId: 'agent',
      destinationKind: 'agent',
      destinationId: 'agent',
      scopeVersion: 1,
      connectionGeneration: 1,
      enabled: true,
    });
    const event: ConnectorVerifiedEvent = {
      envelopeVersion: 'V2',
      authenticatedWebhookId: 'wh-delivery-1',
      providerTriggerRef: binding.providerTriggerRef!,
      providerTriggerUuid: binding.providerTriggerUuid!,
      externalAccountRef: binding.externalAccountRef,
      externalAccountUuid: binding.externalAccountUuid!,
      providerUserRef: tenant.providerUserId,
      eventType: definition.eventType,
      payload: {
        subject: 'Sensitive subject',
        body: 'Untrusted email text',
        token: 'private-token',
      },
    };
    return {
      tenant,
      binding,
      event,
      principal: {
        ownerId,
        tenantId: tenant.id,
        instanceId,
        keyId: ownerId === 'owner-a' ? 'key-a' : 'key-b',
      },
    };
  }
  const inbox = () => db.select().from(schema.managedConnectorEventInbox);

  it('stores encrypted content once and preserves original expiry on signed redelivery', async () => {
    const { event } = await seed();
    expect(await acceptManagedConnectorEvent(db, event, protector, now)).toBe('accepted');
    const [first] = await inbox();
    expect(first.protectedPayload).not.toContain('Sensitive');
    expect(first.protectedPayload).not.toContain('private-token');
    expect(first.expiresAt.getTime()).toBe(now.getTime() + CONNECTOR_EVENT_DELIVERY_WINDOW_MS);
    expect(
      await acceptManagedConnectorEvent(db, event, protector, new Date(now.getTime() + 86_400_000))
    ).toBe('accepted');
    const rows = await inbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(first);
  });

  it.each([
    'providerUserRef',
    'providerTriggerUuid',
    'externalAccountUuid',
    'externalAccountRef',
    'providerTriggerRef',
  ] as const)('rejects a mismatched signed %s without persisting payload', async (field) => {
    const { event } = await seed();
    expect(
      await acceptManagedConnectorEvent(db, { ...event, [field]: 'wrong' }, protector, now)
    ).toBe('rejected');
    expect(await inbox()).toHaveLength(0);
    expect(await acceptManagedConnectorEvent(db, event, protector, now)).toBe('accepted');
    expect(await inbox()).toHaveLength(1);
  });

  it('rejects missing V2 identity and permits V1 only through one exact stored binding', async () => {
    const { event } = await seed();
    expect(
      await acceptManagedConnectorEvent(
        db,
        { ...event, providerUserRef: undefined },
        protector,
        now
      )
    ).toBe('rejected');
    expect(
      await acceptManagedConnectorEvent(
        db,
        {
          ...event,
          envelopeVersion: 'V1',
          providerUserRef: undefined,
          providerTriggerUuid: undefined,
          externalAccountUuid: undefined,
        },
        protector,
        now
      )
    ).toBe('accepted');
    expect(await inbox()).toHaveLength(1);
  });

  it('cannot resolve a cross-tenant ambiguous legacy identity from toolkit alone', async () => {
    const a = await seed();
    const b = await seed('owner-b', 'instance-b');
    await db
      .update(schema.managedConnectorEventBinding)
      .set({
        providerTriggerRef: a.event.providerTriggerRef,
        externalAccountRef: a.event.externalAccountRef,
      })
      .where(eq(schema.managedConnectorEventBinding.tenantId, b.tenant.id));
    expect(
      await acceptManagedConnectorEvent(db, { ...a.event, envelopeVersion: 'V1' }, protector, now)
    ).toBe('rejected');
    expect(await inbox()).toHaveLength(0);
  });

  it('leases only to the originating instance and clears hosted payload only on its exact durable ACK', async () => {
    const a = await seed();
    const b = await seed('owner-b', 'instance-b');
    await acceptManagedConnectorEvent(db, a.event, protector, now);
    const sibling = { ...a.principal, instanceId: 'instance-c', keyId: 'key-c' };
    expect((await pullManagedConnectorEvents(db, sibling, protector, 10, now)).events).toEqual([]);
    expect((await pullManagedConnectorEvents(db, b.principal, protector, 10, now)).events).toEqual(
      []
    );
    const [delivered] = (await pullManagedConnectorEvents(db, a.principal, protector, 10, now))
      .events;
    expect(delivered.content).toEqual({
      version: 1,
      title: 'New email',
      text: 'subject: Sensitive subject\nbody: Untrusted email text',
    });
    expect((await pullManagedConnectorEvents(db, a.principal, protector, 10, now)).events).toEqual(
      []
    );
    expect(await acknowledgeManagedConnectorEvents(db, sibling, [delivered], now)).toEqual({
      acknowledged: 0,
    });
    expect(await acknowledgeManagedConnectorEvents(db, b.principal, [delivered], now)).toEqual({
      acknowledged: 0,
    });
    expect((await inbox())[0].protectedPayload).not.toBe('');
    expect(
      await acknowledgeManagedConnectorEvents(
        db,
        a.principal,
        [{ id: delivered.id, leaseToken: '00000000-0000-4000-8000-000000000000' }],
        now
      )
    ).toEqual({ acknowledged: 0 });
    expect(await acknowledgeManagedConnectorEvents(db, a.principal, [delivered], now)).toEqual({
      acknowledged: 1,
    });
    expect(await acknowledgeManagedConnectorEvents(db, a.principal, [delivered], now)).toEqual({
      acknowledged: 1,
    });
    expect((await inbox())[0]).toMatchObject({ state: 'acknowledged', protectedPayload: '' });
  });

  it('rejects ciphertext copied between tenants even when subscription, event and expiry match', async () => {
    const a = await seed();
    const b = await seed('owner-b', 'instance-b');
    await acceptManagedConnectorEvent(db, a.event, protector, now);
    await acceptManagedConnectorEvent(
      db,
      { ...b.event, payload: { body: 'Only tenant B' } },
      protector,
      now
    );
    const rows = await inbox();
    const source = rows.find((row) => row.tenantId === a.tenant.id)!;
    const target = rows.find((row) => row.tenantId === b.tenant.id)!;
    expect(source.subscriptionId).toBe(target.subscriptionId);
    expect(source.providerEventId).toBe(target.providerEventId);
    expect(source.expiresAt).toEqual(target.expiresAt);
    await db
      .update(schema.managedConnectorEventInbox)
      .set({ protectedPayload: source.protectedPayload })
      .where(eq(schema.managedConnectorEventInbox.tenantId, b.tenant.id));
    await expect(pullManagedConnectorEvents(db, b.principal, protector, 1, now)).rejects.toThrow(
      'Event content is unavailable.'
    );
    await db
      .update(schema.managedConnectorEventInbox)
      .set({ protectedPayload: target.protectedPayload })
      .where(eq(schema.managedConnectorEventInbox.tenantId, b.tenant.id));
    const delivered = await pullManagedConnectorEvents(db, b.principal, protector, 1, now);
    expect(delivered.events).toHaveLength(1);
    expect(delivered.events[0].content.text).toBe('body: Only tenant B');
  });

  it('a reclaimed lease rejects the previous worker token and retains the original deadline', async () => {
    const a = await seed();
    await acceptManagedConnectorEvent(db, a.event, protector, now);
    const [old] = (await pullManagedConnectorEvents(db, a.principal, protector, 1, now)).events;
    const later = new Date(now.getTime() + 60_001);
    const [fresh] = (await pullManagedConnectorEvents(db, a.principal, protector, 1, later)).events;
    expect(fresh.id).toBe(old.id);
    expect(fresh.leaseToken).not.toBe(old.leaseToken);
    expect(fresh.expiresAt).toBe(old.expiresAt);
    expect(await acknowledgeManagedConnectorEvents(db, a.principal, [old], later)).toEqual({
      acknowledged: 0,
    });
    expect(await acknowledgeManagedConnectorEvents(db, a.principal, [fresh], later)).toEqual({
      acknowledged: 1,
    });
  });

  it('revocation suppresses new delivery but accepts the already committed local receipt', async () => {
    const a = await seed();
    await acceptManagedConnectorEvent(db, a.event, protector, now);
    const [delivery] = (await pullManagedConnectorEvents(db, a.principal, protector, 1, now))
      .events;
    await db
      .update(schema.managedConnectorEventSubscription)
      .set({ enabled: false, revokedAt: now });
    expect(
      await acceptManagedConnectorEvent(
        db,
        { ...a.event, authenticatedWebhookId: 'wh-new' },
        protector,
        now
      )
    ).toBe('rejected');
    expect(
      (
        await pullManagedConnectorEvents(
          db,
          a.principal,
          protector,
          1,
          new Date(now.getTime() + 60_001)
        )
      ).events
    ).toEqual([]);
    expect(await acknowledgeManagedConnectorEvents(db, a.principal, [delivery], now)).toEqual({
      acknowledged: 1,
    });
  });

  it.each(['key', 'instance', 'permission'] as const)(
    'checks live %s authority before pulling or acknowledging content',
    async (kind) => {
      const a = await seed();
      await acceptManagedConnectorEvent(db, a.event, protector, now);
      const [delivery] = (await pullManagedConnectorEvents(db, a.principal, protector, 1, now))
        .events;
      if (kind === 'key') await client.exec(`UPDATE apikey SET enabled = false WHERE id = 'key-a'`);
      else if (kind === 'instance')
        await client.exec(`UPDATE instance SET revoked_at = now() WHERE id = 'instance-a'`);
      else
        await client.exec(
          `UPDATE apikey SET permissions = '{"instance":["link"],"connectors":["usage"]}' WHERE id = 'key-a'`
        );
      await expect(
        pullManagedConnectorEvents(db, a.principal, protector, 1, now)
      ).rejects.toThrow();
      await expect(
        acknowledgeManagedConnectorEvents(db, a.principal, [delivery], now)
      ).rejects.toThrow();
      expect((await inbox())[0].protectedPayload).not.toBe('');
    }
  );

  it('sweeps all delivery states and eventually removes payload-free dedupe metadata', async () => {
    const a = await seed();
    await acceptManagedConnectorEvent(db, a.event, protector, now);
    const expiry = new Date(now.getTime() + CONNECTOR_EVENT_DELIVERY_WINDOW_MS);
    expect(
      (await pullManagedConnectorEvents(db, a.principal, protector, 1, expiry)).events
    ).toEqual([]);
    expect(await sweepManagedConnectorEventRetention(db, expiry)).toEqual({
      contentRowsCleared: 1,
      metadataRowsDeleted: 0,
    });
    expect((await inbox())[0]).toMatchObject({ state: 'expired', protectedPayload: '' });
    expect(await sweepManagedConnectorEventRetention(db, expiry)).toEqual({
      contentRowsCleared: 0,
      metadataRowsDeleted: 0,
    });
    expect(
      await sweepManagedConnectorEventRetention(
        db,
        new Date(now.getTime() + CONNECTOR_EVENT_METADATA_WINDOW_MS)
      )
    ).toEqual({ contentRowsCleared: 0, metadataRowsDeleted: 1 });
    expect(await inbox()).toHaveLength(0);
  });

  function eventProvider(f: Awaited<ReturnType<typeof seed>>) {
    const events: ConnectorEventCapability = {
      listDefinitions: vi.fn<ConnectorEventCapability['listDefinitions']>(async () => ({
        status: 'ok',
        definitions: [definition],
      })),
      reconcileTrigger: vi.fn<ConnectorEventCapability['reconcileTrigger']>(async () => ({
        status: 'found',
        trigger: {
          providerTriggerRef: f.binding.providerTriggerRef!,
          providerTriggerUuid: f.binding.providerTriggerUuid!,
          externalAccountRef: f.binding.externalAccountRef,
          externalAccountUuid: f.binding.externalAccountUuid!,
          enabled: true,
        },
      })),
      createTrigger: vi.fn<ConnectorEventCapability['createTrigger']>(async (input) =>
        (await input.authorizeDispatch())
          ? {
              status: 'ready',
              providerTriggerRef: f.binding.providerTriggerRef!,
              ownership: 'unproven',
            }
          : { status: 'denied', code: 'AUTHORITY_CHANGED' }
      ),
      setTriggerEnabled: vi.fn<ConnectorEventCapability['setTriggerEnabled']>(async (input) =>
        (await input.authorizeDispatch())
          ? { status: 'ok' }
          : { status: 'denied', code: 'AUTHORITY_CHANGED' }
      ),
      deleteTrigger: vi.fn<ConnectorEventCapability['deleteTrigger']>(async (input) =>
        (await input.authorizeDispatch())
          ? { status: 'ok' }
          : { status: 'denied', code: 'AUTHORITY_CHANGED' }
      ),
      verifyWebhook: vi.fn<ConnectorEventCapability['verifyWebhook']>(async () => ({
        status: 'rejected',
        code: 'not-used',
      })),
    };
    const provider: ManagedAuthorityProviderContext = {
      events,
      providerUserId: f.tenant.providerUserId,
      materialGeneration: 1,
      executionConfigDigest: 'event-config',
      signal: new AbortController().signal,
      accounts: {
        getAccount: async (connectedAccountId) => ({
          connectedAccountId,
          providerUserId: f.tenant.providerUserId,
          toolkit: 'gmail',
          authConfigId: 'ac_gmail',
          status: 'ACTIVE',
        }),
        deleteAccount: vi.fn(async () => {}),
      },
    };
    const command = {
      version: 1 as const,
      kind: 'set_event_subscription' as const,
      commandId: 'event-authority-one',
      managedConnectionId: 'gmail',
      scopeVersion: 1,
      subscriptionId: 'new-subscription',
      subscriptionVersion: 1,
      hostedDefinitionId: f.binding.definitionId,
      agentId: 'agent-one',
      destination: { kind: 'room' as const, id: 'room-one' },
      filter: {},
      enabled: true,
    };
    return { events, provider, command };
  }

  it('acknowledges the exact full reviewed event command and preserves history without replaying revoked consent', async () => {
    const f = await seed();
    const p = eventProvider(f);
    const result = await applyManagedAuthorityCommand(db, f.principal, p.command, p.provider);
    expect(result).toEqual({
      conflict: false,
      status: {
        version: 1,
        commandId: p.command.commandId,
        managedConnectionId: 'gmail',
        scopeVersion: 1,
        state: 'applied',
        appliedEventScopeHash: managedRequestHash(p.command),
        externalCleanup: 'not_required',
      },
    });
    const revoke = {
      ...p.command,
      commandId: 'revoke-one',
      scopeVersion: 2,
      subscriptionVersion: 2,
      enabled: false,
    };
    expect(
      (await applyManagedAuthorityCommand(db, f.principal, revoke, p.provider)).status.state
    ).toBe('applied');
    expect(await applyManagedAuthorityCommand(db, f.principal, p.command, p.provider)).toEqual(
      result
    );
    const [subscription] = await db
      .select()
      .from(schema.managedConnectorEventSubscription)
      .where(eq(schema.managedConnectorEventSubscription.id, p.command.subscriptionId));
    expect(subscription).toMatchObject({ enabled: false, scopeVersion: 2 });
    expect(p.events.reconcileTrigger).toHaveBeenCalledTimes(1);
  });

  it('refuses changed command contents and unavailable exact definitions before provider dispatch', async () => {
    const f = await seed();
    const p = eventProvider(f);
    expect(
      (await applyManagedAuthorityCommand(db, f.principal, p.command, p.provider)).conflict
    ).toBe(false);
    expect(
      (
        await applyManagedAuthorityCommand(
          db,
          f.principal,
          { ...p.command, destination: { kind: 'room', id: 'another' } },
          p.provider
        )
      ).conflict
    ).toBe(true);
    const missing = await applyManagedAuthorityCommand(
      db,
      f.principal,
      {
        ...p.command,
        commandId: 'missing',
        subscriptionId: 'missing',
        hostedDefinitionId: '00000000-0000-4000-8000-000000000000',
      },
      p.provider
    );
    expect(missing.status).toMatchObject({
      state: 'rejected',
      rejectionCode: 'event_definition_unavailable',
    });
    expect(p.events.reconcileTrigger).toHaveBeenCalledTimes(1);
  });

  it('removes only the last reference to a shared managed physical trigger', async () => {
    const f = await seed();
    const p = eventProvider(f);
    await applyManagedAuthorityCommand(db, f.principal, p.command, p.provider);
    const first = await applyManagedAuthorityCommand(
      db,
      f.principal,
      {
        ...p.command,
        commandId: 'revoke-first',
        scopeVersion: 2,
        subscriptionVersion: 2,
        enabled: false,
      },
      p.provider
    );
    expect(first.status).toMatchObject({ state: 'applied', externalCleanup: 'not_required' });
    expect(p.events.deleteTrigger).not.toHaveBeenCalled();
    const last = await applyManagedAuthorityCommand(
      db,
      f.principal,
      {
        ...p.command,
        commandId: 'revoke-last',
        subscriptionId: 'subscription',
        scopeVersion: 1,
        subscriptionVersion: 2,
        enabled: false,
      },
      p.provider
    );
    expect(last.status).toMatchObject({ state: 'applied', externalCleanup: 'complete' });
    expect(p.events.deleteTrigger).toHaveBeenCalledTimes(1);
  });

  async function pendingCleanup() {
    const f = await seed();
    const p = eventProvider(f);
    const command = {
      ...p.command,
      commandId: 'offline-disable',
      subscriptionId: 'subscription',
      subscriptionVersion: 2,
      enabled: false,
    };
    expect((await applyManagedAuthorityCommand(db, f.principal, command)).status).toMatchObject({
      state: 'applied',
      externalCleanup: 'pending',
    });
    return { ...f, ...p, command };
  }

  it('upgrades pending hosted disable receipts without changing their exact authority or original outcome', async () => {
    await client.close();
    client = new PGlite();
    await provisionBase(client, false);
    db = drizzle(client, { schema }) as unknown as ManagedConnectorDatabase;
    const f = await seed();
    await client.query(
      `INSERT INTO managed_connector_authority_command (tenant_id,instance_id,command_id,connection_id,request_hash,kind,scope_key,scope_version,request_payload,state,external_cleanup,event_binding_id)
      VALUES ($1,'instance-a','legacy-disable','gmail','immutable-hash','set_event_subscription','event:subscription',2,'{"enabled":false}','applied','pending',$2)`,
      [f.tenant.id, f.binding.id]
    );
    const before = (
      await client.query<Record<string, unknown>>(
        'SELECT * FROM managed_connector_authority_command'
      )
    ).rows[0];
    const migration = readdirSync(MIGRATIONS_DIR).find(
      (name) => name.startsWith('0013_') && name.endsWith('.sql')
    )!;
    await client.exec(readFileSync(join(MIGRATIONS_DIR, migration), 'utf8'));
    expect((await client.query('SELECT * FROM managed_connector_authority_command')).rows).toEqual([
      { ...before, event_cleanup_after: null },
    ]);
  });

  it('reconciles an applied disable while the local instance is offline without creating authority', async () => {
    const f = await pendingCleanup();
    await client.exec(`UPDATE instance SET last_seen_at = '2020-01-01' WHERE id = 'instance-a'`);
    expect(await recoverManagedEventCleanup(db, f.provider.signal, () => f.provider)).toEqual({
      examined: 1,
      completed: 1,
    });
    expect(f.events.deleteTrigger).toHaveBeenCalledTimes(1);
    expect(await recoverManagedEventCleanup(db, f.provider.signal, () => f.provider)).toEqual({
      examined: 0,
      completed: 0,
    });
    expect((await db.select().from(schema.managedConnectorEventSubscription))[0]).toMatchObject({
      enabled: false,
      scopeVersion: 2,
    });
    expect((await client.query('SELECT id FROM apikey')).rows).toHaveLength(3);
  });

  it('mounts offline event cleanup behind the existing cron authentication with real database receipts', async () => {
    const f = await pendingCleanup();
    vi.spyOn(dbClient, 'getDb').mockReturnValue(db);
    vi.spyOn(authModule, 'getAuth').mockReturnValue({} as never);
    vi.spyOn(cleanupModule, 'runCleanup').mockResolvedValue({
      unverifiedUsers: 0,
      expiredDeviceCodes: 0,
      staleInstances: 0,
    });
    const recover = eventCleanup.recoverManagedEventCleanup;
    vi.spyOn(eventCleanup, 'recoverManagedEventCleanup').mockImplementation((database, signal) =>
      recover(database, signal, () => f.provider)
    );
    const original = env.CRON_SECRET;
    env.CRON_SECRET = 'synthetic-cron-only';
    try {
      expect((await cleanupCron(new Request('https://dorkos.test/api/cron/cleanup'))).status).toBe(
        401
      );
      expect(f.events.deleteTrigger).not.toHaveBeenCalled();
      const response = await cleanupCron(
        new Request('https://dorkos.test/api/cron/cleanup', {
          headers: { authorization: 'Bearer synthetic-cron-only' },
        })
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        ok: true,
        eventSubscriptions: { examined: 1, completed: 1 },
      });
      expect(f.events.deleteTrigger).toHaveBeenCalledTimes(1);
      expect(
        (await db.select().from(schema.managedConnectorAuthorityCommand))[0].externalCleanup
      ).toBe('complete');
    } finally {
      env.CRON_SECRET = original;
    }
  });

  it('review does not starve another tenant behind an unrecoverable cleanup receipt', async () => {
    const a = await pendingCleanup();
    const b = await seed('owner-b', 'instance-b');
    const p = eventProvider(b);
    await applyManagedAuthorityCommand(db, b.principal, {
      ...p.command,
      commandId: 'healthy-disable',
      subscriptionId: 'subscription',
      subscriptionVersion: 2,
      enabled: false,
    });
    await client.exec(
      `UPDATE managed_connector_authority_command SET updated_at = '2020-01-01' WHERE instance_id = 'instance-a'; UPDATE apikey SET enabled = false WHERE id = 'key-a'`
    );
    const resolve = vi.fn((userId: string) =>
      userId === b.tenant.providerUserId ? p.provider : a.provider
    );
    const now = new Date();
    expect(await recoverManagedEventCleanup(db, p.provider.signal, resolve, 1, () => now)).toEqual({
      examined: 1,
      completed: 0,
    });
    // Reconstruct the database facade: progress is persisted, never a process cursor.
    const restarted = drizzle(client, { schema }) as unknown as ManagedConnectorDatabase;
    expect(
      await recoverManagedEventCleanup(restarted, p.provider.signal, resolve, 1, () => now)
    ).toEqual({ examined: 1, completed: 1 });
    expect(
      await recoverManagedEventCleanup(restarted, p.provider.signal, resolve, 1, () => now)
    ).toEqual({ examined: 0, completed: 0 });
    expect(p.events.deleteTrigger).toHaveBeenCalledTimes(1);
    expect(a.events.deleteTrigger).not.toHaveBeenCalled();
    await client.exec("UPDATE apikey SET enabled = true WHERE id = 'key-a'");
    expect(
      await recoverManagedEventCleanup(restarted, p.provider.signal, resolve, 1, () => now)
    ).toEqual({ examined: 0, completed: 0 });
    expect(
      await recoverManagedEventCleanup(
        restarted,
        p.provider.signal,
        resolve,
        1,
        () => new Date(now.getTime() + 30_001)
      )
    ).toEqual({ examined: 1, completed: 1 });
    expect(a.events.deleteTrigger).toHaveBeenCalledTimes(1);
  });

  it('cannot borrow a same-owner sibling instance key for offline cleanup', async () => {
    const f = await pendingCleanup();
    await client.exec(`UPDATE apikey SET enabled = false WHERE id = 'key-a'`);
    const resolve = vi.fn(() => f.provider);
    expect(await recoverManagedEventCleanup(db, f.provider.signal, resolve)).toEqual({
      examined: 1,
      completed: 0,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(f.events.reconcileTrigger).not.toHaveBeenCalled();
    expect(f.events.deleteTrigger).not.toHaveBeenCalled();
  });

  it.each(['key', 'provider', 'subscriber'] as const)(
    'rechecks %s authority after cleanup readback before native deletion',
    async (change) => {
      const f = await pendingCleanup();
      const readback = await f.events.reconcileTrigger({} as never);
      vi.mocked(f.events.reconcileTrigger).mockImplementation(async () => {
        if (change === 'key')
          await client.exec(`UPDATE apikey SET enabled = false WHERE id = 'key-a'`);
        if (change === 'provider')
          await client.exec(`UPDATE managed_connector_provider SET material_generation = 2`);
        if (change === 'subscriber')
          await db.insert(schema.managedConnectorEventSubscription).values({
            tenantId: f.tenant.id,
            id: 'new-review',
            connectionId: 'gmail',
            targetInstanceId: 'instance-a',
            bindingId: f.binding.id,
            agentId: 'other',
            destinationKind: 'room',
            destinationId: 'room',
            scopeVersion: 1,
            connectionGeneration: 1,
            enabled: false,
          });
        return readback;
      });
      const native = vi.fn();
      vi.mocked(f.events.deleteTrigger).mockImplementation(async (input) => {
        if (await input.authorizeDispatch()) {
          native();
          return { status: 'ok' };
        }
        return { status: 'denied', code: 'AUTHORITY_CHANGED' };
      });
      expect(
        (await recoverManagedEventCleanup(db, f.provider.signal, () => f.provider)).completed
      ).toBe(0);
      expect(native).not.toHaveBeenCalled();
      expect(
        (await db.select().from(schema.managedConnectorAuthorityCommand))[0].externalCleanup
      ).toBe('pending');
    }
  );

  it('reads back an uncertain delete before retry and treats confirmed absence as completion', async () => {
    const f = await pendingCleanup();
    vi.mocked(f.events.deleteTrigger).mockResolvedValue({
      status: 'outcome_unknown',
      code: 'PROVIDER_OUTCOME_UNKNOWN',
    });
    expect(
      (await recoverManagedEventCleanup(db, f.provider.signal, () => f.provider)).completed
    ).toBe(0);
    vi.mocked(f.events.reconcileTrigger).mockResolvedValue({ status: 'absent' });
    expect(
      (
        await recoverManagedEventCleanup(
          db,
          f.provider.signal,
          () => f.provider,
          25,
          () => new Date(Date.now() + 31_000)
        )
      ).completed
    ).toBe(1);
    expect(f.events.deleteTrigger).toHaveBeenCalledTimes(1);
    expect((await db.select().from(schema.managedConnectorEventBinding))[0].state).toBe('retired');
  });

  it('allows only one concurrent cleanup worker to dispatch the captured physical trigger', async () => {
    const f = await pendingCleanup();
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const readback = await f.events.reconcileTrigger({} as never);
    vi.mocked(f.events.reconcileTrigger).mockImplementation(async () => {
      started();
      await blocked;
      return readback;
    });
    const first = recoverManagedEventCleanup(db, f.provider.signal, () => f.provider);
    await ready;
    expect(
      (await recoverManagedEventCleanup(db, f.provider.signal, () => f.provider)).completed
    ).toBe(0);
    unblock();
    expect((await first).completed).toBe(1);
    expect(f.events.deleteTrigger).toHaveBeenCalledTimes(1);
  });

  it('converges concurrent event discoveries and never resurrects old consent on metadata A to B to A', async () => {
    const f = await seed();
    const p = eventProvider(f);
    const context = { principal: f.principal, db, ...p.provider };
    const request = {
      toolkit: 'gmail',
      toolkitVersion: definition.toolkitVersion,
      limit: 100,
      signal: p.provider.signal,
    };
    const [a, sibling] = await Promise.all([
      listManagedEventDefinitions(context, request),
      listManagedEventDefinitions(context, request),
    ]);
    expect(a.definitions[0].hostedDefinitionId).toBe(sibling.definitions[0].hostedDefinitionId);
    expect(a.definitions[0].hostedDefinitionId).toBe(f.binding.definitionId);
    const changed = {
      ...definition,
      definitionHash: `sha256:${'b'.repeat(64)}`,
      payloadSchema: { type: 'object' },
    };
    vi.mocked(p.events.listDefinitions).mockResolvedValueOnce({
      status: 'ok',
      definitions: [changed],
    });
    const b = await listManagedEventDefinitions(context, request);
    const restored = await listManagedEventDefinitions(context, request);
    expect(
      new Set([
        a.definitions[0].hostedDefinitionId,
        b.definitions[0].hostedDefinitionId,
        restored.definitions[0].hostedDefinitionId,
      ]).size
    ).toBe(3);
    const definitions = await db.select().from(schema.managedConnectorEventDefinition);
    expect(definitions.filter((row) => row.current)).toHaveLength(1);
    expect((await db.select().from(schema.managedConnectorEventSubscription))[0]).toMatchObject({
      enabled: false,
      revokedAt: expect.any(Date),
    });
    expect(await acceptManagedConnectorEvent(db, f.event, protector, now)).toBe('rejected');
    expect(p.events.createTrigger).not.toHaveBeenCalled();
  });

  it('does not complete a cleanup receipt after the exact key is revoked during native deletion', async () => {
    const f = await pendingCleanup();
    vi.mocked(f.events.deleteTrigger).mockImplementation(async (input) => {
      expect(await input.authorizeDispatch()).toBe(true);
      await client.exec(`UPDATE apikey SET enabled = false WHERE id = 'key-a'`);
      return { status: 'ok' };
    });
    expect(
      (await recoverManagedEventCleanup(db, f.provider.signal, () => f.provider)).completed
    ).toBe(0);
    expect(
      (await db.select().from(schema.managedConnectorAuthorityCommand))[0].externalCleanup
    ).toBe('pending');
  });

  it('keeps an ambiguous upsert pending and reconciles before any retry', async () => {
    const f = await seed();
    const p = eventProvider(f);
    vi.mocked(p.events.reconcileTrigger).mockResolvedValue({ status: 'absent' });
    vi.mocked(p.events.createTrigger).mockImplementation(async (input) => {
      expect(await input.authorizeDispatch()).toBe(true);
      return { status: 'outcome_unknown', code: 'PROVIDER_OUTCOME_UNKNOWN' };
    });
    const first = await applyManagedAuthorityCommand(db, f.principal, p.command, p.provider);
    expect(first.status.state).toBe('pending');
    expect(
      (await applyManagedAuthorityCommand(db, f.principal, p.command, p.provider)).status.state
    ).toBe('pending');
    expect(p.events.reconcileTrigger).toHaveBeenCalledTimes(2);
    expect(p.events.createTrigger).toHaveBeenCalledTimes(1);
    const [subscription] = await db
      .select()
      .from(schema.managedConnectorEventSubscription)
      .where(eq(schema.managedConnectorEventSubscription.id, p.command.subscriptionId));
    expect(subscription.enabled).toBe(false);
  });

  it('closes final dispatch when receive authority changes during upstream reconciliation', async () => {
    const f = await seed();
    const p = eventProvider(f);
    vi.mocked(p.events.reconcileTrigger).mockImplementation(async () => {
      await db
        .update(schema.managedConnectorEventSubscription)
        .set({ revokedAt: new Date() })
        .where(eq(schema.managedConnectorEventSubscription.id, p.command.subscriptionId));
      return { status: 'absent' };
    });
    expect(
      (await applyManagedAuthorityCommand(db, f.principal, p.command, p.provider)).status.state
    ).toBe('pending');
    expect(p.events.createTrigger).toHaveBeenCalledTimes(1);
    const [subscription] = await db
      .select()
      .from(schema.managedConnectorEventSubscription)
      .where(eq(schema.managedConnectorEventSubscription.id, p.command.subscriptionId));
    expect(subscription.enabled).toBe(false);
    expect(p.events.setTriggerEnabled).not.toHaveBeenCalled();
  });

  function signedRequest(
    f: Awaited<ReturnType<typeof seed>>,
    payloadOverrides = {},
    badSignature = false
  ) {
    const secret = 'isolated-webhook-signature-key';
    const body = JSON.stringify(
      {
        type: definition.eventType,
        timestamp: new Date().toISOString(),
        log_id: 'safe-log',
        data: {
          connection_id: f.event.externalAccountUuid,
          connection_nano_id: f.event.externalAccountRef,
          trigger_id: f.event.providerTriggerUuid,
          trigger_nano_id: f.event.providerTriggerRef,
          user_id: f.event.providerUserRef,
          subject: 'Route content',
          ...payloadOverrides,
        },
      },
      null,
      2
    );
    const id = 'signed-webhook-one';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', secret)
      .update(`${id}.${timestamp}.${body}`)
      .digest('base64');
    return new Request('https://dorkos.test/api/connectors/managed/events', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${badSignature ? 'invalid' : signature}`,
      },
    });
  }
  function configureRoute() {
    vi.spyOn(eventConfig, 'readManagedConnectorConfig').mockReturnValue({
      enabled: true,
      liveReady: true,
      eventsLiveReady: true,
      projectApiKey: 'local-signature-only',
      webhookSecret: 'isolated-webhook-signature-key',
      authConfigByToolkit: {},
    });
    vi.spyOn(eventProtection, 'managedEventProtector').mockReturnValue(protector);
    return vi.spyOn(dbClient, 'getDb').mockReturnValue(db);
  }
  it('verifies the actual raw hosted route before tenant lookup and commits encrypted content before 202', async () => {
    const f = await seed();
    const lookup = configureRoute();
    const bad = await receiveSignedEvent(signedRequest(f, {}, true));
    expect(bad.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
    expect(await inbox()).toHaveLength(0);
    const good = await receiveSignedEvent(signedRequest(f));
    expect(good.status).toBe(202);
    expect(lookup).toHaveBeenCalledTimes(1);
    const stored = await inbox();
    expect(stored).toHaveLength(1);
    expect(stored[0].providerEventId).toBe('signed-webhook-one');
    expect(stored[0].protectedPayload).not.toContain('Route content');
    expect((await receiveSignedEvent(signedRequest(f))).status).toBe(202);
    expect(await inbox()).toHaveLength(1);
  });
  it('rejects a correctly signed cross-user envelope at the hosted HTTP boundary', async () => {
    const f = await seed();
    configureRoute();
    expect((await receiveSignedEvent(signedRequest(f, { user_id: 'another-user' }))).status).toBe(
      403
    );
    expect(await inbox()).toHaveLength(0);
    expect((await receiveSignedEvent(signedRequest(f))).status).toBe(202);
    expect(await inbox()).toHaveLength(1);
  });
  it('keeps hosted ingress closed before the separately attested event smoke', async () => {
    const f = await seed();
    const lookup = configureRoute();
    vi.mocked(eventConfig.readManagedConnectorConfig).mockReturnValue({
      enabled: true,
      liveReady: true,
      eventsLiveReady: false,
      projectApiKey: 'local-signature-only',
      webhookSecret: 'isolated-webhook-signature-key',
      authConfigByToolkit: {},
    });
    expect((await receiveSignedEvent(signedRequest(f))).status).toBe(503);
    expect(lookup).not.toHaveBeenCalled();
    expect(await inbox()).toHaveLength(0);
  });
});
