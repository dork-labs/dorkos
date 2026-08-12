/**
 * Sessions as palette rows — the one place a `Session` becomes something ⌘K can
 * draw and search (design-decisions §15).
 *
 * Until this landed, the palette could find agents, rooms, commands and
 * actions, and could not find a conversation at all: the biggest gap the ⌘K
 * audit named. The endpoint was already there and already used by the sidebar
 * (`GET /api/sessions/recent`); nothing in the palette ever asked it.
 *
 * Pure and synchronous, so the shape of a row is testable without a React tree
 * and the hook above it stays a wiring layer.
 *
 * @module features/command-palette/model/palette-sessions
 */
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { Session, SessionOrigin } from '@dorkos/shared/types';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { sessionDisplayTitle } from '@/layers/entities/session';

/**
 * How many recent sessions the palette asks the server for.
 *
 * Bigger than any list it draws, on purpose. The rows are capped for reading;
 * this window is what SEARCH looks through, and a person recalling a
 * conversation by name is usually reaching past the handful that would fit on
 * screen. Fifty is the route's own ceiling (`RecentSessionsQuerySchema`), so
 * asking for more would be rejected rather than truncated quietly.
 */
export const PALETTE_SESSION_WINDOW = 50;

/** One session, in the shape a palette row needs and nothing more. */
export interface PaletteSessionItem {
  /** The session id — the row's cmdk value, and what opening it navigates to. */
  id: string;
  /**
   * The agent that owns the session, as the row says it — the `who` half of
   * `Agent › title` (BC-23).
   *
   * `null` only when the session carries no directory at all. A directory no
   * registered agent claims still gets a name: its last path segment, which is
   * what the sidebar's own recents list falls back to.
   */
  who: string | null;
  /** What the conversation is called, never blank ({@link sessionDisplayTitle}). */
  title: string;
  /** The directory the session belongs to — travels with every open (DOR-928). */
  cwd: string | null;
  /**
   * The registered agent behind {@link who}, when there is one. Carried so a
   * row can draw that agent's own face rather than a hash of its path.
   */
  agent: AgentPathEntry | null;
  /** Where the session came from — drives the trailing origin mark (BC-26). */
  origin?: SessionOrigin;
  /** The session's own origin wording, when the server has better than the generic label. */
  originLabel?: string;
  /**
   * The room that started it, by id — what a room scope joins on
   * (`scopesOfSession`). Absent unless {@link PaletteSessionItem.origin}
   * is `room`, and absent on a record older than the field, which then falls
   * back to matching {@link PaletteSessionItem.originLabel} by name.
   */
  originRoomId?: string;
  /** When the session was last active, ISO-8601, for the row's relative time. */
  lastActivityAt: string;
  /**
   * Findable, but no longer today's business — the row says so (P3 AC-5).
   *
   * True when the conversation has had **no activity** since the cockpit's 4am
   * day boundary (`overnightBoundary`) — activity of any kind, an agent's own
   * writes included, read off `session.updatedAt`.
   *
   * **That is not the same measurement the sidebar makes, and the two can
   * disagree about one conversation.** Today's `archiveOvernight` retires a row
   * on YOUR last interaction with it — when you last opened or wrote to it,
   * with exemptions for the row you are standing on and anything that mentions
   * you by name. This reads the CONVERSATION's last activity. So an agent that
   * posted at 10:00 into a thread you last opened on Monday leaves Today and is
   * unlabelled here; a thread you opened at 09:00 whose last message is from
   * yesterday stays in Today and is labelled here.
   *
   * Both definitions are defensible for the surface that makes them — Today is
   * about what YOU are doing, recall is about what a THING is — and neither is
   * a bug. What is not claimed is that they are one fact. Aligning them is a
   * product decision nobody has taken; the shared boundary above is only the
   * hour, not the signal.
   *
   * design-decisions §15 is what puts the label here at all: "archived
   * overnight → find it in ⌘K" means by title and recency.
   *
   * **A label, never a demotion.** An archived ROOM is pushed below everything
   * live no matter what it scores, because somebody closed it. A conversation
   * from yesterday is not closed — it is most of what a person searches ⌘K FOR
   * — so demoting it would sink every conversation older than this morning
   * below every action and slash command in the list. It stays in the ranking
   * on its merits, where its own recency signal already puts it under an
   * equally-relevant live one (`palette-ranking`'s `RECENCY_WEIGHT`).
   */
  archived: boolean;
}

/**
 * Everything about a session a person might type to find it — except its
 * messages.
 *
 * **The exclusion is the design.** ⌘K finds things, not words: message content
 * is a separate surface (the ⌘K/⌘F split recorded in `specs/rooms` §13.2 and
 * `specs/message-search` §8). The preview field every session carries on the
 * wire is deliberately absent here, even though adding it would be one line. A
 * palette that quietly matched on the last thing an agent said would be a
 * content search nobody chose and nobody can switch off — which is why the
 * field's very NAME is banned from this feature's source, guarded by
 * `__tests__/no-message-search.test.ts`.
 *
 * @param item - The row to describe.
 */
export function paletteSessionKeywords(item: PaletteSessionItem): string[] {
  const keywords = [item.id];
  if (item.who) keywords.push(item.who);
  if (item.cwd) keywords.push(item.cwd);
  return keywords;
}

/**
 * The name a session's directory answers to when no registered agent claims it.
 *
 * The last path segment, which is how a person refers to a project they have
 * not registered — and `null` rather than an invented word when there is no
 * path either, so the row drops its `›` and reads as a place instead of
 * claiming an owner it does not have.
 */
function directoryName(cwd: string | null): string | null {
  if (!cwd) return null;
  const segment = cwd.split('/').filter(Boolean).pop();
  return segment ?? null;
}

/**
 * Turn the sessions the server returned into palette rows.
 *
 * The agent lookup is by `projectPath`, the same join the sidebar's recents
 * section makes: a session knows its `cwd` and an agent knows the directory it
 * lives in, and that pairing is the whole of session-to-agent attribution on
 * this client.
 *
 * @param sessions - Sessions, in the order the server gave them (recency).
 * @param agents - Every agent this cockpit can see.
 * @param archivedBefore - The cockpit's day boundary, epoch ms
 *   (`overnightBoundary`). Anything last active before it is labelled
 *   archived. Injected rather than read from a clock here, for the same reason
 *   the ranker takes its `now`: what a row says becomes assertable against a
 *   fixed corpus instead of against the hour the suite happens to run at.
 */
export function toPaletteSessionItems(
  sessions: readonly Session[],
  agents: readonly AgentPathEntry[],
  archivedBefore: number
): PaletteSessionItem[] {
  const byPath = new Map(agents.map((agent) => [agent.projectPath, agent]));
  return sessions.map((session) => {
    const cwd = session.cwd ?? null;
    const agent = cwd ? (byPath.get(cwd) ?? null) : null;
    // A timestamp the browser cannot parse is NOT archived: an unreadable date
    // is a thing this client knows nothing about, and labelling it would be
    // asserting a fact about a conversation on the strength of a parse failure.
    const lastActivity = Date.parse(session.updatedAt);
    return {
      id: session.id,
      who: agent ? getAgentDisplayName(agent) : directoryName(cwd),
      title: sessionDisplayTitle(session.title),
      cwd,
      agent,
      origin: session.origin,
      originLabel: session.originLabel,
      originRoomId: session.originRoomId,
      lastActivityAt: session.updatedAt,
      archived: !Number.isNaN(lastActivity) && lastActivity < archivedBefore,
    };
  });
}
