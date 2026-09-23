import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import type { CommunityAuth } from './auth.js';
import { ApiError } from './http.js';
import { createPasswordConfirmation } from './password-confirmation.js';

// The Postgres fixture proves the limit end to end from one address. These cases pull the two
// budgets apart, which one socket peer cannot: the account budget follows a guesser across
// addresses, and the address budget follows one address across accounts.

const RIGHT = 'right-password';

function harness() {
  const spent = new Map<string, number>();
  const auth = {
    api: {
      verifyPassword: async ({ body }: { body: { password: string } }) => {
        if (body.password !== RIGHT) throw new Error('INVALID_PASSWORD');
        return { status: true };
      },
    },
  } as unknown as CommunityAuth;
  const confirm = createPasswordConfirmation({
    auth,
    ceiling: 2,
    peer: (c) => c.req.header('x-peer') ?? 'unknown',
    exhausted: (key, ceiling) => (spent.get(key) ?? 0) >= ceiling,
    record: (key) => spent.set(key, (spent.get(key) ?? 0) + 1),
  });
  const context = (peer: string) =>
    ({
      req: {
        raw: { headers: new Headers() },
        header: (name: string) => (name === 'x-peer' ? peer : undefined),
      },
    }) as unknown as Context;
  return { confirm, context };
}

async function refusal(attempt: Promise<void>) {
  try {
    await attempt;
    return 'accepted';
  } catch (cause) {
    if (cause instanceof ApiError) return `${cause.status} ${cause.code}`;
    throw cause;
  }
}

describe('createPasswordConfirmation', () => {
  it('accepts the right password without spending the budget', async () => {
    const { confirm, context } = harness();
    for (let attempt = 0; attempt < 5; attempt++)
      expect(await refusal(confirm(context('10.0.0.1'), 'account-1', RIGHT))).toBe('accepted');
  });

  it('follows one account across addresses', async () => {
    const { confirm, context } = harness();
    expect(await refusal(confirm(context('10.0.0.1'), 'account-1', 'x'))).toBe('403 REAUTH_FAILED');
    expect(await refusal(confirm(context('10.0.0.2'), 'account-1', 'x'))).toBe('403 REAUTH_FAILED');
    expect(await refusal(confirm(context('10.0.0.3'), 'account-1', RIGHT))).toBe(
      '429 RATE_LIMITED'
    );
    // Another account on a fresh address is untouched.
    expect(await refusal(confirm(context('10.0.0.4'), 'account-2', RIGHT))).toBe('accepted');
  });

  it('follows one address across accounts', async () => {
    const { confirm, context } = harness();
    expect(await refusal(confirm(context('10.0.0.9'), 'account-1', 'x'))).toBe('403 REAUTH_FAILED');
    expect(await refusal(confirm(context('10.0.0.9'), 'account-2', 'x'))).toBe('403 REAUTH_FAILED');
    expect(await refusal(confirm(context('10.0.0.9'), 'account-3', RIGHT))).toBe(
      '429 RATE_LIMITED'
    );
    expect(await refusal(confirm(context('10.0.0.8'), 'account-3', RIGHT))).toBe('accepted');
  });
});

describe('every server-side password check', () => {
  // A route that calls Better Auth's verifyPassword itself skips the guess limit (the server-side
  // call never reaches Better Auth's HTTP limiter) and answers a wrong password with some other
  // code. This fails the moment one appears; route it through createPasswordConfirmation instead.
  it('goes through createPasswordConfirmation', () => {
    const root = fileURLToPath(new URL('.', import.meta.url));
    const sources = (readdirSync(root, { recursive: true, encoding: 'utf8' }) as string[])
      .filter((file) => /\.tsx?$/u.test(file))
      .filter((file) => !/(^|\/)__tests__\/|\.test\.tsx?$/u.test(file));
    // The scan really reaches the route modules and the one permitted caller.
    expect(sources).toEqual(expect.arrayContaining(['routes/members.ts', 'routes/host-keys.ts']));
    expect(readFileSync(join(root, 'password-confirmation.ts'), 'utf8')).toMatch(/verifyPassword/u);
    const offenders = sources
      .filter((file) => file !== 'password-confirmation.ts')
      .filter((file) => /\bverifyPassword\b/u.test(readFileSync(join(root, file), 'utf8')))
      .map((file) => relative(root, join(root, file)));
    expect(offenders).toEqual([]);
  });
});
