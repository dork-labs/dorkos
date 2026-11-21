import { sql, type SQL } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** Structural source evidence. The owning writer must verify the real durable source in its transaction. */
export type InternalBirthSource =
  | {
      kind: 'chat-message';
      receiptId: string;
      queueMessageId: string;
      mintedToSessionId: string;
      fromSessionId: string;
      targetAgentId?: string;
    }
  | {
      kind: 'room-seat';
      roomId: string;
      authorId: string;
      boundSessionId: string;
      seatCreatedAt: string;
    }
  | { kind: 'task-run'; runId: string; mintedSessionId: string }
  | { kind: 'heartbeat'; agentId: string; chatDate: string; mintedSessionId: string }
  | { kind: 'connector-subscription'; subscriptionId: string; mintedSessionId: string }
  | { kind: 'required-recovery'; requirementId: string; mintedSessionId: string }
  | {
      kind: 'server-mint';
      owner:
        | 'relay-binding'
        | 'extension-start'
        | 'agent-send'
        | 'chat-start'
        | 'todo-turn'
        | 'carry-over'
        | 'computer-local'
        | 'room-turn';
      mintedSessionId: string;
    };

/** SQL shape checks use only these source-owned literal keys, never caller input. */
function sourceShape(kind: string, required: string[], optional: string[] = []): SQL {
  const keys = ['kind', ...required, ...optional];
  const fields = required.map(
    (key) =>
      `json_type(internal_source, '$.${key}') = 'text' AND length(json_extract(internal_source, '$.${key}')) > 0`
  );
  fields.push(
    ...optional.map(
      (key) =>
        `(json_type(internal_source, '$.${key}') IS NULL OR (json_type(internal_source, '$.${key}') = 'text' AND length(json_extract(internal_source, '$.${key}')) > 0))`
    )
  );
  return sql.raw(
    `(json_extract(internal_source, '$.kind') = '${kind}' AND ${fields.join(' AND ')} AND json_remove(internal_source, ${keys.map((key) => `'$.${key}'`).join(', ')}) = '{}')`
  );
}

/** Durable birth reservations. Insertion alone creates no session metadata or execution authority. */
export const sessionBirthAllocations = sqliteTable(
  'session_birth_allocations',
  {
    sessionId: text('session_id').primaryKey().notNull(),
    version: integer('version').notNull(),
    createdAt: text('created_at').notNull(),
    sourceKind: text('source_kind', {
      enum: ['person-location', 'person-agent', 'internal'],
    }).notNull(),
    ownerId: text('owner_id'),
    locationId: text('location_id'),
    registeredAgentId: text('registered_agent_id'),
    recordedRegisteredPath: text('recorded_registered_path'),
    internalSource: text('internal_source', { mode: 'json' }).$type<InternalBirthSource>(),
  },
  (t) => [
    check('session_birth_session_id', sql`length(${t.sessionId}) > 0`),
    check('session_birth_version', sql`typeof(${t.version}) = 'integer' AND ${t.version} = 1`),
    check('session_birth_created_at', sql`length(${t.createdAt}) > 0`),
    check(
      'session_birth_source_shape',
      sql`coalesce(
        (${t.sourceKind} = 'person-location' AND
          length(${t.ownerId}) > 0 AND length(${t.locationId}) > 0 AND
          ${t.registeredAgentId} IS NULL AND ${t.recordedRegisteredPath} IS NULL AND
          ${t.internalSource} IS NULL) OR
        (${t.sourceKind} = 'person-agent' AND length(${t.ownerId}) > 0 AND
          length(${t.registeredAgentId}) > 0 AND length(${t.recordedRegisteredPath}) > 0 AND
          ${t.locationId} IS NULL AND ${t.internalSource} IS NULL) OR
        (${t.sourceKind} = 'internal' AND ${t.ownerId} IS NULL AND ${t.locationId} IS NULL AND
          ${t.registeredAgentId} IS NULL AND ${t.recordedRegisteredPath} IS NULL AND
          CASE WHEN json_valid(${t.internalSource}) THEN
            json_type(${t.internalSource}) = 'object' AND (
              (${sourceShape('chat-message', ['receiptId', 'queueMessageId', 'mintedToSessionId', 'fromSessionId'], ['targetAgentId'])}
                AND json_extract(${t.internalSource}, '$.mintedToSessionId') = ${t.sessionId}) OR
              (${sourceShape('room-seat', ['roomId', 'authorId', 'boundSessionId', 'seatCreatedAt'])}
                AND json_extract(${t.internalSource}, '$.boundSessionId') = ${t.sessionId}) OR
              (${sourceShape('task-run', ['runId', 'mintedSessionId'])}
                AND json_extract(${t.internalSource}, '$.mintedSessionId') = ${t.sessionId}) OR
              (${sourceShape('heartbeat', ['agentId', 'chatDate', 'mintedSessionId'])}
                AND json_extract(${t.internalSource}, '$.mintedSessionId') = ${t.sessionId}) OR
              (${sourceShape('connector-subscription', ['subscriptionId', 'mintedSessionId'])}
                AND json_extract(${t.internalSource}, '$.mintedSessionId') = ${t.sessionId}) OR
              (${sourceShape('required-recovery', ['requirementId', 'mintedSessionId'])}
                AND json_extract(${t.internalSource}, '$.mintedSessionId') = ${t.sessionId}) OR
              (${sourceShape('server-mint', ['owner', 'mintedSessionId'])}
                AND json_extract(${t.internalSource}, '$.owner') IN (
                  'relay-binding', 'extension-start', 'agent-send', 'chat-start',
                  'todo-turn', 'carry-over', 'computer-local', 'room-turn'
                ) AND json_extract(${t.internalSource}, '$.mintedSessionId') = ${t.sessionId})
            )
          ELSE 0 END), 0)`
    ),
  ]
);

export type SessionBirthAllocation = typeof sessionBirthAllocations.$inferSelect;
export type NewSessionBirthAllocation = typeof sessionBirthAllocations.$inferInsert;
