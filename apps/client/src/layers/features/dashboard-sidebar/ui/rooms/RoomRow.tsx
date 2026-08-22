import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { BellOff } from 'lucide-react';
import { toast } from 'sonner';
import { agentAuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import { sameSidebarItem } from '@dorkos/shared/config-schema';
import { cn } from '@/layers/shared/lib';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  moveToGroup,
  muteItem,
  unmuteItem,
} from '@/layers/entities/config';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { useTeamRoster } from '@/layers/entities/team';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  SidebarRow,
  statusDotClass,
} from '@/layers/shared/ui';
import {
  RoomAvatar,
  RoomTitle,
  hasUnread,
  roomDisplayTitle,
  useAddRoomMember,
  useArchiveRoom,
  useMarkRoomReadNow,
  useRemoveRoomMember,
  useRenameRoom,
  useRoomWorking,
  useUnarchiveRoom,
} from '@/layers/entities/room';
import { sidebarItemFaces, type SidebarItemVisual } from '../../model/sidebar-item';
import { DISABLED_SORTABLE_BINDINGS, type SortableBindings } from '../dnd/SidebarDndPrimitives';
import { buildRoomRowMenuNodes } from './RoomRowMenuItems';
import { openRoomPanel, type RoomDetailsFocus } from '@/layers/features/room-management';

/** Longest room name the server accepts (`UpdateRoomRequestSchema.title`). */
const MAX_NAME = 200;

interface RoomRowProps {
  /** The room this row opens. */
  room: RoomSummary;
  /**
   * The mark to draw, from the sidebar's item view model — a `#` for a channel,
   * the agent's own face for a one-to-one conversation, a stack of faces for a
   * group one. Resolved there because only that layer can see both the room and
   * the fleet (sidebar-groups §3.1).
   */
  visual: SidebarItemVisual;
  /** Whether this room is the one currently on screen. */
  isActive: boolean;
  /** Open the room. */
  onSelect: () => void;
  /**
   * View an agent's profile — the sidebar's one opener, so a room row and an
   * agent row send you to the same place.
   *
   * Takes a DIRECTORY, which is why the gate below is about resolving one and
   * nothing else: given a path this always opens something (`viewProfileFor`).
   */
  viewAgentProfile: (agentPath: string) => () => void;
  /** Open the inline group-create flow, moving this room into the new group on commit. */
  onRequestNewGroup: (ref: SidebarItemRef) => void;
  /**
   * Drag bindings applied to the row's root when the sidebar drag layer is
   * active (rooms-in-groups, DOR-581). Absent for a row that is not a drag
   * source, which renders exactly as before.
   */
  sortable?: SortableBindings;
}

/**
 * One room in the sidebar — its mark, its name, an unread count when the reader
 * is behind, and everything you can do to it.
 *
 * The badge reads `unreadCount` strictly: `null` means "you are not in this
 * room", which is not the same as `0` ("you are in it and caught up"), so a
 * room the operator has never joined shows no badge rather than a zero.
 *
 * The row's accessible name is built from its parts — `RoomTitle` contributes
 * `#general`, the badge contributes `3 unread` — so no part names the room a
 * second time.
 *
 * The actions live in {@link RoomRowMenuItems}, which builds them once and
 * renders the same list into the right-click ContextMenu and the "…"
 * DropdownMenu. Rename is an inline editor on the row itself, matching the
 * gesture the sidebar already uses for naming a group. Everything else opens
 * the room panel — including "Edit topic…", which used to raise a modal of its
 * own for one text field; the panel is where the topic is now written, and this
 * menu item is one of its doors. Those items open the ROOM as well as the panel,
 * because the panel describes whichever room the page is showing.
 */
export function RoomRow({
  room,
  visual,
  isActive,
  onSelect,
  viewAgentProfile,
  onRequestNewGroup,
  sortable = DISABLED_SORTABLE_BINDINGS,
}: RoomRowProps) {
  const meshAgents = useMeshAgentPaths().data?.agents ?? [];
  const unread = hasUnread(room);
  const working = useRoomWorking(room.id, room.working);
  const title = roomDisplayTitle(room);
  const faces = sidebarItemFaces(visual);

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(room.title);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  /**
   * Open this room's panel at the part the menu item named — after opening the
   * room itself.
   *
   * The panel describes the room the PAGE is showing (spec §3.6), and this menu
   * is over a list of rooms most of which are not it. So the row does what
   * pressing the row does first, and the panel follows it there; the id travels
   * with the request so the panel being left behind cannot answer instead.
   */
  const openRoomDetails = (focus: RoomDetailsFocus) => {
    onSelect();
    openRoomPanel(focus, room.id);
  };
  const renameRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const committedRef = useRef(false);
  const navigate = useNavigate();

  const markRead = useMarkRoomReadNow();
  const renameRoom = useRenameRoom();
  const archiveRoom = useArchiveRoom();
  const unarchiveRoom = useUnarchiveRoom();
  const leaveRoom = useRemoveRoomMember({ errorLabel: "Couldn't leave" });
  const rejoinRoom = useAddRoomMember();
  /**
   * **The install OWNER's author id — not necessarily "you".**
   *
   * `GET /api/team`'s `isSelf` names the account that owns this install
   * (`aggregate-team.ts`'s `isOwnerRecord` match), resolved the same way for
   * every caller of the route; it does not read who is asking. This product
   * ships with one operator per install, so the person driving the browser
   * IS the owner and the two coincide. On a future install with a second
   * person logged in, this would still resolve to the OWNER's id — a second
   * person's Leave would try to remove the owner's membership rather than
   * their own, and get refused with a sentence about a room shape rather
   * than about who they are. Known residual; not fixed here.
   *
   * A room's own read carries `viewerAuthorId` (`RoomWithRoster`), which IS
   * caller-scoped — but the sidebar only ever reads the LIST shape, which
   * does not carry it. The team roster is the only source of this answer
   * without opening the room first, and it is mounted app-wide (the account
   * menu keeps it warm), so this is a shared cache hit rather than a fetch of
   * its own.
   */
  const selfAuthorId = useTeamRoster().data?.members.find((member) => member.isSelf)?.id ?? null;

  // "Rename…" and "Edit topic…" both mount an editor that blur-commits, and the
  // launching menu closes in a SECOND commit whose focus restore would blur it
  // (DOR-329). Both nodes carry `opensInput: true`, which is what arms the
  // shared surface's close-focus guard — the arming lives there now, once,
  // instead of at every call site.

  useEffect(() => {
    if (isRenaming) {
      committedRef.current = false;
      requestAnimationFrame(() => {
        renameRef.current?.focus();
        renameRef.current?.select();
      });
    }
  }, [isRenaming]);

  const startRename = () => {
    // Seeded from `title`, not from what the row draws: a channel row reads
    // `#general` and the thing being edited is the name behind it.
    setRenameValue(room.title);
    setIsRenaming(true);
  };

  /**
   * Leave the editor and put the focus back on the row it replaced.
   *
   * Without this the editor unmounts under the cursor and focus falls to
   * `<body>`, which drops a keyboard reader out of the sidebar entirely — they
   * would have to Tab back in from the top of the page to reach the row they
   * just renamed.
   */
  const endRename = () => {
    setIsRenaming(false);
    // After the commit that swaps the editor back for the button.
    requestAnimationFrame(() => rowRef.current?.focus());
  };

  const commitRename = () => {
    // First Enter/Escape decides; everything after is a no-op — guards
    // double-Enter and the blur that follows a commit.
    if (committedRef.current) return;
    committedRef.current = true;
    endRename();
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NAME || trimmed === room.title) return;
    // No per-call `onError`: the shared mutation toast names the action from
    // the hook's `meta` and appends the server's own sentence.
    renameRoom.mutate({ roomId: room.id, title: trimmed });
  };

  const cancelRename = () => {
    committedRef.current = true;
    endRename();
  };

  const handleRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelRename();
    }
  };

  const confirmArchive = () => {
    setArchiveOpen(false);
    archiveRoom.mutate(room.id, {
      // Archive is the honest verb only if it is genuinely reversible, and
      // nothing else in the cockpit un-archives a room yet — so the undo ships
      // with the action rather than waiting for a screen to hold it.
      //
      // The undo deliberately passes NO callbacks. Archiving drops this row
      // from the sidebar, so by the time anyone can click Undo this component
      // is unmounted and its mutation observer has no listeners — and TanStack
      // gates per-call `onError` on exactly that, so a handler here would never
      // run and a failure would fall through to the generic "Action failed."
      // The hook's `meta.errorLabel` reaches the mutation cache's own handler,
      // which is not gated, so the server's reason is what gets shown.
      onSuccess: () =>
        toast.success(`${title} archived`, {
          action: {
            label: 'Undo',
            onClick: () => unarchiveRoom.mutate({ roomId: room.id }),
          },
        }),
    });
  };

  /**
   * Rejoin a room you left — `AddRoomMemberRequestSchema` and
   * `RoomService.addMember` take an existing author's id for any kind, agent
   * or person, so this is the same wire call "Add agents" makes, aimed at
   * yourself instead of an agent. No `responseMode`: the field decides when
   * an AGENT answers unprompted, and the server seeds a person's own inert
   * default.
   */
  const rejoinChannel = () => {
    if (selfAuthorId === null) return;
    rejoinRoom.mutate(
      { roomId: room.id, authorId: selfAuthorId },
      { onSuccess: () => toast.success(`You rejoined ${title}`) }
    );
  };

  /**
   * Leave, and get out of the room's way if it is the one on screen.
   *
   * No per-call `onError` here, and for the archive confirm's own reason:
   * `errorLabel` on {@link useRemoveRoomMember} ("Couldn't leave") reaches
   * the mutation cache's own handler, which composes it with the server's
   * own sentence — the ONLY place "two agents share this room, take one out
   * first" (or "#team is your home channel") is ever explained, so nothing
   * here restates it.
   *
   * **Undo IS possible, unlike this hook's first cut assumed** — the server
   * never restricted `addMember` to agents, only the client's own input type
   * did (DOR-1233 follow-up) — so the offer mirrors Archive's exactly:
   * {@link rejoinChannel}, passed no per-call callbacks the same way
   * `unarchiveRoom.mutate` above is not, because the shared mutation toast is
   * what reports a failed undo.
   */
  const confirmLeave = () => {
    setLeaveOpen(false);
    // `canLeave` gates the menu item on this being non-null; a race between
    // opening the confirm and the roster read landing is the only way it
    // could still be null here, and closing quietly is the right answer to a
    // click on a control that vanished under it.
    if (selfAuthorId === null) return;
    leaveRoom.mutate(
      { roomId: room.id, authorId: selfAuthorId },
      {
        onSuccess: () => {
          toast.success(`You left ${title}`, {
            action: { label: 'Undo', onClick: rejoinChannel },
          });
          // Only when this room is the one on screen: leaving from a row
          // that is not open changes nothing about where the reader is.
          if (isActive) void navigate({ to: '/channels', search: {} });
        },
      }
    );
  };

  const handleMarkRead = () => markRead.mutate(room.id);

  // Only a one-to-one names an unambiguous agent. `participants` is carried for
  // direct messages and `null` for anything else, and the agent is matched on
  // its `agentRef` — the stable handle derived from its directory — never on a
  // display name, which two agents can share.
  //
  // Mesh rather than the picker's roster: this needs a PATH and nothing else,
  // and paths are all mesh holds. Resolving manifests to get display names
  // would be work for an answer this never reads.
  const agentParticipants = (room.participants ?? []).filter((p) => p.kind === 'agent');
  const soleAgentRef = agentParticipants.length === 1 ? agentParticipants[0]!.agentRef : undefined;
  const soleAgentPath =
    soleAgentRef === undefined
      ? null
      : (meshAgents.find((a) => agentAuthorRef(a.projectPath) === soleAgentRef)?.projectPath ??
        null);
  /**
   * Whether this room IS a 1:1 — `soleAgentRef !== undefined`, decided
   * straight from `room.participants` above and never from mesh resolution.
   * Deliberately a DIFFERENT question than `soleAgentPath`'s: that answer is
   * also `null` while the fleet has not loaded yet and once the agent has
   * left the mesh, and the Leave/Rejoin gate below must not read either of
   * those as "not a 1:1" — a DM whose one agent left the mesh is still
   * exactly the room shape leaving strands.
   */
  const isOneToOne = soleAgentRef !== undefined;

  /**
   * `room.wellKnown` on the wire — `'team'` for #team, `null`/absent for
   * every room a person or an agent opened (team-room-home spec D3.1). The
   * server refuses removing the owner from one of these outright.
   */
  const isSystemRoom = room.wellKnown != null;
  /**
   * Whether the viewer is currently on this room's roster. `unreadCount` is
   * `null` for exactly one reason — a read cursor is a property of
   * membership, and a non-member has none (`RoomService.listRooms`) — so this
   * is the same fact the sidebar's own unread badge already reads this way,
   * not a new signal invented for Leave.
   */
  const isMember = room.unreadCount !== null;

  // ── Where this room sits in the sidebar's organization (rooms-in-groups,
  // DOR-581) ──
  // Read here rather than inside `RoomRowMenuItems` so that component stays a
  // pure function of its model: it is the list the command palette and the room
  // slash commands are meant to consume next (spec `rooms` §15.3), and a hook
  // inside it would make it callable only from a React tree.
  //
  // Smart groups are filtered out of the move targets: their membership comes
  // from rules about agents, so a room filed into one would be counted as
  // grouped (and hidden from Channels) while that group drew its derived
  // members instead — the row would vanish. The drag layer refuses the same
  // drop; this refuses to offer it.
  const sidebarPrefs = useSidebarPrefs();
  const { update: updateSidebarPrefs } = useUpdateSidebarPrefs();
  const roomRef: SidebarItemRef = { kind: 'room', roomId: room.id };
  const isMuted = sidebarPrefs.muted.some((m) => sameSidebarItem(m, roomRef));
  // **What mute removes is what was asking** (DOR-1098). A muted row keeps its
  // name at full contrast — that is the part still worth reading — and loses the
  // bold, the unread badge and the working dot. It used to keep all three and
  // dim the lot, which made the name hard to read and left the signals shouting
  // through the dimming.
  const quiet = isMuted || !isMember;
  const currentGroupId =
    sidebarPrefs.groups.find((g) => g.items.some((m) => sameSidebarItem(m, roomRef)))?.id ?? null;
  const moveTargetGroups = sidebarPrefs.groups
    .filter((g) => g.kind !== 'smart')
    .map((g) => ({ id: g.id, name: g.name }));

  const menuModel = {
    kind: room.kind,
    hasUnread: unread,
    isOneToOne,
    canLeave: selfAuthorId !== null,
    isSystemRoom,
    isMember,
    isMuted,
    currentGroupId,
    groups: moveTargetGroups,
    onMarkRead: handleMarkRead,
    onToggleMute: () =>
      updateSidebarPrefs((prev) => (isMuted ? unmuteItem(prev, roomRef) : muteItem(prev, roomRef))),
    onMoveToGroup: (groupId: string | null) =>
      updateSidebarPrefs((prev) => moveToGroup(prev, roomRef, groupId)),
    onNewGroup: () => onRequestNewGroup(roomRef),
    onAddAgents: () => openRoomDetails('add'),
    onOpenMembers: () => openRoomDetails('members'),
    onViewAgentProfile: soleAgentPath === null ? null : viewAgentProfile(soleAgentPath),
    onRename: startRename,
    onEditTopic: () => openRoomDetails('topic'),
    onLeave: () => setLeaveOpen(true),
    onRejoin: rejoinChannel,
    onArchive: () => setArchiveOpen(true),
  };

  return (
    <>
      <SidebarRow
        glyph={<RoomAvatar room={room} participants={room.participants} visuals={faces} />}
        title={<RoomTitle room={room} />}
        titleText={title}
        isActive={isActive}
        emphasized={unread && !quiet}
        muted={quiet}
        onSelect={onSelect}
        buttonRef={rowRef}
        menuNodes={buildRoomRowMenuNodes(menuModel)}
        actionsLabel={`${title} actions`}
        menuWidth="w-52"
        drag={sortable}
        editor={
          isRenaming ? (
            <input
              ref={renameRef}
              value={renameValue}
              maxLength={MAX_NAME}
              aria-label={`Rename ${title}`}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={commitRename}
              // The row is a context-menu trigger, and this field sits inside
              // it. Without this, right-clicking to paste opened the ROOM menu,
              // which blurred the editor and blur-committed a half-typed name
              // nobody confirmed. Propagation stops here so the browser's own
              // edit menu appears instead; the event is deliberately not
              // prevented, because that menu is the whole point of
              // right-clicking a text field.
              onContextMenu={(e) => e.stopPropagation()}
              className={cn(
                'bg-background text-foreground',
                'focus-visible:ring-ring min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-1'
              )}
            />
          ) : undefined
        }
        trailing={
          <>
            {!isMember && (
              <span
                className="text-muted-foreground bg-muted shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                // A hint, not a repeat of the mute icon's shape: the room is
                // still visible (the owner sees every room whether or not
                // they are on its roster), only unpostable — a fact the
                // dimmed row alone does not say.
                aria-label="You left this channel"
              >
                Left
              </span>
            )}
            {isMuted && (
              <BellOff className="text-sidebar-foreground/50 size-3" aria-label="Muted" />
            )}
            {working > 0 && !quiet && (
              <span
                // `img` because the dot has no text of its own: a bare
                // `aria-label` on a generic element is not reliably read out,
                // and a role is what turns this from decoration into something
                // with a name.
                role="img"
                // The shared dot vocabulary — `statusDotClass('working')` is the
                // success token plus the one pulse this cockpit spends on "right
                // now". Deliberately NOT the brand tint of the unread badge it
                // sits beside: two facts about one row have to be tellable apart
                // at a glance, and a second orange mark next to an orange pill
                // reads as part of it.
                className={cn('size-1.5 rounded-full', statusDotClass('working'))}
                // A dot, and nothing else. The unread badge beside it counts
                // messages waiting to be read; this counts work in flight, which
                // is a fact about right now that will be gone shortly and needs
                // no number on screen to be useful. A reader who cannot see it
                // gets the count in the label, where a number costs no room.
                //
                // Like the unread badge, it does not name the room again — the
                // row's own name is already the first half of what a screen
                // reader reads out.
                aria-label={working === 1 ? '1 agent working' : `${working} agents working`}
              />
            )}
            {unread && !quiet && (
              <span
                className="bg-brand/15 text-brand rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
                // The room is NOT named again here. This label joins the row's own
                // name to make it, so repeating the room turned every unread row
                // into "#general 3 unread in #general" — the same name twice, which
                // is the defect this row was just fixed for.
                aria-label={`${room.unreadCount} unread`}
              >
                {room.unreadCount}
              </span>
            )}
          </>
        }
      />

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {title}?</AlertDialogTitle>
            <AlertDialogDescription>
              It leaves your sidebar and its agents stop being triggered by it. Everything said in
              it is kept, and you can bring it back straight afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmArchive}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave {title}?</AlertDialogTitle>
            <AlertDialogDescription>
              You can still read what&rsquo;s here, but you won&rsquo;t be able to post again. You
              can rejoin from this menu any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmLeave}>Leave</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
