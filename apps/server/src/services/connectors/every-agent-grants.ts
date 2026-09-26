/**
 * Owner-wide "every agent" operation grants (ADR 260926-192625).
 *
 * An every-agent grant is a row in `connection_operation_grants` with subject
 * type `every_agent`, the fixed subject id {@link EVERY_AGENT_GRANT_SUBJECT_ID}
 * and a null `agent_id`. It pins exact reviewed operation revisions, exactly
 * like a named-agent grant, and covers every agent the connection's owner has,
 * including agents added later. Every read and write of that subject goes
 * through this module so the predicate and its guardrails live in one place.
 *
 * @module services/connectors/every-agent-grants
 */
import {
  and,
  connectionOperationGrants,
  connections,
  eq,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  inArray,
  isNull,
  type DbTransaction,
} from '@dorkos/db';

/** SQL predicate matching only owner-wide every-agent grant rows. */
export function everyAgentGrantSubject() {
  return and(
    eq(connectionOperationGrants.subjectType, 'every_agent'),
    eq(connectionOperationGrants.subjectId, EVERY_AGENT_GRANT_SUBJECT_ID),
    isNull(connectionOperationGrants.agentId)
  );
}

/** Input to {@link replaceEveryAgentGrants}. */
export interface ReplaceEveryAgentGrantsInput {
  /** Exact stable connection whose every-agent set is replaced. */
  readonly connectionId: string;
  /** The complete reviewed revision set after the change; empty clears the grant. */
  readonly operationRevisionIds: readonly string[];
  /** Verified owner id recorded as the grant's author. */
  readonly createdBy: string;
  /** Timestamp shared by every row this replacement touches. */
  readonly now: string;
  /** Durable id source for new rows. */
  readonly createId: () => string;
}

/**
 * Replace one connection's every-agent revision set inside the caller's transaction.
 *
 * Revisions left out are revoked, previously revoked revisions that come back are
 * restored, and new revisions are inserted. The caller has already proved the
 * owner and that every revision was part of a complete, reviewed catalog.
 *
 * @param tx - The open connector transaction.
 * @param input - Connection, complete revision set, author and clock.
 */
export function replaceEveryAgentGrants(
  tx: DbTransaction,
  input: ReplaceEveryAgentGrantsInput
): void {
  const selected = new Set(input.operationRevisionIds);
  const existing = tx
    .select({
      id: connectionOperationGrants.id,
      operationRevisionId: connectionOperationGrants.operationRevisionId,
      revokedAt: connectionOperationGrants.revokedAt,
    })
    .from(connectionOperationGrants)
    .where(
      and(eq(connectionOperationGrants.connectionId, input.connectionId), everyAgentGrantSubject())
    )
    .all();
  for (const grant of existing) {
    const keep = selected.has(grant.operationRevisionId);
    selected.delete(grant.operationRevisionId);
    if (keep === (grant.revokedAt === null)) continue;
    tx.update(connectionOperationGrants)
      .set({ revokedAt: keep ? null : input.now })
      .where(eq(connectionOperationGrants.id, grant.id))
      .run();
  }
  for (const operationRevisionId of selected) {
    tx.insert(connectionOperationGrants)
      .values({
        id: input.createId(),
        subjectType: 'every_agent',
        subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
        agentId: null,
        connectionId: input.connectionId,
        operationRevisionId,
        createdBy: input.createdBy,
        createdAt: input.now,
      })
      .run();
  }
}

/**
 * Revoke every live every-agent row on the given connections inside the
 * caller's transaction. Taking access away needs no reviewed catalog, so this
 * works while the provider is down.
 *
 * @param tx - The open connector transaction.
 * @param connectionIds - Connections whose every-agent grant ends.
 * @param now - Revocation timestamp.
 * @returns How many rows were revoked.
 */
export function revokeEveryAgentGrants(
  tx: DbTransaction,
  connectionIds: readonly string[],
  now: string
): number {
  if (connectionIds.length === 0) return 0;
  return tx
    .update(connectionOperationGrants)
    .set({ revokedAt: now })
    .where(
      and(
        inArray(connectionOperationGrants.connectionId, [...connectionIds]),
        everyAgentGrantSubject(),
        isNull(connectionOperationGrants.revokedAt)
      )
    )
    .run().changes;
}

/** A connection whose every-agent grant just ended, named for the owner. */
export interface EndedEveryAgentGrant {
  /** Stable connection id. */
  readonly connectionId: string;
  /** The service, e.g. `gmail`. */
  readonly toolkit: string;
  /** The owner's label for the account. */
  readonly label: string;
}

/**
 * The connections among `connectionIds` that are shared with every agent right
 * now. Read inside a transaction just before a path that revokes by connection,
 * so the caller can say afterwards which sharing it ended.
 *
 * @param tx - The open connector transaction.
 * @param connectionIds - Connections about to lose every grant.
 */
export function liveEveryAgentConnections(
  tx: DbTransaction,
  connectionIds: readonly string[]
): EndedEveryAgentGrant[] {
  if (connectionIds.length === 0) return [];
  const rows = tx
    .select({
      connectionId: connections.id,
      toolkit: connections.toolkit,
      label: connections.label,
    })
    .from(connectionOperationGrants)
    .innerJoin(connections, eq(connections.id, connectionOperationGrants.connectionId))
    .where(
      and(
        inArray(connectionOperationGrants.connectionId, [...connectionIds]),
        everyAgentGrantSubject(),
        isNull(connectionOperationGrants.revokedAt)
      )
    )
    .all();
  return [...new Map(rows.map((row) => [row.connectionId, row])).values()];
}
