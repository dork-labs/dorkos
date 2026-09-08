/**
 * @vitest-environment node
 */
import { randomUUID } from 'node:crypto';
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

// Two budgets, because two different things are slow here (DOR-1886).
//
// The BOOT — PGlite plus every Drizzle migration plus a Better Auth password
// hash — is the expensive one, and sharing it moved it into `beforeAll`, where
// it peaked at 8.3s of the 10s hook default at a load average of 254. That is
// the 5-15s band, so the hook keeps 30s.
//
// The CASES are what is left, and sharing made them cheap: 144-720ms, peaking
// at 1.58s across three rounds at a load average of 300-405. Under 5s, so 15s
// — enough for a 9x overrun and no more. The 5s default false-failed all three
// on the run that filed this ticket, which is what both numbers are for.
vi.setConfig({ testTimeout: 15_000, hookTimeout: 30_000 });

/**
 * A name no other case — and no EARLIER ATTEMPT at this same case — has used.
 *
 * `beforeAll` builds one database for the whole file and is NOT re-run when a
 * case retries, so every row a failed attempt wrote is still sitting there on
 * the next one. Both gates retry (`VITEST_RETRY=2` at the pre-push gate,
 * `--retry=1` in the merge queue), so a fixed id turns any one-off failure into
 * a PERMANENT one: the retry re-runs the write and then reads two rows where it
 * asserted one, or is refused a sign-up for an email the first attempt took.
 * Measured both ways — see the header of the shared-database comment below.
 *
 * @param prefix - What the name should read as, before its unique tail.
 * @returns The prefixed, unique name.
 */
function uniqueId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

describe('PostgreSQL security audit persistence', () => {
  // ONE database for the file: the three boots that cost the most here become
  // one, and every case reads only rows keyed to its own user, so they share a
  // Postgres without depending on each other's order.
  //
  // The price is that nothing here may write a FIXED name. The database outlives
  // a failed attempt, so every id a case writes goes through `uniqueId` above.
  // Measured with a one-shot throw after each case's writes under
  // `VITEST_RETRY=2`: with fixed names, case 1 read 2 rows then 3 where it
  // asserts 1, and case 3 was refused its admin sign-up with a 403 because the
  // first attempt already took the address. Case 2 survived on its own — it
  // deletes its account, which frees the email again — but only if it gets far
  // enough to do so, so it takes a unique address too rather than resting on
  // that.
  let client: PGlite;
  let auth: ReturnType<typeof createAuth>;
  let handlers: Handlers;

  beforeAll(async () => {
    vi.stubEnv('BETTER_AUTH_SECRET', 'test-secret-test-secret-test-secret-123');
    ({ client, auth, handlers } = await createHarness());
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => {
    await client.close();
    vi.unstubAllEnvs();
  });

  it('persists a direct audit write with a PostgreSQL UUID', async () => {
    const target = uniqueId('target');
    await recordAudit(auth, {
      actorUserId: 'admin-a',
      action: 'admin.ban_user',
      targetUserId: target,
      reason: 'abuse',
      metadata: { banExpiresIn: 3600 },
    });

    const rows = await listAudit(auth, { targetUserId: target });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: 'admin-a',
      action: 'admin.ban_user',
      targetUserId: target,
      reason: 'abuse',
      metadata: { banExpiresIn: 3600 },
    });
    expect(rows[0].id).toMatch(UUID_PATTERN);
    // Scoped to this attempt's own target, because the table is shared with the
    // two cases below AND with this case's earlier attempts. What is being read
    // off the column is its TYPE, which one row proves as well as every row.
    expect(
      (
        await client.query<{ type: string }>(
          'SELECT pg_typeof(id)::text AS type FROM audit_log WHERE target_user_id = $1',
          [target]
        )
      ).rows
    ).toEqual([{ type: 'uuid' }]);
  });

  it('keeps requested and completed audit rows after real email-confirmed account deletion', async () => {
    const owner = await createSignedInUser(client, handlers, `${uniqueId('leaving')}@dork.test`);
    expect(
      (await handlers.POST(post('/api/auth/delete-user', { callbackURL: '/signin' }, owner.cookie)))
        .status
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
  });

  it('attributes a real admin action to the acting account', async () => {
    const admin = await createSignedInUser(
      client,
      handlers,
      `${uniqueId('admin')}@dork.test`,
      'admin'
    );
    const target = await createSignedInUser(client, handlers, `${uniqueId('target')}@dork.test`);

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
  });
});
