/**
 * OpenCode Session Map — adapter-owned durable mapping from a DorkOS
 * `sessionId` to its OpenCode session id (`ses_…`), one row per binding
 * (ADR-0308: one DorkOS session <-> one OpenCode session).
 *
 * This is what keeps a DorkOS-facing OpenCode session id STABLE across a
 * server restart (DOR-251): the in-memory `OpenCodeSessionMapper` hydrates
 * from these rows at construction, so a post-restart re-list re-associates
 * the ORIGINAL DorkOS id with its OpenCode session instead of minting a new
 * derived id. Mirrors the Codex `codex_threads` idiom (thread-map.ts) minus
 * display metadata — OpenCode's sidecar store is itself durable and owns
 * title/timestamps, so only the id binding needs DorkOS-side durability.
 *
 * Unlike `codex_threads` (INSERT OR IGNORE, first-write-wins), writes here
 * are AUTHORITATIVE: `bind()` replaces any existing row on either key in one
 * transaction, mirroring the mapper's `link()` semantics — a derived adoption
 * that raced the create is superseded so the mapping stays strictly 1:1.
 *
 * @module services/runtimes/opencode/session-map
 */
import { opencodeSessions, eq, or, type Db } from '@dorkos/db';
import { logger, logError } from '../../../lib/logger.js';

/** One persisted DorkOS <-> OpenCode session binding. */
export interface OpenCodeSessionBinding {
  /** DorkOS session identifier (the table's primary key). */
  sessionId: string;
  /** OpenCode session identifier (`ses_…`) bound to it. */
  ocSessionId: string;
}

/**
 * Durable sessionId <-> OpenCode-session-id map for the OpenCode runtime —
 * the production `OpenCodeSessionMapStore`.
 *
 * Per that store contract, neither method throws: the mapper's import graph
 * is filesystem-free by test guard (ADR-0308) so it cannot log, and a
 * persistence failure must degrade to in-memory-only bindings (the old
 * restart-forgets behavior), never break a live session or server boot. Both
 * methods warn-and-degrade here instead.
 *
 * The composition root (`apps/server/src/index.ts`) constructs this with the
 * consolidated Drizzle `Db` handle — never a filesystem path, per
 * `.claude/rules/dork-home.md`.
 */
export class OpenCodeSessionMap {
  constructor(private readonly db: Db) {}

  /**
   * Persist a binding, authoritatively: any existing row for either key is
   * replaced in the same transaction so the mapping stays strictly 1:1
   * (mirrors `OpenCodeSessionMapper.link`). Never throws — a failed write is
   * warned and the binding stays in-memory-only until the next write.
   *
   * @param sessionId - DorkOS session identifier
   * @param ocSessionId - OpenCode session identifier to bind
   */
  bind(sessionId: string, ocSessionId: string): void {
    try {
      this.db.transaction((tx) => {
        tx.delete(opencodeSessions)
          .where(
            or(
              eq(opencodeSessions.sessionId, sessionId),
              eq(opencodeSessions.ocSessionId, ocSessionId)
            )
          )
          .run();
        tx.insert(opencodeSessions)
          .values({ sessionId, ocSessionId, createdAt: new Date().toISOString() })
          .run();
      });
    } catch (err) {
      logger.warn(
        '[OpenCodeSessionMap] failed to persist session binding — id will not survive a restart',
        { sessionId, ocSessionId, ...logError(err) }
      );
    }
  }

  /**
   * All persisted bindings — the hydration source that re-seeds the mapper's
   * in-memory maps after a server restart. Never throws — a failed read is
   * warned and hydration degrades to an empty map (derived ids), never a
   * boot crash.
   */
  listAll(): OpenCodeSessionBinding[] {
    try {
      return this.db
        .select({
          sessionId: opencodeSessions.sessionId,
          ocSessionId: opencodeSessions.ocSessionId,
        })
        .from(opencodeSessions)
        .all();
    } catch (err) {
      logger.warn(
        '[OpenCodeSessionMap] failed to read persisted session bindings — past ids may re-key',
        logError(err)
      );
      return [];
    }
  }
}
