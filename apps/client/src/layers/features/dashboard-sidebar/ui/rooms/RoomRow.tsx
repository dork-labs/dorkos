import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BellOff } from 'lucide-react';
import { toast } from 'sonner';
import { agentAuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import { sameSidebarItem } from '@dorkos/shared/config-schema';
import { cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  moveToGroup,
  muteItem,
  unmuteItem,
} from '@/layers/entities/config';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
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
  useArchiveRoom,
  useMarkRoomReadNow,
  useRenameRoom,
  useRoomWorking,
  useUnarchiveRoom,
} from '@/layers/entities/room';
import { sidebarItemFaces, type SidebarItemVisual } from '../../model/sidebar-item';
import { DISABLED_SORTABLE_BINDINGS, type SortableBindings } from '../dnd/SidebarDndPrimitives';
import { buildRoomRowMenuNodes } from './RoomRowMenuItems';
import { RoomDetailsDialog, type RoomDetailsFocus } from '@/layers/features/room-management';

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
  /** Open an agent's profile in the right-panel hub. */
  onOpenAgentProfile: (agentPath: string) => void;
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
 * the room sheet — including "Edit topic…", which used to raise a modal of its
 * own for one text field; the sheet is where the topic is now written, and this
 * menu item is one of its doors.
 */
export function RoomRow({
  room,
  visual,
  isActive,
  onSelect,
  onOpenAgentProfile,
  onRequestNewGroup,
  sortable = DISABLED_SORTABLE_BINDINGS,
}: RoomRowProps) {
  // Destructured rather than read through `sortable.*` at each use: dnd-kit's
  // `setNodeRef` is a callback ref, and reading it off an object during render
  // trips the lint rule that guards against reading a real ref's `.current`.
  const {
    setNodeRef: setDragNodeRef,
    handleProps: dragHandleProps,
    style: dragStyle,
    isDragging,
    isOver,
  } = sortable;
  const isMobile = useIsMobile();
  const meshAgents = useMeshAgentPaths().data?.agents ?? [];
  const unread = hasUnread(room);
  const working = useRoomWorking(room.id, room.working);
  const title = roomDisplayTitle(room);
  const faces = sidebarItemFaces(visual);

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(room.title);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [detailsFocus, setDetailsFocus] = useState<RoomDetailsFocus | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const committedRef = useRef(false);

  const markRead = useMarkRoomReadNow();
  const renameRoom = useRenameRoom();
  const archiveRoom = useArchiveRoom();
  const unarchiveRoom = useUnarchiveRoom();

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
  const currentGroupId =
    sidebarPrefs.groups.find((g) => g.items.some((m) => sameSidebarItem(m, roomRef)))?.id ?? null;
  const moveTargetGroups = sidebarPrefs.groups
    .filter((g) => g.kind !== 'smart')
    .map((g) => ({ id: g.id, name: g.name }));

  const menuModel = {
    kind: room.kind,
    hasUnread: unread,
    soleAgentPath,
    isMuted,
    currentGroupId,
    groups: moveTargetGroups,
    onMarkRead: handleMarkRead,
    onToggleMute: () =>
      updateSidebarPrefs((prev) => (isMuted ? unmuteItem(prev, roomRef) : muteItem(prev, roomRef))),
    onMoveToGroup: (groupId: string | null) =>
      updateSidebarPrefs((prev) => moveToGroup(prev, roomRef, groupId)),
    onNewGroup: () => onRequestNewGroup(roomRef),
    onAddAgents: () => setDetailsFocus('add'),
    onOpenMembers: () => setDetailsFocus('members'),
    onOpenAgentProfile,
    onRename: startRename,
    onEditTopic: () => setDetailsFocus('topic'),
    onArchive: () => setArchiveOpen(true),
  };

  return (
    <>
      <SidebarRow
        glyph={<RoomAvatar room={room} participants={room.participants} visuals={faces} />}
        title={<RoomTitle room={room} />}
        titleText={title}
        isActive={isActive}
        emphasized={unread}
        muted={isMuted}
        onSelect={onSelect}
        buttonRef={rowRef}
        menuNodes={buildRoomRowMenuNodes(menuModel)}
        actionsLabel={`${title} actions`}
        menuWidth="w-52"
        alwaysShowActions={isMobile}
        dragRef={setDragNodeRef}
        dragProps={dragHandleProps}
        dragStyle={dragStyle}
        isDragging={isDragging}
        isOver={isOver}
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
            {isMuted && (
              <BellOff className="text-sidebar-foreground/50 size-3" aria-label="Muted" />
            )}
            {working > 0 && (
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
            {unread && (
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

      {/* Mounted only while open: a closed sheet would still hold a roster from
          before the last change, and every room row in the sidebar would carry
          one of them. */}
      {detailsFocus !== null && (
        <RoomDetailsDialog
          room={room}
          open
          onOpenChange={(next) => !next && setDetailsFocus(null)}
          focus={detailsFocus}
        />
      )}
    </>
  );
}
