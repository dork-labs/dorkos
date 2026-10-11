/**
 * Audit rows as a reader may see them, where a row points into a session
 * (spec `audit-trail` §3.4).
 *
 * An action an agent took inside a person's own chat is a `space` row: every
 * member may read WHAT was done. Where it was done is the private part. So for
 * a reader who may not read that session, the row loses its session pointer
 * (`source.sessionId`, `turnId`, `toolCallId`) and `audit_get` leaves the
 * session link off; a row whose TARGET is such a session (stopping a chat)
 * loses its target, id and title alike; a `sessionId` filter naming such a
 * session answers an empty page, exactly as a session that does not exist, and
 * a `targetId` filter never matches one. Nothing here confirms a private chat
 * exists.
 *
 * The owner reads every session, so nothing is looked up for them.
 *
 * @module services/audit/audit-session-scrub
 */
import type {
  AuditEvent,
  AuditGetResult,
  AuditQuery,
  AuditQueryResult,
  AuditTimelineQuery,
} from '@dorkos/shared/audit-schemas';
import type { AuditLog } from './audit-log.js';
import type { AuditReader } from './visibility.js';

/** The subset of these sessions the reader may read. */
export type ReadableSessions = (sessionIds: readonly string[]) => ReadonlySet<string>;

/** The fields that place a row inside one session. */
const SESSION_FIELDS = ['sessionId', 'turnId', 'toolCallId'] as const;

/** The event without its session pointer. */
function withoutSession(event: AuditEvent): AuditEvent {
  const source = { ...event.source };
  for (const field of SESSION_FIELDS) delete source[field];
  return { ...event, source };
}

/** The session a row acted ON, when its target is one. */
function targetSessionOf(event: AuditEvent): string | undefined {
  return event.target?.type === 'session' ? event.target.id : undefined;
}

/** Every session a row points into, by where it happened or what it acted on. */
function sessionsOf(event: AuditEvent): string[] {
  const target = targetSessionOf(event);
  return [event.source.sessionId, target].filter((id): id is string => !!id);
}

/** The event as a reader with only `open` sessions may see it. */
function scrubEvent(event: AuditEvent, open: ReadonlySet<string>): AuditEvent {
  let seen = event;
  if (seen.source.sessionId && !open.has(seen.source.sessionId)) seen = withoutSession(seen);
  const target = targetSessionOf(seen);
  if (target && !open.has(target)) seen = { ...seen, target: null };
  return seen;
}

/** A page of rows as `reader` may see it. */
function scrubPage(
  reader: AuditReader,
  result: AuditQueryResult,
  readable: ReadableSessions,
  targetId?: string
): AuditQueryResult {
  if (reader.kind === 'owner') return result;
  const sessions = [...new Set(result.events.flatMap(sessionsOf))];
  if (sessions.length === 0) return result;
  const open = readable(sessions);
  const events = result.events
    // A `targetId` filter that matched a private chat matched nothing.
    .filter((event) => {
      const target = targetSessionOf(event);
      return !(targetId && target === targetId && !open.has(target));
    })
    .map((event) => scrubEvent(event, open));
  // A page that filter emptied is the last one: a cursor beside no rows would
  // say rows matched, which is the one thing a private chat must not confirm.
  if (events.length === 0 && result.events.length > 0) return { events };
  return { ...result, events };
}

/** Whether a `sessionId` filter names a session `reader` may not read. */
function filtersUnreadableSession(
  reader: AuditReader,
  sessionId: string | undefined,
  readable: ReadableSessions
): boolean {
  if (reader.kind === 'owner' || !sessionId) return false;
  return !readable([sessionId]).has(sessionId);
}

/** What the reads below need of the log. */
type AuditReads = Pick<AuditLog, 'query' | 'timeline' | 'getWithLinks'>;

/**
 * `audit_query` / `GET /api/audit`, as `reader` may see it.
 *
 * @param log - The audit log.
 * @param query - The filters.
 * @param reader - Who is reading.
 * @param readable - Which sessions the reader may read.
 */
export function readAuditQuery(
  log: AuditReads,
  query: AuditQuery,
  reader: AuditReader,
  readable: ReadableSessions
): AuditQueryResult {
  if (filtersUnreadableSession(reader, query.sessionId, readable)) return { events: [] };
  return scrubPage(reader, log.query(query, reader), readable, query.targetId);
}

/**
 * `account_timeline`, as `reader` may see it.
 *
 * @param log - The audit log.
 * @param query - The account and filters.
 * @param reader - Who is reading.
 * @param readable - Which sessions the reader may read.
 */
export function readAuditTimeline(
  log: AuditReads,
  query: AuditTimelineQuery,
  reader: AuditReader,
  readable: ReadableSessions
): AuditQueryResult {
  if (filtersUnreadableSession(reader, query.sessionId, readable)) return { events: [] };
  return scrubPage(reader, log.timeline(query, reader), readable);
}

/**
 * `audit_get` / `GET /api/audit/:id`, as `reader` may see it: no session
 * pointer and no session link for a session the reader may not read.
 *
 * @param log - The audit log.
 * @param id - The event id.
 * @param reader - Who is reading.
 * @param readable - Which sessions the reader may read.
 * @returns The row with its links, or `undefined` when the reader may not see it.
 */
export function readAuditEvent(
  log: AuditReads,
  id: string,
  reader: AuditReader,
  readable: ReadableSessions
): AuditGetResult | undefined {
  const found = log.getWithLinks(id, reader, (sessionId) => readable([sessionId]).has(sessionId));
  if (!found || reader.kind === 'owner') return found;
  const sessions = sessionsOf(found.event);
  if (sessions.length === 0) return found;
  const open = readable(sessions);
  const event = scrubEvent(found.event, open);
  const sessionId = found.event.source.sessionId;
  if (!sessionId || open.has(sessionId)) return { ...found, event };
  const { session: _private, ...rest } = found;
  return { ...rest, event };
}
