import { useState } from 'react';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import {
  SidebarGroup,
  SidebarGroupAction,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/layers/shared/ui';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  setChannelsCollapsed,
} from '@/layers/entities/config';
import { useCreateChannel } from '@/layers/entities/room';
import { RoomSectionHeader } from './RoomSectionHeader';
import { RoomRow } from './RoomRow';
import { ChannelCreateInput } from './ChannelCreateInput';
import type { AgentPickerCandidate } from './AgentChipPicker';

/** Skeleton rows shown while the first room list loads. */
const SKELETON_ROWS = 2;

interface ChannelsSectionProps {
  /** Channels, newest activity first. */
  channels: RoomSummary[];
  /** True while the room list is loading with nothing cached. */
  isLoading: boolean;
  /** Set when the room list could not be read. */
  error: unknown;
  /** Which room is on screen, so the matching row reads as current. */
  activeRoomId: string | null;
  /** Open a channel. */
  onSelectRoom: (room: RoomSummary) => void;
  /** Every agent in the fleet, sorted by name — what a row's "Add agents…" offers. */
  agents: AgentPickerCandidate[];
  /** Open an agent's profile in the right-panel hub. */
  onOpenAgentProfile: (agentPath: string) => void;
}

/**
 * The sidebar's "Channels" section: every conversation with a `#name`, one click
 * from open, with an unread count when you are behind.
 *
 * Collapsible and persisted via `ui.sidebar.channelsCollapsed`. The section is
 * always present, empty or not — a person who has never made a channel should
 * still be able to find out that they can.
 */
export function ChannelsSection({
  channels,
  isLoading,
  error,
  activeRoomId,
  onSelectRoom,
  agents,
  onOpenAgentProfile,
}: ChannelsSectionProps) {
  const { channelsCollapsed } = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();
  const [creating, setCreating] = useState(false);
  const createChannel = useCreateChannel();

  const handleCommit = (name: string) => {
    setCreating(false);
    createChannel.mutate(name, {
      // A channel's mark is `#`, so the list never carries its roster.
      onSuccess: (room) => onSelectRoom({ ...room, unreadCount: 0, participants: null }),
      onError: (err) => toast.error(err.message || 'Could not create that channel'),
    });
  };

  return (
    <SidebarGroup>
      <RoomSectionHeader
        label="Channels"
        collapsed={channelsCollapsed}
        onToggle={() => update((prev) => setChannelsCollapsed(prev, !prev.channelsCollapsed))}
      />
      <SidebarGroupAction aria-label="New channel" onClick={() => setCreating(true)}>
        <Plus />
      </SidebarGroupAction>

      {!channelsCollapsed && (
        <SidebarMenu>
          {creating && (
            <ChannelCreateInput onCommit={handleCommit} onCancel={() => setCreating(false)} />
          )}

          {isLoading && channels.length === 0 ? (
            Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <SidebarMenuSkeleton key={`channel-skeleton-${i}`} showIcon />
            ))
          ) : error ? (
            <SidebarMenuItem>
              <p className="text-muted-foreground px-2.5 py-1.5 text-xs">
                Couldn&apos;t load your channels. They&apos;re still there — reload to try again.
              </p>
            </SidebarMenuItem>
          ) : (
            <>
              {channels.map((room) => (
                <RoomRow
                  key={room.id}
                  room={room}
                  isActive={room.id === activeRoomId}
                  onSelect={() => onSelectRoom(room)}
                  agents={agents}
                  onOpenAgentProfile={onOpenAgentProfile}
                />
              ))}

              {channels.length === 0 && !creating && (
                <SidebarMenuItem>
                  <p className="text-muted-foreground px-2.5 py-1.5 text-xs">
                    No channels yet — create one to get a few agents talking in the same place.
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
