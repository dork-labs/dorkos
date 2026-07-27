import { useMemo } from 'react';
import { toast } from 'sonner';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { useSidebarPrefs, useUpdateSidebarPrefs, setDmsCollapsed } from '@/layers/entities/config';
import { useRoomRosters, useStartDirectMessage } from '@/layers/entities/room';
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
  /**
   * Agent manifests keyed by projectPath. Used for the BASE name a room's roster
   * stores, which is not the disambiguated label above.
   */
  agents: Record<string, AgentManifest | null>;
  /** Which room is on screen, so the matching row reads as current. */
  activeRoomId: string | null;
  /** Open a conversation. */
  onSelectRoom: (room: RoomSummary) => void;
}

/** The name the server records for an agent author when it mints one. */
function baseAgentName(manifest: AgentManifest | null | undefined, agentPath: string): string {
  return getAgentDisplayName(manifest, agentPath.split('/').pop() ?? 'Agent');
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
  agents,
  activeRoomId,
  onSelectRoom,
}: DirectMessagesSectionProps) {
  const { dmsCollapsed } = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();
  const startDirectMessage = useStartDirectMessage();

  // Who you already have a conversation with is read off each DM's ROSTER, not
  // off its title. Two reasons: a title is editable, so it can drift from who is
  // actually in the room; and a DM whose join failed has no agent member at all,
  // so it must not tie up the agent it happens to be named after — which is how
  // a single failed request could hide an agent from this menu for good.
  //
  // The comparison is still a display name, because `AuthorRef` carries no agent
  // reference by design (spec §3 keeps `agentPath` server-side). It compares the
  // agent's BASE manifest name — the string the server stored when it minted the
  // author — rather than the sidebar's disambiguated label, which is the same
  // except in the collision case, where the disambiguated one would never match.
  const dmRoomIds = useMemo(() => dms.map((room) => room.id), [dms]);
  const rosters = useRoomRosters(dmRoomIds);

  const candidates = useMemo<DirectMessageCandidate[]>(() => {
    const taken = new Set<string>();
    for (const members of rosters.values()) {
      for (const member of members) {
        if (member.author.kind === 'agent') taken.add(member.author.displayName);
      }
    }
    return Object.entries(displayNames)
      .filter(([agentPath]) => !taken.has(baseAgentName(agents[agentPath], agentPath)))
      .map(([agentPath, displayName]) => ({ agentPath, displayName }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, [rosters, displayNames, agents]);

  const handleStart = (candidate: DirectMessageCandidate) => {
    startDirectMessage.mutate(
      { agentPath: candidate.agentPath, title: candidate.displayName },
      {
        onSuccess: (room) => onSelectRoom({ ...room, unreadCount: 0 }),
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
