/**
 * The regression test ADR 260726-170126 exists to make impossible: an agent's
 * persisted author id must survive the mesh registry rebuilding its row.
 *
 * **One assertion in this file was deliberately narrowed by ADR 260801-003051,
 * and it is the load-bearing thing to read before touching either.** The
 * original pinned "a rebuild under a FRESH ULID keeps the author id", which is
 * no longer true and must not be made true again: a different manifest id at a
 * directory is exactly how a re-inited directory is told from a rebuilt cache,
 * and treating the two the same is what let a new agent inherit the previous
 * occupant's entire message history (DOR-790 H12).
 *
 * The premise it rested on is unreachable in current code anyway. No reconciler
 * path mints ids — `reconciler.ts` only ever calls `registry.update(entry.id, …)`,
 * and an ADR-0043 rebuild reads ids back from the `.dork/agent.json` files that
 * store them — so a rebuild re-registers the SAME id, which is the case pinned
 * below. What survives untouched is the invariant that actually protects
 * history: an author id never changes and a row is never deleted, so every
 * message ever written still resolves to whoever wrote it.
 *
 * `directory-reuse.test.ts` holds the other half — what happens when the id
 * genuinely changes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { agents, authors, eq, type Db } from '@dorkos/db';
import { AuthorRegistry, toAuthorRef } from '../author-registry.js';

const ANA_PATH = '/Users/dorian/agents/ana';

/**
 * Register an agent row the way the mesh registry does.
 *
 * `name` is the slug and `displayName` is the label; a manifest with no display
 * name leaves the column null, which is the state the registry reads back as
 * "this agent is called by its slug".
 */
function registerAgent(
  db: Db,
  agent: { id: string; projectPath: string; name: string; displayName?: string }
): void {
  const now = new Date().toISOString();
  db.insert(agents)
    .values({
      id: agent.id,
      name: agent.name,
      ...(agent.displayName !== undefined ? { displayName: agent.displayName } : {}),
      runtime: 'claude-code',
      projectPath: agent.projectPath,
      registeredAt: now,
      updatedAt: now,
    })
    .run();
}

describe('AuthorRegistry', () => {
  let db: Db;
  let registry: AuthorRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
  });

  it('mints once and resolves to the same id every time after', () => {
    const first = registry.resolveAgent(ANA_PATH, 'Ana');
    const second = registry.resolveAgent(ANA_PATH, 'Ana');
    const third = registry.resolveAgent(ANA_PATH, 'Ana');

    expect(second.id).toBe(first.id);
    expect(third.id).toBe(first.id);
    expect(db.select().from(authors).all()).toHaveLength(1);
  });

  it('keeps the same author id when the registry cache is deleted and rebuilt', () => {
    // The state before: an agent registered under one ULID, with an author.
    registerAgent(db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const before = registry.resolveAgent(ANA_PATH, 'Ana');

    // The ADR-0043 rebuild: the derived cache is dropped and rebuilt from
    // `.dork/agent.json` on disk — which is where the id lives, so the id comes
    // back the same. That is what makes this a rebuild rather than a re-init.
    db.delete(agents).where(eq(agents.projectPath, ANA_PATH)).run();
    registerAgent(db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });

    const after = registry.resolveAgent(ANA_PATH, 'Ana');

    expect(after.id).toBe(before.id);
    expect(db.select().from(authors).all()).toHaveLength(1);
  });

  it('never deletes or renumbers an author, so old messages keep their true writer', () => {
    // The invariant the assertion above USED to carry, restated against a
    // premise that is reachable: a directory changing hands starts a new author,
    // and the old one stays exactly where it was. `directory-reuse.test.ts`
    // proves the mint; this proves the half that protects history.
    registerAgent(db, { id: 'ULID_ANA', projectPath: ANA_PATH, name: 'ana' });
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');

    db.delete(agents).where(eq(agents.projectPath, ANA_PATH)).run();
    registerAgent(db, { id: 'ULID_BO', projectPath: ANA_PATH, name: 'bo' });
    const bo = registry.resolveAgent(ANA_PATH, 'Bo');

    expect(bo.id).not.toBe(ana.id);
    // Ana's row is still there, still hers, still named Ana.
    expect(registry.getById(ana.id)).toMatchObject({ id: ana.id, displayName: 'Ana' });
  });

  it('gives a different agent directory a different author', () => {
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const bo = registry.resolveAgent('/Users/dorian/agents/bo', 'Bo');
    expect(bo.id).not.toBe(ana.id);
  });

  it('refreshes the cached display name without moving the id', () => {
    const first = registry.resolveAgent(ANA_PATH, 'Ana');
    const renamed = registry.resolveAgent(ANA_PATH, 'Ana Reyes');

    expect(renamed.id).toBe(first.id);
    expect(renamed.displayName).toBe('Ana Reyes');
    expect(registry.getById(first.id)?.displayName).toBe('Ana Reyes');
  });

  it('keeps human, agent and system in one table without colliding on a shared key', () => {
    const asAgent = registry.resolve({
      kind: 'agent',
      naturalKey: 'system',
      displayName: 'An agent literally called system',
    });
    expect(registry.system().id).not.toBe(asAgent.id);
  });

  it('mints exactly one local human and one system author', () => {
    expect(registry.localHuman().id).toBe(registry.localHuman().id);
    expect(registry.system().id).toBe(registry.system().id);
    expect(db.select().from(authors).all()).toHaveLength(2);
  });

  it('resolves many authors in one read', () => {
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const human = registry.localHuman();
    const found = registry.getMany([ana.id, human.id, 'never-minted']);

    expect(found.size).toBe(2);
    expect(found.get(ana.id)?.displayName).toBe('Ana');
  });

  it('keeps the natural key off the shape that reaches a room member', () => {
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const ref = toAuthorRef(ana);

    expect(ana.naturalKey).toBe(ANA_PATH);
    expect(JSON.stringify(ref)).not.toContain('/Users/dorian');
    // The projection is closed, not filtered: the assertion is the WHOLE key
    // set, so a field added to `AuthorRecord` cannot ride onto the wire by
    // being spread into the ref and nobody noticing.
    expect(Object.keys(ref).sort()).toEqual(['agentRef', 'displayName', 'handle', 'id', 'kind']);
  });

  it('gives an agent a handle derived from its path, not the path', () => {
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const renamed = registry.resolveAgent(ANA_PATH, 'Ana II');

    // Same path, so the same handle — a rename does not change who this is.
    expect(toAuthorRef(renamed).agentRef).toBe(toAuthorRef(ana).agentRef);
    expect(toAuthorRef(ana).agentRef).not.toContain(ANA_PATH);
    // A human has no agent to point at.
    expect(toAuthorRef(registry.localHuman()).agentRef).toBeUndefined();
  });
});

/**
 * A cached display name is never DOWNGRADED by a caller that knows less than it
 * appears to (DOR-1264).
 *
 * The bug this pins: an agent acting through a room tool arrives with a name
 * replayed out of its identity token, and the token used to be minted under
 * `agents.name` — the slug. Every tool call therefore rewrote `Docs Writer` to
 * `docs-writer` on the author row, and every message and the member list showed
 * the slug, while the manifest and the mesh still said `Docs Writer`.
 *
 * The runtimes now mint under the display name, so this is the second line: the
 * registry weighs a caller's label against the manifest rather than trusting it.
 */
describe('AuthorRegistry — a name is only refreshed by a caller that knows one', () => {
  const DOCS_PATH = '/Users/dorian/agents/docs-writer';
  let db: Db;
  let registry: AuthorRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
    registerAgent(db, {
      id: 'ULID_DOCS',
      projectPath: DOCS_PATH,
      name: 'docs-writer',
      displayName: 'Docs Writer',
    });
  });

  it('stores the display name a mesh-backed caller resolves with', () => {
    const author = registry.resolveAgent(DOCS_PATH, 'Docs Writer');

    expect(author.displayName).toBe('Docs Writer');
    expect(registry.getById(author.id)?.displayName).toBe('Docs Writer');
  });

  it('keeps it when a following resolve carries only the slug', () => {
    const minted = registry.resolveAgent(DOCS_PATH, 'Docs Writer');
    const viaToken = registry.resolveAgent(DOCS_PATH, 'docs-writer');

    expect(viaToken.id).toBe(minted.id);
    expect(viaToken.displayName).toBe('Docs Writer');
    expect(registry.getById(minted.id)?.displayName).toBe('Docs Writer');
  });

  it('keeps it when a following resolve carries no name at all', () => {
    const minted = registry.resolveAgent(DOCS_PATH, 'Docs Writer');
    const nameless = registry.resolveAgent(DOCS_PATH, undefined);

    expect(nameless.displayName).toBe('Docs Writer');
    expect(registry.getById(minted.id)?.displayName).toBe('Docs Writer');
  });

  it('still refreshes when the agent is genuinely renamed', () => {
    const minted = registry.resolveAgent(DOCS_PATH, 'Docs Writer');
    // The manifest moves first — the `agents` row is its derived cache — and the
    // mesh-backed caller resolves with what it now says.
    db.update(agents)
      .set({ displayName: 'Documentation Writer' })
      .where(eq(agents.projectPath, DOCS_PATH))
      .run();
    const renamed = registry.resolveAgent(DOCS_PATH, 'Documentation Writer');

    expect(renamed.displayName).toBe('Documentation Writer');
    expect(registry.getById(minted.id)?.displayName).toBe('Documentation Writer');
  });

  it('refreshes to the slug when the slug is what the agent is genuinely called', () => {
    // The guard weighs a label against the manifest; it is not a rule that a
    // slug-shaped string may never be a display name. An agent renamed TO its
    // slug must still be renamed.
    const minted = registry.resolveAgent(DOCS_PATH, 'Docs Writer');
    db.update(agents).set({ displayName: null }).where(eq(agents.projectPath, DOCS_PATH)).run();
    const renamed = registry.resolveAgent(DOCS_PATH, 'docs-writer');

    expect(renamed.displayName).toBe('docs-writer');
    expect(registry.getById(minted.id)?.displayName).toBe('docs-writer');
  });

  it('mints under the manifest name when the very first resolve carries none', () => {
    // No stored label to keep, so an unknowing caller takes the occupant's own
    // name rather than writing a blank one onto a brand-new row.
    const author = registry.resolveAgent(DOCS_PATH, undefined);

    expect(author.displayName).toBe('Docs Writer');
    expect(registry.getById(author.id)?.displayName).toBe('Docs Writer');
  });
});

/**
 * The account binding (spec `invites` §4.1–§4.4). The property that matters is
 * that the opaque `id` does not move: every `room_entries.author_id`, every
 * `room_members` row and every read cursor points at it, and the whole
 * justification for the opaque-id indirection is that this can happen without
 * rewriting one of them.
 */
describe('AuthorRegistry — binding a human author to an account', () => {
  let db: Db;
  let registry: AuthorRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
  });

  it('rebinds the local sentinel in place, keeping its id', () => {
    const sentinel = registry.localHuman();

    const bound = registry.bindOwner('user-dorian');

    expect(bound.id).toBe(sentinel.id);
    expect(bound.naturalKey).toBe('user:user-dorian');
    // One row, not two: nothing was left behind for a later resolve to find.
    expect(db.select().from(authors).where(eq(authors.kind, 'human')).all()).toHaveLength(1);
  });

  it('leaves the owner rendering as "You", now and forever', () => {
    // `authors.display_name` is ONE column per author, so writing the account
    // name here would not label the owner going forward — it would relabel
    // every message they had ever written, retroactively, the moment they
    // turned login on. D6 keeps this install single-user, so the only person
    // who reads this roster is the owner, and "You" is the right word.
    const sentinel = registry.localHuman();
    expect(sentinel.displayName).toBe('You');

    const bound = registry.bindOwner('user-dorian');

    expect(bound.displayName).toBe('You');
    expect(registry.getById(sentinel.id)?.displayName).toBe('You');
  });

  it('is idempotent, and keeps the same id and name on every call after', () => {
    const first = registry.bindOwner('user-dorian');
    const second = registry.bindOwner('user-dorian');

    expect(second.id).toBe(first.id);
    expect(second.displayName).toBe('You');
  });

  it('mints a fresh row when there is no sentinel to adopt', () => {
    const bound = registry.bindOwner('user-dorian');
    expect(bound.naturalKey).toBe('user:user-dorian');
    expect(registry.getById(bound.id)?.displayName).toBe('You');
  });

  it('never lets a second account inherit the sentinel', () => {
    // The reason `human()` and `bindOwner()` are different methods. D6 says a
    // second local account cannot exist; this is the guard that makes the
    // failure survivable if that ever stopped being true, because adopting
    // `'local'` would hand over the owner's messages, memberships and cursors.
    const sentinel = registry.localHuman();

    const someone = registry.human('user-priya');

    expect(someone.id).not.toBe(sentinel.id);
    expect(registry.getById(sentinel.id)?.naturalKey).toBe('local');
    expect(registry.getById(sentinel.id)?.displayName).toBe('You');
  });
});

describe('AuthorRegistry — who the owner is', () => {
  let db: Db;
  let registry: AuthorRegistry;

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
  });

  it('is the local sentinel while the install has no accounts', () => {
    const sentinel = registry.localHuman();
    expect(registry.isOwner(sentinel.id, null)).toBe(true);
  });

  it('is the bound account, and nobody else, once one exists', () => {
    const owner = registry.bindOwner('user-dorian');
    const someone = registry.human('user-priya');

    expect(registry.isOwner(owner.id, 'user-dorian')).toBe(true);
    expect(registry.isOwner(someone.id, 'user-dorian')).toBe(false);
  });

  it('is nobody an agent or the system author could be', () => {
    const ana = registry.resolveAgent(ANA_PATH, 'Ana');
    const system = registry.system();

    expect(registry.isOwner(ana.id, null)).toBe(false);
    expect(registry.isOwner(system.id, null)).toBe(false);
    expect(registry.isOwner(ana.id, 'user-dorian')).toBe(false);
  });

  it('is not a stray local author once the install has an owner account', () => {
    // The state a rollback or a hand-edited database could leave: a sentinel
    // beside a bound row. The bound row is the owner; the sentinel is not.
    registry.bindOwner('user-dorian');
    const stray = registry.localHuman();

    expect(registry.isOwner(stray.id, 'user-dorian')).toBe(false);
  });

  it('is nobody at all when the author id names no row', () => {
    expect(registry.isOwner('01JZZZZZZZZZZZZZZZZZZZZZZZ', null)).toBe(false);
  });

  it('refuses a non-human author holding the owner natural key', () => {
    // `isOwner` guards on `kind` BEFORE it compares natural keys, and this is
    // the only test that proves it. Every other assertion here is satisfied
    // twice over — an agent's natural key is an absolute `agentPath`, so it
    // fails the key comparison as well — which means deleting the kind guard
    // leaves the whole suite green while these two rows become the owner.
    //
    // Unreachable today (agent natural keys come from `resolveAgent`, and a
    // path is absolute), so this is not a live hole. It is a guard with no
    // test, which is how guards get refactored away.
    const mimicsSentinel = registry.resolve({
      kind: 'agent',
      naturalKey: 'local',
      displayName: 'Impostor',
    });
    const mimicsAccount = registry.resolve({
      kind: 'agent',
      naturalKey: 'user:user-dorian',
      displayName: 'Impostor',
    });

    expect(registry.isOwner(mimicsSentinel.id, null)).toBe(false);
    expect(registry.isOwner(mimicsAccount.id, 'user-dorian')).toBe(false);

    // And the same shape as the system author, which is the other non-human kind.
    const systemMimic = registry.resolve({
      kind: 'system',
      naturalKey: 'local',
      displayName: 'Impostor',
    });
    expect(registry.isOwner(systemMimic.id, null)).toBe(false);
  });
});

describe('AuthorRegistry — the photo write path', () => {
  let db: Db;
  let registry: AuthorRegistry;
  let authorId: string;

  beforeEach(() => {
    db = createTestDb();
    registry = new AuthorRegistry(db);
    authorId = registry.localHuman().id;
  });

  it('stores whatever URL it is handed, verbatim', () => {
    const absolute = 'https://cdn.example/photo.png?v=abc';

    expect(registry.setImageUrl(authorId, absolute).imageUrl).toBe(absolute);
    expect(registry.getById(authorId)?.imageUrl).toBe(absolute);
  });

  it('clears it with null', () => {
    registry.setImageUrl(authorId, '/api/profile/avatar/x?v=1');
    registry.setImageUrl(authorId, null);

    expect(registry.getById(authorId)?.imageUrl).toBeNull();
  });

  it('survives the next resolve — a caller that only knows a name must not wipe it', () => {
    registry.setImageUrl(authorId, '/api/profile/avatar/x?v=1');
    registry.localHuman();

    expect(registry.getById(authorId)?.imageUrl).toBe('/api/profile/avatar/x?v=1');
  });

  it('refuses an author that does not exist', () => {
    expect(() => registry.setImageUrl('nobody', 'https://cdn.example/x.png')).toThrow(
      'No such author'
    );
  });
});
