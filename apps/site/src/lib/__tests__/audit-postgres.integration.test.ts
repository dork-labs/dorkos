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
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPassword: vi.fn().mockResolvedValue(undefined),
  sendDeleteAccountVerification: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/posthog-server', () => ({
  aliasInstanceToAccount: vi.fn(),
  deletePostHogPerson: vi.fn(),
}));

import * as schema from '@/db/schema';
import { listAudit, recordAudit } from '../audit-service';
import { createAuth } from '../auth';
import * as mailer from '../mailer';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct-horse-battery-staple';
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../drizzle/', import.meta.url));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Handlers = ReturnType<typeof toNextJsHandler>;

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

function cookieHeader(response: Response): string {
  const value = response.headers.get('set-cookie');
  if (!value) throw new Error('Sign-in did not return a session cookie.');
  return value
    .split(/,(?=\s*[^;=\s]+=)/)
    .map((part) => part.split(';')[0].trim())
    .join('; ');
}

async function createSignedInUser(
  client: PGlite,
  handlers: Handlers,
  email: string,
  role: 'admin' | 'user' = 'user'
): Promise<{ id: string; cookie: string }> {
  const signUp = await handlers.POST(
    post('/api/auth/sign-up/email', { email, password: PASSWORD, name: email })
  );
  expect(signUp.status).toBe(200);
  const user = await client.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [
    email,
  ]);
  expect(user.rows).toHaveLength(1);
  await client.query('UPDATE "user" SET email_verified = true, role = $2 WHERE id = $1', [
    user.rows[0].id,
    role,
  ]);
  const signIn = await handlers.POST(
    post('/api/auth/sign-in/email', { email, password: PASSWORD })
  );
  expect(signIn.status).toBe(200);
  return { id: user.rows[0].id, cookie: cookieHeader(signIn) };
}

async function createHarness(): Promise<{
  client: PGlite;
  auth: ReturnType<typeof createAuth>;
  handlers: Handlers;
}> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  const auth = createAuth(
    drizzleAdapter(db, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        apikey: schema.apikey,
        deviceCode: schema.deviceCode,
        instance: schema.instance,
        auditLog: schema.auditLog,
      },
    })
  );
  return { client, auth, handlers: toNextJsHandler(auth) };
}

describe('PostgreSQL security audit persistence', () => {
  beforeAll(() => vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-test-secret-test-secret-123'));
  beforeEach(() => vi.clearAllMocks());
  afterAll(() => vi.unstubAllEnvs());

  it('persists a direct audit write with a PostgreSQL UUID', async () => {
    const { client, auth } = await createHarness();
    try {
      await recordAudit(auth, {
        actorUserId: 'admin-a',
        action: 'admin.ban_user',
        targetUserId: 'target-a',
        reason: 'abuse',
        metadata: { banExpiresIn: 3600 },
      });

      const rows = await listAudit(auth, { targetUserId: 'target-a' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorUserId: 'admin-a',
        action: 'admin.ban_user',
        targetUserId: 'target-a',
        reason: 'abuse',
        metadata: { banExpiresIn: 3600 },
      });
      expect(rows[0].id).toMatch(UUID_PATTERN);
      expect(
        (await client.query<{ type: string }>('SELECT pg_typeof(id)::text AS type FROM audit_log'))
          .rows
      ).toEqual([{ type: 'uuid' }]);
    } finally {
      await client.close();
    }
  });

  it('keeps requested and completed audit rows after real email-confirmed account deletion', async () => {
    const { client, auth, handlers } = await createHarness();
    try {
      const owner = await createSignedInUser(client, handlers, 'leaving@dork.test');
      expect(
        (
          await handlers.POST(
            post('/api/auth/delete-user', { callbackURL: '/signin' }, owner.cookie)
          )
        ).status
      ).toBe(200);
      const sent = vi.mocked(mailer.sendDeleteAccountVerification).mock.calls.at(-1);
      if (!sent) throw new Error('Account deletion did not send its confirmation URL.');

      const callback = await handlers.GET(
        new Request(new URL(sent[0].url), {
          headers: { origin: ORIGIN, cookie: owner.cookie },
        })
      );
      expect(callback.status).toBe(302);
      expect(
        (await client.query('SELECT id FROM "user" WHERE id = $1', [owner.id])).rows
      ).toHaveLength(0);

      const audit = await listAudit(auth, { targetUserId: owner.id });
      expect(audit).toHaveLength(2);
      expect(audit.map(({ action }) => action).sort()).toEqual([
        'account.self_delete.completed',
        'account.self_delete.requested',
      ]);
      for (const row of audit) {
        expect(row.id).toMatch(UUID_PATTERN);
        expect(row.actorUserId).toBe(owner.id);
        expect(row.targetUserId).toBe(owner.id);
      }
    } finally {
      await client.close();
    }
  });

  it('attributes a real admin action to the acting account', async () => {
    const { client, auth, handlers } = await createHarness();
    try {
      const admin = await createSignedInUser(client, handlers, 'admin@dork.test', 'admin');
      const target = await createSignedInUser(client, handlers, 'target@dork.test');

      const response = await handlers.POST(
        post('/api/auth/admin/ban-user', { userId: target.id, banReason: 'abuse' }, admin.cookie)
      );
      expect(response.status).toBe(200);
      expect(
        (
          await client.query<{ banned: boolean }>('SELECT banned FROM "user" WHERE id = $1', [
            target.id,
          ])
        ).rows
      ).toEqual([{ banned: true }]);

      const audit = await listAudit(auth, { targetUserId: target.id });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        actorUserId: admin.id,
        action: 'admin.ban_user',
        targetUserId: target.id,
        reason: 'abuse',
      });
      expect(audit[0].id).toMatch(UUID_PATTERN);
    } finally {
      await client.close();
    }
  });
});
