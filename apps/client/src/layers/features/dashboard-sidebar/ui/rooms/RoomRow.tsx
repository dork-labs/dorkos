import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { agentAuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { cn } from '@/layers/shared/lib';
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
  useMarkRoomReadNow,
  useUpdateRoom,
} from '@/layers/entities/room';
import { useMenuCloseFocusGuard } from '../../model/use-menu-close-focus-guard';
import { RoomRowMenuItems } from './RoomRowMenuItems';
import { RoomMembersDialog, type MembersDialogIntent } from './RoomMembersDialog';
import { RoomTopicDialog } from './RoomTopicDialog';
import type { AgentPickerCandidate } from './AgentChipPicker';

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
  agents: AgentPickerCandidate[];
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
  const committedRef = useRef(false);

  const markRead = useMarkRoomReadNow();
  const updateRoom = useUpdateRoom();

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

  const commitRename = () => {
    // First Enter/Escape decides; everything after is a no-op — guards
    // double-Enter and the blur that follows a commit.
    if (committedRef.current) return;
    committedRef.current = true;
    setIsRenaming(false);
    const trimmed = renameValue.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_NAME || trimmed === room.title) return;
    updateRoom.mutate(
      { roomId: room.id, patch: { title: trimmed } },
      { onError: (err) => toast.error(err.message || `Couldn't rename ${title}`) }
    );
  };

  const cancelRename = () => {
    committedRef.current = true;
    setIsRenaming(false);
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
    updateRoom.mutate(
      { roomId: room.id, patch: { archived: true } },
      {
        // Archive is the honest verb only if it is genuinely reversible, and
        // nothing else in the cockpit un-archives a room yet — so the undo
        // ships with the action rather than waiting for a screen to hold it.
        onSuccess: () =>
          toast.success(`${title} archived`, {
            action: {
              label: 'Undo',
              onClick: () =>
                updateRoom.mutate(
                  { roomId: room.id, patch: { archived: false } },
                  {
                    onError: (err) => toast.error(err.message || `Couldn't bring ${title} back`),
                  }
                ),
            },
          }),
        onError: (err) => toast.error(err.message || `Couldn't archive ${title}`),
      }
    );
  };

  const handleMarkRead = () =>
    markRead.mutate(room.id, {
      onError: (err) => toast.error(err.message || `Couldn't mark ${title} as read`),
    });

  // Only a one-to-one names an unambiguous agent. `participants` is carried for
  // direct messages and `null` for anything else, and the agent is matched on
  // its `agentRef` — the stable handle derived from its directory — never on a
  // display name, which two agents can share.
  const agentParticipants = (room.participants ?? []).filter((p) => p.kind === 'agent');
  const soleAgentRef = agentParticipants.length === 1 ? agentParticipants[0]!.agentRef : undefined;
  const soleAgentPath =
    soleAgentRef === undefined
      ? null
      : (agents.find((a) => agentAuthorRef(a.agentPath) === soleAgentRef)?.agentPath ?? null);

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
                  className={cn(
                    'bg-background text-foreground',
                    'focus-visible:ring-ring min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-1'
                  )}
                />
              </div>
            ) : (
              <button
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
