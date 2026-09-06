/**
 * Persisted connector-attachment stores (connection-scoping spec
 * `specs/connection-scoping/` §Part 1) — the durable half of the two-level
 * consent ladder `SessionConnectorService` reads at hydration time.
 *
 * Two canonical tables, two thin CRUD wrappers:
 *
 * - {@link AgentConnectorAttachmentStore} — standing, agent-level consent.
 *   Row existence IS the consent (no boolean column); a detach deletes the
 *   row.
 * - {@link SessionConnectorAttachmentStore} — per-session overrides. A row
 *   here is a tombstone, not just a presence flag: `'attached'` selects the
 *   session-scoped path for an account the agent has not standingly attached;
 *   `'detached'` suppresses inherited access. The row never grants an operation
 *   by itself. See `design-decisions.md` D2 for the per-account precedence.
 *
 * Both stores use stable DorkOS connection ids and hold pure intent records —
 * never a resolved `McpAppServerConnection` (unserializable, provider-held). Reading either
 * table back never produces something tool-shaped by itself; a caller must
 * still resolve the connection via the owning `ConnectorProvider`.
 *
 * @module services/connectors/attachment-store
 */
import {
  agentConnectionAttachments,
  sessionConnectionOverrides,
  eq,
  and,
  type Db,
} from '@dorkos/db';
import type { ConnectedAccountId } from '@dorkos/shared/connector-provider';

/** One agent's standing account attachment, as persisted. */
export interface AgentConnectorAttachment {
  agentId: string;
  accountId: ConnectedAccountId;
  attachedAt: string;
}

/** Standing, agent-level connector consent — see module doc. */
export class AgentConnectorAttachmentStore {
  private readonly _db: Db;

  constructor(db: Db) {
    this._db = db;
  }

  /**
   * Record standing consent for `agentId` to use `accountId`. Idempotent —
   * re-attaching an already-attached account leaves `attachedAt` at its
   * original value (first-attach wins, mirroring the registry's
   * first-write-wins convention) rather than resetting it.
   */
  attach(agentId: string, accountId: ConnectedAccountId): void {
    this._db
      .insert(agentConnectionAttachments)
      .values({ agentId, connectionId: accountId, attachedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  /** Revoke standing consent. Idempotent — detaching an unattached account is a no-op. */
  detach(agentId: string, accountId: ConnectedAccountId): void {
    this._db
      .delete(agentConnectionAttachments)
      .where(
        and(
          eq(agentConnectionAttachments.agentId, agentId),
          eq(agentConnectionAttachments.connectionId, accountId)
        )
      )
      .run();
  }

  /** Every account standingly attached to `agentId`. */
  listForAgent(agentId: string): AgentConnectorAttachment[] {
    return this._db
      .select()
      .from(agentConnectionAttachments)
      .where(eq(agentConnectionAttachments.agentId, agentId))
      .all()
      .map((row) => ({
        agentId: row.agentId,
        accountId: row.connectionId as ConnectedAccountId,
        attachedAt: row.attachedAt,
      }));
  }
}

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
