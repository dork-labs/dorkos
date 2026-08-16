/**
 * Turning everything this client knows about live work into the rows the
 * presence strip draws.
 *
 * Pure and hook-free, so the interesting cases — an agent nothing can name, a
 * room the list has not caught up on, one agent working in two places — are
 * settled by a function call rather than by staging a store.
 *
 * **The rule the whole module exists to keep: omit rather than lie.** Three
 * separate reads have to agree before an agent can be drawn — who it is, where
 * the work is, and where following it goes — and every one of them can be
 * missing. A missing WHO drops the row entirely: an avatar nobody can name is
 * not presence, it is a smudge. A missing WHERE drops the activity line and
 * keeps the name, because "this agent is working" is still true and still worth
 * saying. Nothing here ever substitutes a placeholder for either.
 *
 * @module features/presence-strip/lib/presence-rows
 */
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import {
  agentAuthorRef,
  type AuthorOrigin,
  type AuthorRef,
  type RoomSummary,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';
import {
  presenceDetail,
  presenceRow,
  roomDisplayTitle,
  type PresenceCopyState,
  type RoomPresenceClaim,
} from '@/layers/entities/room';
import { resolveAgentVisual, resolveIdentityFace, type IdentityFace } from '@/layers/shared/lib';

/**
 * What a room claim is bound to, in words.
 *
 * "Replying in" rather than "working in", because that is what a room claim
 * IS — the dispatcher took it to answer a trigger in that room, and it is
 * released when the reply lands (room-presence spec §3.3). A person reading it
 * can predict what will appear and where.
 *
 * @param roomTitle - The room's name as the rest of the cockpit prints it.
 */
function replyingIn(roomTitle: string): string {
  return `replying in ${roomTitle}`;
}

/**
 * What a running session is bound to, in words.
 *
 * Deliberately vague about WHAT the turn is doing, because nothing on this
 * client knows: a session's lifecycle says a turn is in flight and its working
 * directory says whose it is, and that is the whole of the truth available.
 * Naming a file or a tool here would be an invention.
 */
const WORKING_IN_SESSION = 'working in a session';

/** Following a row opens a room, as a reader. */
export interface PresenceFollowRoom {
  kind: 'room';
  /** The room to open. */
  roomId: string;
}

/** Following a row opens a session, as a watcher. */
export interface PresenceFollowSession {
  kind: 'session';
  /** The session to open. */
  sessionId: string;
  /**
   * The directory it is running in, carried so the session opens where it
   * actually lives.
   *
   * `/session` takes both, and it has to: a transcript is keyed by its
   * working directory, so a session id opened against the wrong one resolves to
   * a different conversation or to none (DOR-1004, the newborn-agent cwd race).
   */
  cwd: string;
}

/**
 * Where following one row goes.
 *
 * Both destinations are READS. Opening a room subscribes to its stream and
 * opening a session opens its transcript; neither posts, and neither takes the
 * session lock, which is only ever claimed by a write (`X-Client-Id` rides
 * `postMessage`, command intents and UI actions — nothing else). That is the
 * agent-etiquette rule made structural: you can watch anything from here and
 * interrupt nothing.
 */
export type PresenceFollowTarget = PresenceFollowRoom | PresenceFollowSession;

/** One agent on the strip: who it is, what it is doing, and where to watch. */
export interface PresenceRow {
  /** Stable key for React, unique across both halves of the strip. */
  id: string;
  /** The agent's display name. */
  name: string;
  /** Its `@handle`, when it has one. `null` is never rendered as a bare `@`. */
  handle: string | null;
  /** The disc to draw, already resolved. */
  face: IdentityFace;
  /** What it is bound to, in words, or `null` when nothing can truthfully say. */
  binding: string | null;
  /** Whether the wait is still ordinary, or has gone long. */
  state: PresenceCopyState;
  /**
   * When the work started (ISO 8601), or `null` when nothing measures it.
   *
   * An instant, not an age. The age is a function of the clock, so a row
   * carrying one would change every second and re-render the pinned header
   * with it; the leaf that draws a duration works it out for itself, and only
   * while somebody is looking at it.
   */
  since: string | null;
  /** The room this row is about, when it is about one — for the hover card. */
  roomTitle: string | null;
  /** The runtime the agent runs on, when the fleet knows it — for the hover card. */
  runtime: string | null;
  /**
   * The id the team roster files this agent under — what the hover card's
   * "View profile" opens — or `null` when nothing here can name one.
   *
   * The ONLY id on this row that addresses a profile. `id` above is a React key;
   * a room claim's `authorId` is a room fact in a different space entirely (see
   * `profileMemberIdOf`); and an agent's manifest id is what it calls itself on
   * disk, which the roster is not keyed by. This one comes from the mesh
   * registry — see {@link PresenceRowsInput.meshIdByPath}.
   *
   * `null` leaves the card's footer inert and marked **soon**, which is the
   * honest answer for work this client can see happening and cannot attribute
   * to a roster row.
   */
  profileMemberId: string | null;
  /** What the whole row says, for the accessible name. */
  line: string;
  /** What is drawn after the name, or `null` when there is nothing true to add. */
  detail: string | null;
  /** Where watching it goes. */
  follow: PresenceFollowTarget;
}

/** A session a runtime says is mid-turn, and the directory it is running in. */
export interface WorkingSession {
  /** The session id — what following it opens. */
  sessionId: string;
  /** The working directory the runtime reported for it. */
  cwd: string;
}

/** Everything the strip needs to know, gathered by the hook above it. */
export interface PresenceRowsInput {
  /** Live room claims, oldest first, from every room this client can hear. */
  claims: readonly RoomPresenceClaim[];
  /** Rooms whose roster is in hand, by id — the read that answers WHO. */
  rosters: Readonly<Record<string, RoomWithRoster>>;
  /** The room list, by id — the read that answers WHERE. */
  rooms: Readonly<Record<string, RoomSummary>>;
  /** Sessions the runtimes report as mid-turn, with the directory of each. */
  sessions: readonly WorkingSession[];
  /** Registered agents by project directory — the read that names a session. */
  agents: Readonly<Record<string, AgentManifest | null>>;
  /**
   * The id the TEAM roster files each agent under, by project directory — what
   * a profile opens on.
   *
   * A separate map from {@link PresenceRowsInput.agents} because it comes from a
   * different read and a different id space. `agents` is the on-disk manifest,
   * which names and dresses an agent; this is the mesh registry, which is what
   * `GET /api/team` keys its rows by. The manifest's own id usually agrees and
   * is not guaranteed to — a directory re-registered after its manifest was
   * rewritten keeps the registry row it had — so reading the id off the manifest
   * produced `?profile=<id nothing holds>` and a drawer that closed itself.
   *
   * A path absent here yields a row with no profile to open, which is honest:
   * this client can see the work and cannot name whose it is to the roster.
   */
  meshIdByPath: Readonly<Record<string, string>>;
  /**
   * Rooms whose work is already visible somewhere else on the page, and so
   * must not be repeated here.
   *
   * The case is the home surface: it IS the `#team` room, and that room draws
   * its own presence line under its composer. Without this the same agent
   * announces itself twice, three lines apart, in two different sentences.
   *
   * **Excluding happens INSIDE this function, and that is the whole point.**
   * Filtering the claims before they arrive would drop the room row and leave
   * the agent's streaming session unaccounted for — so the strip would draw the
   * SAME agent again through its coarser half, saying "working in a session"
   * about work the room below is already narrating. An excluded claim still
   * spends its agent's directory here; it just draws nothing.
   */
  excludeRoomIds?: readonly string[];
}

/** A roster member, reduced to the two things a face needs. */
interface RosterFace {
  author: AuthorRef;
  origin?: AuthorOrigin;
}

/**
 * Who is in a room, from whichever read got there first.
 *
 * A channel's roster rides its detail; a direct message carries its own on
 * every list row (`RoomSummary.participants` is `null` for a channel, never
 * `[]`), so a DM can be named without ever having been opened. Two sources for
 * one answer, and the strip takes whichever it has.
 */
function rosterOf(
  roomId: string,
  input: Pick<PresenceRowsInput, 'rosters' | 'rooms'>
): RosterFace[] {
  const detail = input.rosters[roomId];
  if (detail !== undefined) {
    return detail.members.map((member) => ({ author: member.author, origin: member.origin }));
  }
  const participants = input.rooms[roomId]?.participants;
  return participants === null || participants === undefined
    ? []
    : participants.map((author) => ({ author }));
}

/**
 * Index the fleet by the stable handle a room author carries.
 *
 * `AuthorRef.agentRef` is `agentAuthorRef(projectPath)` and its docs say to
 * compare that and never a display name — so this is how a room author becomes
 * the agent that owns it, for both the fresher face (a manifest's own colour
 * and emoji outrank the author row's render cache) and the de-duplication
 * below.
 */
function indexAgentsByRef(
  agents: PresenceRowsInput['agents']
): Map<string, { path: string; manifest: AgentManifest }> {
  const byRef = new Map<string, { path: string; manifest: AgentManifest }>();
  for (const [path, manifest] of Object.entries(agents)) {
    if (manifest === null) continue;
    byRef.set(agentAuthorRef(path), { path, manifest });
  }
  return byRef;
}

/** Assemble one row's words once, so the view never composes copy. */
function withCopy(row: Omit<PresenceRow, 'line' | 'detail'>): PresenceRow {
  return {
    ...row,
    line: presenceRow(row.name, row.binding, row.state),
    detail: presenceDetail(row.binding, row.state),
  };
}

/**
 * Build the strip's rows from every live signal this client holds.
 *
 * Two halves, in this order:
 *
 * 1. **Room claims** — an agent the dispatcher has taken a claim for, in a room
 *    this client is subscribed to. The most specific thing the cockpit can say
 *    about live work, so it goes first and it wins any tie.
 * 2. **Running sessions** — a session a runtime reports as mid-turn, in a
 *    directory that names a registered agent. Coarser: it says an agent is
 *    working and cannot say what about.
 *
 * **The halves overlap and the overlap is real, not theoretical.** A room turn
 * RUNS in a session, in the agent's own directory — so an agent replying in
 * `#team` is also a streaming session, and without the join below it would
 * appear twice, once saying where and once saying nothing. The join is on
 * `agentAuthorRef(projectPath)`, the handle both sides carry.
 *
 * The rule the join enforces, stated plainly: **the session half is suppressed
 * whenever the agent has ANY room claim** — including a claim that was
 * excluded, and including a claim in a room that has nothing to do with the
 * session. That is deliberate and it is the conservative direction: a session
 * this agent is running is more likely to BE the room turn than to be second,
 * unrelated work, and drawing it twice is the failure a reader notices. The
 * cost is that an agent genuinely doing two things at once is announced as the
 * one the cockpit can describe.
 *
 * **Two rooms are two rows, though.** The suppression is of the coarser half
 * only; an agent holding claims in `#team` and `#release-train` is drawn once
 * per room, because both rows say something specific and different, and a
 * person watching wants the one they care about.
 *
 * **What is dropped, and why each is a truth rather than a gap:**
 *
 * - A claim whose author is in no roster this client holds. Nothing can name
 *   it, and the room presence line's "An agent" fallback works there only
 *   because that line is already inside the room it is talking about.
 * - A session whose directory names no registered agent — the shape a runtime
 *   that reports lifecycle without a working directory leaves behind. Something
 *   is running and this client cannot say whose it is, so it says nothing.
 * - A claim in an excluded room, which draws no row but still spends its
 *   agent's directory — see {@link PresenceRowsInput.excludeRoomIds}.
 *
 * @param input - Every live read, already gathered. See {@link PresenceRowsInput}.
 * @returns The rows to draw, room claims first. Empty when nobody is working.
 */
export function buildPresenceRows(input: PresenceRowsInput): PresenceRow[] {
  const agentsByRef = indexAgentsByRef(input.agents);
  const excluded = new Set(input.excludeRoomIds ?? []);
  const rows: PresenceRow[] = [];
  /** Project paths already spoken for by a room claim — the join key. */
  const claimedPaths = new Set<string>();

  for (const claim of input.claims) {
    const member = rosterOf(claim.roomId, input).find(
      (entry) => entry.author.id === claim.authorId
    );
    if (member === undefined) continue;

    const agent =
      member.author.agentRef === undefined ? undefined : agentsByRef.get(member.author.agentRef);
    // Recorded BEFORE the exclusion check, and that ordering is the whole seam:
    // an excluded room's claim is still this agent's work, so its session must
    // stay suppressed. Skipping the claim earlier — filtering the input instead
    // of the output — would hand the agent straight back to the session half,
    // which would then announce the very work the exclusion was hiding, in
    // vaguer words.
    if (agent !== undefined) claimedPaths.add(agent.path);
    if (excluded.has(claim.roomId)) continue;

    // The room list answers WHERE, and it is a different read from the roster
    // that answered WHO — so a room this client can name the members of but
    // cannot yet name (a channel created seconds ago, a list mid-refetch) draws
    // the agent with no activity line rather than a guess at the room.
    const room = input.rooms[claim.roomId];
    const roomTitle = room === undefined ? null : roomDisplayTitle(room);

    rows.push(
      withCopy({
        id: `room:${claim.roomId}:${claim.authorId}`,
        name: member.author.displayName,
        handle: member.author.handle,
        face: resolveIdentityFace({
          // An agent's own manifest outranks the author row's render cache: a
          // colour changed in Settings shows here on the next fleet read rather
          // than when the room next resolves the author. `resolveAgentVisual`
          // is what turns a manifest's `icon` into the `emoji` a disc draws.
          record: member.author,
          override: agent === undefined ? null : resolveAgentVisual(agent.manifest),
          ...(member.origin !== undefined ? { origin: member.origin } : {}),
        }),
        binding: roomTitle === null ? null : replyingIn(roomTitle),
        state: claim.state,
        since: claim.since,
        roomTitle,
        runtime: agent?.manifest.runtime ?? null,
        // The REGISTRY's id — not the claim's author id, which is a room fact,
        // and not the manifest's own id, which is what the agent calls itself
        // on disk. Only the registry's is what the team roster is keyed by.
        // See {@link PresenceRowsInput.meshIdByPath}.
        profileMemberId: agent === undefined ? null : (input.meshIdByPath[agent.path] ?? null),
        follow: { kind: 'room', roomId: claim.roomId },
      })
    );
  }

  // One row per agent, not per session: two turns in one directory is a fact
  // about the fleet, not two agents to watch. The first session wins, which is
  // the one the store yielded first — any of them opens the same agent's work.
  const seenPaths = new Set(claimedPaths);
  const sessionRows: PresenceRow[] = [];
  for (const session of input.sessions) {
    if (seenPaths.has(session.cwd)) continue;
    const manifest = input.agents[session.cwd];
    if (manifest === null || manifest === undefined) continue;
    seenPaths.add(session.cwd);

    const name = manifest.displayName ?? manifest.name;
    sessionRows.push(
      withCopy({
        id: `session:${session.sessionId}`,
        name,
        // A manifest holds no handle — that lives on the author row a room
        // mints, and this agent may never have been in one. Absent, not faked.
        handle: null,
        face: resolveIdentityFace({
          record: { id: manifest.id, kind: 'agent', displayName: name },
          override: resolveAgentVisual(manifest),
        }),
        binding: WORKING_IN_SESSION,
        // A session's lifecycle has no long-wait threshold — that is a room's
        // judgement about its own wait, and a session nobody is waiting in has
        // nothing to be late for.
        state: 'working',
        // Nothing here measures a turn's age: the session-list store holds a
        // lifecycle, not a start time.
        since: null,
        roomTitle: null,
        runtime: manifest.runtime,
        // The registry's id for this directory, same rule as the room half.
        // Nullable for the same reason too: this half draws an agent as soon as
        // its MANIFEST resolves, and the registry is a separate read that can
        // be missing an entry the manifest has.
        profileMemberId: input.meshIdByPath[session.cwd] ?? null,
        follow: { kind: 'session', sessionId: session.sessionId, cwd: session.cwd },
      })
    );
  }

  // Named order for the coarser half, since it has no claim age to sort by.
  sessionRows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return [...rows, ...sessionRows];
}
