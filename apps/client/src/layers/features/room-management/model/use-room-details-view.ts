/**
 * Everything the room sheet knows, read once and joined once.
 *
 * Split out of the sheet itself rather than inlined: five reads and five
 * derivations is most of a component that also owns four mutations, a focus
 * handoff and three pieces of interaction state. Here they can be read as one
 * answer to "what does this surface know about this room".
 *
 * @module features/room-management/model/use-room-details-view
 */
import { useCallback, useMemo } from 'react';
import {
  agentAuthorRef,
  type AuthorRef,
  type RoomRosterEntry,
  type RoomWithRoster,
  type RoomWorkingClaim,
} from '@dorkos/shared/room-schemas';
import type { AgentVisual } from '@/layers/shared/lib';
import {
  PRESENCE_TTL_MS,
  profileMemberIdOf,
  useLoadedRoomEntries,
  useRoom,
  useRoomFinished,
  useRoomPresence,
  type EngagedWindow,
  type RoomPresenceAuthor,
} from '@/layers/entities/room';
import { useEngagedWindow } from '@/layers/entities/config';
import { useMeshMemberIds } from '@/layers/entities/mesh';
import type { AgentRoster } from '@/layers/entities/agent';
import { useAgentPickerCandidates } from './use-agent-picker-candidates';
import { facesOfRoster, useRoomFaces } from './use-room-faces';

/** What the sheet renders from. Nothing here is interaction state. */
export interface RoomDetailsView {
  /** The fleet, and whether it is known. */
  agents: AgentRoster;
  /** The room as the server most recently gave it, or `null` until it lands. */
  room: RoomWithRoster | null;
  /** True while the roster is being read. */
  isLoading: boolean;
  /** True when the roster could not be read at all. */
  isError: boolean;
  /**
   * Read the roster again. The way out of {@link RoomDetailsView.isError}, so a
   * failed read is not answered by asking the reader to close the sheet and
   * open it again — which is the same request, made of a person.
   */
  retry: () => void;
  /** The roster, in the order the server hands it back. Empty until it lands. */
  members: RoomRosterEntry[];
  /**
   * How many agents are in the room. `0` before the roster lands as well as
   * after it lands empty, so read {@link RoomDetailsView.room} alongside it
   * before saying anything about a room with nobody in it.
   */
  agentCount: number;
  /** The roster's authors, or `null` while it is still being read. */
  participants: AuthorRef[] | null;
  /** The faces of this room's agents, in roster order. */
  roomVisuals: AgentVisual[];
  /** Each agent's face, keyed by the stable handle the roster carries. */
  facesByRef: ReadonlyMap<string, AgentVisual>;
  /** Whether an agent is already in the room, and so not offerable. */
  isAlreadyIn: (agent: { agentPath: string }) => boolean;
  /**
   * Where a member's agent lives on disk, or `null` when the fleet cannot say.
   *
   * The roster carries `agentRef`, a one-way hash of the directory (a home path
   * is not something to put on a shared surface, ADR 260726-170126), and every
   * write that puts an agent INTO a room needs the directory itself. The fleet
   * this sheet already reads to offer the picker is the only thing that holds
   * both, so the mapping is built here rather than guessed anywhere else.
   */
  agentPathOf: (member: RoomRosterEntry) => string | null;
  /**
   * The id the TEAM roster files a member under — what `?profile=` opens — or
   * `undefined` when nothing here can say.
   *
   * A person's roster row IS their author row, so their id passes straight
   * through. An agent's does not: the roster keys agents by the id the mesh
   * registered, and this sheet holds only the author ULID minted for it in this
   * room. The bridge is the fleet read already in hand — directory first
   * ({@link RoomDetailsView.agentPathOf}), then the mesh's own id for it — so an
   * agent this client cannot place yields `undefined` and its row stays plain
   * text rather than a control that opens an empty profile.
   */
  profileMemberIdOf: (member: RoomRosterEntry) => string | undefined;
  /** When each author last posted, as far as the loaded page can say. */
  lastSpokeByAuthor: ReadonlyMap<string, string>;
  /**
   * Who is working here, as best anything can say — the live stream when this
   * client has one, and the server's own read of the claim map when it does not.
   *
   * Empty is only ever a claim about the room when
   * {@link RoomDetailsView.workingKnown} is true. See it for why.
   */
  working: RoomPresenceAuthor[];
  /**
   * Whether {@link RoomDetailsView.working} is an ANSWER, or just an absence.
   *
   * The distinction this sheet had no way to make. Presence rides each room's
   * own SSE stream, and only the room ON SCREEN has one open — so a sheet opened
   * from the sidebar over some other room heard nothing, drew nothing, and was
   * indistinguishable from a room where nobody is working. A person reading it
   * had no way to tell "quiet" from "not listening".
   *
   * `true` when something current is answering: the room's own stream has spoken,
   * or the room read landed recently enough carrying its `workingAgents` rows —
   * the server's live read of the same claim map the stream publishes from. Only
   * then does an empty list mean nobody is working.
   *
   * `false` while the room is still being read, against a server old enough not
   * to send the field, and — the case worth spelling out — once that snapshot has
   * aged past {@link PRESENCE_TTL_MS} with the stream saying nothing. A snapshot
   * is a fact about when it was fetched, and `useRoom` does not refetch a sheet
   * somebody is already looking at, so half a minute later it is no longer
   * evidence of anything. Turning a stale "nobody" into a confident one is the
   * exact failure this field exists to prevent, one source further along.
   */
  workingKnown: boolean;
  /** The engaged-window ceilings, or `null` while the config read is in flight. */
  engagedWindow: EngagedWindow | null;
}

/**
 * Read one room for its sheet, and join it to the fleet.
 *
 * @param roomId - The room being described.
 * @param open - Whether the sheet is on screen. Every read here is gated on it:
 *   a closed sheet holding a roster would show one from before the last change,
 *   and every room row in the sidebar mounts one of these.
 */
export function useRoomDetailsView(roomId: string, open: boolean): RoomDetailsView {
  // Read here rather than handed down: the sheet opens from four places and
  // only one of them has a fleet to give it.
  const agents = useAgentPickerCandidates();
  // The list payload carries a DM's participants but never a channel's roster,
  // and never anyone's response mode — so the sheet reads the room itself.
  const roomQuery = useRoom(open ? roomId : null);
  // The ceilings the engaged rung is described with. `null` until the config
  // read lands, and the sentence says less rather than quoting the numbers this
  // install ships with — see `useEngagedWindow`.
  const engagedWindow = useEngagedWindow();
  // Who is working, if anybody is telling us. The signal rides the room's own
  // SSE stream, which only the room ON SCREEN has open — so a sheet opened from
  // the sidebar over some other room learns nothing from it. Opening a second
  // stream to decorate a dialog is not a trade worth making; reading what the
  // room GET already carries is, which is what `workingNow` below does.
  const live = useRoomPresence(open ? roomId : null);
  // What the stream has said FINISHED here, which is the only thing that can
  // overrule the room read's own snapshot. Subscribed rather than read once: the
  // whole point is that it arrives after the sheet is already on screen.
  const finished = useRoomFinished(open ? roomId : null);
  // "Last spoke" is decoration: worth printing over an open room, never worth a
  // history GET of its own — and never worth racing the live stream for the
  // cache entry it writes into. See `useLoadedRoomEntries`.
  const loadedEntries = useLoadedRoomEntries(open ? roomId : null);

  const roomRefetch = roomQuery.refetch;
  const retry = useCallback(() => {
    void roomRefetch();
  }, [roomRefetch]);

  const room = roomQuery.data ?? null;
  const members = useMemo(() => room?.members ?? [], [room]);
  const agentMembers = useMemo(
    () => members.filter((member) => member.author.kind === 'agent'),
    [members]
  );

  // An agent already in the room is not offerable. `agentRef` is the stable
  // handle derived from the agent's directory (ADR 260726-170126) — display
  // names are labels and two agents can share one, so they are never the key.
  const isAlreadyIn = useMemo(() => {
    const present = new Set(
      agentMembers.map((member) => member.author.agentRef).filter((ref): ref is string => !!ref)
    );
    return (agent: { agentPath: string }) => present.has(agentAuthorRef(agent.agentPath));
  }, [agentMembers]);

  /**
   * Each agent's real face, keyed by the same stable handle the roster carries.
   *
   * Read from {@link useRoomFaces} rather than joined again here: the bar's room
   * mark needs the same answer, and two joins are two chances for the same agent
   * to be drawn two ways — which is the bug `room-agent-faces.test.tsx` exists
   * for. The fleet underneath is the one this hook already reads to offer the
   * picker, so it costs a memo rather than a request.
   */
  const facesByRef = useRoomFaces();

  /**
   * The same join as {@link facesByRef}, read the other way: from the handle a
   * roster row carries back to the directory a write needs.
   */
  const agentPathOf = useMemo(() => {
    const paths = new Map<string, string>();
    for (const candidate of agents.candidates) {
      paths.set(agentAuthorRef(candidate.agentPath), candidate.agentPath);
    }
    return (member: RoomRosterEntry): string | null => {
      const ref = member.author.agentRef;
      return ref === undefined ? null : (paths.get(ref) ?? null);
    };
  }, [agents.candidates]);

  // The one join that reaches the roster's id space, shared with the sidebar
  // face and the Team card — deliberately the MESH's id and not the on-disk
  // manifest's, because `GET /api/team` builds its agent rows from the same
  // registry (see `useMeshMemberIds`).
  const memberIdByPath = useMeshMemberIds();
  const profileMemberId = useCallback(
    (member: RoomRosterEntry): string | undefined => {
      const path = agentPathOf(member);
      return profileMemberIdOf(member.author, path === null ? undefined : memberIdByPath.get(path));
    },
    [agentPathOf, memberIdByPath]
  );

  const participants = useMemo(() => room?.members.map((member) => member.author) ?? null, [room]);

  /**
   * The faces of this room's agents, in roster order.
   *
   * Only a direct message's mark draws them, and it is the same join the roster
   * rows make — so the mark at the top of the panel is the face the row below it
   * shows, rather than a letter disc for the agent the reader is looking at. The
   * bar's own room mark reads the same two things (`facesOfRoster`), which is
   * what keeps all three agreeing.
   */
  const roomVisuals = useMemo(
    () => facesOfRoster(agentMembers, facesByRef),
    [agentMembers, facesByRef]
  );

  /**
   * When each author last posted, as far as the loaded page can say.
   *
   * Posts only: a notice is the ROOM speaking about a member, not the member
   * speaking. Absent authors are absent from the map, and the row prints when
   * they joined rather than claiming they have never spoken — the page is only
   * the tail of the log, so silence in it proves nothing.
   */
  const lastSpokeByAuthor = useMemo(() => {
    const spoke = new Map<string, string>();
    for (const entry of loadedEntries ?? []) {
      if (entry.kind === 'post') spoke.set(entry.authorId, entry.createdAt);
    }
    return spoke;
  }, [loadedEntries]);

  // Deliberately NOT memoised, for the reason `useRoomPresence` gives for the
  // same choice: both halves of this answer are functions of the clock — the
  // elapsed times, and whether the snapshot is still evidence — so a cache keyed
  // on the inputs would be a cache of stale numbers and a stale verdict. The two
  // common cases allocate nothing: a live stream returns its own array, and a
  // room with nothing working returns the one shared empty one.
  const presence = workingNow(live, room?.workingAgents, roomQuery.dataUpdatedAt, finished);

  return {
    agents,
    room,
    isLoading: roomQuery.isLoading,
    isError: roomQuery.isError,
    retry,
    members,
    agentCount: agentMembers.length,
    participants,
    roomVisuals,
    facesByRef,
    isAlreadyIn,
    agentPathOf,
    profileMemberIdOf: profileMemberId,
    lastSpokeByAuthor,
    working: presence.agents,
    workingKnown: presence.known,
    engagedWindow,
  };
}

/**
 * Who is working here, and whether that is an answer at all.
 *
 * **The stream wins whenever it has spoken**, which is the same precedence
 * `useRoomWorking` gives the sidebar's dot and for the same reason: a snapshot is
 * a fact about when it was fetched, and the stream is now. In particular the
 * stream is the only thing that can say an agent has STOPPED — the room read is
 * cached and would go on claiming a turn that ended.
 *
 * **The snapshot is aged out, and ages out the VERDICT with it.** It is bounded
 * by the same {@link PRESENCE_TTL_MS} every other presence reader uses, measured
 * from when the room read landed. Past that the rows go — and `known` goes with
 * them, which is the half that matters: dropping the rows while still claiming to
 * know would turn a stale snapshot into a confident "nobody is working", which is
 * a worse lie than the silence this whole field replaced.
 *
 * Like `summarize` and `countNow`, it reads the clock at render rather than
 * running a timer: nothing here re-renders on its own, so the bound is applied
 * the next time something else draws — which for a sheet a person is looking at
 * is every interaction.
 *
 * **A finish the stream reported OVERRULES the snapshot row it is about**, and
 * that is the half a reader notices when it is missing. `live` being empty is
 * ambiguous — it means "confirmed nobody" and "never heard anything" alike — so
 * falling straight through to the snapshot would keep an agent on screen as
 * working underneath the reply it had already posted. The release that should
 * have retired it lands on a store that never recorded the start, because
 * signals do not replay and this sheet may have opened mid-turn; `useRoomFinished`
 * is where that otherwise-discarded release is kept (DOR-786).
 *
 * Compared against `fetchedAt` rather than trusted outright, because an agent
 * that finished and was then claimed AGAIN is working, and the room read is what
 * says so. The comparison is this client's clock on both sides. Its one soft
 * edge is the millisecond or two between the server reading its claim map and
 * the response landing here: a release inside that window loses to the snapshot,
 * which is the same direction this code has always erred.
 *
 * @param live - What the room's own stream has said, or empty.
 * @param snapshot - The claims the room read carried, or `undefined` when the
 *   read has not landed (or the server does not send them).
 * @param fetchedAt - This client's clock when the room read landed, as TanStack
 *   Query recorded it. `0` before any read.
 * @param finished - When the stream last said each author finished here.
 * @returns The rows, oldest claim first, and whether they are an answer.
 */
function workingNow(
  live: RoomPresenceAuthor[],
  snapshot: readonly RoomWorkingClaim[] | undefined,
  fetchedAt: number,
  finished: Readonly<Record<string, number>>
): { agents: RoomPresenceAuthor[]; known: boolean } {
  if (live.length > 0) return { agents: live, known: true };
  if (snapshot === undefined) return { agents: live, known: false };
  const now = Date.now();
  // The room read is the only thing answering, so its age is the answer's age.
  if (now - fetchedAt >= PRESENCE_TTL_MS) return { agents: NOBODY_WORKING, known: false };
  // Everything the room read listed that the stream has not since retired. An
  // empty result here is still an ANSWER — the stream told us they finished,
  // which is knowledge, not absence — so `known` stays true.
  const stillWorking = snapshot.filter((claim) => (finished[claim.authorId] ?? 0) <= fetchedAt);
  if (stillWorking.length === 0) return { agents: live, known: true };
  return {
    known: true,
    agents: stillWorking.map((claim) => ({
      authorId: claim.authorId,
      // The snapshot deliberately carries no entry id: which message a turn
      // answers belongs to the live signal, which is designed to say it. An empty
      // string is the honest stand-in — the peek that follows one draws nothing
      // rather than pointing at a message that does not exist.
      entryId: '',
      // Never `working_late`. Whether a room has stopped WAITING for a turn is a
      // judgement the dispatcher publishes and the claim map does not record, so
      // saying anything sharper here would be an invention.
      state: 'working' as const,
      since: claim.since,
      elapsedMs: Math.max(0, now - Date.parse(claim.since)),
    })),
  };
}

/** One shared empty answer, so an aged-out sheet never re-renders its reader. */
const NOBODY_WORKING: RoomPresenceAuthor[] = [];
