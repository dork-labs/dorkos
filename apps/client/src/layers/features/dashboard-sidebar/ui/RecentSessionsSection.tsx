import { useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Session } from '@dorkos/shared/types';
import type { SessionListWarning } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import { SidebarGroup, SidebarMenu, SidebarMenuSkeleton } from '@/layers/shared/ui';
import {
  useSidebarPrefs,
  useUpdateSidebarPrefs,
  setRecentsCollapsed,
} from '@/layers/entities/config';
import { RecentSessionRow } from './RecentSessionRow';

/** Most sessions the Recent section ever renders. */
const MAX_RECENT_ROWS = 5;
/** Skeleton rows shown while the recent-sessions fan-out is loading. */
const SKELETON_ROWS = 3;

interface RecentSessionsSectionProps {
  /** Most-recent sessions across every agent (already trimmed server-side). */
  sessions: Session[];
  /** True while the recent-sessions query is loading with no cached data. */
  isLoading: boolean;
  /** Per-runtime degradation from the fan-out; logged to the console only. */
  warnings?: SessionListWarning[];
  /** Agent manifests keyed by projectPath (for row glyphs). */
  agents: Record<string, AgentManifest | null>;
  /** Disambiguated display names keyed by projectPath. */
  displayNames: Record<string, string>;
  /** Resume the given session. */
  onSelectSession: (session: Session) => void;
}

/**
 * The "Recent" section: the latest sessions across all agents, one click from
 * resume. Collapsible (persisted via `ui.sidebar.recentsCollapsed`). Progressive
 * disclosure (visibility, skeletons) is decided by the orchestrator; this only
 * renders when it should be shown.
 */
export function RecentSessionsSection({
  sessions,
  isLoading,
  warnings,
  agents,
  displayNames,
  onSelectSession,
}: RecentSessionsSectionProps) {
  const { recentsCollapsed } = useSidebarPrefs();
  const { update } = useUpdateSidebarPrefs();

  // Recents degradation stays calm in the UI — surface it to the console only.
  useEffect(() => {
    if (warnings && warnings.length > 0) {
      console.warn('[recent-sessions] partial results', warnings);
    }
  }, [warnings]);

  const rows = sessions.slice(0, MAX_RECENT_ROWS);

  return (
    <SidebarGroup>
      <button
        type="button"
        onClick={() => update((prev) => setRecentsCollapsed(prev, !prev.recentsCollapsed))}
        aria-expanded={!recentsCollapsed}
        className={cn(
          'text-sidebar-foreground/70 hover:text-sidebar-foreground focus-visible:ring-sidebar-ring',
          'flex h-8 w-full items-center gap-1 rounded-md px-2 text-xs font-medium outline-hidden focus-visible:ring-2'
        )}
      >
        {recentsCollapsed ? (
          <ChevronRight className="size-3.5 shrink-0" />
        ) : (
          <ChevronDown className="size-3.5 shrink-0" />
        )}
        <span className="tracking-wider uppercase">Recent</span>
      </button>

      {!recentsCollapsed && (
        <SidebarMenu>
          {isLoading && sessions.length === 0
            ? Array.from({ length: SKELETON_ROWS }, (_, i) => (
                <SidebarMenuSkeleton key={`recent-skeleton-${i}`} showIcon />
              ))
            : rows.map((session) => (
                <RecentSessionRow
                  key={session.id}
                  session={session}
                  agent={(session.cwd && agents[session.cwd]) || null}
                  displayName={
                    (session.cwd && displayNames[session.cwd]) ||
                    session.cwd?.split('/').pop() ||
                    'Agent'
                  }
                  onClick={() => onSelectSession(session)}
                />
              ))}
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
