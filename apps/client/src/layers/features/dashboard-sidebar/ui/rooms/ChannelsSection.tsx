import { useState } from 'react';
import { Plus } from 'lucide-react';
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
import { ChannelCreateDialog } from '@/layers/features/room-membership';
import { RoomSectionHeader } from './RoomSectionHeader';
import { RoomRow } from './RoomRow';

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
 *
 * The "+" opens {@link ChannelCreateDialog} rather than an inline row, because
 * naming a channel and picking who is in it is one step and a picker does not
 * fit in a sidebar's width (spec `rooms` §14.2).
 */
export function ChannelsSection({
  channels,
  isLoading,
  error,
  activeRoomId,
  onSelectRoom,
  onOpenAgentProfile,
}: ChannelsSectionProps) {
  const { channelsCollapsed } = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();
  const [creating, setCreating] = useState(false);

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

      {/* Mounted only while open, so a name and a half-picked roster are
          forgotten between attempts rather than waiting there next time. */}
      {creating && (
        <ChannelCreateDialog
          open
          onOpenChange={(next) => !next && setCreating(false)}
          // A channel's mark is `#`, so the list never carries its roster.
          onCreated={(room) => onSelectRoom({ ...room, unreadCount: 0, participants: null })}
        />
      )}

      {!channelsCollapsed && (
        <SidebarMenu>
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
                  onOpenAgentProfile={onOpenAgentProfile}
                />
              ))}

              {channels.length === 0 && (
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
