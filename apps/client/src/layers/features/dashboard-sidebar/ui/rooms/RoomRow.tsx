import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { agentAuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { cn } from '@/layers/shared/lib';
import type { AgentRoster } from '@/layers/entities/agent';
import { useIsMobile } from '@/layers/shared/model';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  SidebarMenuAction,
  SidebarMenuItem,
} from '@/layers/shared/ui';
import {
  RoomAvatar,
  RoomTitle,
  hasUnread,
  roomDisplayTitle,
  useArchiveRoom,
  useMarkRoomReadNow,
  useRenameRoom,
  useUnarchiveRoom,
} from '@/layers/entities/room';
import { useMenuCloseFocusGuard } from '../../model/use-menu-close-focus-guard';
import { RoomRowMenuItems } from './RoomRowMenuItems';
import { RoomMembersDialog, type MembersDialogIntent } from '@/layers/features/room-membership';
import { RoomTopicDialog } from './RoomTopicDialog';

/** Longest room name the server accepts (`UpdateRoomRequestSchema.title`). */
const MAX_NAME = 200;

interface RoomRowProps {
  /** The room this row opens. */
  room: RoomSummary;
  /** Whether this room is the one currently on screen. */
  isActive: boolean;
  /** Open the room. */
  onSelect: () => void;
  /** Every agent in the fleet, sorted by name — what "Add agents…" offers. */
  agents: AgentRoster;
  /** Open an agent's profile in the right-panel hub. */
  onOpenAgentProfile: (agentPath: string) => void;
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
 * gesture the sidebar already uses for naming a group; the topic editor and the
 * members panel are modals, because neither fits in a sidebar's width.
 */
export function RoomRow({ room, isActive, onSelect, agents, onOpenAgentProfile }: RoomRowProps) {
  const isMobile = useIsMobile();
  const unread = hasUnread(room);
  const title = roomDisplayTitle(room);

  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(room.title);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [topicOpen, setTopicOpen] = useState(false);
  const [membersIntent, setMembersIntent] = useState<MembersDialogIntent | null>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const committedRef = useRef(false);

  const markRead = useMarkRoomReadNow();
  const renameRoom = useRenameRoom();
  const archiveRoom = useArchiveRoom();
  const unarchiveRoom = useUnarchiveRoom();

  // "Rename…" mounts an inline editor, and the launching menu closes in a SECOND
  // commit whose focus restore would blur it — blur-cancelling the editor before
  // anyone sees it (DOR-329). Armed by startRename, wired onto BOTH contents.
  const { arm: armCloseFocusGuard, onCloseAutoFocus } = useMenuCloseFocusGuard();

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
    armCloseFocusGuard();
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
  const agentParticipants = (room.participants ?? []).filter((p) => p.kind === 'agent');
  const soleAgentRef = agentParticipants.length === 1 ? agentParticipants[0]!.agentRef : undefined;
  const soleAgentPath =
    soleAgentRef === undefined
      ? null
      : (agents.candidates.find((a) => agentAuthorRef(a.agentPath) === soleAgentRef)?.agentPath ??
        null);

  const menuModel = {
    kind: room.kind,
    hasUnread: unread,
    soleAgentPath,
    onMarkRead: handleMarkRead,
    onAddAgents: () => setMembersIntent('add'),
    onOpenMembers: () => setMembersIntent('roster'),
    onOpenAgentProfile,
    onRename: startRename,
    onEditTopic: () => setTopicOpen(true),
    onArchive: () => setArchiveOpen(true),
  };

  return (
    <SidebarMenuItem>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className="group/room relative">
            {isRenaming ? (
              <div className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5">
                <RoomAvatar room={room} participants={room.participants} />
                <input
                  ref={renameRef}
                  value={renameValue}
                  maxLength={MAX_NAME}
                  aria-label={`Rename ${title}`}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={handleRenameKeyDown}
                  onBlur={commitRename}
                  // The row is a context-menu trigger, and this field sits
                  // inside it. Without this, right-clicking to paste opened the
                  // ROOM menu, which blurred the editor and blur-committed a
                  // half-typed name nobody confirmed. Propagation stops here so
                  // the browser's own edit menu appears instead; the event is
                  // deliberately not prevented, because that menu is the whole
                  // point of right-clicking a text field.
                  onContextMenu={(e) => e.stopPropagation()}
                  className={cn(
                    'bg-background text-foreground',
                    'focus-visible:ring-ring min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-1'
                  )}
                />
              </div>
            ) : (
              <button
                ref={rowRef}
                type="button"
                onClick={onSelect}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'focus-visible:ring-sidebar-ring flex w-full items-center gap-2 rounded-md py-1.5 pr-7 pl-2.5 text-left text-xs outline-hidden transition-colors duration-100 focus-visible:ring-2 active:scale-[0.98]',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  unread && !isActive && 'text-foreground font-medium'
                )}
              >
                <RoomAvatar room={room} participants={room.participants} />
                <RoomTitle room={room} className="min-w-0 flex-1" />
                {unread && (
                  <span
                    className="bg-brand/15 text-brand shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums"
                    // The room is NOT named again here. This label joins the row's own
                    // name to make it, so repeating the room turned every unread row
                    // into "#general 3 unread in #general" — the same name twice, which
                    // is the defect this row was just fixed for.
                    aria-label={`${room.unreadCount} unread`}
                  >
                    {room.unreadCount}
                  </span>
                )}
              </button>
            )}

            {!isRenaming && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuAction
                    showOnHover={!isMobile}
                    aria-label={`${title} actions`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="size-4" />
                  </SidebarMenuAction>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="right"
                  align="start"
                  className="w-52"
                  onCloseAutoFocus={onCloseAutoFocus}
                >
                  <RoomRowMenuItems variant="dropdown" {...menuModel} />
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-52" onCloseAutoFocus={onCloseAutoFocus}>
          <RoomRowMenuItems variant="context" {...menuModel} />
        </ContextMenuContent>
      </ContextMenu>

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

      {/* Mounted only while open: a closed dialog would still hold state seeded
          from a room that has since changed under it, and every room row in the
          sidebar would carry two of them. */}
      {topicOpen && (
        <RoomTopicDialog room={room} open onOpenChange={(next) => !next && setTopicOpen(false)} />
      )}
      {membersIntent !== null && (
        <RoomMembersDialog
          room={room}
          open
          onOpenChange={(next) => !next && setMembersIntent(null)}
          intent={membersIntent}
          agents={agents}
        />
      )}
    </SidebarMenuItem>
  );
}
