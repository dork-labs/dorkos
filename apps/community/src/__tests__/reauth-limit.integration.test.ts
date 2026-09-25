import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  admit,
  bootstrapHost,
  startTenancyHarness,
  TENANCY_PASSWORD,
  type TenancyHarness,
  type TenancyMember,
} from './tenancy-test-harness.js';

// DOR-2275: every route that asks for the account's password spends from one per-account guess
// budget. Each route below gets its own case, so a route that stops going through that budget
// (or grows a budget of its own) fails by name, and the table must name every such route.

const CEILING = 3;
const COMMUNITY_NAME = 'Guard Owner Community';
/** A well-formed key id; the password is checked before the key is looked up. */
const ANY_KEY_ID = '00000000-0000-4000-8000-000000000000';

let h: TenancyHarness;
let communityId: string;
let operator: string;
let person: TenancyMember;
let bystander: TenancyMember;

type Actor = 'operator' | 'person';
interface GuardedRoute {
  /** `METHOD path` as the route module registers it. */
  route: string;
  actor: Actor;
  call: (cookie: string, password: string) => Promise<Response>;
}

const tenant = () => `/api/v1/communities/${communityId}`;

/** Every password-confirmed route, with a request that reaches its password check. */
const ROUTES: GuardedRoute[] = [
  {
    route: 'POST /me/leave',
    actor: 'person',
    call: (cookie, password) =>
      h.call(`${tenant()}/me/leave`, {
        cookie,
        body: { password, communityName: COMMUNITY_NAME },
      }),
  },
  {
    route: 'DELETE /me/grants',
    actor: 'person',
    call: (cookie, password) =>
      h.call(`${tenant()}/me/grants`, { method: 'DELETE', cookie, body: { password } }),
  },
  {
    route: 'POST /account/erasures',
    actor: 'person',
    call: (cookie, password) =>
      h.call('/api/v1/account/erasures', {
        cookie,
        body: { kind: 'membership', communityId, password },
      }),
  },
  {
    route: 'POST /owner/transfer',
    actor: 'operator',
    call: (cookie, password) =>
      h.call(`${tenant()}/owner/transfer`, {
        cookie,
        body: { successorMemberId: person.memberId, password, lifecycleVersion: 1 },
      }),
  },
  {
    route: 'POST /owner/export',
    actor: 'operator',
    call: (cookie, password) => h.call(`${tenant()}/owner/export`, { cookie, body: { password } }),
  },
  {
    route: 'POST /owner/lifecycle',
    actor: 'operator',
    call: (cookie, password) =>
      h.call(`${tenant()}/owner/lifecycle`, {
        cookie,
        body: { action: 'archive', lifecycleVersion: 1, password },
      }),
  },
  {
    route: 'POST /owner/deletion',
    actor: 'operator',
    call: (cookie, password) =>
      h.call(`${tenant()}/owner/deletion`, {
        cookie,
        body: {
          lifecycleVersion: 1,
          password,
          confirmName: COMMUNITY_NAME,
          confirmIdSuffix: communityId.slice(-8),
        },
      }),
  },
  {
    route: 'POST /owner/deletion/cancel',
    actor: 'operator',
    call: (cookie, password) =>
      h.call(`${tenant()}/owner/deletion/cancel`, {
        cookie,
        body: { lifecycleVersion: 1, password },
      }),
  },
  {
    route: 'POST /host/api-keys',
    actor: 'operator',
    call: (cookie, password) =>
      h.call('/api/v1/host/api-keys', {
        cookie,
        body: { label: 'Guessing', scopes: ['communities:read'], expiresInDays: 30, password },
      }),
  },
  {
    route: 'POST /host/api-keys/:id/rotate',
    actor: 'operator',
    call: (cookie, password) =>
      h.call(`/api/v1/host/api-keys/${ANY_KEY_ID}/rotate`, {
        cookie,
        body: { overlapMinutes: 0, password },
      }),
  },
];

const cookieOf = (actor: Actor) => (actor === 'operator' ? operator : person.cookie);

/** Every `METHOD path` in the route modules whose handler confirms a password. */
function passwordConfirmedRoutes(): string[] {
  const dir = fileURLToPath(new URL('../routes/', import.meta.url));
  const found: string[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.ts'))) {
    const source = readFileSync(`${dir}${file}`, 'utf8');
    const handlers = [...source.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)'/gu)];
    handlers.forEach((match, index) => {
      const body = source.slice(match.index, handlers[index + 1]?.index ?? source.length);
      if (/\bconfirmPassword\b/u.test(body)) found.push(`${match[1].toUpperCase()} ${match[2]}`);
    });
  }
  return found.sort();
}

async function expectCode(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toMatchObject({ code });
}

// The limiter reads Date.now(); this clock only moves forward across tests, so no test inherits
// an earlier test's window.
let clock = Date.now();
function advance(ms: number) {
  clock += ms;
  vi.setSystemTime(new Date(clock));
}

/** Move past every earlier test's window, so each starts with a whole budget. */
function freshWindow() {
  advance(61_000);
}

beforeAll(async () => {
  h = await startTenancyHarness('reauth_guard', { reauthAttemptsPerMinute: CEILING });
  const host = await bootstrapHost(h, 'Guard Owner', 'owner@reauth-guard.test');
  communityId = host.communityId;
  operator = host.cookie;
  person = await admit(h, communityId, operator, {
    name: 'Guesser',
    email: 'guesser@reauth-guard.test',
  });
  bystander = await admit(h, communityId, operator, {
    name: 'Bystander',
    email: 'bystander@reauth-guard.test',
  });
});

afterAll(async () => {
  await h?.close();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(clock));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the one per-account password guess limit', () => {
  it('covers every route that asks for a password', () => {
    // A convenience, not the guarantee: this text scan sees only `app.<method>('…')` handlers in
    // routes/*.ts. What guarantees no password check skips the budget is the source scan in
    // password-confirmation.test.ts, over all of src/, that finds any Better Auth password
    // check outside createPasswordConfirmation. This one makes a new route get its own case.
    expect(passwordConfirmedRoutes()).toEqual(ROUTES.map((entry) => entry.route).sort());
  });

  describe.each(ROUTES)('$route', (entry) => {
    it('refuses even the right password once wrong guesses on other routes spend the budget', async () => {
      freshWindow();
      const cookie = cookieOf(entry.actor);
      // This route really checks the password: a wrong one is a password failure.
      await expectCode(await entry.call(cookie, 'guess-here'), 403, 'REAUTH_FAILED');
      // The rest of the budget goes on the same account's other routes.
      const others = ROUTES.filter(
        (other) => other.actor === entry.actor && other.route !== entry.route
      );
      for (const other of others.slice(0, CEILING - 1))
        await expectCode(await other.call(cookie, `guess-${other.route}`), 403, 'REAUTH_FAILED');

      const limited = await entry.call(cookie, TENANCY_PASSWORD);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({
        code: 'RATE_LIMITED',
        message: 'Too many wrong passwords. Wait a minute, then try again.',
      });
      const wait = Number(limited.headers.get('retry-after'));
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(60);
    });
  });

  it('counts wrong guesses on different routes together, and the wait ends with the window', async () => {
    freshWindow();
    const [leave, disconnect, erase] = ROUTES.filter((entry) => entry.actor === 'person');
    await expectCode(await leave.call(person.cookie, 'guess-1'), 403, 'REAUTH_FAILED');
    await expectCode(await disconnect.call(person.cookie, 'guess-2'), 403, 'REAUTH_FAILED');
    advance(20_000);
    await expectCode(await erase.call(person.cookie, 'guess-3'), 403, 'REAUTH_FAILED');
    const limited = await disconnect.call(person.cookie, TENANCY_PASSWORD);
    expect(limited.status).toBe(429);
    // The first guess, 20 seconds ago, is the next to leave the minute.
    expect(limited.headers.get('retry-after')).toBe('40');

    advance(40_000);
    expect((await disconnect.call(person.cookie, TENANCY_PASSWORD)).status).toBe(204);
  });

  it('leaves another account alone, even with the same address and community', async () => {
    freshWindow();
    const disconnect = ROUTES.find((entry) => entry.route === 'DELETE /me/grants')!;
    for (let guess = 0; guess < CEILING; guess++)
      await expectCode(
        await disconnect.call(person.cookie, `guess-${guess}`),
        403,
        'REAUTH_FAILED'
      );
    expect((await disconnect.call(person.cookie, TENANCY_PASSWORD)).status).toBe(429);
    // The bystander's wrong password is still checked, and the right one still works.
    await expectCode(await disconnect.call(bystander.cookie, 'wrong'), 403, 'REAUTH_FAILED');
    expect((await disconnect.call(bystander.cookie, TENANCY_PASSWORD)).status).toBe(204);
  });

  it('gives a correct password its attempt back, so the right one never spends the budget', async () => {
    freshWindow();
    const disconnect = ROUTES.find((entry) => entry.route === 'DELETE /me/grants')!;
    for (let guess = 0; guess < CEILING - 1; guess++)
      await expectCode(
        await disconnect.call(person.cookie, `guess-${guess}`),
        403,
        'REAUTH_FAILED'
      );
    for (let right = 0; right < CEILING + 2; right++)
      expect((await disconnect.call(person.cookie, TENANCY_PASSWORD)).status).toBe(204);
    // One attempt is still left for a mistyped password; it is checked, not refused.
    await expectCode(await disconnect.call(person.cookie, 'typo'), 403, 'REAUTH_FAILED');
    expect((await disconnect.call(person.cookie, TENANCY_PASSWORD)).status).toBe(429);
  });

  it("keeps the sign-in library's own password change off, so it cannot guess around the budget", async () => {
    freshWindow();
    const change = await h.call('/api/auth/change-password', {
      cookie: person.cookie,
      body: { currentPassword: 'guess', newPassword: 'another-long-password' },
    });
    expect(change.status).toBe(404);
    // Nothing was spent: the budget is still whole.
    const disconnect = ROUTES.find((entry) => entry.route === 'DELETE /me/grants')!;
    for (let guess = 0; guess < CEILING; guess++)
      await expectCode(
        await disconnect.call(person.cookie, `guess-${guess}`),
        403,
        'REAUTH_FAILED'
      );
  });
});

describe('the other per-minute limits', () => {
  let signup: TenancyHarness;
  beforeAll(async () => {
    signup = await startTenancyHarness('signup_retry', { signupAttemptsPerMinute: 1 });
  });
  afterAll(async () => {
    await signup?.close();
  });

  it('say how long to wait too, counted from the oldest attempt in the window', async () => {
    freshWindow();
    const attempt = () =>
      signup.call('/api/auth/sign-up/email', {
        body: { name: 'Nobody', email: 'nobody@retry.test', password: 'long-enough-password' },
      });
    // The first attempt passes the limit (and is refused later for want of an invitation).
    expect((await attempt()).status).not.toBe(429);
    advance(15_000);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: 'RATE_LIMITED' });
    expect(limited.headers.get('retry-after')).toBe('45');
  });
});
