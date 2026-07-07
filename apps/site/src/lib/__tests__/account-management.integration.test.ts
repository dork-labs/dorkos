/**
 * @vitest-environment node
 */
import { memoryAdapter } from 'better-auth/adapters/memory';
import { toNextJsHandler } from 'better-auth/next-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Resend seam so no test performs real email I/O. The delete-account
// verification email is part of the self-serve delete flow under test.
vi.mock('@/lib/mailer', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPassword: vi.fn().mockResolvedValue(undefined),
  sendDeleteAccountVerification: vi.fn().mockResolvedValue(undefined),
}));

import { exportAccountData } from '../account-service';
import { listAudit, recordAudit } from '../audit-service';
import { type Auth, createAuth } from '../auth';

const ORIGIN = 'http://localhost:3000';
const PASSWORD = 'correct-horse-battery-staple';

/** A row shape loose enough for the in-memory Better Auth store. */
type MemoryRow = Record<string, unknown>;

/** A fresh, fully-provisioned in-memory store for every test. */
function freshMemory(): Record<string, MemoryRow[]> {
  return {
    user: [],
    session: [],
    account: [],
    verification: [],
    apikey: [],
    deviceCode: [],
    instance: [],
    // The memory adapter keys by Better Auth model name (`auditLog`), not the
    // SQL table name (`audit_log`); the Drizzle adapter maps the model to the
    // `audit_log` table in production.
    auditLog: [],
  };
}

/** Build a JSON POST against the Better Auth Next.js handler, with optional cookie. */
function authRequest(pathname: string, body: unknown, cookie?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json', origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  return new Request(`${ORIGIN}${pathname}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

/** Reduce a `set-cookie` header to the `name=value; name=value` form for a Cookie header. */
function toCookieHeader(setCookie: string): string {
  return setCookie
    .split(/,(?=\s*[^;=\s]+=)/)
    .map((c) => c.split(';')[0].trim())
    .join('; ');
}

/** Sign up + mark verified + sign in against `POST`, returning the session cookie. */
async function signUpVerifyAndSignIn(
  POST: (request: Request) => Promise<Response>,
  memory: Record<string, MemoryRow[]>,
  email: string
): Promise<string> {
  await POST(authRequest('/api/auth/sign-up/email', { email, password: PASSWORD, name: email }));
  const row = memory.user.find((u) => u.email === email);
  if (row) row.emailVerified = true;
  const res = await POST(authRequest('/api/auth/sign-in/email', { email, password: PASSWORD }));
  const cookie = res.headers.get('set-cookie');
  if (!cookie) throw new Error(`sign-in did not set a cookie for ${email}`);
  return toCookieHeader(cookie);
}

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = 'test-secret-test-secret-test-secret-123';
});
afterAll(() => {
  delete process.env.BETTER_AUTH_SECRET;
});

describe('cloud-account-management — auth config wiring', () => {
  const auth = createAuth(memoryAdapter(freshMemory()));

  it('auto-links only verified trusted providers (decision D-A)', () => {
    const linking = auth.options.account?.accountLinking;
    expect(linking?.enabled).toBe(true);
    expect(linking?.trustedProviders).toEqual(
      expect.arrayContaining(['google', 'github', 'email-password'])
    );
    expect(linking?.allowDifferentEmails).toBe(false);
  });

  it('enables self-serve account deletion with a verification email (decision D-B)', () => {
    const del = auth.options.user?.deleteUser;
    expect(del?.enabled).toBe(true);
    expect(typeof del?.sendDeleteAccountVerification).toBe('function');
    expect(typeof del?.beforeDelete).toBe('function');
    expect(typeof del?.afterDelete).toBe('function');
  });

  it('registers the admin surface (ban/impersonate/list) on the API', () => {
    const api = auth.api as Record<string, unknown>;
    for (const method of ['banUser', 'unbanUser', 'impersonateUser', 'listUsers', 'setRole']) {
      expect(typeof api[method]).toBe('function');
    }
  });
});

describe('cloud-account-management — audit service', () => {
  let auth: Auth;
  beforeEach(() => {
    auth = createAuth(memoryAdapter(freshMemory()));
  });

  it('records an entry and reads it back newest-first, filtered by target', async () => {
    await recordAudit(auth, {
      actorUserId: 'admin-1',
      action: 'admin.ban_user',
      targetUserId: 'victim',
      reason: 'spam',
      metadata: { banExpiresIn: 3600 },
    });
    await recordAudit(auth, {
      actorUserId: 'admin-1',
      action: 'admin.set_role',
      targetUserId: 'someone-else',
    });

    const forVictim = await listAudit(auth, { targetUserId: 'victim' });
    expect(forVictim).toHaveLength(1);
    expect(forVictim[0]).toMatchObject({
      actorUserId: 'admin-1',
      action: 'admin.ban_user',
      targetUserId: 'victim',
      reason: 'spam',
      metadata: { banExpiresIn: 3600 },
    });
    expect(typeof forVictim[0].createdAt).toBe('string');

    const all = await listAudit(auth);
    expect(all).toHaveLength(2);
  });
});

describe('cloud-account-management — data export never leaks secrets', () => {
  it('exports account data with password hashes, tokens, and key values stripped', async () => {
    const memory = freshMemory();
    const auth = createAuth(memoryAdapter(memory));
    const adapter = (await auth.$context).adapter;

    const user = (await adapter.create({
      model: 'user',
      data: {
        name: 'Alice',
        email: 'alice@dork.test',
        emailVerified: true,
        role: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    })) as { id: string };

    await adapter.create({
      model: 'account',
      data: {
        accountId: 'gh-123',
        providerId: 'github',
        userId: user.id,
        accessToken: 'SECRET-ACCESS-TOKEN',
        refreshToken: 'SECRET-REFRESH-TOKEN',
        password: 'SECRET-PASSWORD-HASH',
        scope: 'read:user',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    await adapter.create({
      model: 'apikey',
      data: {
        name: 'my instance',
        referenceId: user.id,
        key: 'SECRET-KEY-VALUE',
        start: 'dki_abc',
        prefix: 'dki_',
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const data = await exportAccountData(auth, user.id);
    expect(data).not.toBeNull();
    const serialized = JSON.stringify(data);

    // The user's own data is present.
    expect(data?.account.email).toBe('alice@dork.test');
    expect(data?.authMethods).toHaveLength(1);
    expect(data?.authMethods[0].providerId).toBe('github');
    expect(data?.apiKeys).toHaveLength(1);
    expect(data?.apiKeys[0].name).toBe('my instance');

    // No secret material anywhere in the serialized export.
    expect(serialized).not.toContain('SECRET-ACCESS-TOKEN');
    expect(serialized).not.toContain('SECRET-REFRESH-TOKEN');
    expect(serialized).not.toContain('SECRET-PASSWORD-HASH');
    expect(serialized).not.toContain('SECRET-KEY-VALUE');
  });
});

describe('cloud-account-management — admin actions (audit attribution + effects)', () => {
  let memory: Record<string, MemoryRow[]>;
  let POST: (request: Request) => Promise<Response>;
  let auth: Auth;

  /** Sign up + verify + sign in, promote to admin, return the admin cookie + id. */
  async function makeAdmin(email: string): Promise<{ cookie: string; id: string }> {
    const cookie = await signUpVerifyAndSignIn(POST, memory, email);
    const row = memory.user.find((u) => u.email === email) as { id: string; role?: string };
    row.role = 'admin';
    return { cookie, id: row.id };
  }

  beforeEach(() => {
    memory = freshMemory();
    auth = createAuth(memoryAdapter(memory));
    POST = toNextJsHandler(auth).POST;
  });

  it('bans a target: sets banned, writes an audit row, and disables the target API keys', async () => {
    // An admin (role set directly — mirrors the break-glass promote) and a victim.
    const admin = await makeAdmin('admin@dork.test');
    const adminCookie = admin.cookie;
    const adminRow = { id: admin.id };

    await signUpVerifyAndSignIn(POST, memory, 'victim@dork.test');
    const victim = memory.user.find((u) => u.email === 'victim@dork.test') as { id: string };

    // The victim has a live linked-instance API key.
    const adapter = (await auth.$context).adapter;
    await adapter.create({
      model: 'apikey',
      data: {
        name: 'victim instance',
        referenceId: victim.id,
        key: 'victim-key',
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const res = await POST(
      authRequest(
        '/api/auth/admin/ban-user',
        { userId: victim.id, banReason: 'abuse' },
        adminCookie
      )
    );
    expect(res.status).toBe(200);

    // The user is banned.
    const bannedRow = memory.user.find((u) => u.id === victim.id);
    expect(bannedRow?.banned).toBe(true);

    // An audit row was written naming the acting admin and the target.
    const audit = await listAudit(auth, { targetUserId: victim.id });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('admin.ban_user');
    expect(audit[0].actorUserId).toBe(adminRow?.id);
    expect(audit[0].reason).toBe('abuse');

    // The victim's API key is now disabled, so its next heartbeat 401s.
    const keys = memory.apikey.filter((k) => k.referenceId === victim.id);
    expect(keys).toHaveLength(1);
    expect(keys[0].enabled).toBe(false);
  });

  it('audits create-user with the acting admin as actor and the new user as target', async () => {
    // create-user does not run adminMiddleware, so the actor must be resolved via
    // the getSessionFromCtx fallback (regression guard for actor='unknown').
    const admin = await makeAdmin('admin@dork.test');
    const res = await POST(
      authRequest(
        '/api/auth/admin/create-user',
        { email: 'made@dork.test', password: PASSWORD, name: 'Made', role: 'user' },
        admin.cookie
      )
    );
    expect(res.status).toBe(200);
    const created = memory.user.find((u) => u.email === 'made@dork.test') as { id: string };

    const audit = await listAudit(auth, { targetUserId: created.id });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe('admin.create_user');
    expect(audit[0].actorUserId).toBe(admin.id);
    expect(audit[0].actorUserId).not.toBe('unknown');
  });

  it('audits update-user', async () => {
    const admin = await makeAdmin('admin@dork.test');
    await signUpVerifyAndSignIn(POST, memory, 'target@dork.test');
    const target = memory.user.find((u) => u.email === 'target@dork.test') as { id: string };

    const res = await POST(
      authRequest(
        '/api/auth/admin/update-user',
        { userId: target.id, data: { name: 'Renamed' } },
        admin.cookie
      )
    );
    expect(res.status).toBe(200);

    const audit = await listAudit(auth, { targetUserId: target.id });
    expect(audit.map((a) => a.action)).toContain('admin.update_user');
    expect(audit.find((a) => a.action === 'admin.update_user')?.actorUserId).toBe(admin.id);
  });

  it('impersonation stamps session.impersonatedBy and writes an attributed audit row', async () => {
    const admin = await makeAdmin('admin@dork.test');
    await signUpVerifyAndSignIn(POST, memory, 'subject@dork.test');
    const subject = memory.user.find((u) => u.email === 'subject@dork.test') as { id: string };

    const res = await POST(
      authRequest('/api/auth/admin/impersonate-user', { userId: subject.id }, admin.cookie)
    );
    expect(res.status).toBe(200);

    // The impersonation session records who is impersonating.
    const impersonated = memory.session.find((s) => s.impersonatedBy === admin.id);
    expect(impersonated).toBeTruthy();
    expect(impersonated?.userId).toBe(subject.id);

    // And the action is audited to the admin, targeting the impersonated account.
    const audit = await listAudit(auth, { targetUserId: subject.id });
    const row = audit.find((a) => a.action === 'admin.impersonate_user');
    expect(row).toBeTruthy();
    expect(row?.actorUserId).toBe(admin.id);
  });
});

describe('cloud-account-management — self-serve delete (GDPR erasure)', () => {
  it('erases the user via the email-verified flow and leaves a surviving audit row', async () => {
    const memory = freshMemory();
    const auth = createAuth(memoryAdapter(memory));
    const POST = toNextJsHandler(auth).POST;

    const cookie = await signUpVerifyAndSignIn(POST, memory, 'leaving@dork.test');
    const user = memory.user.find((u) => u.email === 'leaving@dork.test') as { id: string };

    // Request deletion → the server sends a verification email (mocked) carrying a
    // one-time token; nothing is deleted yet.
    const start = await POST(
      authRequest('/api/auth/delete-user', { callbackURL: '/signin' }, cookie)
    );
    expect(start.status).toBe(200);
    expect(memory.user.find((u) => u.id === user.id)).toBeTruthy();

    const mailer = await import('@/lib/mailer');
    const call = vi.mocked(mailer.sendDeleteAccountVerification).mock.calls.at(-1);
    expect(call).toBeTruthy();
    const url = new URL((call![0] as { url: string }).url);
    const token = url.searchParams.get('token');
    expect(token).toBeTruthy();

    // Follow the confirmation link → beforeDelete/afterDelete fire and the user is
    // erased. The callback is a GET carrying the token as a query param.
    const GET = toNextJsHandler(auth).GET;
    const callback = await GET(
      new Request(
        `${ORIGIN}/api/auth/delete-user/callback?token=${encodeURIComponent(token!)}&callbackURL=${encodeURIComponent('/signin')}`,
        { method: 'GET', headers: { origin: ORIGIN, cookie } }
      )
    );
    expect([200, 302]).toContain(callback.status);
    expect(memory.user.find((u) => u.id === user.id)).toBeUndefined();

    // The audit trail of the deletion survives the erasure (audit_log has no FK
    // to user, so it is never cascaded away).
    const audit = await listAudit(auth, { targetUserId: user.id });
    expect(audit.map((a) => a.action)).toContain('account.self_delete.completed');
  });
});
