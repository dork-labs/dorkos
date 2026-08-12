/**
 * The "Jump back in" model — one ordered list of the threads a person was last
 * in, whatever kind of thread each one is (spec `team-room-home` §D2.3).
 *
 * Pure and synchronous: it takes the two lists the cockpit already fetches (the
 * cross-agent recent sessions and the room list) and answers with rows. Nothing
 * here fetches, and nothing here renders — which is what lets the sidebar
 * section and the composer popover show the SAME list without a second query
 * path between them.
 *
 * @module entities/recents/lib/jump-back-in
 */
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { Session } from '@dorkos/shared/types';
import { interactionKey, type InteractionTimestamps } from '@/layers/entities/interactions';
import { hasUnread, roomDisplayTitle } from '@/layers/entities/room';
import { partitionSessionsByOrigin, sessionDisplayTitle } from '@/layers/entities/session';

/**
 * How many rows "Jump back in" ever shows.
 *
 * Eight is the spec's number and it is a reading limit, not a fetch limit: this
 * is a shortcut back to what you were doing, and a list long enough to scan is
 * a list you have to scan. Everything past it is still one click away in the
 * section it lives in.
 */
export const MAX_JUMP_BACK_IN = 8;

/**
 * What kind of thread a row points at.
 *
 * The two room kinds keep the server's own spelling (`RoomKind` is
 * `'channel' | 'dm'`) rather than collapsing to one `room` arm: a row draws a
 * `#` for one and a face for the other, and a second vocabulary for the same
 * distinction is one that drifts.
 */
export type JumpBackInKind = 'session' | 'dm' | 'channel';

/** What every row carries, whatever it points at. */
interface JumpBackInBase {
  /** Stable id of the thing this row opens — a session id, or a room id. */
  id: string;
  /**
   * What the thread is called, written the way a person says it — a session's
   * title, a conversation's title, `#general` for a channel.
   *
   * A surface that draws the room's own `#` mark beside this should render
   * `RoomTitle` instead of printing the name, or the reader gets `# #general`.
   * The prose form is what belongs in a tooltip, an `aria-label`, or any list
   * that carries no glyph.
   */
  name: string;
  /**
   * One line about the last thing that happened here, or `null` when there is
   * nothing honest to say. Never a placeholder: a row with no summary draws no
   * second line at all.
   */
  summary: string | null;
  /** When the thread was last active, ISO-8601, for relative rendering. */
  lastActivityAt: string;
}

/** A row that opens a session. */
export interface JumpBackInSessionItem extends JumpBackInBase {
  kind: 'session';
  /**
   * The session itself, so a row can draw its origin mark and a caller can
   * navigate with the `cwd` it needs. Carried rather than flattened because
   * every consumer of this model already speaks `Session`.
   */
  session: Session;
}

/** A row that opens a room — a channel or a direct message. */
export interface JumpBackInRoomItem extends JumpBackInBase {
  kind: 'dm' | 'channel';
  /** The room itself, so a row can draw its mark (`RoomAvatar` reads it whole). */
  room: RoomSummary;
}

/** One row in "Jump back in". */
export type JumpBackInItem = JumpBackInSessionItem | JumpBackInRoomItem;

/** The merged model: what to show, and what is deliberately tucked away. */
export interface JumpBackInModel {
  /**
   * The rows, most recently touched by the OPERATOR first (see
   * {@link recencyMs}), deduped and capped.
   */
  items: JumpBackInItem[];
  /**
   * Sessions somebody else started — a room's own turn, a scheduled run, a
   * bridged chat, an agent calling an agent. Kept OUT of
   * {@link JumpBackInModel.items} and offered behind a reveal, because "jump
   * back in" means the threads you were in.
   */
  automated: JumpBackInSessionItem[];
}

/** Inputs to {@link mergeJumpBackIn}. */
export interface MergeJumpBackInInput {
  /**
   * Recent sessions across every agent, as `useRecentSessions` returns them.
   *
   * Fetch MORE of these than the row cap. Room turns and other automated runs
   * are filtered out of the rows after the server has already truncated the
   * list, so a window the size of the cap can arrive holding nothing but runs
   * and starve the visible list — see {@link useJumpBackIn}, which asks for
   * three times the cap.
   */
  sessions: readonly Session[];
  /** Every room this cockpit can see, as `useRooms` returns them. */
  rooms: readonly RoomSummary[];
  /**
   * Room ids the operator has muted (`ui.sidebar.muted`). Muted rooms are
   * dropped entirely rather than dimmed: mute means "stop pulling me back into
   * this", and a shortcut whose whole job is to pull you back into things has
   * no quieter way to honour that. The room keeps its row in its own section,
   * dimmed, exactly as before.
   */
  mutedRoomIds?: ReadonlySet<string>;
  /**
   * When the operator themselves last opened each thread, keyed `<kind>:<id>`
   * (`entities/interactions`). The list's ordering key (BC-16).
   *
   * Absent means "nothing recorded on this device", which is the honest state
   * of a browser that has never been used here — and the list then falls back
   * to activity recency rather than coming back empty. See {@link recencyMs}.
   */
  interactions?: InteractionTimestamps;
  /** Row cap. Defaults to {@link MAX_JUMP_BACK_IN}. */
  limit?: number;
}

/**
 * Collapse a blob of text to the one line a row can hold.
 *
 * Returns `null` for anything empty, so an absent summary and a whitespace-only
 * one are the same fact to a row rather than two.
 */
function oneLine(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length === 0 ? null : collapsed;
}

/**
 * What a room row says under its name.
 *
 * Unread comes first because it is the reason a person is looking at this list
 * at all; live work comes next because it is true only right now; the topic is
 * the standing description and the weakest of the three, so it is what a quiet,
 * caught-up channel falls back to.
 *
 * There is deliberately no last-message preview: `GET /api/rooms` does not
 * carry one, and fetching a room's tail per row would be a request per row for
 * a line nobody asked for. When the list route grows a preview, it belongs
 * here, above the unread count.
 */
function roomSummaryLine(room: RoomSummary): string | null {
  if (hasUnread(room)) {
    const count = room.unreadCount ?? 0;
    return count === 1 ? '1 new message' : `${count} new messages`;
  }
  const working = room.working ?? 0;
  if (working > 0) return working === 1 ? '1 agent working' : `${working} agents working`;
  return oneLine(room.topic);
}

/** Turn one session into a row. */
function sessionItem(session: Session): JumpBackInSessionItem {
  return {
    kind: 'session',
    id: session.id,
    name: sessionDisplayTitle(session.title),
    summary: oneLine(session.lastMessagePreview),
    lastActivityAt: session.updatedAt,
    session,
  };
}

/** Turn one room into a row. */
function roomItem(room: RoomSummary): JumpBackInRoomItem {
  return {
    kind: room.kind === 'dm' ? 'dm' : 'channel',
    id: room.id,
    name: roomDisplayTitle(room),
    summary: roomSummaryLine(room),
    lastActivityAt: room.lastActivityAt,
    room,
  };
}

/**
 * An ISO-8601 instant as a number a sort can use, or `null` when there is
 * nothing parseable.
 *
 * Parsed rather than string-compared: a session's `updatedAt` and a room's
 * `lastActivityAt` are both ISO-8601 but are produced by different code paths,
 * and comparing `2026-08-08T10:00:00Z` against `2026-08-08T10:00:00.000+00:00`
 * as strings answers with whichever spelling sorts first.
 */
function epochMs(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The interaction-store key for one row: a session is `session:<id>`, and both
 * room kinds are `room:<id>`.
 *
 * A direct message is a room whose `kind` is `'dm'`, so it is keyed exactly
 * like a channel — the same rule the read cursors follow. Inventing a `dm:`
 * namespace here would split one conversation's history across two keys that
 * each look right.
 *
 * @param item - The row.
 */
function interactionKeyOf(item: JumpBackInItem): string {
  return item.kind === 'session'
    ? interactionKey('session', item.id)
    : interactionKey('room', item.id);
}

/**
 * The instant this row is ordered by — **when the OPERATOR last touched it**
 * (BC-16), falling back to when it was last active.
 *
 * The fallback is the honest half, not a loophole. A row the operator has never
 * opened on this device has no interaction record, and ordering every such row
 * as "never" would show a person who has just switched machines an
 * alphabetical-by-tiebreak list of their own work. So a row with a record is
 * placed by the record — an agent posting in a channel cannot move it — and a
 * row without one keeps the activity ordering this list has always used.
 *
 * The other half of BC-16's key, `userLastMessageAt`, has no source on the wire
 * yet (spec §F makes it an additive, optional field on `GET
 * /api/sessions/recent`). When it arrives it joins the `Math.max` here; until
 * then the interaction record alone governs — omission, never a guess.
 *
 * An unparseable timestamp sorts last rather than throwing: one bad row must
 * not empty the list.
 *
 * @param item - The row.
 * @param interactions - When the operator last opened each thread.
 */
function recencyMs(item: JumpBackInItem, interactions: InteractionTimestamps): number {
  const opened = epochMs(interactions[interactionKeyOf(item)]);
  if (opened !== null) return opened;
  return epochMs(item.lastActivityAt) ?? Number.NEGATIVE_INFINITY;
}

/**
 * Most recent first, with the id breaking a tie descending — the same direction
 * the sort itself runs, so two rows that tie never swap places between renders.
 *
 * @param interactions - When the operator last opened each thread.
 */
function byRecency(interactions: InteractionTimestamps) {
  return (a: JumpBackInItem, b: JumpBackInItem): number =>
    recencyMs(b, interactions) - recencyMs(a, interactions) || b.id.localeCompare(a.id);
}

/** Drop repeats, keeping the first (most recent) occurrence of each thread. */
function dedupe(items: JumpBackInItem[]): JumpBackInItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Whether a room belongs in the shortcut at all.
 *
 * Three rooms are dropped, for three different reasons:
 *
 * - **Muted.** Mute means "stop pulling me back into this", and this list's
 *   entire job is pulling you back into things.
 * - **Not joined** (`unreadCount === null`). A room you can SEE but are not in
 *   is not somewhere you have been; that is what `null` means, and it is not
 *   zero (see {@link RoomSummary}).
 * - **Never used** (`lastActivityAt === createdAt`). A room nobody has said
 *   anything in yet has no "back" to jump to — creating five channels on
 *   Tuesday would otherwise fill the whole list with rooms you have never
 *   opened, pushing out the work you were actually doing.
 */
function isJumpBackInRoom(room: RoomSummary, mutedRoomIds: ReadonlySet<string>): boolean {
  if (mutedRoomIds.has(room.id)) return false;
  if (room.unreadCount === null) return false;
  if (room.lastActivityAt === room.createdAt) return false;
  return true;
}

/**
 * Merge sessions and rooms into one ordered, deduped, capped list.
 *
 * **One row per thread, and the origin is what decides.** A session somebody
 * else started — a room's own turn, a scheduled run, a Telegram message, one
 * agent calling another — is an engine run under a thread that is already in
 * this list under its own name, so it never gets a row of its own; it goes to
 * {@link JumpBackInModel.automated} instead.
 *
 * That is the whole dedupe, and it rests entirely on the origin being TRUE.
 * A room turn carries no marker in its own transcript, so the server assigns
 * `origin: 'room'` from the `room_sessions` binding on the way out
 * (`services/session/origin/room-origin-overlay.ts`). Without that overlay a room and
 * its turn are two indistinguishable rows and both are drawn — which is exactly
 * what shipped in review. Nothing here can recover from a missing origin:
 * the key namespaces (`session:` / `channel:`) can never collide, so the
 * `dedupe` pass below removes repeats of the SAME thing and never a room and
 * its run.
 *
 * Empty in, empty out — no source is required to have anything in it, and a
 * caller with nothing to show gets an empty list rather than a shape it has to
 * special-case.
 *
 * @param input - The two source lists, the muted set, and an optional row cap.
 */
export function mergeJumpBackIn({
  sessions,
  rooms,
  mutedRoomIds = new Set<string>(),
  interactions = {},
  limit = MAX_JUMP_BACK_IN,
}: MergeJumpBackInInput): JumpBackInModel {
  const { conversations, automated } = partitionSessionsByOrigin([...sessions]);
  const order = byRecency(interactions);
  const merged = [
    ...conversations.map(sessionItem),
    ...rooms.filter((room) => isJumpBackInRoom(room, mutedRoomIds)).map(roomItem),
  ].sort(order);

  return {
    items: dedupe(merged).slice(0, limit),
    automated: automated.map(sessionItem).sort(order).slice(0, limit),
  };
}
