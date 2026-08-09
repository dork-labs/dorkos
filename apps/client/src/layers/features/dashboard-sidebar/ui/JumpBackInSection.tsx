import { useEffect, useState } from 'react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
import type { JumpBackInItem, JumpBackInSessionItem } from '@/layers/entities/recents';
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
} from '@/layers/shared/ui';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  setRecentsCollapsed,
} from '@/layers/entities/config';
import { SidebarSectionHeader } from './SidebarSectionHeader';
import { buildJumpBackInHeaderMenuNodes } from './SectionHeaderMenuItems';
import { JumpBackInRoomRow, JumpBackInSessionRow } from './JumpBackInRow';
import type { SidebarItemVisual } from '../model/sidebar-item';

/** Skeleton rows shown while the first answer is still on its way. */
const SKELETON_ROWS = 3;

interface JumpBackInSectionProps {
  /** The threads to offer, most recently active first (already capped). */
  items: JumpBackInItem[];
  /** Sessions somebody else started, kept behind the reveal row. */
  automated: JumpBackInSessionItem[];
  /** True while the sources are loading with nothing cached. */
  isLoading: boolean;
  /** Per-runtime degradation from the session fan-out; logged to the console only. */
  warnings?: SessionListWarning[];
  /** Agent manifests keyed by projectPath (for session-row glyphs). */
  agents: Record<string, AgentManifest | null>;
  /** Disambiguated display names keyed by projectPath. */
  displayNames: Record<string, string>;
  /** The mark to draw for a room, from the sidebar's item view model. */
  visualOf: (room: RoomSummary) => SidebarItemVisual;
  /**
   * Which room is on screen, so the matching row reads as current. `null` when
   * the reader is not in a room — the same shape every other room section takes.
   */
  activeRoomId?: string | null;
  /** Which session is on screen, for the same reason. */
  activeSessionId?: string | null;
  /** Resume a session. */
  onSelectSession: (session: Session) => void;
  /** Open a room. */
  onSelectRoom: (room: RoomSummary) => void;
  /** Start a new session, from the header menu. */
  onNewSession: () => void;
}

/**
 * The "Jump back in" section: the last few threads this person was in —
 * sessions, direct messages and channels together — one click from where they
 * left off.
 *
 * It replaces the old "Recent" section, which only ever knew about agent
 * chats: a person who spent their morning in `#general` and their afternoon in
 * a DM saw neither, and the one list that claimed to be about "what you were
 * doing" was about a third of it.
 *
 * Collapsible, persisted under the same `ui.sidebar.recentsCollapsed` key the
 * section it replaces used — the preference is "is my recents list open", and
 * that fact did not change when the list learned about rooms.
 *
 * **Rooms appear here AND in their own sections, on purpose.** This is a
 * shortcut ordered by time, not a home: Channels stays alphabetical so it stops
 * moving, and a shortcut that hid the row from its home would make the sidebar
 * rearrange itself as people talk (`use-rooms.ts`).
 *
 * Automated runs — a room's own turn, a scheduled task, a bridged Telegram
 * chat, one agent calling another — stay behind the reveal row rather than
 * taking rows in the list. They are not threads you were in, and the room or
 * task that started them is already here under its own name.
 *
 * Muted rooms are absent entirely, not dimmed: mute means "stop pulling me back
 * into this", and pulling you back into things is all this list does. The room
 * keeps its dimmed row in its own section.
 *
 * The section draws nothing at all when there is nothing to jump back into,
 * which is the whole visibility rule: an empty shortcut list is a header with
 * no purpose.
 */
export function JumpBackInSection({
  items,
  automated,
  isLoading,
  warnings,
  agents,
  displayNames,
  visualOf,
  activeRoomId = null,
  activeSessionId = null,
  onSelectSession,
  onSelectRoom,
  onNewSession,
}: JumpBackInSectionProps) {
  const { recentsCollapsed } = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();
  const [automatedExpanded, setAutomatedExpanded] = useState(false);

  // Degradation stays calm in the UI — surface it to the console only.
  useEffect(() => {
    if (warnings && warnings.length > 0) {
      console.warn('[jump-back-in] partial results', warnings);
    }
  }, [warnings]);

  const resolveAgent = (session: Session) => (session.cwd && agents[session.cwd]) || null;
  const resolveDisplayName = (session: Session) =>
    (session.cwd && displayNames[session.cwd]) || session.cwd?.split('/').pop() || 'Agent';

  const renderSessionRow = (item: JumpBackInSessionItem) => (
    <JumpBackInSessionRow
      key={`session-${item.id}`}
      item={item}
      agent={resolveAgent(item.session)}
      displayName={resolveDisplayName(item.session)}
      isActive={item.id === activeSessionId}
      onClick={() => onSelectSession(item.session)}
    />
  );

  const toggleCollapsed = () => update((prev) => setRecentsCollapsed(prev, !prev.recentsCollapsed));

  // Nothing to offer and nothing on its way: no header, no empty state. Every
  // other section is a place that exists whether or not it has anything in it;
  // this one is a shortcut, and a shortcut to nowhere is chrome.
  if (!isLoading && items.length === 0 && automated.length === 0) return null;

  return (
    <SidebarGroup>
      <SidebarSectionHeader
        label="Jump back in"
        collapsed={recentsCollapsed}
        onToggle={toggleCollapsed}
        nodes={buildJumpBackInHeaderMenuNodes({
          collapsed: recentsCollapsed,
          onNewSession,
          onToggleCollapsed: toggleCollapsed,
        })}
      />

      {!recentsCollapsed && (
        <SidebarMenu>
          {isLoading && items.length === 0 ? (
            Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <SidebarMenuSkeleton key={`jump-back-in-skeleton-${i}`} showIcon />
            ))
          ) : (
            <>
              {items.map((item) =>
                item.kind === 'session' ? (
                  renderSessionRow(item)
                ) : (
                  <JumpBackInRoomRow
                    key={`room-${item.id}`}
                    item={item}
                    visual={visualOf(item.room)}
                    isActive={item.id === activeRoomId}
                    onClick={() => onSelectRoom(item.room)}
                  />
                )
              )}

              {automated.length > 0 && (
                <SidebarMenuItem>
                  <button
                    type="button"
                    onClick={() => setAutomatedExpanded((prev) => !prev)}
                    aria-expanded={automatedExpanded}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors duration-100"
                  >
                    {automatedExpanded ? 'Hide' : `+ ${automated.length} automated`}
                  </button>
                </SidebarMenuItem>
              )}

              {automatedExpanded && automated.map(renderSessionRow)}
            </>
          )}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
