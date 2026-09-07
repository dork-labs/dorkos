/**
 * @vitest-environment node
 */
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { toNextJsHandler } from 'better-auth/next-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/mailer', () => ({
  sendVerificationEmail: vi.fn(),
  sendResetPassword: vi.fn(),
  sendDeleteAccountVerification: vi.fn(),
}));
vi.mock('@/lib/posthog-server', () => ({
  aliasInstanceToAccount: vi.fn(),
  deletePostHogPerson: vi.fn(),
}));

import * as schema from '@/db/schema';
import { createAuth } from '../auth';
import * as mailer from '../mailer';
import { revokeInstance } from '../instance-service';

const ORIGIN = 'http://localhost:3000';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../drizzle/', import.meta.url));

type GraphKind = 'without_events' | 'discovery_only' | 'full_graph';

interface GraphIds {
  ownerId: string;
  instanceId: string;
  tenantId: string;
}

function post(path: string, body: unknown, cookie?: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function createSignedInOwner(
  client: PGlite,
  handlers: ReturnType<typeof toNextJsHandler>,
  suffix: string
): Promise<{ ownerId: string; cookie: string }> {
  const email = `delete-${suffix}@dork.test`;
  const password = 'correct-horse-battery-staple';
  expect(
    (await handlers.POST(post('/api/auth/sign-up/email', { email, password, name: suffix }))).status
  ).toBe(200);
  await client.query('UPDATE "user" SET email_verified = true WHERE email = $1', [email]);
  const owner = await client.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [
    email,
  ]);
  const response = await handlers.POST(post('/api/auth/sign-in/email', { email, password }));
  expect(response.status).toBe(200);
  const cookie = response.headers
    .get('set-cookie')!
    .split(/,(?=\s*[^;=\s]+=)/)
    .map((value) => value.split(';')[0].trim())
    .join('; ');
  return { ownerId: owner.rows[0].id, cookie };
}

async function seedManagedGraph(
  client: PGlite,
  input: { ownerId: string; prefix: 'a' | 'b'; kind: GraphKind }
): Promise<GraphIds> {
  const number = input.prefix === 'a' ? '1' : '2';
  const ids = {
    ownerId: input.ownerId,
    instanceId: `instance-${input.prefix}`,
    tenantId: `${number.repeat(8)}-${number.repeat(4)}-4${number.repeat(3)}-8${number.repeat(3)}-${number.repeat(12)}`,
    providerUserId: `${number.repeat(7)}3-${number.repeat(4)}-4${number.repeat(3)}-8${number.repeat(3)}-${number.repeat(12)}`,
    definitionId: `${number.repeat(7)}4-${number.repeat(4)}-4${number.repeat(3)}-8${number.repeat(3)}-${number.repeat(12)}`,
    bindingId: `${number.repeat(7)}5-${number.repeat(4)}-4${number.repeat(3)}-8${number.repeat(3)}-${number.repeat(12)}`,
    leaseToken: `${number.repeat(7)}6-${number.repeat(4)}-4${number.repeat(3)}-8${number.repeat(3)}-${number.repeat(12)}`,
  };
  await client.query(
    `INSERT INTO instance(id, user_id, name, platform, dorkos_version)
     VALUES ($1, $2, $3, 'darwin', '1.0.0')`,
    [ids.instanceId, input.ownerId, `Laptop ${input.prefix.toUpperCase()}`]
  );
  await client.query(
    'INSERT INTO connector_tenant(id, owner_user_id, provider_user_id) VALUES ($1, $2, $3)',
    [ids.tenantId, input.ownerId, ids.providerUserId]
  );
  await client.query(
    `INSERT INTO managed_connector_provider(
       tenant_id, id, provider_type, configuration_digest
     ) VALUES ($1, 'managed:composio', 'composio', $2)`,
    [ids.tenantId, `digest-${input.prefix}`]
  );
  await client.query(
    `INSERT INTO managed_connector_connection(
       tenant_id, id, originating_instance_id, provider_instance_id, provider_user_id,
       external_account_ref, toolkit, auth_config_id, label, lifecycle,
       authentication_status, material_generation
     ) VALUES (
       $1, $2, $3, 'managed:composio', $4, $5, 'gmail', $6, $7, 'active', 'active', 1
     )`,
    [
      ids.tenantId,
      `gmail-${input.prefix}`,
      ids.instanceId,
      ids.providerUserId,
      `ca-${input.prefix}`,
      `ac-${input.prefix}`,
      `Gmail ${input.prefix.toUpperCase()}`,
    ]
  );

  if (input.kind === 'discovery_only' || input.kind === 'full_graph') {
    await client.query(
      `INSERT INTO managed_connector_event_definition(
         tenant_id, id, provider_instance_id, toolkit, event_type, definition_hash, definition
       ) VALUES ($1, $2, 'managed:composio', 'gmail', 'GMAIL_NEW_MESSAGE', $3, '{}')`,
      [ids.tenantId, ids.definitionId, `definition-${input.prefix}`]
    );
  }

  if (input.kind === 'full_graph') {
    await client.query(
      `INSERT INTO managed_connector_event_binding(
         tenant_id, id, provider_instance_id, provider_generation, external_account_ref,
         definition_id, filter_hash, filter, provider_trigger_ref, state
       ) VALUES ($1, $2, 'managed:composio', 1, $3, $4, $5, '{}', $6, 'ready')`,
      [
        ids.tenantId,
        ids.bindingId,
        `ca-${input.prefix}`,
        ids.definitionId,
        `filter-${input.prefix}`,
        `trigger-${input.prefix}`,
      ]
    );
    await client.query(
      `INSERT INTO managed_connector_event_subscription(
         tenant_id, id, connection_id, target_instance_id, binding_id, agent_id,
         destination_kind, destination_id, scope_version, connection_generation, enabled
       ) VALUES ($1, $2, $3, $4, $5, $6, 'agent', $6, 1, 1, true)`,
      [
        ids.tenantId,
        `subscription-${input.prefix}`,
        `gmail-${input.prefix}`,
        ids.instanceId,
        ids.bindingId,
        `agent-${input.prefix}`,
      ]
    );
    await client.query(
      `INSERT INTO managed_connector_event_inbox(
         tenant_id, subscription_id, subscription_version, provider_event_id,
         target_instance_id, protected_payload, received_at, expires_at, metadata_expires_at
       ) VALUES ($1, $2, 1, $3, $4, $5, now(), now() + interval '7 days', now() + interval '30 days')`,
      [
        ids.tenantId,
        `subscription-${input.prefix}`,
        `event-${input.prefix}`,
        ids.instanceId,
        `encrypted-${input.prefix}`,
      ]
    );
    await client.query(
      `INSERT INTO managed_connector_operation_revision(
         tenant_id, id, provider_instance_id, toolkit, operation_slug, toolkit_version,
         schema_hash, classification, input_schema
       ) VALUES ($1, $2, 'managed:composio', 'gmail', 'GMAIL_GET_PROFILE', 'v1', $3, 'read', '{}')`,
      [ids.tenantId, ids.definitionId, `schema-${input.prefix}`]
    );
    await client.query(
      `INSERT INTO managed_connector_grant(
         tenant_id, instance_id, connection_id, agent_id, operation_revision_id,
         scope_version, active
       ) VALUES ($1, $2, $3, $4, $5, 1, true)`,
      [
        ids.tenantId,
        ids.instanceId,
        `gmail-${input.prefix}`,
        `agent-${input.prefix}`,
        ids.definitionId,
      ]
    );
    await client.query(
      `INSERT INTO managed_connector_execution_attempt(
         tenant_id, instance_id, attempt_id, logical_operation_id, attempt_index,
         request_hash, connection_id, agent_id, surface, actor_kind, actor_id,
         grant_scope_version, operation_revision_id, state, execution_lease_token,
         lease_expires_at, outcome
       ) VALUES (
         $1, $2, $3, $4, 1, $5, $6, $7, 'mcp', 'agent', $7,
         1, $8, 'recorded', $9, now(), 'success'
       )`,
      [
        ids.tenantId,
        ids.instanceId,
        `attempt-${input.prefix}`,
        `operation-${input.prefix}`,
        `request-${input.prefix}`,
        `gmail-${input.prefix}`,
        `agent-${input.prefix}`,
        ids.definitionId,
        ids.leaseToken,
      ]
    );
  }
  return ids;
}

const MANAGED_TABLES = [
  'managed_connector_provider',
  'managed_connector_connection',
  'managed_connector_operation_revision',
  'managed_connector_grant',
  'managed_connector_execution_attempt',
  'managed_connector_event_definition',
  'managed_connector_event_binding',
  'managed_connector_event_subscription',
  'managed_connector_event_inbox',
] as const;

async function tenantSnapshot(client: PGlite, tenantId: string): Promise<Record<string, string[]>> {
  const snapshot: Record<string, string[]> = {};
  for (const table of MANAGED_TABLES) {
    const rows = await client.query<{ row: string }>(
      `SELECT to_jsonb(value)::text AS row FROM ${table} value WHERE tenant_id = $1 ORDER BY 1`,
      [tenantId]
    );
    snapshot[table] = rows.rows.map(({ row }) => row);
  }
  return snapshot;
}

async function completeAccountDeletion(
  handlers: ReturnType<typeof toNextJsHandler>,
  cookie: string
): Promise<Response> {
  expect(
    (await handlers.POST(post('/api/auth/delete-user', { callbackURL: '/signin' }, cookie))).status
  ).toBe(200);
  const sent = vi.mocked(mailer.sendDeleteAccountVerification).mock.calls.at(-1);
  if (!sent) throw new Error('Better Auth did not send the account-deletion verification URL.');
  return handlers.GET(new Request(new URL(sent[0].url), { headers: { origin: ORIGIN, cookie } }));
}

describe('managed event account deletion', () => {
  beforeAll(() => vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-test-secret-test-secret-123'));
  beforeEach(() => vi.clearAllMocks());
  afterAll(() => vi.unstubAllEnvs());

  it.each(['without_events', 'discovery_only', 'full_graph'] as const)(
    'lets the real Better Auth callback erase an owner in state %s',
    async (kind) => {
      const client = new PGlite();
      try {
        const db = drizzle(client, { schema });
        await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
        const auth = createAuth(drizzleAdapter(db, { provider: 'pg', schema }));
        const handlers = toNextJsHandler(auth);
        const owner = await createSignedInOwner(client, handlers, kind);
        const target = await seedManagedGraph(client, {
          ownerId: owner.ownerId,
          prefix: 'a',
          kind,
        });
        await client.query(
          `INSERT INTO audit_log(actor_user_id, action, target_user_id, reason)
           VALUES ($1, 'account.self_delete.requested', $1, 'preexisting-before-callback')`,
          [owner.ownerId]
        );

        let otherOwnerId: string | undefined;
        let other: GraphIds | undefined;
        let otherBefore: Record<string, string[]> | undefined;
        if (kind === 'full_graph') {
          otherOwnerId = 'other-owner';
          await client.query(
            `INSERT INTO "user"(id, name, email, email_verified)
             VALUES ($1, 'Other Owner', 'other-owner@dork.test', true)`,
            [otherOwnerId]
          );
          other = await seedManagedGraph(client, {
            ownerId: otherOwnerId,
            prefix: 'b',
            kind: 'full_graph',
          });
          otherBefore = await tenantSnapshot(client, other.tenantId);
        }

        const response = await completeAccountDeletion(handlers, owner.cookie);
        expect(response.status).toBe(302);
        expect(
          (await client.query('SELECT id FROM "user" WHERE id = $1', [owner.ownerId])).rows
        ).toHaveLength(0);
        expect(
          (await client.query('SELECT id FROM connector_tenant WHERE id = $1', [target.tenantId]))
            .rows
        ).toHaveLength(0);
        for (const rows of Object.values(await tenantSnapshot(client, target.tenantId))) {
          expect(rows).toEqual([]);
        }

        const audit = await client.query<{ action: string; reason: string | null }>(
          `SELECT action, reason FROM audit_log
           WHERE target_user_id = $1 AND reason = 'preexisting-before-callback'`,
          [owner.ownerId]
        );
        expect(audit.rows).toEqual([
          {
            action: 'account.self_delete.requested',
            reason: 'preexisting-before-callback',
          },
        ]);

        if (other && otherOwnerId && otherBefore) {
          expect(await tenantSnapshot(client, other.tenantId)).toEqual(otherBefore);
          expect(
            (await client.query('SELECT id FROM "user" WHERE id = $1', [otherOwnerId])).rows
          ).toHaveLength(1);
          expect(
            (await client.query('SELECT id FROM instance WHERE id = $1', [other.instanceId])).rows
          ).toHaveLength(1);
        }
      } finally {
        await client.close();
      }
    },
    30_000
  );

  it('keeps event history when an owner performs the ordinary instance revoke', async () => {
    const client = new PGlite();
    try {
      const db = drizzle(client, { schema });
      await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
      await client.query(
        `INSERT INTO "user"(id, name, email, email_verified)
         VALUES ('owner-a', 'Owner A', 'owner-a@dork.test', true),
                ('owner-b', 'Owner B', 'owner-b@dork.test', true)`
      );
      const target = await seedManagedGraph(client, {
        ownerId: 'owner-a',
        prefix: 'a',
        kind: 'full_graph',
      });
      await client.query(
        `INSERT INTO apikey(
           id, reference_id, key, created_at, updated_at, metadata
         ) VALUES ('key-a', 'owner-a', 'hashed-key-a', now(), now(), $1)`,
        [JSON.stringify({ instanceId: target.instanceId })]
      );
      const before = await tenantSnapshot(client, target.tenantId);
      const auth = createAuth(drizzleAdapter(db, { provider: 'pg', schema }));

      expect(
        await revokeInstance(auth, { userId: 'owner-b', instanceId: target.instanceId })
      ).toEqual({ ok: false, notFound: true });
      expect(await tenantSnapshot(client, target.tenantId)).toEqual(before);

      expect(
        await revokeInstance(auth, { userId: 'owner-a', instanceId: target.instanceId })
      ).toEqual({ ok: true });
      expect(await tenantSnapshot(client, target.tenantId)).toEqual(before);
      expect((await client.query("SELECT id FROM apikey WHERE id = 'key-a'")).rows).toHaveLength(0);
      const instance = await client.query<{ revoked_at: Date | null }>(
        'SELECT revoked_at FROM instance WHERE id = $1',
        [target.instanceId]
      );
      expect(instance.rows[0].revoked_at).not.toBeNull();
    } finally {
      await client.close();
    }
  }, 30_000);
});
