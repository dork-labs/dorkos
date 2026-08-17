/**
 * Who may take a handle, who may take it back, and what the boot seeding holds
 * before anybody can ask (spec `handles` §3, §4, §4a, §8).
 *
 * Driven through the real registry against a real SQLite file, because every
 * invariant here is an INDEX invariant: case folding, partial uniqueness, and a
 * conflict target that must not swallow an insert. A fake store would assert
 * the code's opinion of the database rather than the database's.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { agents, authors, handleTombstones, eq, sql, type Db } from '@dorkos/db';
import { AuthorRegistry } from '../../author-registry.js';
import { ensureHandles } from '../ensure-handles.js';
import { RoomError } from '../../room-errors.js';
import { createTestDb } from '@dorkos/test-utils/db';

const ANA_PATH = '/agents/ana';
const BO_PATH = '/agents/bo';

/**
 * Register an agent in the mesh cache, the way the reconciler would.
 *
 * `displayName` defaults to the slug, which is what a manifest declaring none
 * reads back as. Pass it when the two genuinely differ — a real install mostly
 * has `mio-clicker-pm` addressing `Mio Clicker PM`, and the handle rules here
 * are precisely about deriving from the first and never the second.
 */
function registerAgent(
  db: Db,
  id: string,
  projectPath: string,
  called: { name: string; displayName?: string }
): void {
  db.insert(agents)
    .values({
      id,
      name: called.name,
      displayName: called.displayName ?? called.name,
      projectPath,
      runtime: 'claude-code',
      registeredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .run();
}

describe('claiming a handle', () => {
  let db: Db;
  let registry: AuthorRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
  });

  it('refuses a handle live on another author with HANDLE_TAKEN', () => {
    registerAgent(db, 'ULID_ANA', ANA_PATH, { name: 'ana' });
    registry.resolveAgent(ANA_PATH, 'Ana');
    const person = registry.localHuman();

    expect(() => registry.setHandle(person.id, 'ana')).toThrow(
      expect.objectContaining({ code: 'HANDLE_TAKEN' })
    );
  });

  it('refuses a handle tombstoned to another author with HANDLE_RESERVED', () => {
    registerAgent(db, 'ULID_ANA', ANA_PATH, { name: 'ana' });
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const person = registry.localHuman();

    // Ana gives `ana` up. Nobody else may have it, ever.
    registry.setHandle(ana.id, 'ana-pm');

    expect(() => registry.setHandle(person.id, 'ana')).toThrow(
      expect.objectContaining({ code: 'HANDLE_RESERVED' })
    );
  });

  it('refuses a spelling the grammar rejects with INVALID_HANDLE', () => {
    const person = registry.localHuman();
    for (const bad of ['a', 'ana bo', '.ana', 'ana.', 'a..b', 'ａna', 'аna']) {
      expect(() => registry.setHandle(person.id, bad), bad).toThrow(
        expect.objectContaining({ code: 'INVALID_HANDLE' })
      );
    }
    expect(registry.getById(person.id)?.handle).toBeNull();
  });

  it('lowercases what somebody typed rather than refusing it', () => {
    // Lowercase-only is stronger than case-insensitive: it removes the question
    // rather than answering it, so there is never a stored mixed-case value
    // something has to decide is equal to another. Refusing `Ana` outright would
    // be pedantry — nothing is ambiguous about what the person meant.
    const person = registry.localHuman();
    expect(registry.setHandle(person.id, '  Ana  ').handle).toBe('ana');
  });

  it('lets the ORIGINAL author take their own handle back', () => {
    registerAgent(db, 'ULID_ANA', ANA_PATH, { name: 'ana' });
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');

    registry.setHandle(ana.id, 'ana-pm');
    expect(registry.setHandle(ana.id, 'ana').handle).toBe('ana');
    // And the tombstone is gone, so nothing stands refusing a claim for a reason
    // that is no longer true.
    expect(tombstonesFor(db, 'ana')).toEqual([]);
  });

  it('never reissues a freed handle to anybody else, however long it stands', () => {
    // The keystone: reuse is the vector a rename is not. GitHub releases a name
    // and got repojacking; Matrix never frees one and cannot rename at all. A
    // permanent reservation takes the safety without the price.
    registerAgent(db, 'ULID_ANA', ANA_PATH, { name: 'ana' });
    registerAgent(db, 'ULID_BO', BO_PATH, { name: 'bo' });
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const bo = registry.resolveAgent(BO_PATH, 'Bo');

    registry.setHandle(ana.id, 'ana-pm');
    expect(() => registry.setHandle(bo.id, 'ana')).toThrow(
      expect.objectContaining({ code: 'HANDLE_RESERVED' })
    );
    // Changing hands twice more does not wear the reservation down.
    registry.setHandle(ana.id, 'ana-lead');
    registry.setHandle(ana.id, 'ana-again');
    expect(() => registry.setHandle(bo.id, 'ana')).toThrow(
      expect.objectContaining({ code: 'HANDLE_RESERVED' })
    );
  });

  it('folds case in the INDEX, not only in the query that reads it', () => {
    // The redundancy is the point: the grammar already forbids uppercase, so
    // `lower(handle)` in the index is belt-and-braces — and what it buys is that
    // the constraint stops depending on every future write path remembering to
    // normalize. A `TEXT PRIMARY KEY` in SQLite is BINARY-collated, so `Ana` and
    // `ana` would be two distinct tombstones and "already lowercased" would be
    // enforced by a doc comment. Asserted against the database directly, because
    // no service call can tell a folding index from a folding query.
    const now = new Date().toISOString();
    db.insert(handleTombstones).values({ handle: 'Ana', authorId: 'a', releasedAt: now }).run();

    expect(() =>
      db.insert(handleTombstones).values({ handle: 'ana', authorId: 'b', releasedAt: now }).run()
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('folds case on the tombstone, so a directly-written `Ana` still blocks `ana`', () => {
    // The grammar forbids uppercase, so this row cannot be written through
    // `setHandle` — which is the point. The refusal must come from the INDEX,
    // not from a write path remembering to normalize.
    const person = registry.localHuman();
    db.insert(handleTombstones)
      .values({ handle: 'Ana', authorId: 'somebody-else', releasedAt: new Date().toISOString() })
      .run();

    expect(() => registry.setHandle(person.id, 'ana')).toThrow(
      expect.objectContaining({ code: 'HANDLE_RESERVED' })
    );
  });

  it('clears a handle on an empty string, and never stores one', () => {
    // Many NULLs coexist under the partial unique index; many empty strings do
    // not, so the second person to clear theirs would collide with the first.
    registerAgent(db, 'ULID_ANA', ANA_PATH, { name: 'ana' });
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const person = registry.localHuman();

    expect(registry.setHandle(ana.id, '   ').handle).toBeNull();
    expect(registry.setHandle(person.id, '').handle).toBeNull();

    const stored = db.select({ handle: authors.handle }).from(authors).all();
    expect(stored.some((row) => row.handle === '')).toBe(false);
    expect(stored.filter((row) => row.handle === null).length).toBeGreaterThan(1);
  });
});

describe('deriving a handle at mint', () => {
  let db: Db;
  let registry: AuthorRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
  });

  it('reads `agents.name`, not the display name', () => {
    // For most agent rows the two columns differ, and reading the wrong one is
    // the single most likely way to implement derivation wrong.
    registerAgent(db, 'ULID_ANA', ANA_PATH, { name: 'temp-assetops-aced-iframe' });
    const ana = registry.resolveAgent(ANA_PATH, 'temp_assetops_aced_iframe');

    expect(ana.handle).toBe('temp-assetops-aced-iframe');
  });

  it('de-collides against a TOMBSTONE, not only against live handles', () => {
    // The path 48 of 52 agents take. A `taken` set built from live rows alone
    // lets a newly-minted agent derive straight onto a handle somebody released,
    // which defeats the tombstone where it matters most.
    registerAgent(db, 'ULID_ANA', ANA_PATH, { name: 'helper' });
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    expect(ana.handle).toBe('helper');
    registry.setHandle(ana.id, 'ana');

    registerAgent(db, 'ULID_BO', BO_PATH, { name: 'helper' });
    const bo = registry.resolveAgent(BO_PATH, 'Bo');

    expect(bo.handle).toBe('helper-2');
  });

  it('gives the local human nothing, because there is no honest string to derive', () => {
    // `'You'` is the defect this feature removes. Shipping it as a permanent
    // default on an install that may never run an account onboarding would be
    // shipping the defect as the answer.
    expect(registry.localHuman().handle).toBeNull();
  });

  it('does not refresh the handle when the manifest name changes (D12)', () => {
    registerAgent(db, 'ULID_ANA', ANA_PATH, { name: 'ana' });
    const first = registry.resolveAgent(ANA_PATH, 'Ana');
    expect(first.handle).toBe('ana');

    // Both columns, because a manifest rename moves both: `name` addresses the
    // agent and `display_name` renders it. Moving only `name` would stage a
    // state no manifest produces, and `AuthorRegistry` now (correctly) declines
    // to overwrite a display name with a slug the manifest contradicts
    // (DOR-1264).
    db.update(agents)
      .set({ name: 'Ana The Second', displayName: 'Ana The Second' })
      .where(eq(agents.id, 'ULID_ANA'))
      .run();
    const again = registry.resolveAgent(ANA_PATH, 'Ana The Second');

    // The mesh reconciler rebuilds `agents` from disk every five minutes, so a
    // re-derived handle would follow the manifest — back into a name with a
    // space in it — and silently undo the feature.
    expect(again.handle).toBe('ana');
    expect(again.displayName).toBe('Ana The Second');
  });

  it('refuses a handle collision at insert instead of returning a phantom author', () => {
    // **The single line where this design most easily regresses into something
    // worse than nothing.** The insert used to carry a BARE
    // `onConflictDoNothing()`, which means "on conflict with ANY unique index".
    // Once `authors_handle_unique` exists, a handle collision silently drops the
    // insert, the re-read that follows queries `(kind, natural_key)` and finds
    // nothing, and the caller is handed a ULID for a row that does not exist.
    // Every later `room_entries.author_id` would then point at a phantom.
    //
    // Reaching that collision takes a deliberately corrupt row, because the
    // ordinary paths cannot produce one: derivation de-collides against every
    // handle it can see, and `retireAndMint` releases before it mints. Here the
    // retired row keeps its handle, and the fresh mint is inside its own lineage
    // — so `taken` does not report it and derivation walks straight onto it.
    registerAgent(db, 'ULID_ANA', ANA_PATH, { name: 'ana' });
    const first = registry.resolveAgent(ANA_PATH, 'Ana');
    expect(first.handle).toBe('ana');
    db.update(authors)
      .set({ retiredAt: new Date().toISOString() })
      .where(eq(authors.id, first.id))
      .run();

    let thrown: unknown = null;
    try {
      registry.resolveAgent(ANA_PATH, 'Ana');
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RoomError);
    expect((thrown as RoomError).code).toBe('HANDLE_TAKEN');
    // And nothing was written: no second active row, no phantom to point at.
    expect(db.select().from(authors).where(eq(authors.handle, 'ana')).all()).toHaveLength(1);
  });
});

describe('the seeded reservations', () => {
  let db: Db;
  let registry: AuthorRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
  });

  it('holds `dorkos` for the room’s own voice before anything can be minted', () => {
    // The ordering the lazy version failed on: `system()` has ONE production
    // caller, the notice path, so on a fresh install the row does not exist
    // until the first notice fires — and an agent whose manifest name is
    // `DorkOS` that joins first would take `@dorkos` and be addressed as the
    // room itself.
    ensureHandles(db, registry);
    registerAgent(db, 'ULID_IMPOSTOR', ANA_PATH, { name: 'DorkOS' });

    const impostor = registry.resolveAgent(ANA_PATH, 'DorkOS');

    expect(registry.system().handle).toBe('dorkos');
    expect(impostor.handle).toBe('dorkos-2');
  });

  it('holds the three broadcast words against anybody claiming them', () => {
    ensureHandles(db, registry);
    const person = registry.localHuman();

    for (const word of ['everyone', 'here', 'channel']) {
      expect(() => registry.setHandle(person.id, word), word).toThrow(
        expect.objectContaining({ code: 'HANDLE_RESERVED' })
      );
    }
  });

  it('keeps an agent from DERIVING onto a broadcast word', () => {
    // A model writes `@everyone` whether or not that is our spelling for a
    // broadcast, so an unreserved `everyone` is a name an adversarial agent
    // could claim precisely to harvest broadcast-intent messages.
    ensureHandles(db, registry);
    registerAgent(db, 'ULID_EVERYONE', ANA_PATH, { name: 'everyone' });

    expect(registry.resolveAgent(ANA_PATH, 'Everyone').handle).toBe('everyone-2');
  });

  it('still backfills when seeding fails, and says what it lost', () => {
    // One `try` around both halves let a seeding failure cancel a backfill that
    // had not run yet, so an install would lose every agent's address to a
    // problem with one reserved word. They repair independent state.
    registerAgent(db, 'ULID_ANA', ANA_PATH, { name: 'ana' });
    registry.resolveAgent(ANA_PATH, 'Ana');
    db.update(authors).set({ handle: null }).run();
    const seedFailure = new Error('the reservations are unreachable');
    const broken = new Proxy(registry, {
      get(target, prop, receiver) {
        if (prop === 'system') {
          return () => {
            throw seedFailure;
          };
        }
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    expect(() => ensureHandles(db, broken)).not.toThrow();

    expect(registry.getById(registry.listActive('agent')[0]!.id)?.handle).toBe('ana');
  });

  it('is idempotent across boots', () => {
    ensureHandles(db, registry);
    const first = registry.system().handle;
    const tombstonesAfterFirst = db.select().from(handleTombstones).all().length;

    ensureHandles(db, registry);
    ensureHandles(db, registry);

    expect(registry.system().handle).toBe(first);
    expect(db.select().from(handleTombstones).all()).toHaveLength(tombstonesAfterFirst);
  });
});

describe('the backfill', () => {
  let db: Db;
  let registry: AuthorRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
  });

  /** Mint the shapes a real install holds, with the handle column left empty. */
  function seedLegacyAuthors(): void {
    registerAgent(db, 'ULID_ANA', ANA_PATH, {
      name: 'mio-clicker-pm',
      displayName: 'Mio Clicker PM',
    });
    registerAgent(db, 'ULID_BO', BO_PATH, { name: 'Art Blocks Analytics' });
    registerAgent(db, 'ULID_CY', '/agents/cy', { name: 'LifeOS' });
    registry.resolveAgent(ANA_PATH, 'Mio Clicker PM');
    registry.resolveAgent(BO_PATH, 'Art Blocks Analytics');
    registry.resolveAgent('/agents/cy', 'LifeOS');
    registry.localHuman();
    // Every row goes back to the pre-column state, which is what a real install
    // upgrading into this migration actually looks like.
    db.update(authors).set({ handle: null }).run();
    db.delete(handleTombstones).run();
  }

  it('gives every space-named agent a valid handle, and the human none', () => {
    seedLegacyAuthors();
    ensureHandles(db, registry);

    const byName = new Map(
      db
        .select()
        .from(authors)
        .all()
        .map((row) => [row.displayName, row.handle])
    );
    expect(byName.get('Mio Clicker PM')).toBe('mio-clicker-pm');
    expect(byName.get('Art Blocks Analytics')).toBe('art-blocks-analytics');
    expect(byName.get('LifeOS')).toBe('lifeos');
    // Asked, never derived.
    expect(byName.get('You')).toBeNull();
    // The room's own voice, seeded rather than derived.
    expect(byName.get('DorkOS')).toBe('dorkos');
  });

  it('writes nothing on a second run, and does not advance a suffix', () => {
    seedLegacyAuthors();
    // A second agent that derives onto the same stem, so a re-run that
    // re-derived would push it to `-3`.
    registerAgent(db, 'ULID_DUP', '/agents/dup', { name: 'LifeOS' });
    registry.resolveAgent('/agents/dup', 'LifeOS');
    db.update(authors).set({ handle: null }).run();

    ensureHandles(db, registry);
    const first = db
      .select({ id: authors.id, handle: authors.handle })
      .from(authors)
      .all()
      .map((row) => `${row.id}:${row.handle}`)
      .sort();
    const tombstonesAfterFirst = db.select().from(handleTombstones).all().length;

    ensureHandles(db, registry);
    const second = db
      .select({ id: authors.id, handle: authors.handle })
      .from(authors)
      .all()
      .map((row) => `${row.id}:${row.handle}`)
      .sort();

    expect(second).toEqual(first);
    expect(db.select().from(handleTombstones).all()).toHaveLength(tombstonesAfterFirst);
    expect(first.filter((row) => row.endsWith(':lifeos-2'))).toHaveLength(1);
    expect(first.some((row) => row.endsWith(':lifeos-3'))).toBe(false);
  });

  it('leaves a handle somebody already chose alone', () => {
    seedLegacyAuthors();
    ensureHandles(db, registry);
    const cy = db.select().from(authors).where(eq(authors.handle, 'lifeos')).get()!;

    registry.setHandle(cy.id, 'life-os');
    ensureHandles(db, registry);

    expect(registry.getById(cy.id)?.handle).toBe('life-os');
  });
});

/** Every tombstone row for a handle, case-folded the way the index folds. */
function tombstonesFor(db: Db, handle: string): { authorId: string }[] {
  return db
    .select({ authorId: handleTombstones.authorId })
    .from(handleTombstones)
    .where(sql`lower(${handleTombstones.handle}) = ${handle}`)
    .all();
}
