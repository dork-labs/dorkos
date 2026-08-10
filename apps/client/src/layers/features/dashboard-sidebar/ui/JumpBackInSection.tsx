import { useEffect, useMemo, useState } from 'react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoomSummary } from '@dorkos/shared/room-schemas';
import type { Session, SessionListWarning } from '@dorkos/shared/types';
import type {
  JumpBackInItem,
  JumpBackInRoomItem,
  JumpBackInSessionItem,
} from '@/layers/entities/recents';
import { formatRelativeTime } from '@/layers/shared/lib';
import { useNow, useRovingFocus } from '@/layers/shared/model';
import {
  SectionHeader,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarRow,
} from '@/layers/shared/ui';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  isSectionCollapsed,
  setSectionCollapsed,
} from '@/layers/entities/config';
import { AgentAvatar, useAgentVisual } from '@/layers/entities/agent';
import { hasUnread, RoomAvatar, RoomTitle } from '@/layers/entities/room';
import { SessionOriginMark } from '@/layers/entities/session';
import { buildJumpBackInHeaderMenuNodes } from './SectionHeaderMenuItems';
import { sidebarItemFaces, type SidebarItemVisual } from '../model/sidebar-item';

/** Skeleton rows shown while the first answer is still on its way. */
const SKELETON_ROWS = 3;

/** How often the relative timestamps in this list re-read the clock. */
const CLOCK_TICK_MS = 60_000;

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
 * Collapsible, persisted under the same `ui.sidebar.sections.recents` key the
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
  const recentsCollapsed = isSectionCollapsed(useSidebarPrefs(), 'recents');
  const { update } = useUpdateSidebarPrefs();
  const [automatedExpanded, setAutomatedExpanded] = useState(false);
  const toggleCollapsed = () =>
    update((prev) => setSectionCollapsed(prev, 'recents', !isSectionCollapsed(prev, 'recents')));
  const roving = useRovingFocus({
    onCollapse: () => !recentsCollapsed && toggleCollapsed(),
    onExpand: () => recentsCollapsed && toggleCollapsed(),
  });

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

  // Nothing to offer and nothing on its way: no header, no empty state. Every
  // other section is a place that exists whether or not it has anything in it;
  // this one is a shortcut, and a shortcut to nowhere is chrome.
  if (!isLoading && items.length === 0 && automated.length === 0) return null;

  return (
    <SidebarGroup className="px-0" {...roving}>
      <SectionHeader
        label="Jump back in"
        collapsed={recentsCollapsed}
        onToggle={toggleCollapsed}
        controlsId="sidebar-section-jump-back-in"
        nodes={buildJumpBackInHeaderMenuNodes({
          collapsed: recentsCollapsed,
          onNewSession,
          onToggleCollapsed: toggleCollapsed,
        })}
      />

      {!recentsCollapsed && (
        <SidebarMenu id="sidebar-section-jump-back-in">
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
                    className="text-sidebar-foreground/70 hover:bg-sidebar-accent/70 hover:text-sidebar-foreground flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors duration-100"
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

/**
 * When a row was last active, as words — or nothing at all.
 *
 * A timestamp the browser cannot parse renders NOTHING rather than the string
 * "Invalid Date". Both sources are ISO-8601 by contract, so this is the
 * contract being broken — and a row that quietly drops its time is a row you
 * can still click, where one reading "Invalid Date" is a bug report.
 */
function useRelativeTime(lastActivityAt: string): string | null {
  const now = useNow(CLOCK_TICK_MS);
  return useMemo(
    () => (Number.isNaN(Date.parse(lastActivityAt)) ? null : formatRelativeTime(lastActivityAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastActivityAt, now]
  );
}

/** The relative timestamp every row in this list carries in its meta slot. */
function TimeStamp({ lastActivityAt }: { lastActivityAt: string }) {
  const relative = useRelativeTime(lastActivityAt);
  if (relative === null) return null;
  return <span className="text-sidebar-foreground/50 text-[11px] font-normal">{relative}</span>;
}

/**
 * One session in "Jump back in" — the owning agent's face, `Agent › title`, and
 * the last thing said in it.
 *
 * The attribution is the row grammar's own (BC-23), not a decoration: a session
 * belongs to an agent, the `›` says so, and the same agent with three sessions
 * makes three rows with the name repeated on purpose.
 */
function JumpBackInSessionRow({
  item,
  agent,
  displayName,
  isActive,
  onClick,
}: {
  item: JumpBackInSessionItem;
  agent: AgentManifest | null;
  displayName: string;
  isActive: boolean;
  onClick: () => void;
}) {
  const visual = useAgentVisual(agent, item.session.cwd ?? displayName);

  return (
    <SidebarRow
      glyph={<AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />}
      who={displayName}
      title={item.name}
      isActive={isActive}
      onSelect={onClick}
      preview={item.summary}
      trailing={
        <>
          {/* The origin mark rides in the meta slot and never on the avatar —
              the avatar's corners belong to identity (BC-26). */}
          <SessionOriginMark
            origin={item.session.origin}
            label={item.session.originLabel}
            className="text-sidebar-foreground/50"
          />
          <TimeStamp lastActivityAt={item.lastActivityAt} />
        </>
      }
    />
  );
}

/**
 * One room in "Jump back in" — a channel or a direct message, drawn with the
 * same mark and the same name it wears in its own section, so a reader never
 * has to work out that the two rows are the same room.
 *
 * No `who` and so no `›`: a room is the place, not a thread of one.
 *
 * The name goes through {@link RoomTitle} rather than the model's prose name:
 * the mark already draws the `#`, and printing it again gives `# #general`.
 */
function JumpBackInRoomRow({
  item,
  visual,
  isActive,
  onClick,
}: {
  item: JumpBackInRoomItem;
  visual: SidebarItemVisual;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <SidebarRow
      glyph={
        <RoomAvatar
          room={item.room}
          participants={item.room.participants}
          visuals={sidebarItemFaces(visual)}
        />
      }
      title={<RoomTitle room={item.room} />}
      titleText={item.name}
      isActive={isActive}
      emphasized={hasUnread(item.room)}
      onSelect={onClick}
      preview={item.summary}
      trailing={<TimeStamp lastActivityAt={item.lastActivityAt} />}
    />
  );
}
