import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import type { CommunityAuth } from './auth.js';
import { ApiError } from './http.js';
import { createPasswordConfirmation } from './password-confirmation.js';

// The Postgres fixture proves the limit end to end. These cases control timing, which real HTTP
// cannot: a burst held open inside verifyPassword shows the check and the spend are one step.

const RIGHT = 'right-password';

function harness(ceiling = 2) {
  const spent = new Map<string, number>();
  const checked: string[] = [];
  let hold: Promise<void> | null = null;
  let release = () => undefined as void;
  const auth = {
    api: {
      verifyPassword: async ({ body }: { body: { password: string } }) => {
        checked.push(body.password);
        if (hold) await hold;
        if (body.password !== RIGHT) throw new Error('INVALID_PASSWORD');
        return { status: true };
      },
    },
  } as unknown as CommunityAuth;
  const confirm = createPasswordConfirmation({
    auth,
    ceiling,
    // The same contract as the app's limitAttempts: check and spend synchronously.
    spend: (key, limit) => {
      if ((spent.get(key) ?? 0) >= limit) throw new ApiError(429, 'RATE_LIMITED', 'limited');
      spent.set(key, (spent.get(key) ?? 0) + 1);
    },
    refund: (key) => spent.set(key, (spent.get(key) ?? 1) - 1),
  });
  const context = { req: { raw: { headers: new Headers() } } } as unknown as Context;
  return {
    checked,
    confirm: (account: string, password: string) => confirm(context, account, password),
    holdVerification() {
      hold = new Promise<void>((resolve) => {
        release = () => {
          hold = null;
          resolve();
        };
      });
    },
    release: () => release(),
  };
}

async function outcome(attempt: Promise<void>) {
  try {
    await attempt;
    return 'accepted';
  } catch (cause) {
    if (cause instanceof ApiError) return `${cause.status} ${cause.code}`;
    throw cause;
  }
}

describe('createPasswordConfirmation', () => {
  it('refunds a correct password, so the right one never spends the budget', async () => {
    const { confirm } = harness();
    for (let attempt = 0; attempt < 5; attempt++)
      expect(await outcome(confirm('account-1', RIGHT))).toBe('accepted');
  });

  it('refuses even the right password once an account has spent its budget, and only that account', async () => {
    const { confirm, checked } = harness();
    expect(await outcome(confirm('account-1', 'x'))).toBe('403 REAUTH_FAILED');
    expect(await outcome(confirm('account-1', 'y'))).toBe('403 REAUTH_FAILED');
    expect(await outcome(confirm('account-1', RIGHT))).toBe('429 RATE_LIMITED');
    expect(checked).toEqual(['x', 'y']);
    // Another account (from the same address, which the budget no longer looks at) is untouched.
    expect(await outcome(confirm('account-2', RIGHT))).toBe('accepted');
  });

  it('checks exactly the budget from a concurrent burst, however long each check takes', async () => {
    const { confirm, checked, holdVerification, release } = harness(2);
    holdVerification();
    const burst = [...['a', 'b', 'c', 'd', 'e', 'f', 'g'], RIGHT].map((password) =>
      outcome(confirm('account-1', password))
    );
    // Every attempt has reached the limiter while the first checks are still pending.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(checked).toEqual(['a', 'b']);
    release();
    const results = await Promise.all(burst);
    expect(results.slice(0, 2)).toEqual(['403 REAUTH_FAILED', '403 REAUTH_FAILED']);
    // The right password landed after the budget was spent, so it was refused unchecked.
    expect(results.slice(2)).toEqual(Array(6).fill('429 RATE_LIMITED'));
    expect(checked).toEqual(['a', 'b']);
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
