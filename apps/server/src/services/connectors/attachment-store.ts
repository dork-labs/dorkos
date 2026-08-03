/**
 * Persisted connector-attachment stores (connection-scoping spec
 * `specs/connection-scoping/` §Part 1) — the durable half of the two-level
 * consent ladder `SessionConnectorService` reads at hydration time.
 *
 * Two tables, two thin CRUD wrappers:
 *
 * - {@link AgentConnectorAttachmentStore} — standing, agent-level consent.
 *   Row existence IS the consent (no boolean column); a detach deletes the
 *   row.
 * - {@link SessionConnectorAttachmentStore} — per-session overrides. A row
 *   here is a tombstone, not just a presence flag: `'attached'` grants an
 *   account the agent has not standingly attached; `'detached'` SUPPRESSES
 *   one the agent HAS. See `design-decisions.md` D2 for why "no merge" means
 *   per-account override rather than an all-or-nothing session behavior.
 *
 * Both stores hold pure intent records — never a resolved
 * `McpAppServerConnection` (unserializable, provider-held). Reading either
 * table back never produces something tool-shaped by itself; a caller must
 * still resolve the connection via the owning `ConnectorProvider`.
 *
 * @module services/connectors/attachment-store
 */
import {
  agentConnectorAttachments,
  sessionConnectorAttachments,
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
      .insert(agentConnectorAttachments)
      .values({ agentId, accountId, attachedAt: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
  }

  /** Revoke standing consent. Idempotent — detaching an unattached account is a no-op. */
  detach(agentId: string, accountId: ConnectedAccountId): void {
    this._db
      .delete(agentConnectorAttachments)
      .where(
        and(
          eq(agentConnectorAttachments.agentId, agentId),
          eq(agentConnectorAttachments.accountId, accountId)
        )
      )
      .run();
  }

  /** Every account standingly attached to `agentId`. */
  listForAgent(agentId: string): AgentConnectorAttachment[] {
    return this._db
      .select()
      .from(agentConnectorAttachments)
      .where(eq(agentConnectorAttachments.agentId, agentId))
      .all()
      .map((row) => ({ ...row, accountId: row.accountId as ConnectedAccountId }));
  }

  /**
   * Delete every standing attachment of `agentId` — the agent-deletion
   * cascade (adversarial review MAJOR 6). Without this, unregistering an
   * agent and later registering a NEW agent under the same id (a real
   * possibility — mesh ids are stable strings a person can reuse by pointing
   * a fresh directory at the same registration path) would silently inherit
   * the deleted agent's standing account consent. Mirrors the reasoning
   * `ConnectorRegistry.recordDisconnect`'s doc already makes for account ids:
   * a deleted identity's consent rows must not outlive it. Idempotent —
   * deleting an agent with nothing attached is a no-op.
   *
   * @param agentId - The unregistered agent's id.
   */
  deleteAgent(agentId: string): void {
    this._db
      .delete(agentConnectorAttachments)
      .where(eq(agentConnectorAttachments.agentId, agentId))
      .run();
  }
}

/** One session's override state for one account. */
export type SessionConnectorOverrideState = 'attached' | 'detached';

/** One session's persisted override row. */
export interface SessionConnectorOverride {
  sessionId: string;
  accountId: ConnectedAccountId;
  state: SessionConnectorOverrideState;
  updatedAt: string;
}

/** Per-session connector-attachment overrides — see module doc. */
export class SessionConnectorAttachmentStore {
  private readonly _db: Db;

  constructor(db: Db) {
    this._db = db;
  }

  /** Write (or replace) the override for one session's account. */
  setState(
    sessionId: string,
    accountId: ConnectedAccountId,
    state: SessionConnectorOverrideState
  ): void {
    const updatedAt = new Date().toISOString();
    this._db
      .insert(sessionConnectorAttachments)
      .values({ sessionId, accountId, state, updatedAt })
      .onConflictDoUpdate({
        target: [sessionConnectorAttachments.sessionId, sessionConnectorAttachments.accountId],
        set: { state, updatedAt },
      })
      .run();
  }

  /** Every override recorded for one session. */
  listForSession(sessionId: string): SessionConnectorOverride[] {
    return this._db
      .select()
      .from(sessionConnectorAttachments)
      .where(eq(sessionConnectorAttachments.sessionId, sessionId))
      .all()
      .map((row) => ({
        ...row,
        accountId: row.accountId as ConnectedAccountId,
        state: row.state as SessionConnectorOverrideState,
      }));
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
      .from(sessionConnectorAttachments)
      .where(eq(sessionConnectorAttachments.sessionId, oldSessionId))
      .all();
    for (const row of oldRows) {
      const existing = this._db
        .select()
        .from(sessionConnectorAttachments)
        .where(
          and(
            eq(sessionConnectorAttachments.sessionId, newSessionId),
            eq(sessionConnectorAttachments.accountId, row.accountId)
          )
        )
        .get();
      const where = and(
        eq(sessionConnectorAttachments.sessionId, oldSessionId),
        eq(sessionConnectorAttachments.accountId, row.accountId)
      );
      if (existing) {
        // The new id already has its own explicit override for this account
        // — it wins; the old row would otherwise collide on the primary key.
        this._db.delete(sessionConnectorAttachments).where(where).run();
      } else {
        this._db
          .update(sessionConnectorAttachments)
          .set({ sessionId: newSessionId })
          .where(where)
          .run();
      }
    }
  }
}
