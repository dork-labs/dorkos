/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The service is a thin mapper over the Better Auth admin plugin's `listUsers`;
// mock that seam so we can assert the query we build and the view we return.
const listUsers = vi.fn();
vi.mock('@/lib/auth', () => ({
  getAuth: () => ({ api: { listUsers } }),
}));

import { type AdminUserView, listUsersForAdmin } from '../admin-service';

/** The exact public field set of an AdminUserView — nothing else may leak. */
const VIEW_KEYS: (keyof AdminUserView)[] = [
  'id',
  'email',
  'name',
  'role',
  'banned',
  'banReason',
  'banExpires',
  'emailVerified',
  'createdAt',
];

describe('listUsersForAdmin', () => {
  const HEADERS = new Headers({ cookie: 'session=abc' });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds a default query (page size 50, newest-first) and forwards the request headers', async () => {
    listUsers.mockResolvedValue({ users: [], total: 0 });

    await listUsersForAdmin(HEADERS);

    expect(listUsers).toHaveBeenCalledTimes(1);
    const arg = listUsers.mock.calls[0][0] as { query: Record<string, unknown>; headers: Headers };
    expect(arg.headers).toBe(HEADERS);
    expect(arg.query).toMatchObject({
      limit: 50,
      offset: 0,
      sortBy: 'createdAt',
      sortDirection: 'desc',
    });
    // No search args when none is requested.
    expect(arg.query.searchValue).toBeUndefined();
    expect(arg.query.searchField).toBeUndefined();
  });

  it('adds a contains-on-email search and honours explicit limit/offset', async () => {
    listUsers.mockResolvedValue({ users: [], total: 0 });

    await listUsersForAdmin(HEADERS, { search: 'kai', limit: 10, offset: 20 });

    const query = (listUsers.mock.calls[0][0] as { query: Record<string, unknown> }).query;
    expect(query).toMatchObject({
      limit: 10,
      offset: 20,
      searchValue: 'kai',
      searchField: 'email',
      searchOperator: 'contains',
    });
  });

  it('maps raw rows: role defaults to user, banned/emailVerified coerce, dates go ISO', async () => {
    const created = new Date('2026-01-02T03:04:05.000Z');
    const banExp = new Date('2026-02-01T00:00:00.000Z');
    listUsers.mockResolvedValue({
      total: 3,
      users: [
        // A plain user: role omitted, banned falsy, unverified, Date timestamps.
        {
          id: 'u1',
          email: 'a@dork.test',
          name: 'Alice',
          role: null,
          banned: null,
          emailVerified: false,
          createdAt: created,
        },
        // A banned admin: banned true, string dates that must be normalised to ISO.
        {
          id: 'u2',
          email: 'b@dork.test',
          name: 'Bob',
          role: 'admin',
          banned: true,
          banReason: 'spam',
          banExpires: banExp.toISOString(),
          emailVerified: true,
          createdAt: created.toISOString(),
        },
      ],
    });

    const page = await listUsersForAdmin(HEADERS);

    expect(page.total).toBe(3);
    expect(page.users[0]).toEqual({
      id: 'u1',
      email: 'a@dork.test',
      name: 'Alice',
      role: 'user', // defaulted from null
      banned: false, // coerced from null
      banReason: null,
      banExpires: null,
      emailVerified: false,
      createdAt: created.toISOString(),
    });
    expect(page.users[1]).toEqual({
      id: 'u2',
      email: 'b@dork.test',
      name: 'Bob',
      role: 'admin',
      banned: true,
      banReason: 'spam',
      banExpires: banExp.toISOString(),
      emailVerified: true,
      createdAt: created.toISOString(),
    });
  });

  it('coerces a non-boolean banned value to false (only literal true bans)', async () => {
    // Better Auth stores banned as 0/1 in SQLite; a truthy-but-not-true value must
    // not read as banned in the view.
    listUsers.mockResolvedValue({
      users: [{ id: 'u3', email: 'c@dork.test', name: 'Cara', banned: 1 as never }],
    });

    const page = await listUsersForAdmin(HEADERS);
    expect(page.users[0].banned).toBe(false);
    // total falls back to the row count when the plugin omits it.
    expect(page.total).toBe(1);
  });

  it('never leaks secret fields present on the raw row into the view', async () => {
    listUsers.mockResolvedValue({
      users: [
        {
          id: 'u9',
          email: 'leak@dork.test',
          name: 'Danger',
          role: 'user',
          emailVerified: true,
          createdAt: new Date('2026-03-03T00:00:00.000Z'),
          // Secret material the raw plugin row may carry — must be stripped.
          password: 'SECRET-PASSWORD-HASH',
          twoFactorSecret: 'SECRET-TOTP',
          sessionToken: 'SECRET-SESSION-TOKEN',
        } as never,
      ],
    });

    const page = await listUsersForAdmin(HEADERS);
    const view = page.users[0];

    // The view exposes exactly the AdminUserView keys, nothing more.
    expect(Object.keys(view).sort()).toEqual([...VIEW_KEYS].sort());

    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('SECRET-PASSWORD-HASH');
    expect(serialized).not.toContain('SECRET-TOTP');
    expect(serialized).not.toContain('SECRET-SESSION-TOKEN');
  });
});
