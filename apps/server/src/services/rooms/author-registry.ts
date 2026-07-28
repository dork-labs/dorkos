/**
 * Mint-on-first-use resolution of `(kind, naturalKey)` to an opaque `authorId`
 * (ADR 260726-170126).
 *
 * The whole point of this module is that an agent's persisted identity is keyed
 * on its **directory**, never on its manifest ULID. `agents` is a derived cache
 * (ADR-0043) and its reconciler is licensed to delete the table and rebuild it,
 * re-registering every agent under a fresh ULID. `agentPath` is what survives
 * that — it is already the key the agent-token store uses, and
 * `agents.project_path` is `NOT NULL UNIQUE`.
 *
 * The indirection through an opaque id is not ceremony over the path:
 *
 * - Accounts land later and need the same column. One id with a kind and a
 *   natural key holds humans, agents and the system; a path holds only agents.
 * - A room is a shared surface. A raw path would put `/Users/dorian/…` in front
 *   of every member of every room, which is a privacy defect we would have to
 *   undo under migration.
 *
 * @module server/services/rooms/author-registry
 */
import { ulid } from 'ulidx';
import { authors, eq, and, inArray, type Db } from '@dorkos/db';
import { agentAuthorRef, type AuthorKind, type AuthorRef } from '@dorkos/shared/room-schemas';

/**
 * The natural key of the unbound human author — the one an install mints while
 * it has no accounts at all. {@link AuthorRegistry.bindOwner} rebinds it in
 * place the moment an owner account exists, so it is a starting state rather
 * than a permanent identity.
 */
const LOCAL_HUMAN_NATURAL_KEY = 'local';

/**
 * The natural key a human author bound to a local account carries.
 *
 * Opaque (Better Auth ids are random), free of personal data, and stable across
 * the person changing their email or their display name. The email is
 * deliberately not the key, for the reason this module already gives about
 * paths: a room is a shared surface, and an address is not something to make
 * every roster row's identity out of.
 *
 * @param userId - The Better Auth user id.
 */
function accountNaturalKey(userId: string): string {
  return `user:${userId}`;
}

/** The natural key of the system author — the room's own voice. */
const SYSTEM_NATURAL_KEY = 'system';

/** Display name the system author is minted with. */
const SYSTEM_DISPLAY_NAME = 'DorkOS';

/** Display name the local human author is minted with. */
const LOCAL_HUMAN_DISPLAY_NAME = 'You';

/**
 * Display name for a human author that is not this install's owner. Under
 * ADR 260727-184933 D6 there is no such person locally, so this labels a state
 * that should not arise — neutral on purpose, because a roster has to render
 * something and inventing a name would be worse.
 */
const UNNAMED_HUMAN_DISPLAY_NAME = 'Someone';

/**
 * A stored author row, including the `naturalKey` that never reaches the wire.
 * Server-side only: project it with {@link toAuthorRef} before returning it.
 */
export interface AuthorRecord {
  id: string;
  kind: AuthorKind;
  /** An agent's `agentPath`, a human's account key, or `'system'`. */
  naturalKey: string;
  displayName: string;
  /** Render cache: emoji avatar, or `null` when the author has none. */
  emoji: string | null;
  /** Render cache: identity colour, or `null` when the author has none. */
  color: string | null;
}

/**
 * Drop the natural key, leaving what a room member may see. A room is a shared
 * surface, and `/Users/dorian/…` is not something to hand every member of it —
 * an agent reads its own rooms' rosters, so this is the boundary that stops one
 * agent learning where another one lives.
 *
 * An agent still gets a stable handle to be recognised by: `agentRef` is
 * derived from the path rather than being it, so a consumer can match an author
 * to an agent without comparing rendered names.
 *
 * @param record - The stored author.
 */
export function toAuthorRef(record: AuthorRecord): AuthorRef {
  return {
    id: record.id,
    kind: record.kind,
    displayName: record.displayName,
    ...(record.emoji ? { emoji: record.emoji } : {}),
    ...(record.color ? { color: record.color } : {}),
    ...(record.kind === 'agent' ? { agentRef: agentAuthorRef(record.naturalKey) } : {}),
  };
}

/** What resolving an author needs: its kind, its stable key, and a label. */
export interface ResolveAuthorInput {
  kind: AuthorKind;
  /** The stable identity: an agent's `agentPath`, `'local'`, or `'system'`. */
  naturalKey: string;
  /** Human-readable label, refreshed on the row every time it is resolved. */
  displayName: string;
  /**
   * Emoji avatar, refreshed on the row like `displayName`. `undefined` means
   * "the caller does not know" and leaves whatever is stored alone; `null`
   * clears it. A caller that only holds a name must not blank the rest.
   */
  emoji?: string | null;
  /** Identity colour, on the same lifecycle as {@link ResolveAuthorInput.emoji}. */
  color?: string | null;
}

/**
 * Resolves and mints author rows. Synchronous throughout (`better-sqlite3`), so
 * it composes into the room service's own synchronous write path.
 */
export class AuthorRegistry {
  constructor(private readonly db: Db) {}

  /**
   * Resolve `(kind, naturalKey)` to an author, inserting the row the first time
   * it is seen and refreshing the cached `displayName` after that.
   *
   * @param input - The author's kind, stable key, and current display name.
   * @returns The resolved author, whose `id` is stable for this natural key.
   */
  resolve(input: ResolveAuthorInput): AuthorRecord {
    const existing = this.db
      .select()
      .from(authors)
      .where(and(eq(authors.kind, input.kind), eq(authors.naturalKey, input.naturalKey)))
      .get();

    if (existing) {
      // Only the fields this caller actually knows are refreshed. `resolveAgent`
      // from the identity header carries a name and nothing else, and it must
      // not wipe the avatar the mesh-backed resolve stored.
      const refreshed = {
        displayName: input.displayName,
        emoji: input.emoji === undefined ? existing.emoji : input.emoji,
        color: input.color === undefined ? existing.color : input.color,
      };
      if (
        existing.displayName !== refreshed.displayName ||
        existing.emoji !== refreshed.emoji ||
        existing.color !== refreshed.color
      ) {
        this.db.update(authors).set(refreshed).where(eq(authors.id, existing.id)).run();
      }
      return {
        id: existing.id,
        kind: input.kind,
        naturalKey: input.naturalKey,
        ...refreshed,
      };
    }

    const row = {
      id: ulid(),
      kind: input.kind,
      naturalKey: input.naturalKey,
      displayName: input.displayName,
      emoji: input.emoji ?? null,
      color: input.color ?? null,
      createdAt: new Date().toISOString(),
    };
    // A concurrent resolve of the same natural key would collide on the unique
    // index; ignoring the conflict and re-reading returns the winner's id
    // rather than throwing on a read path.
    this.db.insert(authors).values(row).onConflictDoNothing().run();
    const settled = this.db
      .select()
      .from(authors)
      .where(and(eq(authors.kind, input.kind), eq(authors.naturalKey, input.naturalKey)))
      .get();
    return {
      id: settled?.id ?? row.id,
      kind: input.kind,
      naturalKey: input.naturalKey,
      displayName: input.displayName,
      emoji: row.emoji,
      color: row.color,
    };
  }

  /**
   * Resolve an agent by its directory. This overload exists so no caller is
   * ever handed the opportunity to pass a manifest ULID: the signature simply
   * has no parameter for one.
   *
   * @param agentPath - Absolute path to the agent's project directory.
   * @param displayName - The agent's current name, for rendering.
   * @param presentation - Emoji and colour, when the caller knows them. Omitted
   *   fields leave the stored render cache alone.
   */
  resolveAgent(
    agentPath: string,
    displayName: string,
    presentation: { emoji?: string | null; color?: string | null } = {}
  ): AuthorRecord {
    return {
      ...this.resolve({
        kind: 'agent',
        naturalKey: agentPath,
        displayName,
        ...presentation,
      }),
    };
  }

  /**
   * The unbound human author — the person at the keyboard on an install that
   * has no accounts at all. Once one exists, {@link AuthorRegistry.bindOwner}
   * takes this row over and this method stops being reachable.
   */
  localHuman(): AuthorRecord {
    return this.resolve({
      kind: 'human',
      naturalKey: LOCAL_HUMAN_NATURAL_KEY,
      displayName: LOCAL_HUMAN_DISPLAY_NAME,
    });
  }

  /**
   * The human author for a local account that is NOT this install's owner.
   *
   * Under ADR 260727-184933 D6 there is no such account: registration is closed
   * for good after the first one. This exists as the guard on that invariant
   * rather than as a path anything walks — because the failure it prevents is
   * total. It never adopts the `'local'` sentinel, so if a second account ever
   * did appear, it would get a row of its own rather than the owner's messages,
   * memberships and read cursors. {@link AuthorRegistry.bindOwner} is the one
   * path that may take the sentinel.
   *
   * @param userId - The Better Auth user id.
   */
  human(userId: string): AuthorRecord {
    const naturalKey = accountNaturalKey(userId);
    return this.resolve({
      kind: 'human',
      naturalKey,
      displayName: this.storedHumanName(naturalKey) ?? UNNAMED_HUMAN_DISPLAY_NAME,
    });
  }

  /**
   * The owner's human author — rebinding the `'local'` sentinel onto the owner's
   * account the first time this runs.
   *
   * `author-registry.ts` wrote down the plan for this before the plan existed:
   * _"The single human author v1 mints. It gets an account binding when accounts
   * land, without moving any message."_ This is that, and it is one UPDATE:
   *
   * ```sql
   * UPDATE authors SET natural_key = 'user:<id>'
   *  WHERE kind = 'human' AND natural_key = 'local'
   * ```
   *
   * **The opaque `id` does not change**, which is the entire point of the
   * opaque-id indirection collected in one statement: every `room_entries.author_id`,
   * every `room_members` row, every `room_sessions` binding and every read
   * cursor keeps pointing at the same author. Nothing is migrated and nothing is
   * rewritten.
   *
   * **`displayName` is deliberately not touched, and this is load-bearing.** The
   * column is a render cache with one value per author, so writing the owner's
   * account name here would not label them going forward — it would relabel
   * every message they had ever written, retroactively, the moment they turned
   * login on. And there is nothing to gain by it: D6 keeps this install
   * single-user, so the owner is the only person who ever reads their own
   * roster, and `'You'` is the right word for them. (`specs/invites` §17 #5
   * asked whether the rename was acceptable; D6 answers no. Remote community
   * members render under their real names, but they are cached under a different
   * natural-key scheme by a different path — never this one.)
   *
   * Idempotent, and safe in either order: once a bound row exists this returns
   * it untouched, and an install whose sentinel was never minted gets a fresh
   * bound row.
   *
   * @param userId - The owner's Better Auth user id.
   */
  bindOwner(userId: string): AuthorRecord {
    const naturalKey = accountNaturalKey(userId);
    const bound = this.db
      .select()
      .from(authors)
      .where(and(eq(authors.kind, 'human'), eq(authors.naturalKey, naturalKey)))
      .get();
    if (bound) return toRecord(bound);

    const sentinel = this.db
      .select()
      .from(authors)
      .where(and(eq(authors.kind, 'human'), eq(authors.naturalKey, LOCAL_HUMAN_NATURAL_KEY)))
      .get();
    if (!sentinel) {
      return this.resolve({ kind: 'human', naturalKey, displayName: LOCAL_HUMAN_DISPLAY_NAME });
    }

    this.db.update(authors).set({ naturalKey }).where(eq(authors.id, sentinel.id)).run();
    return { ...toRecord(sentinel), naturalKey };
  }

  /**
   * Whether an author is the owner of this install — the predicate that replaced
   * `kind === 'human'` in the two places that used to read it as "is the
   * operator" (spec `invites` §4.4).
   *
   * Two modes, one meaning:
   *
   * - **No owner account** (`ownerUserId` is `null`): the `'local'` sentinel is
   *   the owner. This is what keeps a single-user install identical — with no
   *   accounts there is nobody else it could be.
   * - **An owner account exists:** the author bound to `user:<ownerUserId>` is
   *   the owner, and nobody else is. Not another human, not an agent, not the
   *   system author.
   *
   * @param authorId - The author to weigh.
   * @param ownerUserId - The owner account's user id, or `null` when the install
   *   has no accounts.
   */
  isOwner(authorId: string, ownerUserId: string | null): boolean {
    const author = this.getById(authorId);
    if (!author || author.kind !== 'human') return false;
    return (
      author.naturalKey ===
      (ownerUserId === null ? LOCAL_HUMAN_NATURAL_KEY : accountNaturalKey(ownerUserId))
    );
  }

  /** The system author — who a `notice` entry is written by. */
  system(): AuthorRecord {
    return this.resolve({
      kind: 'system',
      naturalKey: SYSTEM_NATURAL_KEY,
      displayName: SYSTEM_DISPLAY_NAME,
    });
  }

  /**
   * Look an author up by its opaque id.
   *
   * @param id - The author id.
   * @returns The author, or `null` when no row carries that id.
   */
  getById(id: string): AuthorRecord | null {
    const row = this.db.select().from(authors).where(eq(authors.id, id)).get();
    return row ? toRecord(row) : null;
  }

  /**
   * Look up many authors at once — one query for a whole roster rather than one
   * per member.
   *
   * @param ids - The author ids to resolve.
   * @returns A map from id to author, omitting ids with no row.
   */
  getMany(ids: readonly string[]): Map<string, AuthorRecord> {
    const resolved = new Map<string, AuthorRecord>();
    if (ids.length === 0) return resolved;
    const rows = this.db
      .select()
      .from(authors)
      .where(inArray(authors.id, [...new Set(ids)]))
      .all();
    for (const row of rows) resolved.set(row.id, toRecord(row));
    return resolved;
  }

  /** The stored display name of a human author, or `null` when it has no row yet. */
  private storedHumanName(naturalKey: string): string | null {
    const row = this.db
      .select({ displayName: authors.displayName })
      .from(authors)
      .where(and(eq(authors.kind, 'human'), eq(authors.naturalKey, naturalKey)))
      .get();
    return row?.displayName ?? null;
  }
}

/** Narrow a stored row's stringly-typed `kind` onto the domain union. */
function toRecord(row: typeof authors.$inferSelect): AuthorRecord {
  return {
    id: row.id,
    kind: row.kind as AuthorKind,
    naturalKey: row.naturalKey,
    displayName: row.displayName,
    emoji: row.emoji,
    color: row.color,
  };
}
