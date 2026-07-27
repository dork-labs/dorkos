import { useMemo } from 'react';
import { toast } from 'sonner';
import { agentAuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/layers/shared/ui';
import { useSidebarPrefs, useUpdateSidebarPrefs, setDmsCollapsed } from '@/layers/entities/config';
import { useStartDirectMessage } from '@/layers/entities/room';
import { RoomSectionHeader } from './RoomSectionHeader';
import { RoomRow } from './RoomRow';
import { NewDirectMessageMenu, type DirectMessageCandidate } from './NewDirectMessageMenu';

/** Skeleton rows shown while the first room list loads. */
const SKELETON_ROWS = 2;

interface DirectMessagesSectionProps {
  /** Direct messages, newest activity first. */
  dms: RoomSummary[];
  /** True while the room list is loading with nothing cached. */
  isLoading: boolean;
  /** Set when the room list could not be read. */
  error: unknown;
  /** Disambiguated agent display names keyed by projectPath — the menu's labels. */
  displayNames: Record<string, string>;
  /** Which room is on screen, so the matching row reads as current. */
  activeRoomId: string | null;
  /** Open a conversation. */
  onSelectRoom: (room: RoomSummary) => void;
}

/**
 * The sidebar's "Direct messages" section: one row per one-to-one conversation,
 * with an unread count when you are behind.
 *
 * Collapsible and persisted via `ui.sidebar.dmsCollapsed`. Like Channels, it is
 * always present — the empty state is what tells a person the feature exists.
 */
export function DirectMessagesSection({
  dms,
  isLoading,
  error,
  displayNames,
  activeRoomId,
  onSelectRoom,
}: DirectMessagesSectionProps) {
  const { dmsCollapsed } = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();
  const startDirectMessage = useStartDirectMessage();

  // Who you already have a conversation with is read off each DM's ROSTER, not
  // off its title. Two reasons: a title is editable, so it can drift from who is
  // actually in the room; and a DM whose join failed has no agent member at all,
  // so it must not tie up the agent it happens to be named after.
  //
  // The roster rides along on the list (`RoomSummary.participants`), so this
  // costs nothing. It used to be one `GET /api/rooms/:id` per direct message,
  // fired only to answer this question.
  //
  // The comparison is `agentRef` — the stable handle the server derives from the
  // agent's directory, which this side computes from the same directory. It used
  // to compare display names, because `AuthorRef` offered nothing better; that
  // made two agents sharing a name indistinguishable here, so opening a DM with
  // one hid both.
  const candidates = useMemo<DirectMessageCandidate[]>(() => {
    const taken = new Set<string>();
    for (const room of dms) {
      for (const participant of room.participants ?? []) {
        if (participant.agentRef) taken.add(participant.agentRef);
      }
    }
    return Object.entries(displayNames)
      .filter(([agentPath]) => !taken.has(agentAuthorRef(agentPath)))
      .map(([agentPath, displayName]) => ({ agentPath, displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [dms, displayNames]);

  const handleStart = (candidate: DirectMessageCandidate) => {
    startDirectMessage.mutate(
      { agentPath: candidate.agentPath, title: candidate.displayName },
      {
        onSuccess: (room) =>
          onSelectRoom({
            ...room,
            unreadCount: 0,
            participants: room.members.map((member) => member.author),
          }),
        onError: (err) =>
          toast.error(
            err.message || `Could not start a conversation with ${candidate.displayName}`
          ),
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
      <NewDirectMessageMenu
        candidates={candidates}
        hasAnyAgents={Object.keys(displayNames).length > 0}
        onSelect={handleStart}
      />

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
                />
              ))}

              {dms.length === 0 && (
                <SidebarMenuItem>
                  <p className="text-muted-foreground px-2.5 py-1.5 text-xs">
                    No messages yet — start one to talk to a single agent on its own.
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
