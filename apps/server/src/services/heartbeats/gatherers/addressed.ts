/**
 * The `addressed` gatherer (spec `heartbeats` §5): messages to the agent since
 * its last beat that it has not answered.
 *
 * - **Local authors only.** A message from somebody off this machine (a bridged
 *   Telegram or Slack sender, whose author key carries the external prefix) is
 *   never a change, so a stranger never wakes a beat or shapes one (§3.3).
 * - **A room message counts when it names the agent; a DM counts whole.**
 *   Another agent's post counts only when it names this one (canon §5.2 step 2).
 * - **No bodies.** A change says who wrote, when and in which room; the agent
 *   reads the words through its room tools. A DM's words never reach the beat
 *   chat or the record, which a whole space can read (§5).
 * - **Unanswered** means the agent has posted nothing in that room after it.
 *
 * @module services/heartbeats/gatherers/addressed
 */
import { and, desc, eq, gt, inArray, ne } from 'drizzle-orm';
import { authors, roomEntries, roomMembers, rooms, type Db } from '@dorkos/db';
import { isExternalNaturalKey } from '../../rooms/author-registry.js';
import type { Change, GatherContext, Gatherer } from './types.js';
import { entryMarksOf } from '../../core/turn-power/turn-levels.js';
import { hasMarks, parseStoredMarks, type TurnMarks } from '../../core/turn-power/turn-marks.js';

/** How far back a first beat looks, with no last beat to measure from. */
const FIRST_BEAT_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** At most this many entries are read per beat. */
const READ_LIMIT = 500;

/**
 * Parse a stored JSON array of author ids, or nothing.
 *
 * @param raw - The `mentions` column.
 */
function mentionIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** One room the agent sits in. */
interface Seat {
  roomId: string;
  kind: string;
  title: string;
}

/** One entry, as the gatherer reads it. */
interface ReadEntry {
  id: string;
  roomId: string;
  seq: number;
  authorId: string;
  mentions: string;
  turnMarks: string | null;
  createdAt: string;
  authorKind: string;
  naturalKey: string;
  authorName: string;
}

/**
 * The agent's author ids and the rooms it sits in.
 *
 * @param db - The database.
 * @param agentPath - Its home directory.
 */
function seatsOf(db: Db, agentPath: string): { own: string[]; rooms: Map<string, Seat> } {
  const own = db
    .select({ id: authors.id })
    .from(authors)
    .where(and(eq(authors.kind, 'agent'), eq(authors.naturalKey, agentPath)))
    .all()
    .map((row) => row.id);
  if (own.length === 0) return { own, rooms: new Map() };
  const seats = db
    .select({ roomId: roomMembers.roomId, kind: rooms.kind, title: rooms.title })
    .from(roomMembers)
    .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
    .where(inArray(roomMembers.authorId, own))
    .all();
  return { own, rooms: new Map(seats.map((seat) => [seat.roomId, seat])) };
}

/**
 * The newest posts in those rooms since a moment, returned oldest first, so a
 * busy day keeps the latest messages rather than the morning's.
 *
 * @param db - The database.
 * @param roomIds - The rooms.
 * @param since - The window's start.
 */
function recentPosts(db: Db, roomIds: string[], since: string): ReadEntry[] {
  return db
    .select({
      id: roomEntries.id,
      roomId: roomEntries.roomId,
      seq: roomEntries.seq,
      authorId: roomEntries.authorId,
      mentions: roomEntries.mentions,
      turnMarks: roomEntries.turnMarks,
      createdAt: roomEntries.createdAt,
      authorKind: authors.kind,
      naturalKey: authors.naturalKey,
      authorName: authors.displayName,
    })
    .from(roomEntries)
    .innerJoin(authors, eq(authors.id, roomEntries.authorId))
    .where(
      and(
        inArray(roomEntries.roomId, roomIds),
        gt(roomEntries.createdAt, since),
        eq(roomEntries.kind, 'post'),
        ne(authors.kind, 'system')
      )
    )
    .orderBy(desc(roomEntries.createdAt), desc(roomEntries.seq))
    .limit(READ_LIMIT)
    .all()
    .reverse();
}

/**
 * Whether an entry is a local message to the agent it has not answered.
 *
 * @param entry - The entry.
 * @param seat - Its room.
 * @param own - The agent's author ids.
 * @param lastOwnSeq - The agent's latest post per room.
 */
function isUnanswered(
  entry: ReadEntry,
  seat: Seat,
  own: string[],
  lastOwnSeq: Map<string, number>
): boolean {
  if (own.includes(entry.authorId)) return false;
  // Strangers never shape a beat (§3.3).
  if (isExternalNaturalKey(entry.naturalKey)) return false;
  const addressed = seat.kind === 'dm' || mentionIds(entry.mentions).some((id) => own.includes(id));
  return addressed && (lastOwnSeq.get(entry.roomId) ?? 0) <= entry.seq;
}

/**
 * The change for one unanswered entry: who, where and when, never the words.
 *
 * @param entry - The entry.
 * @param seat - Its room.
 */
function changeFor(entry: ReadEntry, seat: Seat): Change {
  const who = entry.authorName || (entry.authorKind === 'agent' ? 'An agent' : 'Someone');
  const where = seat.title ? `#${seat.title}` : `room ${entry.roomId}`;
  return {
    gatherer: 'addressed',
    key: `room-entry:${entry.id}`,
    summary:
      seat.kind === 'dm'
        ? `${who} wrote to you directly (room ${entry.roomId}).`
        : `${who} mentioned you in ${where}.`,
    at: entry.createdAt,
    ref: { kind: 'room-entry', id: entry.id },
    signal: 'unanswered',
    ...marksField(entry),
  };
}

/**
 * The marks a post was written under, as the change carries them (DOR-3036): from its kept level,
 * else from its row. A beat reading a marked post is a marked turn.
 *
 * @param entry - The entry.
 */
function marksField(entry: ReadEntry): { marks?: TurnMarks } {
  const marks =
    entryMarksOf(entry.id) ?? (entry.turnMarks ? parseStoredMarks(entry.turnMarks) : null);
  return marks && hasMarks(marks) ? { marks } : {};
}

/**
 * Build the gatherer over the rooms tables.
 *
 * @param db - The server's database.
 */
export function createAddressedGatherer(db: Db): Gatherer {
  return async (ctx: GatherContext): Promise<Change[]> => {
    const { own, rooms: seats } = seatsOf(db, ctx.agent.projectPath);
    if (seats.size === 0) return [];
    const since = ctx.since ?? new Date(ctx.now.getTime() - FIRST_BEAT_LOOKBACK_MS).toISOString();
    const entries = recentPosts(db, [...seats.keys()], since);
    // Anything the agent said in a room after a message answers it.
    const lastOwnSeq = new Map<string, number>();
    for (const entry of entries) {
      if (own.includes(entry.authorId)) {
        lastOwnSeq.set(entry.roomId, Math.max(lastOwnSeq.get(entry.roomId) ?? 0, entry.seq));
      }
    }
    return entries.flatMap((entry) => {
      const seat = seats.get(entry.roomId);
      return seat && isUnanswered(entry, seat, own, lastOwnSeq) ? [changeFor(entry, seat)] : [];
    });
  };
}
