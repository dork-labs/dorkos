import { useMemo, type ReactNode } from 'react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { JumpBackInRoomItem, JumpBackInSessionItem } from '@/layers/entities/recents';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import { SidebarMenuItem } from '@/layers/shared/ui';
import { AgentAvatar, useAgentVisual } from '@/layers/entities/agent';
import { hasUnread, RoomAvatar, RoomTitle } from '@/layers/entities/room';
import { SessionOriginMark } from '@/layers/entities/session';
import { sidebarItemFaces, type SidebarItemVisual } from '../model/sidebar-item';

interface JumpBackInRowShellProps {
  /** The mark at the head of the row — a face, a stack of faces, or a `#`. */
  mark: ReactNode;
  /** The thread's name. A node rather than a string so a room can bring its own. */
  label: ReactNode;
  /** The whole row in one line, for the tooltip and the accessible name. */
  title: string;
  /** One line about the last thing that happened, or `null` for no second line. */
  summary: string | null;
  /** When the thread was last active, ISO-8601. */
  lastActivityAt: string;
  /** Drawn between the name and the timestamp — an origin mark, when there is one. */
  trailing?: ReactNode;
  /** Whether this row is asking for the reader's attention (unread). */
  emphasized?: boolean;
  /** Whether this thread is the one currently on screen. */
  isActive?: boolean;
  /** Open the thread. */
  onClick: () => void;
}

/**
 * The shape every "Jump back in" row shares: a mark, a name with a relative
 * time, and — only when there is something honest to say — one line about what
 * last happened.
 *
 * Two lines rather than the one the sidebar's other rows use, and deliberately:
 * this list mixes kinds, so "#general" alone does not tell you why it is near
 * the top. The second line is what makes the ordering legible. A row with no
 * summary draws one line and no reserved space, so a quiet list stays quiet.
 */
function JumpBackInRowShell({
  mark,
  label,
  title,
  summary,
  lastActivityAt,
  trailing,
  emphasized = false,
  isActive = false,
  onClick,
}: JumpBackInRowShellProps) {
  const now = useNow(60_000);
  // A timestamp the browser cannot parse renders NOTHING rather than the string
  // "Invalid Date". Both sources are ISO-8601 by contract, so this is the
  // contract being broken — and a row that quietly drops its time is a row you
  // can still click, where one reading "Invalid Date" is a bug report.
  const relativeTime = useMemo(
    () => (Number.isNaN(Date.parse(lastActivityAt)) ? null : formatRelativeTime(lastActivityAt)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastActivityAt, now]
  );

  return (
    <SidebarMenuItem>
      <button
        type="button"
        onClick={onClick}
        title={title}
        // The same current-page contract every other sidebar row carries
        // (`RoomRow`, `AgentListItem`), so a keyboard reader is told which row
        // is the one already on screen rather than having to click to find out.
        aria-current={isActive ? 'page' : undefined}
        className={cn(
          'focus-visible:ring-sidebar-ring',
          'flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-xs outline-hidden transition-colors duration-100 focus-visible:ring-2 active:scale-[0.98]',
          isActive
            ? 'bg-sidebar-accent text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          emphasized && !isActive && 'text-foreground font-medium'
        )}
      >
        {/* Nudged down so the mark reads as centred on the FIRST line rather
            than on a two-line block whose second line may not be there. */}
        <span className="mt-px flex shrink-0 items-center">{mark}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex w-full items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {trailing}
            {relativeTime !== null && (
              <span className="text-muted-foreground/60 shrink-0 text-[10px] font-normal">
                {relativeTime}
              </span>
            )}
          </span>
          {summary !== null && (
            <span className="text-muted-foreground/70 truncate text-[11px] font-normal">
              {summary}
            </span>
          )}
        </span>
      </button>
    </SidebarMenuItem>
  );
}

interface JumpBackInSessionRowProps {
  /** The session this row opens. */
  item: JumpBackInSessionItem;
  /** Owning agent manifest (for glyph + colour), or null when unregistered. */
  agent: AgentManifest | null;
  /** Disambiguated display name of the owning agent (tooltip / a11y). */
  displayName: string;
  /** Whether this session is the one currently on screen. */
  isActive?: boolean;
  /** Resume the session. */
  onClick: () => void;
}

/**
 * One session in "Jump back in" — the owning agent's face, the session title,
 * and the last thing said in it.
 *
 * The origin mark still rides between the title and the time: automated runs
 * are reachable from the reveal row below the list, and one of them arriving
 * from Telegram should say so exactly where it always has.
 */
export function JumpBackInSessionRow({
  item,
  agent,
  displayName,
  isActive = false,
  onClick,
}: JumpBackInSessionRowProps) {
  const visual = useAgentVisual(agent, item.session.cwd ?? displayName);

  return (
    <JumpBackInRowShell
      mark={<AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />}
      label={item.name}
      title={`${displayName} · ${item.name}`}
      summary={item.summary}
      lastActivityAt={item.lastActivityAt}
      isActive={isActive}
      trailing={
        <SessionOriginMark
          origin={item.session.origin}
          label={item.session.originLabel}
          className="text-muted-foreground/50"
        />
      }
      onClick={onClick}
    />
  );
}

interface JumpBackInRoomRowProps {
  /** The room this row opens. */
  item: JumpBackInRoomItem;
  /**
   * The mark to draw, from the sidebar's item view model — a `#` for a channel,
   * the agent's own face for a one-to-one conversation, a stack for a group one.
   * Resolved there because only that layer sees both the room and the fleet.
   */
  visual: SidebarItemVisual;
  /** Whether this room is the one currently on screen. */
  isActive?: boolean;
  /** Open the room. */
  onClick: () => void;
}

/**
 * One room in "Jump back in" — a channel or a direct message, drawn with the
 * same mark and the same name it wears in its own section, so a reader never
 * has to work out that the two rows are the same room.
 *
 * The name goes through {@link RoomTitle} rather than the model's prose name:
 * the mark already draws the `#`, and printing it again gives `# #general`.
 */
export function JumpBackInRoomRow({
  item,
  visual,
  isActive = false,
  onClick,
}: JumpBackInRoomRowProps) {
  return (
    <JumpBackInRowShell
      mark={
        <RoomAvatar
          room={item.room}
          participants={item.room.participants}
          visuals={sidebarItemFaces(visual)}
        />
      }
      label={<RoomTitle room={item.room} />}
      title={item.summary === null ? item.name : `${item.name} · ${item.summary}`}
      summary={item.summary}
      lastActivityAt={item.lastActivityAt}
      emphasized={hasUnread(item.room)}
      isActive={isActive}
      onClick={onClick}
    />
  );
}
