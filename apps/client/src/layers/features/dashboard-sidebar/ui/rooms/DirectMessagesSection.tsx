import { toast } from 'sonner';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/layers/shared/ui';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import { useSidebarPrefs, useUpdateSidebarPrefs, setDmsCollapsed } from '@/layers/entities/config';
import { directMessageTitle, useStartDirectMessage } from '@/layers/entities/room';
import { RoomSectionHeader } from './RoomSectionHeader';
import { RoomRow } from './RoomRow';
import { NewDirectMessageMenu } from '@/layers/features/room-membership';

/** Skeleton rows shown while the first room list loads. */
const SKELETON_ROWS = 2;

interface DirectMessagesSectionProps {
  /** Direct messages, newest activity first. */
  dms: RoomSummary[];
  /** True while the room list is loading with nothing cached. */
  isLoading: boolean;
  /** Set when the room list could not be read. */
  error: unknown;
  /** Which room is on screen, so the matching row reads as current. */
  activeRoomId: string | null;
  /** Open a conversation. */
  onSelectRoom: (room: RoomSummary) => void;
  /** Open an agent's profile in the right-panel hub. */
  onOpenAgentProfile: (agentPath: string) => void;
}

/**
 * The sidebar's "Direct messages" section: one row per conversation — with one
 * agent or with several — and an unread count when you are behind.
 *
 * Collapsible and persisted via `ui.sidebar.dmsCollapsed`. Like Channels, it is
 * always present — the empty state is what tells a person the feature exists.
 */
export function DirectMessagesSection({
  dms,
  isLoading,
  error,
  activeRoomId,
  onSelectRoom,
  onOpenAgentProfile,
}: DirectMessagesSectionProps) {
  const { dmsCollapsed } = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();
  const startDirectMessage = useStartDirectMessage();

  // Every agent is offerable, always — the picker reads the fleet unfiltered. It
  // used to exclude anyone already on a DM's roster, which was how a duplicate
  // one-to-one was prevented, and which is wrong the moment a conversation can
  // hold several agents: Ana alone and Ana + Kai are different conversations,
  // and hiding Ana makes the second one unreachable.
  //
  // The guarantee it was providing did not disappear, it moved: the server
  // matches a direct message on its exact member set and answers with the room
  // you already have (`RoomService.createRoom`). That is the only place it can
  // be made correctly anyway — evaluating it here would mean holding the roster
  // of every DM, which is the per-room fetch R5 deleted.
  const handleStart = (chosen: AgentPickerCandidate[]) => {
    const title = directMessageTitle(chosen.map((c) => c.displayName));
    startDirectMessage.mutate(
      { agentPaths: chosen.map((c) => c.agentPath), title },
      {
        onSuccess: (room) =>
          onSelectRoom({
            ...room,
            unreadCount: 0,
            participants: room.members.map((member) => member.author),
          }),
        onError: (err) =>
          toast.error(err.message || `Could not start a conversation with ${title}`),
      }
    );
  };

  return (
    <SidebarGroup>
      <RoomSectionHeader
        label="Direct messages"
        collapsed={dmsCollapsed}
        onToggle={() => update((prev) => setDmsCollapsed(prev, !prev.dmsCollapsed))}
      />
      <NewDirectMessageMenu onStart={handleStart} />

      {!dmsCollapsed && (
        <SidebarMenu>
          {isLoading && dms.length === 0 ? (
            Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <SidebarMenuSkeleton key={`dm-skeleton-${i}`} showIcon />
            ))
          ) : error ? (
            <SidebarMenuItem>
              <p className="text-muted-foreground px-2.5 py-1.5 text-xs">
                Couldn&apos;t load your messages. They&apos;re still there — reload to try again.
              </p>
            </SidebarMenuItem>
          ) : (
            <>
              {dms.map((room) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  isActive={room.id === activeRoomId}
                  onSelect={() => onSelectRoom(room)}
                  onOpenAgentProfile={onOpenAgentProfile}
                />
              ))}

              {dms.length === 0 && (
                <SidebarMenuItem>
                  <p className="text-muted-foreground px-2.5 py-1.5 text-xs">
                    No messages yet — start one to talk to an agent on its own, or to a few at once.
                  </p>
                </SidebarMenuItem>
              )}
            </>
          )}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
