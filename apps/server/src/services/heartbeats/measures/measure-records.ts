/**
 * What the measures read (spec `heartbeats` §13): one agent's rows from the
 * beat record, the outbox, its promises, the rooms its messages landed in, and
 * the audit trail, over a window. Reads only; every number the measures report
 * is computed from these rows in `measures.ts`, never from the agent's own
 * account of itself.
 *
 * @module services/heartbeats/measures/measure-records
 */
import { and, eq, gte, inArray, isNotNull, lte, sql } from 'drizzle-orm';
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
  /** Pauses, heartbeat edits, settings changes and stops by people, since the window began. */
  audit: MeasureAuditRow[];
  /** The direct-message rooms the agent is in, for a muted DM. */
  dmRoomIds: string[];
  /** Its promises that came due in the window. */
  commitments: MeasureCommitment[];
}

/** The audit actions a person's hand shows up in. */
const PERSON_ACTIONS = [
  'agent.paused',
  'chat.stopped',
  'heartbeat.config_changed',
  'config.changed',
] as const;

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
 * not a person finding it useful. In a direct message any later post is a
 * reply; in a shared room only a reply in its thread is.
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
      AND (room.kind = 'dm' OR r.parent_entry_id = s.id OR r.thread_root_entry_id = s.id)
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
        // A row resolved while still held never reached anybody: it closed
        // before its moment came. One that went out closed at or after it.
        lte(heartbeatOutbox.deliverAfter, heartbeatOutbox.closedAt)
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
    dmRoomIds: readDmRooms(db, input.agentPath),
    commitments: due,
  };
}
