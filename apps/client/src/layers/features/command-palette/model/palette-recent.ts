/**
 * What the palette shows before anything is typed — the command center's two
 * lists, as pure functions (design-decisions §15).
 *
 * **Continue** is what is live right now, and **Recent** is what you were last
 * in. Both are computed here rather than in a component so the ordering rules
 * can be asserted against a fixed corpus instead of a rendered tree.
 *
 * @module features/command-palette/model/palette-recent
 */
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type {
  SessionActivity,
  SessionLifecycle,
  SessionStatus,
} from '@dorkos/shared/session-stream';
import type { Session } from '@dorkos/shared/types';
import { humanOriginSessionIds } from '@/layers/entities/session';
import type { PaletteSessionItem } from './palette-sessions';

/**
 * How many rows Recent ever draws.
 *
 * A reading limit, not a fetch limit — the same reasoning (and the same number)
 * as the sidebar's "Jump back in": this is a shortcut back to what you were
 * doing, and a list long enough to need scanning is a list you have to scan.
 * Everything past it is one keystroke away, because typing searches the whole
 * window.
 */
export const MAX_PALETTE_RECENT = 8;

/** One live session, as the fleet-wide session-list store knows it. */
export interface ContinueEntry {
  /** The session that is live. */
  sessionId: string;
  /** Its coarse phase — what the verb ladder's top rung reads. */
  lifecycle: SessionLifecycle;
  /** The tool it most recently started, when the server knows one. */
  activity: SessionActivity | null;
}

/**
 * The sessions Continue is about: the human ones actually doing something.
 *
 * **Human-origin only, from the shared definition** ({@link
 * humanOriginSessionIds}, `design-decisions.md` §18). A scheduled run or a
 * room's own turn is an engine run under a thread already listed under its own
 * name, and Recent has always dropped it for that reason — so a Continue that
 * promoted the very session Recent suppressed made one dialog give two answers
 * about what is running (DOR-1137, audit D4). A blocked automated session still
 * reaches the operator, through Now, which reads no origin at all; what it does
 * not do is claim a first-class row in a list about where to go back to.
 *
 * Two lifecycles qualify and no others. `blocked` comes first because it is
 * waiting on a person and streaming is not — the same priority Now uses (BC-6)
 * — and within a lifecycle the id breaks the tie so the list cannot reshuffle
 * itself between renders while nothing has changed.
 *
 * Everything else is absent rather than dimmed. The store already prunes a
 * status the moment its session settles, so an idle session has no entry here
 * at all; a Continue row for something that finished would be the exact lie the
 * verb ladder exists to prevent.
 *
 * @param statuses - The session-list store's status map, keyed by session id.
 * @param sessions - Every session record the palette can see, the live stream's
 *   own map included. It is what supplies each id's origin; an id no record
 *   covers is kept, on the same "unknown is not automated" rule the sidebar's
 *   working rollup follows.
 */
export function selectContinueEntries(
  statuses: Record<string, SessionStatus | undefined>,
  sessions: readonly Session[]
): ContinueEntry[] {
  const live = new Set(humanOriginSessionIds(Object.keys(statuses), sessions));
  const entries: ContinueEntry[] = [];
  for (const [sessionId, status] of Object.entries(statuses)) {
    if (!status) continue;
    if (!live.has(sessionId)) continue;
    if (status.lifecycle !== 'streaming' && status.lifecycle !== 'blocked') continue;
    entries.push({
      sessionId,
      lifecycle: status.lifecycle,
      activity: status.activity ?? null,
    });
  }
  return entries.sort((a, b) => {
    if (a.lifecycle !== b.lifecycle) return a.lifecycle === 'blocked' ? -1 : 1;
    return a.sessionId.localeCompare(b.sessionId);
  });
}

/** One row in Recent — a conversation, a room, or an agent. */
export type PaletteRecentEntry =
  | { kind: 'session'; key: string; lastActivityAt: string; session: PaletteSessionItem }
  | { kind: 'room'; key: string; lastActivityAt: string; room: RoomSummary }
  | { kind: 'agent'; key: string; lastActivityAt: string; agent: AgentPathEntry };

/** Inputs to {@link buildPaletteRecent}. */
export interface BuildPaletteRecentInput {
  /**
   * Conversations, most recent first. Automated runs must already be filtered
   * out by the caller (`partitionSessionsByOrigin`) — a room's own turn or a
   * scheduled run is an engine run under a thread that is already in this list
   * under its own name, so it never takes a row of its own. They stay
   * searchable; they just do not claim space in a list about where you were.
   */
  sessions: readonly PaletteSessionItem[];
  /** Every room the cockpit can see, archived ones included. */
  rooms: readonly RoomSummary[];
  /** Room ids with something waiting, from the palette's own unread list. */
  unreadRoomIds: ReadonlySet<string>;
  /** Every agent the cockpit can see. */
  agents: readonly AgentPathEntry[];
  /**
   * Each agent's latest session time, keyed by `projectPath` — the
   * `agentActivity` map `GET /api/sessions/recent` already returns. An agent
   * with no entry has never run anything this window can see, so it has no
   * "recent" to be, and is left out rather than sorted to the bottom.
   */
  agentActivity: Readonly<Record<string, string>>;
  /** Session ids already drawn under Continue, so nothing is listed twice. */
  excludeSessionIds?: ReadonlySet<string>;
  /** Row cap. Defaults to {@link MAX_PALETTE_RECENT}. */
  limit?: number;
}

/**
 * When a row was last active, as a number a sort can use.
 *
 * Parsed rather than string-compared: a session's `updatedAt`, a room's
 * `lastActivityAt` and an agent's activity stamp are all ISO-8601 from three
 * different code paths, and comparing spellings sorts by spelling. An
 * unparseable stamp sorts last rather than throwing — one bad row must not
 * empty the list.
 */
function activityMs(entry: PaletteRecentEntry): number {
  const parsed = Date.parse(entry.lastActivityAt);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Whether a room belongs in Recent at all.
 *
 * Three exclusions, for three reasons:
 *
 * - **Not joined** (`unreadCount === null`). A room you can see but are not in
 *   is not somewhere you have been — and `null` is not `0`.
 * - **Never used** (`lastActivityAt === createdAt`). A room nobody has spoken
 *   in has no "back" to go to; five channels made on Tuesday would otherwise
 *   fill the whole list.
 * - **Archived.** An archived room is findable by name — that is what
 *   `useRooms({ includeArchived })` bought — but a list of where you were is
 *   not where a closed channel argues for itself. Labeling archived results is
 *   task 3.4's job, and until it lands an unlabeled archived row here would be
 *   a row pretending to be live.
 */
function isRecentRoom(room: RoomSummary): boolean {
  if (room.unreadCount === null) return false;
  if (room.archived) return false;
  if (room.lastActivityAt === room.createdAt) return false;
  return true;
}

/**
 * One ordered list of the last things you were in, across types.
 *
 * **Unread rooms lead.** Everything else is a guess about what you might want
 * and an unread room is a fact about what is waiting — the same reasoning that
 * put unread rooms at the head of the untyped palette before this list existed
 * (spec `rooms` §13.2), kept alive inside the command center's shape.
 *
 * **After that it is recency, and only recency.** Frecency is the other half of
 * §15's rule and it is deliberately not here yet: the only frecency store that
 * exists today is agent-only (`use-agent-frecency.ts`), and the unified
 * `type:id` store is task 3.3's. Blending a half-store now would mean building
 * a ranking that 3.2's scorer deletes. Recency alone is honest in the meantime;
 * it is never a guess.
 *
 * **An agent whose own conversation is already listed is dropped.** The row
 * would open that same conversation (BC-34), so keeping both says one thing
 * twice in a list eight rows long.
 *
 * @param input - The three source lists, the unread set, and the row cap.
 */
export function buildPaletteRecent({
  sessions,
  rooms,
  unreadRoomIds,
  agents,
  agentActivity,
  excludeSessionIds = new Set<string>(),
  limit = MAX_PALETTE_RECENT,
}: BuildPaletteRecentInput): PaletteRecentEntry[] {
  const sessionEntries: PaletteRecentEntry[] = sessions
    .filter((session) => !excludeSessionIds.has(session.id))
    .map((session) => ({
      kind: 'session' as const,
      key: `session:${session.id}`,
      lastActivityAt: session.lastActivityAt,
      session,
    }));

  // Built from the UNFILTERED sessions, and that is the whole point of it.
  //
  // A conversation is excluded above because Continue is already drawing it —
  // which is the strongest possible reason to suppress its agent's row, not a
  // reason to forget the agent has a conversation at all. Reading this off
  // `sessionEntries` instead meant an agent with exactly one conversation, live
  // right now, appeared in Continue and again in Recent one row below: the
  // "one thing twice" this function exists to prevent, walked in from the
  // Continue side (BC-34).
  const listedCwds = new Set(sessions.flatMap((session) => (session.cwd ? [session.cwd] : [])));

  const roomEntries: PaletteRecentEntry[] = rooms.filter(isRecentRoom).map((room) => ({
    kind: 'room' as const,
    key: `room:${room.id}`,
    lastActivityAt: room.lastActivityAt,
    room,
  }));

  const agentEntries: PaletteRecentEntry[] = agents.flatMap((agent) => {
    if (listedCwds.has(agent.projectPath)) return [];
    const lastActivityAt = agentActivity[agent.projectPath];
    if (!lastActivityAt) return [];
    return [{ kind: 'agent' as const, key: `agent:${agent.projectPath}`, lastActivityAt, agent }];
  });

  const waiting: PaletteRecentEntry[] = [];
  const rest: PaletteRecentEntry[] = [];
  for (const entry of [...sessionEntries, ...roomEntries, ...agentEntries]) {
    if (entry.kind === 'room' && unreadRoomIds.has(entry.room.id)) waiting.push(entry);
    else rest.push(entry);
  }

  // Most recent first, with the key breaking a tie in the same direction the
  // sort runs — so two rows that tie never swap places between renders.
  const byRecency = (a: PaletteRecentEntry, b: PaletteRecentEntry) =>
    activityMs(b) - activityMs(a) || b.key.localeCompare(a.key);

  return [...waiting.sort(byRecency), ...rest.sort(byRecency)].slice(0, limit);
}
