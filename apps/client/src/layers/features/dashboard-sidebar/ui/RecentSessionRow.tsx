import { useMemo } from 'react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Session } from '@dorkos/shared/types';
import { cn, formatRelativeTime } from '@/layers/shared/lib';
import { useNow } from '@/layers/shared/model';
import { SidebarMenuItem } from '@/layers/shared/ui';
import { useAgentVisual, AgentAvatar } from '@/layers/entities/agent';
import { sessionDisplayTitle } from '@/layers/entities/session';

interface RecentSessionRowProps {
  /** Session to resume on click. */
  session: Session;
  /** Owning agent manifest (for glyph + color), or null when unregistered. */
  agent: AgentManifest | null;
  /** Disambiguated display name of the owning agent (tooltip / a11y). */
  displayName: string;
  /** Resume the session. */
  onClick: () => void;
}

/**
 * One row in the sidebar's "Recent" section: the owning agent's glyph, the
 * session title, and a relative timestamp. Clicking resumes the session.
 */
export function RecentSessionRow({ session, agent, displayName, onClick }: RecentSessionRowProps) {
  const visual = useAgentVisual(agent, session.cwd ?? displayName);
  const now = useNow(60_000);
  const relativeTime = useMemo(
    () => formatRelativeTime(session.updatedAt),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session.updatedAt, now]
  );

  return (
    <SidebarMenuItem>
      <button
        type="button"
        onClick={onClick}
        title={`${displayName} · ${sessionDisplayTitle(session.title)}`}
        className={cn(
          'text-muted-foreground hover:bg-accent hover:text-foreground',
          'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors duration-100 active:scale-[0.98]'
        )}
      >
        <AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />
        <span className="min-w-0 flex-1 truncate">{sessionDisplayTitle(session.title)}</span>
        <span className="text-muted-foreground/60 shrink-0 text-[10px]">{relativeTime}</span>
      </button>
    </SidebarMenuItem>
  );
}
