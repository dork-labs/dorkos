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
} from '@dorkos/shared/room-schemas';
import type { AgentVisual } from '@/layers/shared/lib';
import {
  profileMemberIdOf,
  useLoadedRoomEntries,
  useRoom,
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
  /** Who is working, when this client is being told at all. */
  working: RoomPresenceAuthor[];
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
  // the sidebar over some other room correctly learns nothing, and the rows say
  // the next true thing instead. Opening a second stream to decorate a dialog is
  // not a trade worth making.
  const working = useRoomPresence(open ? roomId : null);
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
    working,
    engagedWindow,
  };
}
