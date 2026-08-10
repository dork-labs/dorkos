import { useState } from 'react';
import { toast } from 'sonner';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import { MessageSquare } from 'lucide-react';
import {
  SectionHeader,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/layers/shared/ui';
import { useRovingFocus } from '@/layers/shared/model';
import type { AgentPickerCandidate } from '@/layers/entities/agent';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  isSectionCollapsed,
  setSectionCollapsed,
} from '@/layers/entities/config';
import { directMessageTitle, useStartDirectMessage } from '@/layers/entities/room';
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import type { SidebarItemVisual } from '../../model/sidebar-item';
import { useMarkRoomsRead } from '../../model/use-mark-rooms-read';
import { buildDirectMessagesHeaderMenuNodes } from '../SectionHeaderMenuItems';
import {
  Droppable,
  Sortable,
  SortableList,
  sidebarDndData,
  sidebarRowDndId,
} from '../dnd/SidebarDndPrimitives';
import { RoomRow } from './RoomRow';
import { NewDirectMessageMenu } from '@/layers/features/room-management';

/** This section's own name, as the drag layer announces it. */
const SECTION_LABEL = 'Direct messages';

/** Skeleton rows shown while the first room list loads. */
const SKELETON_ROWS = 2;

interface DirectMessagesSectionProps {
  /**
   * Direct messages that are in no group, newest activity first. Grouped ones
   * render in their group instead — a conversation lives in exactly one place
   * (sidebar-groups §4).
   */
  dms: RoomSummary[];
  /** Whether any conversation is in a group, which changes what an empty list means. */
  hasGroupedDms: boolean;
  /**
   * Every conversation with unread, grouped ones included — so "Mark all read"
   * means all of them and not just the ones this section happens to draw.
   */
  unreadDmIds: string[];
  /** The faces to draw for a conversation, from the item view model. */
  visualOf: (room: RoomSummary) => SidebarItemVisual;
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
  /** Open the inline group-create flow, moving the chosen conversation into it on commit. */
  onRequestNewGroup: (ref: SidebarItemRef) => void;
}

/**
 * The sidebar's "Direct messages" section: one row per ungrouped conversation —
 * with one agent or with several — and an unread count when you are behind.
 *
 * Collapsible and persisted via `ui.sidebar.sections.dms`. Like Channels, it is
 * always present: the empty state is what tells a person the feature exists, and
 * it distinguishes "you have none" from "yours are all filed into groups", which
 * are the same empty list and completely different facts.
 */
export function DirectMessagesSection({
  dms,
  hasGroupedDms,
  unreadDmIds,
  visualOf,
  isLoading,
  error,
  activeRoomId,
  onSelectRoom,
  onOpenAgentProfile,
  onRequestNewGroup,
}: DirectMessagesSectionProps) {
  const dmsCollapsed = isSectionCollapsed(useSidebarPrefs(), 'dms');
  const { update } = useUpdateSidebarPrefs();
  const startDirectMessage = useStartDirectMessage();
  const markRoomsRead = useMarkRoomsRead();
  // The picker's open state lives here rather than inside the "+" it hangs off,
  // because the header menu's "New message…" opens the same panel — one state,
  // two ways in, no second picker.
  const [pickerOpen, setPickerOpen] = useState(false);

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

  const toggleCollapsed = () =>
    update((prev) => setSectionCollapsed(prev, 'dms', !isSectionCollapsed(prev, 'dms')));
  const roving = useRovingFocus({
    onCollapse: () => !dmsCollapsed && toggleCollapsed(),
    onExpand: () => dmsCollapsed && toggleCollapsed(),
  });

  return (
    <SidebarGroup className="px-0" {...roving}>
      <SectionHeader
        label="Direct messages"
        icon={MessageSquare}
        collapsed={dmsCollapsed}
        onToggle={toggleCollapsed}
        controlsId="sidebar-section-dms"
        hasSectionAction
        nodes={buildDirectMessagesHeaderMenuNodes({
          collapsed: dmsCollapsed,
          hasUnread: unreadDmIds.length > 0,
          onNewMessage: () => setPickerOpen(true),
          onMarkAllRead: () => markRoomsRead(unreadDmIds),
          onToggleCollapsed: toggleCollapsed,
        })}
      />
      <NewDirectMessageMenu open={pickerOpen} onOpenChange={setPickerOpen} onStart={handleStart} />

      {!dmsCollapsed && (
        // A drop zone as well as a list: this is where a conversation lands
        // when it is dragged back out of a group (rooms-in-groups, DOR-581).
        <Droppable
          id="container::dms"
          data={{ type: 'container', container: { kind: 'ungrouped', section: SECTION_LABEL } }}
        >
          <SidebarMenu id="sidebar-section-dms">
            {isLoading && dms.length === 0 ? (
              Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <SidebarMenuSkeleton key={`dm-skeleton-${i}`} showIcon />
              ))
            ) : error ? (
              <SidebarMenuItem>
                <p className="text-sidebar-foreground/60 px-2 py-1.5 text-xs">
                  Couldn&apos;t load your messages. They&apos;re still there — reload to try again.
                </p>
              </SidebarMenuItem>
            ) : (
              <>
                <SortableList
                  items={dms.map((room) =>
                    sidebarRowDndId('ungrouped', { kind: 'room', roomId: room.id })
                  )}
                >
                  {dms.map((room) => {
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

                {dms.length === 0 && (
                  <SidebarMenuItem>
                    <p className="text-sidebar-foreground/60 px-2 py-1.5 text-xs">
                      {hasGroupedDms
                        ? 'Your conversations are all in groups above.'
                        : 'No messages yet — start one to talk to an agent on its own, or to a few at once.'}
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
