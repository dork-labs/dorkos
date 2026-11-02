import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { dropTestDatabase } from './drop-test-database.js';

/** A maintenance pool that records its SQL and reports no sessions left open. */
function fakeAdmin() {
  const query = vi.fn(async () => ({ rows: [{ n: 0 }] }));
  return { admin: { query } as unknown as Pool, query };
}

describe('dropTestDatabase (DOR-3696)', () => {
  // Purpose: the name reaches SQL quoted, only after the drain query, through one FORCE drop.
  it('drains, then drops the quoted name', async () => {
    const { admin, query } = fakeAdmin();
    await dropTestDatabase(admin, 'community_tokens_0123abcd');
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining('pg_stat_activity'), [
      'community_tokens_0123abcd',
    ]);
    expect(query).toHaveBeenLastCalledWith(
      'DROP DATABASE IF EXISTS "community_tokens_0123abcd" WITH (FORCE)'
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  // Purpose: anything but a plain lower-case identifier is refused before any SQL runs.
  it.each([
    ['a quote', 'x" WITH (FORCE); DROP DATABASE postgres; --'],
    ['a space', 'community x'],
    ['upper case', 'Community_X'],
    ['an empty name', ''],
    ['a name past 63 characters', `a${'b'.repeat(63)}`],
  ])('refuses %s without running SQL', async (_, name) => {
    const { admin, query } = fakeAdmin();
    await expect(dropTestDatabase(admin, name)).rejects.toThrow('not a generated test database');
    expect(query).not.toHaveBeenCalled();
  });
});
