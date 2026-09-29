/**
 * Access levels stored as the owner's intent (ADR 260929-071355).
 *
 * When the owner gives an agent, or every agent, "Read" or "Read and write"
 * on one connection, the level itself is kept in `connection_access_levels`.
 * The grant rows stay the only thing access is ever checked against; this
 * module owns the level rows beside them and the one rule that re-derives a
 * level's grant rows from the catalog (`accessLevelRevisionIds`), so a level
 * follows the app and never covers more than its classes.
 *
 * Every path that ends a subject's grants some other way (exact actions,
 * removing an agent, disconnecting) ends its level here too, in the same
 * transaction, so a level can never bring back access that was taken away.
 *
 * @module services/connectors/execution/access-levels
 */
import {
  and,
  connectionAccessLevels,
  connectionOperationGrants,
  eq,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  inArray,
  type Db,
  type DbTransaction,
} from '@dorkos/db';
import type { ConnectorAccessLevel } from '@dorkos/shared/connector-schemas';

/** Who a level is for: one named agent, or every agent the owner has. */
export type AccessLevelSubject =
  { readonly kind: 'agent'; readonly agentId: string } | { readonly kind: 'every_agent' };

/** One level the owner chose on a connection. */
export interface StoredAccessLevel {
  /** Who holds it. */
  readonly subject: AccessLevelSubject;
  /** The chosen level. */
  readonly level: ConnectorAccessLevel;
  /** Who chose it, as recorded on the grant rows it derives. */
  readonly createdBy: string;
}

function subjectColumns(subject: AccessLevelSubject) {
  return subject.kind === 'agent'
    ? { subjectType: 'agent' as const, subjectId: subject.agentId, agentId: subject.agentId }
    : {
        subjectType: 'every_agent' as const,
        subjectId: EVERY_AGENT_GRANT_SUBJECT_ID,
        agentId: null,
      };
}

/**
 * Every level chosen on one connection.
 *
 * @param tx - The open connector transaction.
 * @param connectionId - The connection.
 */
export function readAccessLevels(
  tx: Db | DbTransaction,
  connectionId: string
): StoredAccessLevel[] {
  return tx
    .select()
    .from(connectionAccessLevels)
    .where(eq(connectionAccessLevels.connectionId, connectionId))
    .all()
    .map((row) => ({
      subject:
        row.subjectType === 'every_agent'
          ? { kind: 'every_agent' as const }
          : { kind: 'agent' as const, agentId: row.subjectId },
      level: row.level,
      createdBy: row.createdBy,
    }));
}

/** Input to {@link recordAccessLevel}. */
export interface RecordAccessLevelInput {
  /** The connection the level is on. */
  readonly connectionId: string;
  /** Who it is for. */
  readonly subject: AccessLevelSubject;
  /** The chosen level, or `undefined` when the owner chose exact actions or none. */
  readonly level: ConnectorAccessLevel | undefined;
  /** Verified owner id recorded as the level's author. */
  readonly createdBy: string;
  /** Timestamp of the change. */
  readonly now: string;
}

/**
 * Keep or end one subject's level, beside the grant change that carries it.
 * With no level the subject holds exact actions (or nothing), and its row is
 * removed so nothing re-derives its grants.
 *
 * @param tx - The open connector transaction.
 * @param input - Connection, subject, level, author and clock.
 */
export function recordAccessLevel(tx: DbTransaction, input: RecordAccessLevelInput): void {
  const columns = subjectColumns(input.subject);
  if (!input.level) {
    tx.delete(connectionAccessLevels)
      .where(
        and(
          eq(connectionAccessLevels.connectionId, input.connectionId),
          eq(connectionAccessLevels.subjectType, columns.subjectType),
          eq(connectionAccessLevels.subjectId, columns.subjectId)
        )
      )
      .run();
    return;
  }
  tx.insert(connectionAccessLevels)
    .values({
      ...columns,
      connectionId: input.connectionId,
      level: input.level,
      createdBy: input.createdBy,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [
        connectionAccessLevels.subjectType,
        connectionAccessLevels.subjectId,
        connectionAccessLevels.connectionId,
      ],
      set: {
        level: input.level,
        createdBy: input.createdBy,
        updatedAt: input.now,
      },
    })
    .run();
}

/**
 * Note that DorkOS staged this hosted command on its own to keep one level
 * current, so a refusal of it keeps the level (the next pass sends it again)
 * rather than ending a choice the owner made.
 *
 * @param tx - The open connector transaction.
 * @param input - Connection, subject and the staged command.
 */
export function markFollowerCommand(
  tx: DbTransaction,
  input: { connectionId: string; subject: AccessLevelSubject; commandId: string }
): void {
  const columns = subjectColumns(input.subject);
  tx.update(connectionAccessLevels)
    .set({ followerCommandId: input.commandId })
    .where(
      and(
        eq(connectionAccessLevels.connectionId, input.connectionId),
        eq(connectionAccessLevels.subjectType, columns.subjectType),
        eq(connectionAccessLevels.subjectId, columns.subjectId)
      )
    )
    .run();
}

/**
 * Whether this hosted command is the one DorkOS staged on its own for the
 * subject's level (see {@link markFollowerCommand}).
 *
 * @param tx - The open connector transaction.
 * @param input - Connection, subject and the command.
 */
export function isFollowerCommand(
  tx: DbTransaction,
  input: { connectionId: string; subject: AccessLevelSubject; commandId: string }
): boolean {
  const columns = subjectColumns(input.subject);
  return (
    tx
      .select({ commandId: connectionAccessLevels.followerCommandId })
      .from(connectionAccessLevels)
      .where(
        and(
          eq(connectionAccessLevels.connectionId, input.connectionId),
          eq(connectionAccessLevels.subjectType, columns.subjectType),
          eq(connectionAccessLevels.subjectId, columns.subjectId)
        )
      )
      .get()?.commandId === input.commandId
  );
}

/**
 * End every level on these connections: they were disconnected or removed,
 * and every grant on them ended with them.
 *
 * @param tx - The open connector transaction.
 * @param connectionIds - The connections.
 */
export function endConnectionAccessLevels(
  tx: DbTransaction,
  connectionIds: readonly string[]
): void {
  if (connectionIds.length === 0) return;
  tx.delete(connectionAccessLevels)
    .where(inArray(connectionAccessLevels.connectionId, [...connectionIds]))
    .run();
}

/**
 * End one agent's levels: on one connection, or on every connection when the
 * agent is removed.
 *
 * @param tx - The open connector transaction.
 * @param agentId - The agent losing access.
 * @param connectionId - The one connection, or every connection when absent.
 */
export function endAgentAccessLevels(
  tx: DbTransaction,
  agentId: string,
  connectionId?: string
): void {
  tx.delete(connectionAccessLevels)
    .where(
      and(
        eq(connectionAccessLevels.subjectType, 'agent'),
        eq(connectionAccessLevels.subjectId, agentId),
        ...(connectionId ? [eq(connectionAccessLevels.connectionId, connectionId)] : [])
      )
    )
    .run();
}

/**
 * End the every-agent level on these connections, beside the every-agent
 * grants a caller just revoked.
 *
 * @param tx - The open connector transaction.
 * @param connectionIds - The connections that stop being shared.
 */
export function endEveryAgentAccessLevels(
  tx: DbTransaction,
  connectionIds: readonly string[]
): void {
  if (connectionIds.length === 0) return;
  tx.delete(connectionAccessLevels)
    .where(
      and(
        inArray(connectionAccessLevels.connectionId, [...connectionIds]),
        eq(connectionAccessLevels.subjectType, 'every_agent')
      )
    )
    .run();
}

/** Input to {@link replaceNamedAgentGrants}. */
export interface ReplaceNamedAgentGrantsInput {
  /** Exact stable connection whose grant set for one agent is replaced. */
  readonly connectionId: string;
  /** The agent whose complete set this is. */
  readonly agentId: string;
  /** The complete set after the change; empty revokes the agent's access. */
  readonly operationRevisionIds: readonly string[];
  /** Author recorded on new rows. */
  readonly createdBy: string;
  /** Timestamp shared by every row this replacement touches. */
  readonly now: string;
  /** Durable id source for new rows. */
  readonly createId: () => string;
}

/**
 * Replace one named agent's grant set on one connection, on this computer's
 * own authority, inside the caller's transaction: revisions left out are
 * revoked, ones that come back are restored, and new ones are inserted. The
 * caller has already proved the owner and that every revision was offered.
 *
 * @param tx - The open connector transaction.
 * @param input - Connection, agent, complete set, author and clock.
 */
export function replaceNamedAgentGrants(
  tx: DbTransaction,
  input: ReplaceNamedAgentGrantsInput
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
      and(
        eq(connectionOperationGrants.subjectType, 'agent'),
        eq(connectionOperationGrants.subjectId, input.agentId),
        eq(connectionOperationGrants.connectionId, input.connectionId)
      )
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
        subjectType: 'agent',
        subjectId: input.agentId,
        agentId: input.agentId,
        connectionId: input.connectionId,
        operationRevisionId,
        createdBy: input.createdBy,
        createdAt: input.now,
      })
      .run();
  }
}
