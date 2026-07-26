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
import type { AuthorKind, AuthorRef } from '@dorkos/shared/room-schemas';

/** The natural key of the single human author v1 mints. */
const LOCAL_HUMAN_NATURAL_KEY = 'local';

/** The natural key of the system author — the room's own voice. */
const SYSTEM_NATURAL_KEY = 'system';

/** Display name the system author is minted with. */
const SYSTEM_DISPLAY_NAME = 'DorkOS';

/** Display name the local human author is minted with. */
const LOCAL_HUMAN_DISPLAY_NAME = 'You';

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
}

/**
 * Drop the natural key, leaving what a room member may see. A room is a shared
 * surface, and `/Users/dorian/…` is not something to hand every member of it.
 *
 * @param record - The stored author.
 */
export function toAuthorRef(record: AuthorRecord): AuthorRef {
  return { id: record.id, kind: record.kind, displayName: record.displayName };
}

/** What resolving an author needs: its kind, its stable key, and a label. */
export interface ResolveAuthorInput {
  kind: AuthorKind;
  /** The stable identity: an agent's `agentPath`, `'local'`, or `'system'`. */
  naturalKey: string;
  /** Human-readable label, refreshed on the row every time it is resolved. */
  displayName: string;
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
      if (existing.displayName !== input.displayName) {
        this.db
          .update(authors)
          .set({ displayName: input.displayName })
          .where(eq(authors.id, existing.id))
          .run();
      }
      return {
        id: existing.id,
        kind: input.kind,
        naturalKey: input.naturalKey,
        displayName: input.displayName,
      };
    }

    const row = {
      id: ulid(),
      kind: input.kind,
      naturalKey: input.naturalKey,
      displayName: input.displayName,
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
    };
  }

  /**
   * Resolve an agent by its directory. This overload exists so no caller is
   * ever handed the opportunity to pass a manifest ULID: the signature simply
   * has no parameter for one.
   *
   * @param agentPath - Absolute path to the agent's project directory.
   * @param displayName - The agent's current name, for rendering.
   */
  resolveAgent(agentPath: string, displayName: string): AuthorRecord {
    return this.resolve({ kind: 'agent', naturalKey: agentPath, displayName });
  }

  /**
   * The single human author v1 mints. It gets an account binding when accounts
   * land, without moving any message.
   */
  localHuman(): AuthorRecord {
    return this.resolve({
      kind: 'human',
      naturalKey: LOCAL_HUMAN_NATURAL_KEY,
      displayName: LOCAL_HUMAN_DISPLAY_NAME,
    });
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
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind as AuthorKind,
      naturalKey: row.naturalKey,
      displayName: row.displayName,
    };
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
    for (const row of rows) {
      resolved.set(row.id, {
        id: row.id,
        kind: row.kind as AuthorKind,
        naturalKey: row.naturalKey,
        displayName: row.displayName,
      });
    }
    return resolved;
  }
}
