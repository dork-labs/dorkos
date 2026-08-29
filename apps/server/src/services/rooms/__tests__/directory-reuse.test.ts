/**
 * An author row belongs to the occupant it was minted for
 * (ADR 260801-003051).
 *
 * ADR 260726-170126 keys room author identity on the agent's DIRECTORY and
 * accepts that a *moved* agent splits in two. It left the inverse unhandled:
 * registering a **new** agent where an old one lived silently inherited the old
 * one's entire message history, `@handle` claims and room memberships. The stamp
 * this file is about is what tells one occupancy of a directory from the next —
 * derived from the `agents` table, never accepted from a caller.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { agents, authors, roomMembers, eq, isNull, and, type Db } from '@dorkos/db';
import { createTestDb } from '@dorkos/test-utils/db';
import { AuthorRegistry } from '../author-registry.js';
import { createAgentLookup } from '../index.js';
import { createRoomHarness, type RoomHarness } from './room-test-harness.js';

const ANA_PATH = '/agents/ana';

vi.mock('../../../lib/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/logger.js')>();
  return { ...actual, logger: { ...actual.logger, warn: vi.fn(), info: vi.fn() } };
});

const { logger } = await import('../../../lib/logger.js');

/**
 * Register an agent row the way the mesh registry does. `name` is the slug;
 * `displayName` is left null unless given, which is how a manifest that declares
 * none is stored.
 */
function registerAgent(
  db: Db,
  id: string,
  projectPath: string,
  called: { name?: string; displayName?: string } = {}
): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id,
      name: called.name ?? 'ana',
      ...(called.displayName !== undefined ? { displayName: called.displayName } : {}),
      runtime: 'claude-code',
      projectPath,
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

/** Swap whichever agent is registered at `projectPath` for a different one. */
function replaceAgentAt(
  db: Db,
  projectPath: string,
  newId: string,
  called: { name?: string; displayName?: string } = {}
): void {
  db.delete(agents).where(eq(agents.projectPath, projectPath)).run();
  registerAgent(db, newId, projectPath, called);
}

/** Every `authors` row for a directory, retired ones included. */
function allAuthorRows(db: Db, naturalKey: string) {
  return db.select().from(authors).where(eq(authors.naturalKey, naturalKey)).all();
}

let db: Db;
let registry: AuthorRegistry;

beforeEach(() => {
  db = createTestDb();
  registry = new AuthorRegistry(db);
  vi.mocked(logger.warn).mockClear();
});

// ---------------------------------------------------------------------------
// §5.8 — a reused directory starts a fresh author
// ---------------------------------------------------------------------------

describe('a directory that changes hands starts a fresh author', () => {
  it('retires the old row, mints a stamped one, and never moves a message', () => {
    registerAgent(db, 'ULID_ANA', ANA_PATH, { name: 'ana', displayName: 'Ana' });
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    expect(ana.mintedForManifestId).toBe('ULID_ANA');

    replaceAgentAt(db, ANA_PATH, 'ULID_BO', { name: 'bo', displayName: 'Bo' });
    const bo = registry.resolveAgent(ANA_PATH, 'Bo');

    // A DIFFERENT author, which is the entire point: everything Ana ever wrote
    // still carries Ana's id and still renders as Ana.
    expect(bo.id).not.toBe(ana.id);
    expect(bo.mintedForManifestId).toBe('ULID_BO');
    expect(registry.getById(ana.id)?.displayName).toBe('Ana');

    // Two rows, exactly one of them active.
    const rows = allAuthorRows(db, ANA_PATH);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.retiredAt === null).map((row) => row.id)).toEqual([bo.id]);
    expect(rows.find((row) => row.id === ana.id)?.retiredAt).not.toBeNull();
  });

  it('does not resolve the retired row by its id, so a ghost cannot be seated again', () => {
    // `findAuthorByHandle` falls back to an author ID when a token names no live
    // handle (DOR-1611), and it scans LIVE rows to do it — deliberately, and not
    // through `getById`, which carries no `retired_at IS NULL` filter. Swapping
    // the two stays green on every other test in this repo and puts a retired
    // GHOST back on a roster: the room-management verbs seat whatever this
    // lookup hands back, and the owner would see a member nobody can reach.
    const harness: RoomHarness = createRoomHarness({ agents: (d) => createAgentLookup(d) });
    registerAgent(harness.db, 'ULID_ANA', ANA_PATH, { name: 'ana', displayName: 'Ana' });
    const ana = harness.authors.resolveAgent(ANA_PATH, 'Ana');

    replaceAgentAt(harness.db, ANA_PATH, 'ULID_BO', { name: 'bo', displayName: 'Bo' });
    const bo = harness.authors.resolveAgent(ANA_PATH, 'Bo');

    // The live occupant resolves by id, which is the fallback doing its job…
    expect(harness.service.findAuthorByHandle(bo.id)?.id).toBe(bo.id);
    // …and its predecessor does not, which is the half a mutation removes.
    expect(harness.service.findAuthorByHandle(ana.id)).toBeNull();
    // A liveness rule, never a deletion: the row is still there, and everything
    // Ana ever wrote still renders as Ana.
    expect(harness.authors.getById(ana.id)?.displayName).toBe('Ana');
  });

  it('names the fresh author from the manifest, not from a predecessor still holding a token', () => {
    // The stale-token path, which is reachable and long-lived: an identity token
    // is never rewritten, `revoke` has no production caller, and one stays valid
    // for up to thirty days. So the agent that USED to live here can still make
    // a bearer call carrying its own name, minutes after the directory changed
    // hands — and that name looks knowledgeable, because it is nothing like the
    // new occupant's slug. On a mint the manifest wins for exactly this reason.
    registerAgent(db, 'ULID_ANA', ANA_PATH, { name: 'ana', displayName: 'Ana' });
    registry.resolveAgent(ANA_PATH, 'Ana');

    replaceAgentAt(db, ANA_PATH, 'ULID_BO', { name: 'bo', displayName: 'Bo' });
    const bo = registry.resolveAgent(ANA_PATH, 'Ana');

    expect(bo.mintedForManifestId).toBe('ULID_BO');
    expect(bo.displayName).toBe('Bo');
    expect(registry.getById(bo.id)?.displayName).toBe('Bo');
  });

  it('leaves the fresh author a member of nothing, and says so loudly', () => {
    const harness: RoomHarness = createRoomHarness({ agents: (d) => createAgentLookup(d) });
    registerAgent(harness.db, 'ULID_ANA', ANA_PATH);
    const room = harness.service.createRoom(
      { kind: 'channel', slug: 'general', title: '#general', members: [], agentPaths: [ANA_PATH] },
      harness.human
    );
    const ana = harness.authors.resolveAgent(ANA_PATH, 'Ana');
    expect(
      harness.db.select().from(roomMembers).where(eq(roomMembers.authorId, ana.id)).all()
    ).toHaveLength(1);

    vi.mocked(logger.warn).mockClear();
    replaceAgentAt(harness.db, ANA_PATH, 'ULID_BO');
    const bo = harness.authors.resolveAgent(ANA_PATH, 'Bo');

    // Room membership is an ACCESS fact. A new agent occupying a reused
    // directory must not inherit the rooms the previous one was invited to —
    // so it is in none, and has to be re-invited.
    expect(
      harness.db.select().from(roomMembers).where(eq(roomMembers.authorId, bo.id)).all()
    ).toHaveLength(0);
    // The old membership is untouched, which is what keeps the room's history
    // and its roster coherent.
    expect(
      harness.db.select().from(roomMembers).where(eq(roomMembers.authorId, ana.id)).all()
    ).toHaveLength(1);

    // Loud, not silent: both ids and every room left behind.
    const [message, fields] = vi.mocked(logger.warn).mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    expect(message).toContain('changed hands');
    expect(fields).toMatchObject({
      retiredAuthorId: ana.id,
      authorId: bo.id,
      manifestId: 'ULID_BO',
      previousManifestId: 'ULID_ANA',
      roomsLeftBehind: 1,
      roomIds: [room.id],
    });
  });

  it('makes only the new occupant addressable, and only it takes turns', async () => {
    const harness: RoomHarness = createRoomHarness({ agents: (d) => createAgentLookup(d) });
    registerAgent(harness.db, 'ULID_ANA', ANA_PATH);
    const seeded = harness.service.createRoom(
      { kind: 'channel', slug: 'general', title: '#general', members: [], agentPaths: [ANA_PATH] },
      harness.human
    );
    const ana = harness.authors.resolveAgent(ANA_PATH, 'ana');

    replaceAgentAt(harness.db, ANA_PATH, 'ULID_BO');
    // The operator re-invites the agent that lives there now.
    const bo = harness.service.addMember(seeded.id, harness.human, { agentPath: ANA_PATH });

    const room = harness.service.getRoom(seeded.id, harness.human)!;
    const rowFor = (id: string) => room.members.find((m) => m.author.id === id)!.author;
    expect(rowFor(ana.id).handle).toBeNull();
    expect(rowFor(bo.author.id).handle).toBe('ana');

    const entry = harness.service.post(room.id, { authorId: harness.human, text: '@ana hi' });
    expect(entry.mentions).toEqual([bo.author.id]);

    await harness.service.triggersIdle();
    expect(harness.runner.turns.map((turn) => turn.authorId)).toEqual([bo.author.id]);
  });
});

// ---------------------------------------------------------------------------
// §5.9 — grandfathering, and the ghost row
// ---------------------------------------------------------------------------

describe('the two states that must NOT mint a second row', () => {
  it('adopts a legacy row with no stamp rather than retiring it', () => {
    // Every author row that exists before this migration has a null stamp.
    // Retiring them would drop the whole install out of every room at once.
    registerAgent(db, 'ULID_ANA', ANA_PATH);
    db.insert(authors)
      .values({
        id: 'LEGACY_AUTHOR',
        kind: 'agent',
        naturalKey: ANA_PATH,
        displayName: 'Ana',
        createdAt: new Date().toISOString(),
      })
      .run();

    const resolved = registry.resolveAgent(ANA_PATH, 'Ana');

    expect(resolved.id).toBe('LEGACY_AUTHOR');
    expect(resolved.mintedForManifestId).toBe('ULID_ANA');
    expect(allAuthorRows(db, ANA_PATH)).toHaveLength(1);
  });

  it('leaves a ghost row alone, whatever its stamp, and mints nothing', () => {
    // No live occupant means no generation to compare against — and retiring on
    // absence would churn a fresh row on EVERY resolve for an agent that is
    // merely gone. M2 is what stops a ghost claiming anything; this is what
    // stops it multiplying.
    registerAgent(db, 'ULID_ANA', ANA_PATH);
    const stamped = registry.resolveAgent(ANA_PATH, 'Ana');
    db.delete(agents).where(eq(agents.projectPath, ANA_PATH)).run();

    expect(registry.resolveAgent(ANA_PATH, 'Ana').id).toBe(stamped.id);
    expect(registry.resolveAgent(ANA_PATH, 'Ana').id).toBe(stamped.id);
    expect(allAuthorRows(db, ANA_PATH)).toHaveLength(1);
    expect(allAuthorRows(db, ANA_PATH)[0]!.retiredAt).toBeNull();

    // And the same for a row that never had a stamp.
    db.insert(authors)
      .values({
        id: 'LEGACY_BO',
        kind: 'agent',
        naturalKey: '/agents/bo',
        displayName: 'Bo',
        createdAt: new Date().toISOString(),
      })
      .run();
    expect(registry.resolveAgent('/agents/bo', 'Bo').id).toBe('LEGACY_BO');
    expect(allAuthorRows(db, '/agents/bo')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §5.10 — the migration and the partial index
// ---------------------------------------------------------------------------

describe('the partial unique index', () => {
  it('permits a retired sibling and refuses a second ACTIVE one', () => {
    const base = {
      kind: 'agent',
      naturalKey: ANA_PATH,
      displayName: 'Ana',
      createdAt: new Date().toISOString(),
    };
    db.insert(authors)
      .values({ ...base, id: 'RETIRED', retiredAt: '2026-08-01T00:00:00.000Z' })
      .run();
    db.insert(authors)
      .values({ ...base, id: 'ACTIVE' })
      .run();

    // One active author per directory, any number of retired ones.
    expect(() =>
      db
        .insert(authors)
        .values({ ...base, id: 'SECOND_ACTIVE' })
        .run()
    ).toThrow(/UNIQUE/i);
    expect(allAuthorRows(db, ANA_PATH)).toHaveLength(2);
  });

  it('reads only the active row when a retired sibling exists', () => {
    // Without the `retired_at IS NULL` filter, `.get()` picks between the
    // siblings by whatever order SQLite happens to use — so the ordinary resolve
    // would sometimes return a retired author and sometimes not.
    registerAgent(db, 'ULID_BO', ANA_PATH);
    const base = {
      kind: 'agent',
      naturalKey: ANA_PATH,
      displayName: 'Ana',
      createdAt: new Date().toISOString(),
    };
    db.insert(authors)
      .values({
        ...base,
        id: 'RETIRED',
        mintedForManifestId: 'ULID_ANA',
        retiredAt: '2026-08-01T00:00:00.000Z',
      })
      .run();
    db.insert(authors)
      .values({ ...base, id: 'ACTIVE', displayName: 'Bo', mintedForManifestId: 'ULID_BO' })
      .run();

    expect(registry.resolveAgent(ANA_PATH, 'Bo').id).toBe('ACTIVE');
    // And no new row was minted, which is what a lookup that found the retired
    // sibling instead would have done.
    expect(allAuthorRows(db, ANA_PATH)).toHaveLength(2);
    expect(
      db
        .select()
        .from(authors)
        .where(and(eq(authors.naturalKey, ANA_PATH), isNull(authors.retiredAt)))
        .all()
    ).toHaveLength(1);
  });

  it('carries every existing row through the migration untouched', () => {
    // The rows an installed machine already has: no stamp, not retired, and
    // still the author of everything they ever wrote.
    db.insert(authors)
      .values({
        id: 'PRE_EXISTING',
        kind: 'human',
        naturalKey: 'local',
        displayName: 'You',
        createdAt: '2026-07-01T00:00:00.000Z',
      })
      .run();
    const row = db.select().from(authors).where(eq(authors.id, 'PRE_EXISTING')).get();
    expect(row).toMatchObject({ mintedForManifestId: null, retiredAt: null });
    expect(registry.localHuman().id).toBe('PRE_EXISTING');
  });
});
