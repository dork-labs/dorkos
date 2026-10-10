/**
 * Who may read a session's transcript (spec `audit-trail` §3.4).
 *
 * The answer is decided by what started the session, which the binding write
 * stores once and never changes (`session_metadata.launch_origin`, written
 * first-write-wins by `RuntimeRegistry.persistSessionRuntime` and read through
 * `readSessionLaunchOrigins`), mapped by the exhaustive
 * `sessionVisibilityForOrigin`. A room turn is the one origin that does not
 * decide by itself: a team channel is agent work, a person's DM with an agent
 * or a chat bridged from Telegram or Slack is that person's own, so the ROOM it
 * answers in decides (`resolveRoomSessionVisibility`). A session with no stored
 * origin (bound before the column existed, or a conversation held in a
 * runtime's own command-line tool that DorkOS never ran) falls back to the
 * origin overlays: a room binding decides as above, and a task run or a
 * recorded starter means the session is agent work. Anything else is private.
 * Unknown is private.
 *
 * Only two classes exist for sessions today: `space` (every member) and
 * `participants` (a person's own chat; the owner, while a space has one
 * person). Whether a reader may read one is {@link canRead}'s answer, the same
 * rule the audit rows are read under: an agent reads `space` sessions and no
 * other, with the one narrow exception {@link canReadSession} documents.
 *
 * The process-wide resolver is set once at startup ({@link initSessionVisibility});
 * before that, and in a unit test that never sets one, every session is
 * private, which refuses agents and changes nothing for the owner.
 *
 * @module services/audit/session-visibility
 */
import type { ResolveTaskOrigins } from '../session/origin/task-origin-overlay.js';
import type { ResolveStartedBy } from '../session/origin/started-by-origin-overlay.js';
import { sessionVisibilityForOrigin } from '../session/origin/turn-origin.js';
import type { TurnOrigin } from '../session/origin/turn-origin.js';
import { chunked, SQL_IN_CHUNK } from '@dorkos/db';
import { canRead, type AuditReader } from './visibility.js';

/**
 * Who may read a session: every member (`space`), its person alone
 * (`participants`), or the agent members of the room it answers in.
 */
export type SessionVisibility = 'space' | 'participants' | { readonly members: readonly string[] };

/**
 * What the rule reads. Every overlay is optional: a missing one decides
 * nothing, so a room turn read without the room lookup is private.
 */
export interface SessionVisibilityDeps {
  /** The stored origin kind of each session that has one, in one query. */
  launchOriginsOf: (sessionIds: readonly string[]) => ReadonlyMap<string, string>;
  /** Who may read each room-bound session, decided by its room; absent when rooms are off. */
  resolveRoomVisibility?:
    ((sessionIds: readonly string[]) => ReadonlyMap<string, SessionVisibility>) | undefined;
  /** Task runs; absent when tasks are off. */
  resolveTaskOrigins?: ResolveTaskOrigins | undefined;
  /** Recorded starters (`session_started_by`). */
  resolveStartedBy?: ResolveStartedBy | undefined;
}

/**
 * Every origin kind this build knows. A `Record` over the union, so a new
 * origin does not compile until it is listed here as well as decided in
 * `sessionVisibilityForOrigin`.
 */
const KNOWN_KINDS: Record<TurnOrigin['kind'], true> = {
  interactive: true,
  room: true,
  schedule: true,
  'relay-binding': true,
  'agent-dm': true,
  'outside-sender': true,
  'connector-event': true,
  'agent-launch': true,
  'extension-start': true,
  'extension-message': true,
  'chat-message': true,
  'account-handoff': true,
  'account-resume': true,
  'test-harness': true,
};

/** A stored origin string, narrowed to a kind this build knows. */
function asKind(stored: string | null): TurnOrigin['kind'] | undefined {
  return stored !== null && Object.hasOwn(KNOWN_KINDS, stored)
    ? (stored as TurnOrigin['kind'])
    : undefined;
}

/**
 * How many ids one lookup binds at most: every lookup is one `IN (...)` query,
 * and SQLite caps the variables one statement may bind.
 */
export const SESSION_LOOKUP_CHUNK = SQL_IN_CHUNK;

/**
 * Who may read each of `sessionIds`.
 *
 * @param sessionIds - The sessions to classify.
 * @param deps - The stored origin and the overlay lookups.
 * @returns One answer per id.
 */
export function sessionVisibilities(
  sessionIds: readonly string[],
  deps: SessionVisibilityDeps
): Map<string, SessionVisibility> {
  return classify(sessionIds, deps, 0);
}

/** How many carry-overs in a row {@link classify} follows back to the first chat. */
const MAX_CARRY_HOPS = 4;

/** {@link sessionVisibilities}, `hops` carry-overs away from the asked-for session. */
function classify(
  sessionIds: readonly string[],
  deps: SessionVisibilityDeps,
  hops: number
): Map<string, SessionVisibility> {
  const answers = new Map<string, SessionVisibility>();
  for (const chunk of chunked(sessionIds, SESSION_LOOKUP_CHUNK)) {
    classifyChunk(chunk, deps, answers, hops);
  }
  return answers;
}

/** {@link sessionVisibilities} for one chunk, written into `answers`. */
function classifyChunk(
  sessionIds: readonly string[],
  deps: SessionVisibilityDeps,
  answers: Map<string, SessionVisibility>,
  hops: number
): void {
  const stored = deps.launchOriginsOf(sessionIds);
  const roomBound = new Set<string>();
  const carried: string[] = [];
  const undecided: string[] = [];
  for (const id of sessionIds) {
    const kind = asKind(stored.get(id) ?? null);
    if (kind === 'room') roomBound.add(id);
    else if (kind === 'account-handoff') carried.push(id);
    else if (kind) answers.set(id, sessionVisibilityForOrigin(kind));
    else undecided.push(id);
  }
  classifyCarried(carried, deps, answers, hops);
  const roomIds = [...roomBound, ...undecided];
  const rooms = roomIds.length > 0 ? deps.resolveRoomVisibility?.(roomIds) : undefined;
  // A room turn's room decides; a room turn whose room is gone, or read
  // without the room lookup, is unknown, and unknown is private.
  for (const id of roomBound) answers.set(id, rooms?.get(id) ?? 'participants');
  const unbound = undecided.filter((id) => {
    const room = rooms?.get(id);
    if (room) answers.set(id, room);
    return room === undefined;
  });
  if (unbound.length === 0) return;
  const tasks = deps.resolveTaskOrigins?.(unbound);
  const starters = deps.resolveStartedBy?.(unbound);
  for (const id of unbound) {
    const agentWork = tasks?.has(id) || starters?.has(id);
    answers.set(id, agentWork ? 'space' : 'participants');
  }
}

/**
 * A chat carried over to another account continues the chat it replaced, so it
 * is read as that one was. Its `session_started_by` row says which (a
 * `carried` start); a carry-over with none, a person's own chat moved to
 * another account, keeps the cautious private answer.
 */
function classifyCarried(
  carried: readonly string[],
  deps: SessionVisibilityDeps,
  answers: Map<string, SessionVisibility>,
  hops: number
): void {
  if (carried.length === 0) return;
  const starts = hops < MAX_CARRY_HOPS ? deps.resolveStartedBy?.([...carried]) : undefined;
  const sourceOf = new Map<string, string>();
  for (const id of carried) {
    const start = starts?.get(id);
    if (start?.carried && start.startedBySessionId) sourceOf.set(id, start.startedBySessionId);
    else answers.set(id, sessionVisibilityForOrigin('account-handoff'));
  }
  const sources = classify([...new Set(sourceOf.values())], deps, hops + 1);
  for (const [id, source] of sourceOf) answers.set(id, sources.get(source) ?? 'participants');
}

/** The batched lookup: who may read each of these sessions. */
export type SessionVisibilitiesOf = (
  sessionIds: readonly string[]
) => Map<string, SessionVisibility>;

let resolver: SessionVisibilitiesOf | undefined;

/**
 * Set the process-wide lookup, once, at startup.
 *
 * @param lookup - The batched lookup, usually {@link sessionVisibilities} bound
 *   to the runtime registry and the origin overlays.
 */
export function initSessionVisibility(lookup: SessionVisibilitiesOf): void {
  resolver = lookup;
}

/** Forget the process-wide lookup. For tests. */
export function resetSessionVisibility(): void {
  resolver = undefined;
}

/**
 * Who may read each of `sessionIds`, through the process-wide lookup. With
 * none set, every session is private.
 *
 * @param sessionIds - The sessions.
 */
export function readSessionVisibilities(
  sessionIds: readonly string[]
): Map<string, SessionVisibility> {
  if (resolver) return resolver(sessionIds);
  return new Map(sessionIds.map((id) => [id, 'participants' as const]));
}

/**
 * How a private session has involved the chat that wants to read it.
 *
 * Only a reading CHAT can be involved (`chat_read`); every other read path
 * passes none.
 */
export interface SessionInvolvement {
  /** The session started the reading chat (`session_started_by`). */
  startedReader: boolean;
}

/**
 * Whether `reader` may read a session of this visibility: {@link canRead},
 * with a session standing in for a row. A private session names its person as
 * the participant, never an agent, so no agent is ever in it.
 *
 * A room session names its agent members, so only they read it.
 *
 * **The one exception (spec `audit-trail` §3.4, spec `spin-off-chats` §4).** A
 * person's own chat that STARTED a chat has chosen to involve it, so that chat
 * may read it back: a spin-off reads the conversation it was spun off from.
 * Nothing else widens it. A message is not enough: any chat can message a
 * person's chat and draw a reply, and that must not open the person's whole
 * history; the reader already holds what was sent to it. Another agent, a
 * sibling spin-off, a chat the private one messaged or was sent to, or a chat
 * further down the chain is refused.
 *
 * @param reader - Who is reading.
 * @param visibility - The session's class.
 * @param involvedBy - How the session involved the reading chat, when the
 *   reader is a chat (`chat_read`); omitted everywhere else.
 */
export function canReadSession(
  reader: AuditReader,
  visibility: SessionVisibility,
  involvedBy?: SessionInvolvement
): boolean {
  const row =
    typeof visibility === 'string'
      ? { visibility, participants: undefined }
      : { visibility: 'participants' as const, participants: [...visibility.members] };
  if (canRead(reader, row)) return true;
  return involvedBy?.startedReader === true;
}

/**
 * The subset of `sessionIds` that `reader` may read. Everything, without a
 * lookup, for the owner.
 *
 * @param reader - Who is reading.
 * @param sessionIds - The candidates.
 */
export function readableSessionIds(
  reader: AuditReader,
  sessionIds: readonly string[]
): Set<string> {
  if (reader.kind === 'owner') return new Set(sessionIds);
  const readable = new Set<string>();
  for (const [id, visibility] of readSessionVisibilities(sessionIds)) {
    if (canReadSession(reader, visibility)) readable.add(id);
  }
  return readable;
}

/**
 * Which live-stream connections may hear about a session (`GET /api/events`,
 * over SSE and WebSocket): every connection but an agent's, and an agent's only
 * when it may read the session. A person's own chat, its title included, never
 * reaches an agent's stream. Looked up at most once per frame, on the first
 * agent connection.
 *
 * A stream connection does not say WHICH agent it is, so it stands in as an
 * unnamed one: it hears about agent work open to every member, and never about
 * a person's own chat or a room session (only named members read those).
 *
 * @param sessionId - The session the frame is about.
 */
export function sessionAudience(sessionId: string): (principal: { kind: string }) => boolean {
  let agentMayRead: boolean | undefined;
  return (principal) => {
    if (principal.kind !== 'agent') return true;
    agentMayRead ??= readableSessionIds(ANY_AGENT, [sessionId]).has(sessionId);
    return agentMayRead;
  };
}

/** An agent reader with no name, as a stream connection is; see {@link sessionAudience}. */
const ANY_AGENT: AuditReader = { kind: 'agent', accountId: 'unidentified' };
