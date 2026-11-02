import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const hashPassword = vi.hoisted(() => vi.fn(async () => 'hashed'));
vi.mock('better-auth/crypto', () => ({ hashPassword }));

import { inviteSignUp } from '../invite-sign-up.js';

/**
 * A new address; one taken by an empty, never-confirmed account; one taken by a never-confirmed
 * account in use (a first owner who never confirmed); one taken by a confirmed member.
 */
type Address = 'new' | 'empty' | 'unconfirmed-in-use' | 'confirmed';

/**
 * A pool that answers as the database would for each kind of address, and records every
 * statement it runs and the values of the mail request it writes.
 */
function fakePool(address: Address) {
  const statements: string[] = [];
  const requests: unknown[][] = [];
  const client = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      statements.push(text.replace(/\s+/gu, ' ').trim());
      if (text.includes('INSERT INTO email_link_requests')) requests.push(values);
      // The account the address names, read after the sign-up's own insert: a new address is
      // then an empty account too.
      if (text.includes('AS first'))
        return {
          rowCount: 1,
          rows: [{ first: address === 'new' || address === 'empty' }],
        };
      return {
        rowCount: text.includes('INSERT INTO "user"') && address === 'new' ? 1 : 0,
        rows: [],
      };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements, requests };
}

const SPACE = '7d3c3b16-9d4b-4d4c-9b1a-0f6a4f6b2c11';
const ADDRESSES = ['new', 'empty', 'unconfirmed-in-use', 'confirmed'] as const;
const run = (pool: Pool, body: unknown, id = 'id') =>
  inviteSignUp(pool, {
    authSecret: 's'.repeat(32),
    communityId: SPACE,
    body,
    generateId: () => id,
  });
const body = (email: string) => ({ name: 'Probe', email, password: 'typed-password-1234' });

describe('inviteSignUp (DOR-2730)', () => {
  beforeEach(() => hashPassword.mockClear());

  it('runs one slow hash and the same statements for every kind of address', async () => {
    // Fails if a branch skips the hash (a timing tell) or runs other statements.
    const runs = [];
    for (const address of ADDRESSES) {
      const fake = fakePool(address);
      await run(fake.pool, body(`${address}@example.com`));
      runs.push(fake);
    }
    expect(hashPassword).toHaveBeenCalledTimes(ADDRESSES.length);
    for (const other of runs.slice(1)) expect(other.statements).toEqual(runs[0].statements);
  });

  it('asks the finishing link only for an empty account, the notice for any account in use', async () => {
    // Fails if an account in use (a never-confirmed owner included) is sent a reset that would
    // end its sessions and keys (Security M1), or if a request forgets which space it is for.
    const asked = [];
    for (const address of ADDRESSES) {
      const fake = fakePool(address);
      await run(fake.pool, body(`${address}@example.com`));
      const [kind, , email, community] = fake.requests[0];
      asked.push([kind, email, community]);
    }
    expect(asked).toEqual([
      ['password_reset', 'new@example.com', SPACE],
      ['password_reset', 'empty@example.com', SPACE],
      ['existing_account', 'unconfirmed-in-use@example.com', SPACE],
      ['existing_account', 'confirmed@example.com', SPACE],
    ]);
  });

  it('never hashes or stores the password a caller sends', async () => {
    // Fails if the typed password is kept: signing in with it would tell a new address apart.
    const { pool, statements } = fakePool('new');
    await run(pool, body('new@example.com'));
    expect(hashPassword).not.toHaveBeenCalledWith('typed-password-1234');
    expect(statements.some((text) => text.includes('INSERT INTO account'))).toBe(false);
  });

  it('answers with the same user fields for both, and never a caller-chosen picture', async () => {
    const pick = { ...body('A@x.io'), image: 'https://example.com/me.png' };
    const a = await run(fakePool('new').pool, pick, 'a');
    const b = await run(fakePool('confirmed').pool, body('b@x.io'), 'b');
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(a).toMatchObject({ email: 'a@x.io', emailVerified: false, image: null });
  });

  it('keeps a clean, capped name and the reset route’s email rule', async () => {
    // Fails if control, bidi or zero-width characters reach the account's name, or if an
    // address too long for the request table gets past validation (Security S4).
    const { pool, requests } = fakePool('new');
    const user = await run(pool, { name: '  Sa‮m​\u0007  ', email: '  Sam@X.io ' });
    expect(user).toMatchObject({ name: 'Sam', email: 'sam@x.io' });
    expect(requests[0][2]).toBe('sam@x.io');
    await expect(run(pool, { name: 'N'.repeat(101), email: 'x@y.io' })).rejects.toMatchObject({
      body: { code: 'VALIDATION_ERROR' },
    });
    await expect(run(pool, { name: 'N', email: `${'a'.repeat(316)}@y.io` })).rejects.toMatchObject({
      body: { code: 'VALIDATION_ERROR' },
    });
  });

  it('refuses a body with no name or a bad email before any statement', async () => {
    const { pool, statements } = fakePool('new');
    await expect(run(pool, { name: '', email: 'x@y.io' })).rejects.toMatchObject({
      body: { code: 'VALIDATION_ERROR' },
    });
    await expect(run(pool, { name: 'N', email: 'nope' })).rejects.toMatchObject({
      body: { code: 'VALIDATION_ERROR' },
    });
    expect(statements).toEqual([]);
  });
});
