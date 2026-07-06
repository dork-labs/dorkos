/**
 * @vitest-environment node
 */
import { memoryAdapter } from 'better-auth/adapters/memory';
import { toNextJsHandler } from 'better-auth/next-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The Resend seam is mocked at the module boundary so no test performs real
// email/network I/O. `createAuth`'s email hooks call these functions.
vi.mock('@/lib/mailer', () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
  sendResetPassword: vi.fn().mockResolvedValue(undefined),
}));

import { sendVerificationEmail } from '@/lib/mailer';

import { assertProductionAuthEnv, createAuth, resolveBaseURL } from '../auth';

// Emails are assembled from parts so the source never contains a literal
// address token. Domain uses a `.test` TLD (RFC 6761, reserved for testing).
const DOMAIN = 'dork.test';
const OWNER_EMAIL = 'owner' + '@' + DOMAIN;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const OWNER_NAME = 'Owner';

// The auth instance's baseURL comes from BETTER_AUTH_URL (default below); a
// matching Origin header makes Better Auth's CSRF origin check pass.
const ORIGIN = 'http://localhost:3000';

/** A row shape loose enough for the in-memory Better Auth store. */
type MemoryRow = Record<string, unknown> & { email?: string; emailVerified?: boolean };

/** Build a JSON POST request against the Better Auth Next.js handler. */
function authRequest(pathname: string, body: unknown): Request {
  return new Request(`${ORIGIN}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  });
}

describe('DorkOS account — Better Auth cloud identity (integration)', () => {
  // The in-memory adapter needs its model arrays pre-created.
  const memory: Record<string, MemoryRow[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };
  let POST: (request: Request) => Promise<Response>;

  beforeAll(() => {
    // Provide a stable secret so Better Auth signs sessions without warning.
    process.env.BETTER_AUTH_SECRET = 'test-secret-test-secret-test-secret-123';
    const auth = createAuth(memoryAdapter(memory));
    POST = toNextJsHandler(auth).POST;
  });

  afterAll(() => {
    delete process.env.BETTER_AUTH_SECRET;
  });

  it('creates a user and sends exactly one verification email on sign-up', async () => {
    const res = await POST(
      authRequest('/api/auth/sign-up/email', {
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
        name: OWNER_NAME,
      })
    );

    expect(res.status).toBe(200);
    expect(memory.user).toHaveLength(1);
    expect(memory.user[0].email).toBe(OWNER_EMAIL);
    // Freshly created accounts are unverified until they confirm their email.
    expect(memory.user[0].emailVerified).toBe(false);
    // Exactly one verification email, via the mocked mailer — never the network.
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: OWNER_EMAIL, url: expect.stringContaining('http') })
    );
  });

  it('rejects sign-in while the email is unverified', async () => {
    const res = await POST(
      authRequest('/api/auth/sign-in/email', {
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
      })
    );

    // 403: requireEmailVerification blocks a session until the email is verified.
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('signs in and returns a session once the email is verified', async () => {
    // Simulate the user clicking the verification link.
    memory.user[0].emailVerified = true;

    const res = await POST(
      authRequest('/api/auth/sign-in/email', {
        email: OWNER_EMAIL,
        password: OWNER_PASSWORD,
      })
    );

    expect(res.status).toBe(200);
    // A session cookie is issued.
    expect(res.headers.get('set-cookie')).toMatch(/session_token/);
    const body = (await res.json()) as { user?: { email?: string }; token?: string };
    expect(body.user?.email).toBe(OWNER_EMAIL);
    expect(body.token).toBeTruthy();
    // A session row now exists for the user.
    expect(memory.session.length).toBeGreaterThan(0);
  });

  it('registers GitHub and Google as social sign-in providers', () => {
    const auth = createAuth(
      memoryAdapter({ user: [], session: [], account: [], verification: [] })
    );

    expect(auth.options.socialProviders?.github).toBeDefined();
    expect(auth.options.socialProviders?.google).toBeDefined();
  });

  it('enables email/password with verification required', () => {
    const auth = createAuth(
      memoryAdapter({ user: [], session: [], account: [], verification: [] })
    );

    expect(auth.options.emailAndPassword?.enabled).toBe(true);
    expect(auth.options.emailAndPassword?.requireEmailVerification).toBe(true);
  });
});

describe('assertProductionAuthEnv (fail-closed production config)', () => {
  const STRONG_SECRET = 'a'.repeat(32);
  const PUBLIC_URL = 'https://dorkos.ai';

  it('does not throw outside production, even with an unset secret', () => {
    expect(() =>
      assertProductionAuthEnv({
        NODE_ENV: 'development',
        BETTER_AUTH_SECRET: undefined,
        BETTER_AUTH_URL: 'http://localhost:3000',
      })
    ).not.toThrow();
    expect(() =>
      assertProductionAuthEnv({
        NODE_ENV: 'test',
        BETTER_AUTH_SECRET: undefined,
        BETTER_AUTH_URL: 'http://localhost:3000',
      })
    ).not.toThrow();
  });

  it('throws in production when the secret is missing', () => {
    expect(() =>
      assertProductionAuthEnv({
        NODE_ENV: 'production',
        BETTER_AUTH_SECRET: undefined,
        BETTER_AUTH_URL: PUBLIC_URL,
      })
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it('throws in production when the secret is shorter than 32 chars', () => {
    expect(() =>
      assertProductionAuthEnv({
        NODE_ENV: 'production',
        BETTER_AUTH_SECRET: 'a'.repeat(31),
        BETTER_AUTH_URL: PUBLIC_URL,
      })
    ).toThrow(/BETTER_AUTH_SECRET/);
  });

  it('throws in production when the URL is a localhost origin', () => {
    for (const url of ['http://localhost:3000', 'https://127.0.0.1', 'http://[::1]:3000']) {
      expect(() =>
        assertProductionAuthEnv({
          NODE_ENV: 'production',
          BETTER_AUTH_SECRET: STRONG_SECRET,
          BETTER_AUTH_URL: url,
        })
      ).toThrow(/BETTER_AUTH_URL/);
    }
  });

  it('passes in production with a strong secret and a public origin', () => {
    expect(() =>
      assertProductionAuthEnv({
        NODE_ENV: 'production',
        BETTER_AUTH_SECRET: STRONG_SECRET,
        BETTER_AUTH_URL: PUBLIC_URL,
      })
    ).not.toThrow();
  });

  it('passes on a Vercel preview even when BETTER_AUTH_URL is localhost (origin derives from the branch URL)', () => {
    expect(() =>
      assertProductionAuthEnv({
        NODE_ENV: 'production', // Vercel preview builds run with NODE_ENV=production
        BETTER_AUTH_SECRET: STRONG_SECRET,
        BETTER_AUTH_URL: 'http://localhost:3000',
        VERCEL_ENV: 'preview',
        VERCEL_BRANCH_URL: 'dorkos-web-git-some-branch-dopel.vercel.app',
      })
    ).not.toThrow();
  });

  it('still throws on a preview that is missing its branch URL (resolves to localhost)', () => {
    expect(() =>
      assertProductionAuthEnv({
        NODE_ENV: 'production',
        BETTER_AUTH_SECRET: STRONG_SECRET,
        BETTER_AUTH_URL: 'http://localhost:3000',
        VERCEL_ENV: 'preview',
        VERCEL_BRANCH_URL: undefined,
      })
    ).toThrow(/BETTER_AUTH_URL/);
  });
});

describe('resolveBaseURL', () => {
  it('derives the origin from the per-branch URL on a Vercel preview', () => {
    expect(
      resolveBaseURL({
        BETTER_AUTH_URL: 'http://localhost:3000',
        VERCEL_ENV: 'preview',
        VERCEL_BRANCH_URL: 'dorkos-web-git-some-branch-dopel.vercel.app',
      })
    ).toBe('https://dorkos-web-git-some-branch-dopel.vercel.app');
  });

  it('uses the explicit BETTER_AUTH_URL in production', () => {
    expect(
      resolveBaseURL({
        BETTER_AUTH_URL: 'https://dorkos.ai',
        VERCEL_ENV: 'production',
        VERCEL_BRANCH_URL: 'dorkos-web-git-some-branch-dopel.vercel.app',
      })
    ).toBe('https://dorkos.ai');
  });

  it('uses BETTER_AUTH_URL locally (no VERCEL_ENV)', () => {
    expect(
      resolveBaseURL({
        BETTER_AUTH_URL: 'http://localhost:6244',
        VERCEL_ENV: undefined,
        VERCEL_BRANCH_URL: undefined,
      })
    ).toBe('http://localhost:6244');
  });
});
