/**
 * Everything a room row can DO, mounted only once the reader reaches for it.
 *
 * A room row is mostly a picture: a mark, a name, a count. The acts behind it —
 * mark read, mute, move to a section, rename, archive, leave, join — are six
 * mutations and a preferences write, and every one of them used to be mounted by
 * every row on screen. On a 60-room sidebar that is ~420 mutation observers
 * standing idle, rebuilt on every render of the panel, for menus almost none of
 * which are ever opened (`specs/sidebar-simplification` D8).
 *
 * So they live here, and `RoomRow` mounts this hook the first time the reader
 * does anything that could open that row's menu — a press, a right-click, or
 * focus landing in the row. It stays mounted afterwards: a row you have used
 * once is a row you are likely to use again, and re-mounting on every menu open
 * would trade a standing cost for a per-open one.
 *
 * @module features/dashboard-sidebar/ui/rooms/use-room-row-menu
 */
import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { toast } from 'sonner';
import { agentAuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import { moveToGroup, muteItem, unmuteItem, useUpdateSidebarPrefs } from '@/layers/entities/config';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import {
  roomDisplayTitle,
  useAddRoomMember,
  useArchiveRoom,
  useMarkRoomReadNow,
  useRemoveRoomMember,
  useRenameRoom,
  useUnarchiveRoom,
} from '@/layers/entities/room';
import { useTeamRoster } from '@/layers/entities/team';

/** What {@link useRoomRowMenu} needs to know about the row it serves. */
export interface RoomRowMenuInput {
  /** The room the menu acts on. */
  room: RoomSummary;
  /** Whether this room is the one currently on screen — leaving it navigates away. */
  isActive: boolean;
}

/** The acts a room row's menu and confirmations perform. */
export interface RoomRowActs {
  /**
   * Whether Leave and Join may be offered at all — the roster could name the
   * install owner, whose membership those two verbs move.
   */
  canLeave: boolean;
  /**
   * The directory of this room's one agent when it is a one-to-one, `null`
   * otherwise — and also `null` while the fleet is still loading, or once that
   * agent has left the mesh.
   */
  soleAgentPath: string | null;
  /** Mark everything in the room read, now. */
  markRead: () => void;
  /** Silence the room, or give it its voice back. */
  setMuted: (muted: boolean) => void;
  /** File the room into a hand-made section, or take it out of the one it is in. */
  moveToSection: (groupId: string | null) => void;
  /** Rename it. The caller has already trimmed and validated the name. */
  rename: (title: string) => void;
  /** Archive it, offering the undo in the toast that reports it. */
  archive: () => void;
  /** Leave it, offering the undo in the toast that reports it. */
  leave: () => void;
  /** Get onto a room's roster — a room you left, or one you were never in. */
  join: () => void;
}

/**
 * Mount a room row's acts.
 *
 * **Every mutation here is deliberately callback-light.** The shared mutation
 * toast names the action from each hook's `meta` and appends the server's own
 * sentence, so nothing here restates a failure — including the one sentence only
 * the server can write ("two agents share this room, take one out first").
 *
 * @param input - The room, and whether it is the one on screen.
 */
export function useRoomRowMenu({ room, isActive }: RoomRowMenuInput): RoomRowActs {
  // **Held in a ref, so its identity can never rebuild the memo below.** The
  // acts object is published up into the row's state, so anything in its
  // dependency list that changes identity every render is an update loop rather
  // than a wasted render. Navigation is only ever called from a handler, so a
  // ref is the honest shape for it.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  });
  const title = roomDisplayTitle(room);

  // `mutate` and nothing else off each hook: TanStack hands back a fresh result
  // object every render but keeps `mutate` stable for the life of the observer,
  // and the memo at the bottom has to hold across renders that changed nothing.
  const { mutate: markReadRoom } = useMarkRoomReadNow();
  const { mutate: renameRoom } = useRenameRoom();
  const { mutate: archiveRoom } = useArchiveRoom();
  const { mutate: unarchiveRoom } = useUnarchiveRoom();
  const { mutate: leaveRoom } = useRemoveRoomMember({ errorLabel: "Couldn't leave" });
  const { mutate: joinRoom } = useAddRoomMember();
  const { update: updateSidebarPrefs } = useUpdateSidebarPrefs();

  /**
   * **The install OWNER's author id — not necessarily "you".**
   *
   * `GET /api/team`'s `isSelf` names the account that owns this install
   * (`aggregate-team.ts`'s `isOwnerRecord` match), resolved the same way for
   * every caller of the route; it does not read who is asking. This product
   * ships with one operator per install, so the person driving the browser IS
   * the owner and the two coincide. On a future install with a second person
   * logged in, this would still resolve to the OWNER's id — a second person's
   * Leave would try to remove the owner's membership rather than their own, and
   * get refused with a sentence about a room shape rather than about who they
   * are. Known residual; not fixed here.
   *
   * A room's own read carries `viewerAuthorId` (`RoomWithRoster`), which IS
   * caller-scoped — but the sidebar only ever reads the LIST shape, which does
   * not carry it. The team roster is the only source of this answer without
   * opening the room first, and it is mounted app-wide (the account menu keeps
   * it warm), so this is a shared cache hit rather than a fetch of its own.
   */
  const selfAuthorId = useTeamRoster().data?.members.find((member) => member.isSelf)?.id ?? null;

  // Only a one-to-one names an unambiguous agent. `participants` is carried for
  // direct messages and `null` for anything else, and the agent is matched on
  // its `agentRef` — the stable handle derived from its directory — never on a
  // display name, which two agents can share.
  //
  // Mesh rather than the picker's roster: this needs a PATH and nothing else,
  // and paths are all mesh holds. Resolving manifests to get display names would
  // be work for an answer this never reads.
  const meshAgents = useMeshAgentPaths().data?.agents ?? [];
  const agentParticipants = (room.participants ?? []).filter((p) => p.kind === 'agent');
  const soleAgentRef = agentParticipants.length === 1 ? agentParticipants[0]!.agentRef : undefined;
  const soleAgentPath =
    soleAgentRef === undefined
      ? null
      : (meshAgents.find((a) => agentAuthorRef(a.projectPath) === soleAgentRef)?.projectPath ??
        null);

  /**
   * One object, for as long as its inputs hold.
   *
   * The row hands this straight into its menu, so a fresh object on every render
   * would be a changed prop on a memoized row — the very thing D8 is about. The
   * mutation handles above are stable, so what is left in the list is the room
   * itself and the two answers the queries resolve.
   */
  return useMemo<RoomRowActs>(() => {
    const roomRef: SidebarItemRef = { kind: 'room', roomId: room.id };

    /**
     * Get onto this room's roster — `AddRoomMemberRequestSchema` and
     * `RoomService.addMember` take an existing author's id for any kind, agent
     * or person, so this is the same wire call "Add agents" makes, aimed at
     * yourself instead of an agent. No `responseMode`: the field decides when an
     * AGENT answers unprompted, and the server seeds a person's own inert
     * default.
     */
    const join = () => {
      if (selfAuthorId === null) return;
      joinRoom(
        { roomId: room.id, authorId: selfAuthorId },
        { onSuccess: () => toast.success(`You joined ${title}`) }
      );
    };

    return {
      canLeave: selfAuthorId !== null,
      soleAgentPath,
      markRead: () => markReadRoom(room.id),
      setMuted: (muted) =>
        updateSidebarPrefs((prev) => (muted ? muteItem(prev, roomRef) : unmuteItem(prev, roomRef))),
      moveToSection: (groupId) => updateSidebarPrefs((prev) => moveToGroup(prev, roomRef, groupId)),
      rename: (next) => renameRoom({ roomId: room.id, title: next }),
      archive: () =>
        archiveRoom(room.id, {
          // Archive is the honest verb only if it is genuinely reversible, and
          // nothing else in the cockpit un-archives a room yet — so the undo
          // ships with the action rather than waiting for a screen to hold it.
          //
          // The undo deliberately passes NO callbacks. Archiving drops this row
          // from the sidebar, so by the time anyone can click Undo this
          // component is unmounted and its mutation observer has no listeners —
          // and TanStack gates per-call `onError` on exactly that, so a handler
          // here would never run and a failure would fall through to the generic
          // "Action failed." The hook's `meta.errorLabel` reaches the mutation
          // cache's own handler, which is not gated, so the server's reason is
          // what gets shown.
          onSuccess: () =>
            toast.success(`${title} archived`, {
              action: { label: 'Undo', onClick: () => unarchiveRoom({ roomId: room.id }) },
            }),
        }),
      leave: () => {
        // `canLeave` gates the menu item on this being non-null; a race between
        // opening the confirm and the roster read landing is the only way it
        // could still be null here, and doing nothing quietly is the right
        // answer to a click on a control that vanished under it.
        //
        // **Undo IS possible, unlike this hook's first cut assumed** — the
        // server never restricted `addMember` to agents, only the client's own
        // input type did (DOR-1233 follow-up) — so the offer mirrors Archive's.
        if (selfAuthorId === null) return;
        leaveRoom(
          { roomId: room.id, authorId: selfAuthorId },
          {
            onSuccess: () => {
              toast.success(`You left ${title}`, {
                action: { label: 'Undo', onClick: join },
              });
              // Only when this room is the one on screen: leaving from a row
              // that is not open changes nothing about where the reader is.
              if (isActive) void navigateRef.current({ to: '/channels', search: {} });
            },
          }
        );
      },
      join,
    };
  }, [
    room.id,
    title,
    isActive,
    selfAuthorId,
    soleAgentPath,
    markReadRoom,
    renameRoom,
    archiveRoom,
    unarchiveRoom,
    leaveRoom,
    joinRoom,
    updateSidebarPrefs,
  ]);
}
