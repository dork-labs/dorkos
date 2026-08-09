import { useState } from 'react';
import { Hash, Plus } from 'lucide-react';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import {
  SectionHeader,
  SidebarGroup,
  SidebarGroupAction,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/layers/shared/ui';
import { useRovingFocus } from '@/layers/shared/model';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  setChannelsCollapsed,
} from '@/layers/entities/config';
import { ChannelCreateDialog } from '@/layers/features/room-management';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import type { SidebarItemVisual } from '../../model/sidebar-item';
import { useMarkRoomsRead } from '../../model/use-mark-rooms-read';
import { buildChannelsHeaderMenuNodes } from '../SectionHeaderMenuItems';
import {
  Droppable,
  Sortable,
  SortableList,
  sidebarDndData,
  sidebarRowDndId,
} from '../dnd/SidebarDndPrimitives';
import { RoomRow } from './RoomRow';

/** This section's own name, as the drag layer announces it. */
const SECTION_LABEL = 'Channels';

/** Skeleton rows shown while the first room list loads. */
const SKELETON_ROWS = 2;

interface ChannelsSectionProps {
  /**
   * Channels that are in no group, alphabetically. Grouped channels render in
   * their group instead — a channel lives in exactly one place, the same rule
   * the Agents section has always followed (sidebar-groups §4).
   */
  channels: RoomSummary[];
  /** Whether any channel is in a group, which changes what an empty list means. */
  hasGroupedChannels: boolean;
  /**
   * Every channel with unread, grouped ones included — so "Mark all channels
   * read" means all of them and not just the ones this section happens to draw.
   */
  unreadChannelIds: string[];
  /** The mark to draw for a channel — a `#` sigil, from the item view model. */
  visualOf: (room: RoomSummary) => SidebarItemVisual;
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
  /** Open the inline group-create flow, moving the chosen channel into it on commit. */
  onRequestNewGroup: (ref: SidebarItemRef) => void;
}

/**
 * The sidebar's "Channels" section: every ungrouped conversation with a `#name`,
 * one click from open, with an unread count when you are behind.
 *
 * Collapsible and persisted via `ui.sidebar.channelsCollapsed`. The section is
 * always present, empty or not — a person who has never made a channel should
 * still be able to find out that they can.
 *
 * **Empty means two different things and says so.** With no channels at all, the
 * empty state is the invitation to make one. With channels that are all filed
 * into groups, that invitation is simply false, and telling someone to create
 * their first channel when they have five of them a few pixels away reads as a
 * bug in the sidebar.
 *
 * The "+" opens {@link ChannelCreateDialog} rather than an inline row, because
 * naming a channel and picking who is in it is one step and a picker does not
 * fit in a sidebar's width (spec `rooms` §14.2).
 */
export function ChannelsSection({
  channels,
  hasGroupedChannels,
  unreadChannelIds,
  visualOf,
  isLoading,
  error,
  activeRoomId,
  onSelectRoom,
  onOpenAgentProfile,
  onRequestNewGroup,
}: ChannelsSectionProps) {
  const { channelsCollapsed } = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();
  const [creating, setCreating] = useState(false);
  const markRoomsRead = useMarkRoomsRead();

  const toggleCollapsed = () =>
    update((prev) => setChannelsCollapsed(prev, !prev.channelsCollapsed));
  const roving = useRovingFocus({
    onCollapse: () => !channelsCollapsed && toggleCollapsed(),
    onExpand: () => channelsCollapsed && toggleCollapsed(),
  });

  return (
    <SidebarGroup className="px-0">
      <SectionHeader
        label="Channels"
        icon={Hash}
        collapsed={channelsCollapsed}
        onToggle={toggleCollapsed}
        controlsId="sidebar-section-channels"
        hasSectionAction
        nodes={buildChannelsHeaderMenuNodes({
          collapsed: channelsCollapsed,
          hasUnread: unreadChannelIds.length > 0,
          onNewChannel: () => setCreating(true),
          onMarkAllRead: () => markRoomsRead(unreadChannelIds),
          onToggleCollapsed: toggleCollapsed,
        })}
      />
      <SidebarGroupAction
        className="right-2"
        aria-label="New channel"
        onClick={() => setCreating(true)}
      >
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
        // A drop zone as well as a list: this is where a channel lands when it
        // is dragged back out of a group (rooms-in-groups, DOR-581).
        <Droppable
          id="container::channels"
          data={{ type: 'container', container: { kind: 'ungrouped', section: SECTION_LABEL } }}
        >
          <SidebarMenu id="sidebar-section-channels" {...roving}>
            {isLoading && channels.length === 0 ? (
              Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <SidebarMenuSkeleton key={`channel-skeleton-${i}`} showIcon />
              ))
            ) : error ? (
              <SidebarMenuItem>
                <p className="text-sidebar-foreground/60 px-2 py-1.5 text-xs">
                  Couldn&apos;t load your channels. They&apos;re still there — reload to try again.
                </p>
              </SidebarMenuItem>
            ) : (
              <>
                <SortableList
                  items={channels.map((room) =>
                    sidebarRowDndId('ungrouped', { kind: 'room', roomId: room.id })
                  )}
                >
                  {channels.map((room) => {
                    const ref: SidebarItemRef = { kind: 'room', roomId: room.id };
                    return (
                      <Sortable
                        key={room.id}
                        id={sidebarRowDndId('ungrouped', ref)}
                        data={sidebarDndData('ungrouped', ref, SECTION_LABEL)}
                      >
                        {(bindings) => (
                          <RoomRow
                            room={room}
                            visual={visualOf(room)}
                            isActive={room.id === activeRoomId}
                            onSelect={() => onSelectRoom(room)}
                            onOpenAgentProfile={onOpenAgentProfile}
                            onRequestNewGroup={onRequestNewGroup}
                            sortable={bindings}
                          />
                        )}
                      </Sortable>
                    );
                  })}
                </SortableList>

                {channels.length === 0 && (
                  <SidebarMenuItem>
                    <p className="text-sidebar-foreground/60 px-2 py-1.5 text-xs">
                      {hasGroupedChannels
                        ? 'Your channels are all in groups above.'
                        : 'No channels yet — create one to get a few agents talking in the same place.'}
                    </p>
                  </SidebarMenuItem>
                )}
              </>
            )}
          </SidebarMenu>
        </Droppable>
      )}
    </SidebarGroup>
  );
}
