/**
 * @vitest-environment node
 *
 * Who the owner is (spec `invites` §3, ADR 260727-184933 D6).
 *
 * The registration policy in `../index.ts` guarantees the shape these read: the
 * `user` table is writable only while it is empty, so the earliest row is the
 * owner and there is never a second. These tests pin that reading, including
 * against database states the policy would have to be broken to produce —
 * because the thing that must never happen is the owner losing their own
 * machine to a row somebody else wrote.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { user, eq, type Db } from '@dorkos/db';
import { findOwnerAccount } from '../accounts.js';

/** Insert a user row directly, the way Better Auth's adapter does. */
function addUser(
  db: Db,
  fields: { id: string; name: string; createdAt: Date; role?: string | null }
): void {
  db.insert(user)
    .values({
      id: fields.id,
      name: fields.name,
      email: `${fields.id}@dork.test`,
      emailVerified: false,
      createdAt: fields.createdAt,
      updatedAt: fields.createdAt,
      role: fields.role ?? null,
    })
    .run();
}

const EARLY = new Date('2026-01-01T00:00:00.000Z');
const LATE = new Date('2026-06-01T00:00:00.000Z');

describe('findOwnerAccount', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it('is null on an install nobody has registered on', () => {
    expect(findOwnerAccount(db)).toBeNull();
  });

  it('is the only account, with its name', () => {
    addUser(db, { id: 'user-dorian', name: 'Dorian', createdAt: EARLY, role: 'owner' });
    expect(findOwnerAccount(db)).toEqual({ id: 'user-dorian', name: 'Dorian' });
  });

  it('is the earliest account, whatever the rows say about themselves', () => {
    // The state a broken migration or a future bug could leave: the owner's
    // stamp blanked, somebody else's row carrying it. Preferring the stamp
    // handed the install to the wrong account here — the fallback never ran,
    // because a row DID claim the role, just not the right one. Ordering by
    // creation is what the registration policy actually guarantees, so it is
    // the only thing worth reading.
    addUser(db, { id: 'user-dorian', name: 'Dorian', createdAt: EARLY, role: null });
    addUser(db, { id: 'user-priya', name: 'Priya', createdAt: LATE, role: 'owner' });

    expect(findOwnerAccount(db)?.id).toBe('user-dorian');
  });

  it('is still the earliest account when nobody carries a stamp at all', () => {
    addUser(db, { id: 'user-dorian', name: 'Dorian', createdAt: EARLY, role: null });
    addUser(db, { id: 'user-priya', name: 'Priya', createdAt: LATE, role: null });

    expect(findOwnerAccount(db)?.id).toBe('user-dorian');
  });

  it('does not change its answer when a later row is stamped', () => {
    addUser(db, { id: 'user-dorian', name: 'Dorian', createdAt: EARLY, role: 'owner' });
    addUser(db, { id: 'user-priya', name: 'Priya', createdAt: LATE, role: 'member' });
    expect(findOwnerAccount(db)?.id).toBe('user-dorian');

    db.update(user).set({ role: 'owner' }).where(eq(user.id, 'user-priya')).run();
    expect(findOwnerAccount(db)?.id).toBe('user-dorian');
  });

  it('reports a rename, because the name is a render cache and the id is the identity', () => {
    addUser(db, { id: 'user-dorian', name: 'Dorian', createdAt: EARLY, role: 'owner' });
    db.update(user).set({ name: 'D' }).where(eq(user.id, 'user-dorian')).run();
    expect(findOwnerAccount(db)).toEqual({ id: 'user-dorian', name: 'D' });
  });
});
