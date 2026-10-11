/**
 * What the measures read (spec `heartbeats` §13): one agent's rows from the
 * beat record, the outbox, its promises, the rooms its messages landed in, and
 * the audit trail, over a window. Reads only; every number the measures report
 * is computed from these rows in `measures.ts`, never from the agent's own
 * account of itself.
 *
 * @module services/heartbeats/measures/measure-records
 */
import { and, eq, gte, inArray, isNotNull, lte, notLike, or, sql } from 'drizzle-orm';
import {
  auditEvents,
  commitments,
  heartbeatBeats,
  heartbeatOutbox,
  type Db,
  type HeartbeatBeatRow,
  type HeartbeatOutboxRow,
} from '@dorkos/db';

/** A beat row, as the measures read it. */
export type MeasureBeat = Pick<
  HeartbeatBeatRow,
  | 'id'
  | 'kind'
  | 'startedAt'
  | 'endedAt'
  | 'outcome'
  | 'raises'
  | 'bypass'
  | 'triage'
  | 'turnSessionId'
  | 'turnUsage'
>;

/** An outbox row that reached its reader, or is still held for them. */
export type MeasureDelivery = Pick<
  HeartbeatOutboxRow,
  'id' | 'beatId' | 'toAccount' | 'rung' | 'key' | 'deliveredEntryId' | 'closedAt' | 'state'
>;

/** What people did with one message a beat delivered into the app. */
export interface EntryAnswer {
  /** When it was posted (ISO 8601). */
  postedAt: string;
  /** The first reply a person posted after it, or null. */
  firstReplyAt: string | null;
  /** People's reactions on it. */
  reactions: Array<{ emoji: string; at: string }>;
}

/** An audit row the measures count, by a person. */
export interface MeasureAuditRow {
  /** `domain.verb`. */
  action: string;
  /** When (ISO 8601). */
  at: string;
  /** What it acted on. */
  targetId: string | null;
  /** The field changes, parsed, or an empty list. */
  change: Array<{ field: string; before?: unknown; after?: unknown }>;
}

/** Something an agent did itself, in one of its beat chats: a mutating audit row. */
export interface MeasureAgentAction {
  /** The chat it happened in. */
  sessionId: string;
  /** When (ISO 8601). */
  at: string;
}

/** A promise that came due in the window. */
export interface MeasureCommitment {
  /** Where it stands. */
  state: 'open' | 'kept' | 'missed' | 'dropped';
  /** When it was due (ISO 8601). */
  dueAt: string;
  /** When it closed (ISO 8601), or null while open. */
  closedAt: string | null;
}

/** Everything one agent's measures are computed from. */
export interface MeasureRecords {
  /** Its beats that started in the window, ended ones only. */
  beats: MeasureBeat[];
  /** Its outbox rows delivered in the window, and every row still held. */
  deliveries: MeasureDelivery[];
  /** What people did with each delivered room entry, by entry id. */
  answers: Map<string, EntryAnswer>;
  /** Pauses, heartbeat edits and settings changes by people, since the window began. */
  audit: MeasureAuditRow[];
  /** What the agent itself did in its beat chats: tool calls and actions that change things. */
  agentActions: MeasureAgentAction[];
  /** The direct-message rooms the agent is in, for a muted DM. */
  dmRoomIds: string[];
  /** Its promises that came due in the window. */
  commitments: MeasureCommitment[];
}

/**
 * The audit actions a person's hand shows up in. A person stopping a beat's
 * chat is not among them: no production path records that as a person's row
 * yet (only an agent's `chat_stop` writes `chat.stopped`), so it is not
 * measured rather than measured as never happening.
 */
const PERSON_ACTIONS = ['agent.paused', 'heartbeat.config_changed', 'config.changed'] as const;

/** Operations that change something, as opposed to reading it. */
const MUTATING_OPERATIONS = ['create', 'modify', 'remove', 'execute'] as const;

/** One parsed `change` column. */
function parseChange(raw: string | null): MeasureAuditRow['change'] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MeasureAuditRow['change']) : [];
  } catch {
    return [];
  }
}

/**
 * Who answered, and how, each room entry a beat's message landed as. Only a
 * person counts (`authors.kind = 'human'`): an agent replying to an agent is
 * not a person finding it useful. A reply in its thread always counts; in a
 * direct message, so does a later post, until the agent posts again.
 *
 * @param db - The server's database.
 * @param entryIds - The entries.
 */
function readAnswers(db: Db, entryIds: string[]): Map<string, EntryAnswer> {
  const answers = new Map<string, EntryAnswer>();
  if (entryIds.length === 0) return answers;
  const ids = sql.join(
    entryIds.map((id) => sql`${id}`),
    sql`, `
  );
  const posted = db.all<{ id: string; postedAt: string; firstReplyAt: string | null }>(sql`
    SELECT s.id AS id, s.created_at AS postedAt, MIN(r.created_at) AS firstReplyAt
    FROM room_entries s
    JOIN rooms room ON room.id = s.room_id
    LEFT JOIN room_entries r
      ON r.room_id = s.room_id AND r.seq > s.seq AND r.kind = 'post'
      AND (
        r.parent_entry_id = s.id OR r.thread_root_entry_id = s.id
        OR (
          room.kind = 'dm'
          -- In a DM a reply answers the agent's latest message only: one reply
          -- never credits every message the agent sent before it.
          AND NOT EXISTS (
            SELECT 1 FROM room_entries later
            WHERE later.room_id = s.room_id AND later.author_id = s.author_id
              AND later.seq > s.seq AND later.seq < r.seq
          )
        )
      )
      AND r.author_id IN (SELECT id FROM authors WHERE kind = 'human')
    WHERE s.id IN (${ids})
    GROUP BY s.id
  `);
  for (const row of posted) {
    answers.set(row.id, { postedAt: row.postedAt, firstReplyAt: row.firstReplyAt, reactions: [] });
  }
  const reactions = db.all<{ entryId: string; emoji: string; at: string }>(sql`
    SELECT x.entry_id AS entryId, x.emoji AS emoji, x.created_at AS at
    FROM room_entry_reactions x
    JOIN authors a ON a.id = x.author_id AND a.kind = 'human'
    WHERE x.entry_id IN (${ids})
  `);
  for (const reaction of reactions) {
    answers.get(reaction.entryId)?.reactions.push({ emoji: reaction.emoji, at: reaction.at });
  }
  return answers;
}

/**
 * The direct-message rooms an agent is a member of.
 *
 * @param db - The server's database.
 * @param agentPath - The agent's home folder: its room author's stable key.
 */
function readDmRooms(db: Db, agentPath: string): string[] {
  return db
    .all<{ id: string }>(
      sql`
        SELECT DISTINCT m.room_id AS id
        FROM room_members m
        JOIN rooms room ON room.id = m.room_id AND room.kind = 'dm'
        JOIN authors a ON a.id = m.author_id AND a.kind = 'agent' AND a.natural_key = ${agentPath}
      `
    )
    .map((row) => row.id);
}

/**
 * Read one agent's records over a window.
 *
 * @param db - The server's database.
 * @param input - The agent and the window.
 * @param input.agentId - Its Mesh id.
 * @param input.agentPath - Its home folder.
 * @param input.since - Where the window starts (ISO 8601).
 * @param input.now - Where it ends (ISO 8601).
 */
export function readMeasureRecords(
  db: Db,
  input: { agentId: string; agentPath: string; since: string; now: string }
): MeasureRecords {
  const { agentId, since, now } = input;
  const beats = db
    .select({
      id: heartbeatBeats.id,
      kind: heartbeatBeats.kind,
      startedAt: heartbeatBeats.startedAt,
      endedAt: heartbeatBeats.endedAt,
      outcome: heartbeatBeats.outcome,
      raises: heartbeatBeats.raises,
      bypass: heartbeatBeats.bypass,
      triage: heartbeatBeats.triage,
      turnSessionId: heartbeatBeats.turnSessionId,
      turnUsage: heartbeatBeats.turnUsage,
    })
    .from(heartbeatBeats)
    .where(
      and(
        eq(heartbeatBeats.agentId, agentId),
        gte(heartbeatBeats.startedAt, since),
        lte(heartbeatBeats.startedAt, now),
        isNotNull(heartbeatBeats.endedAt)
      )
    )
    .all();
  const columns = {
    id: heartbeatOutbox.id,
    beatId: heartbeatOutbox.beatId,
    toAccount: heartbeatOutbox.toAccount,
    rung: heartbeatOutbox.rung,
    key: heartbeatOutbox.key,
    deliveredEntryId: heartbeatOutbox.deliveredEntryId,
    closedAt: heartbeatOutbox.closedAt,
    state: heartbeatOutbox.state,
  };
  const delivered = db
    .select(columns)
    .from(heartbeatOutbox)
    .where(
      and(
        eq(heartbeatOutbox.agentId, agentId),
        inArray(heartbeatOutbox.state, ['delivered', 'resolved']),
        gte(heartbeatOutbox.closedAt, since),
        // Reached its reader: it landed as an entry, or it is still marked
        // delivered (a note outside the app has no entry). A row resolved while
        // held has neither and never reached anybody.
        or(isNotNull(heartbeatOutbox.deliveredEntryId), eq(heartbeatOutbox.state, 'delivered'))
      )
    )
    .all();
  const held = db
    .select(columns)
    .from(heartbeatOutbox)
    .where(and(eq(heartbeatOutbox.agentId, agentId), eq(heartbeatOutbox.state, 'held')))
    .all();
  const entryIds = [
    ...new Set(
      delivered.map((row) => row.deliveredEntryId).filter((id): id is string => id !== null)
    ),
  ];
  const audit = db
    .select({
      action: auditEvents.action,
      at: auditEvents.at,
      targetId: auditEvents.targetId,
      change: auditEvents.change,
    })
    .from(auditEvents)
    .where(
      and(
        inArray(auditEvents.action, [...PERSON_ACTIONS]),
        eq(auditEvents.actorKind, 'person'),
        gte(auditEvents.at, since)
      )
    )
    .all()
    .map((row) => ({ ...row, change: parseChange(row.change) }));
  const sessionIds = [
    ...new Set(beats.map((beat) => beat.turnSessionId).filter((id): id is string => id !== null)),
  ];
  const agentActions =
    sessionIds.length === 0
      ? []
      : db
          .select({ sessionId: auditEvents.sessionId, at: auditEvents.at })
          .from(auditEvents)
          .where(
            and(
              inArray(auditEvents.sessionId, sessionIds),
              eq(auditEvents.actorKind, 'agent'),
              inArray(auditEvents.operation, [...MUTATING_OPERATIONS]),
              eq(auditEvents.outcome, 'ok'),
              // The beat's own bookkeeping (end_beat, delivery) is not work.
              notLike(auditEvents.action, 'heartbeat.%'),
              gte(auditEvents.at, since)
            )
          )
          .all()
          .filter((row): row is MeasureAgentAction => row.sessionId !== null);
  const due = db
    .select({ state: commitments.state, dueAt: commitments.dueAt, closedAt: commitments.closedAt })
    .from(commitments)
    .where(
      and(
        eq(commitments.agentId, agentId),
        gte(commitments.dueAt, since),
        lte(commitments.dueAt, now)
      )
    )
    .all()
    .filter((row): row is MeasureCommitment => row.dueAt !== null);
  return {
    beats,
    deliveries: [...delivered, ...held],
    answers: readAnswers(db, entryIds),
    audit,
    agentActions,
    dmRoomIds: readDmRooms(db, input.agentPath),
    commitments: due,
  };
}
