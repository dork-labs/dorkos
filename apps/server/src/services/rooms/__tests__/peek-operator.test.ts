/**
 * The non-minting operator lookup, and the one widening it must refuse
 * (DOR-1563).
 *
 * `peekOperator` exists because a reader may not write: the Obsidian embed opens
 * `dork.db` read-only so it can never be a second writer to DorkOS's own file,
 * and `localHuman()`/`bindOwner()` both create rows. It answers the same
 * question against the same two natural keys and returns `null` where they would
 * have minted.
 *
 * **The interesting rule is the one it refuses to apply.** `bindOwner` adopts
 * the pre-login `'local'` sentinel onto the owner's key — that is how an install
 * that gains a login keeps the rooms and memberships it already had. A read-only
 * lookup CANNOT do that, and must not pretend to by reading the sentinel and
 * calling it the owner: that row is not the owner, and handing back the owner's
 * scope for it is the widening this whole seam is shaped to prevent. So the
 * divergence is deliberate, and this file is what makes it a fact rather than a
 * comment.
 *
 * @module server/services/rooms/__tests__/peek-operator
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { authors, type Db } from '@dorkos/db';
import { AuthorRegistry, isOwnerRecord } from '../author-registry.js';
import { createAgentLookup } from '../index.js';

const OWNER_ID = 'owner-x';
const AT = '2026-08-25T09:00:00.000Z';

let db: Db;
let registry: AuthorRegistry;

/** Put one human author row on disk, without going through the registry. */
function seedHuman(id: string, naturalKey: string): void {
  db.insert(authors)
    .values({
      id,
      kind: 'human',
      naturalKey,
      displayName: 'You',
      createdAt: AT,
    })
    .run();
}

beforeEach(() => {
  db = createTestDb();
  registry = new AuthorRegistry(db, createAgentLookup(db));
});

afterEach(() => {
  db.$client.close();
});

describe('an install nobody has registered on', () => {
  it('finds the unbound local human', () => {
    seedHuman('a-local', 'local');

    expect(registry.peekOperator(null)?.id).toBe('a-local');
  });

  it('answers null rather than creating one', () => {
    // The whole reason this method exists. `localHuman()` would mint here, and
    // minting on a readonly connection raises "attempt to write a readonly
    // database" on every search.
    expect(registry.peekOperator(null)).toBeNull();
    expect(db.select().from(authors).all()).toEqual([]);
  });
});

describe('an install with an owner', () => {
  it('finds the row bound to that account', () => {
    seedHuman('a-owner', `user:${OWNER_ID}`);

    const found = registry.peekOperator(OWNER_ID);

    expect(found?.id).toBe('a-owner');
    // And it really is the owner by the same predicate the rooms domain uses,
    // so "found something" cannot pass for "found the right thing".
    expect(isOwnerRecord(found!, OWNER_ID)).toBe(true);
  });

  it('NEVER falls back to the pre-login sentinel', () => {
    // The widening. A `'local'` row on an owned install is a leftover, not the
    // owner — `isOwnerRecord` says so — and returning it would hand the owner's
    // search scope (every room on the machine, and all session history) to a
    // caller the rooms domain would refuse.
    seedHuman('a-local', 'local');

    const found = registry.peekOperator(OWNER_ID);

    expect(found).toBeNull();
  });

  it('picks the owner even when the sentinel is sitting right beside it', () => {
    // Both rows present, which is the state an install is in between gaining a
    // login and `bindOwner` adopting the sentinel. A lookup that preferred the
    // sentinel — or that returned whichever row came first — passes the test
    // above and fails this one.
    seedHuman('a-local', 'local');
    seedHuman('a-owner', `user:${OWNER_ID}`);

    expect(registry.peekOperator(OWNER_ID)?.id).toBe('a-owner');
  });
});
