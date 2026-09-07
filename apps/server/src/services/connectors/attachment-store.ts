/**
 * Canonical session connector overrides (connection-scoping spec Part 1).
 *
 * {@link SessionConnectorAttachmentStore} stores per-session overrides. A row
 * here is a tombstone, not just a presence flag: `'attached'` selects the
 * session-scoped grant path for an account the agent did not inherit;
 * `'detached'` suppresses inherited grants. The row never grants an operation
 * by itself. See `design-decisions.md` D2 for the per-account precedence.
 *
 * The store uses stable DorkOS connection ids and holds pure intent records,
 * never provider transport details. Reading an override never grants an
 * operation by itself; broker authorization still resolves canonical grants.
 *
 * @module services/connectors/attachment-store
 */
import { sessionConnectionOverrides, eq, and, type Db } from '@dorkos/db';
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';

/** One session's override state for one account. */
export type SessionConnectorOverrideState = 'attached' | 'detached';

/** One session's persisted override row. */
export interface SessionConnectorOverride {
  sessionId: string;
  agentId?: string;
  accountId: ConnectedAccountId;
  state: SessionConnectorOverrideState;
  needsReconciliation: boolean;
  updatedAt: string;
}

/** Raised when a new session override cannot be tied to an existing agent. */
export class SessionConnectorOwnerUnavailableError extends Error {
  /** Construct the ownership failure for one session. */
  constructor(sessionId: string) {
    super(`Connector access cannot be changed because session '${sessionId}' has no agent owner.`);
    this.name = 'SessionConnectorOwnerUnavailableError';
  }
}

/** Per-session connector-attachment overrides — see module doc. */
export class SessionConnectorAttachmentStore {
  private readonly _db: Db;
  private readonly _resolveOwner: (sessionId: string) => string | undefined;

  constructor(db: Db, resolveOwner?: (sessionId: string) => string | undefined) {
    this._db = db;
    this._resolveOwner =
      resolveOwner ??
      ((sessionId) => {
        const candidate = this._db.$client
          .prepare(
            `SELECT COUNT(DISTINCT a.id) AS owner_count, MIN(a.id) AS id
             FROM session_metadata sm
             JOIN agents a ON a.project_path = sm.agent_path
             WHERE sm.session_id = ? AND sm.agent_path IS NOT NULL`
          )
          .get(sessionId) as { owner_count: number; id: string | null };
        return candidate.owner_count === 1 && candidate.id ? candidate.id : undefined;
      });
  }

  /**
   * Resolve the registered agent that owns a live session change.
   *
   * Callers that can otherwise no-op still use this first so an unknown or
   * unowned session cannot probe connection ids through different responses.
   *
   * @param sessionId - Session whose connector state would change.
   * @param agentId - Already resolved in-memory owner, when available.
   * @returns The verified owner id.
   * @throws {@link SessionConnectorOwnerUnavailableError} when the session has no owner.
   */
  requireOwner(sessionId: string, agentId?: string): string {
    const owner = agentId ?? this._resolveOwner(sessionId);
    if (!owner) throw new SessionConnectorOwnerUnavailableError(sessionId);
    return owner;
  }

  /** Write (or replace) the override for one session's account. */
  setState(
    sessionId: string,
    accountId: ConnectedAccountId,
    state: SessionConnectorOverrideState,
    agentId?: string
  ): void {
    const owner = this.requireOwner(sessionId, agentId);
    const updatedAt = new Date().toISOString();
    this._db
      .insert(sessionConnectionOverrides)
      .values({
        sessionId,
        connectionId: accountId,
        state,
        agentId: owner,
        needsReconciliation: false,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [sessionConnectionOverrides.sessionId, sessionConnectionOverrides.connectionId],
        set: {
          state,
          agentId: owner,
          needsReconciliation: false,
          updatedAt,
        },
      })
      .run();
  }

  /** Every override recorded for one session. */
  listForSession(sessionId: string): SessionConnectorOverride[] {
    return this._db
      .select()
      .from(sessionConnectionOverrides)
      .where(eq(sessionConnectionOverrides.sessionId, sessionId))
      .all()
      .map((row) => ({
        sessionId: row.sessionId,
        ...(row.agentId && { agentId: row.agentId }),
        accountId: row.connectionId as ConnectedAccountId,
        state: row.state as SessionConnectorOverrideState,
        needsReconciliation: row.needsReconciliation,
        updatedAt: row.updatedAt,
      }));
  }

  /** Bind new, non-migrated rows to an unambiguous session owner. */
  bindOwner(sessionId: string, agentId: string): void {
    this._db.$client
      .prepare(
        `UPDATE session_connection_overrides
         SET agent_id = ?
         WHERE session_id = ? AND agent_id IS NULL AND needs_reconciliation = 0`
      )
      .run(agentId, sessionId);
  }

  /**
   * Move every override row from `oldSessionId` to `newSessionId` — the
   * runtime's canonical-id remap (connection-scoping spec, adversarial
   * review MAJOR 3: a `'detached'` tombstone must survive a rekey or the
   * suppression it recorded silently un-suppresses on the session's next
   * hydration). Per-account, not a bulk `UPDATE`, because `newSessionId` may
   * already carry its own override for the same account — in that
   * conflict the NEW id's row wins (mirrors the projector rekey's "active
   * wins") and the old row is dropped rather than violating the
   * `(sessionId, accountId)` primary key. A no-op when the ids match.
   *
   * @param oldSessionId - The session id overrides were recorded under (request UUID).
   * @param newSessionId - The canonical session id to move them to.
   */
  rekey(oldSessionId: string, newSessionId: string): void {
    if (oldSessionId === newSessionId) return;
    const oldRows = this._db
      .select()
      .from(sessionConnectionOverrides)
      .where(eq(sessionConnectionOverrides.sessionId, oldSessionId))
      .all();
    for (const row of oldRows) {
      const existing = this._db
        .select()
        .from(sessionConnectionOverrides)
        .where(
          and(
            eq(sessionConnectionOverrides.sessionId, newSessionId),
            eq(sessionConnectionOverrides.connectionId, row.connectionId)
          )
        )
        .get();
      const where = and(
        eq(sessionConnectionOverrides.sessionId, oldSessionId),
        eq(sessionConnectionOverrides.connectionId, row.connectionId)
      );
      if (existing) {
        // The new id already has its own explicit override for this account
        // — it wins; the old row would otherwise collide on the primary key.
        this._db.delete(sessionConnectionOverrides).where(where).run();
      } else {
        this._db
          .update(sessionConnectionOverrides)
          .set({ sessionId: newSessionId })
          .where(where)
          .run();
      }
    }
  }
}
