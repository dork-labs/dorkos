import { useCallback, useMemo } from 'react';
import { motion, AnimatePresence, type Variants } from 'motion/react';
import { Plus, MoreHorizontal } from 'lucide-react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Session } from '@dorkos/shared/types';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import {
  SidebarMenuItem,
  SidebarMenuAction,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from '@/layers/shared/ui';
import { useIsMobile } from '@/layers/shared/model';
import { useAgentVisual, AgentIdentity } from '@/layers/entities/agent';
import { useAgentHottestStatus, usePulseMotion, SessionRow } from '@/layers/entities/session';
import { AgentContextMenu } from './AgentContextMenu';
import { AgentRowMenuItems } from './AgentRowMenuItems';
import { AgentActivityBadge } from './AgentActivityBadge';

/** Maximum sessions shown in the expanded agent preview. */
const MAX_PREVIEW_SESSIONS = 3;

// ── Expand/collapse orchestration ──
// Panel is always-mounted (height driven by variants); rows use AnimatePresence
// so they animate on mount whether they arrive during expansion or load late.

/** Outer wrapper — springs the height open/closed. */
const panelVariants: Variants = {
  expanded: {
    height: 'auto',
    transition: { type: 'spring', stiffness: 500, damping: 35, mass: 0.8 },
  },
  collapsed: {
    height: 0,
    transition: { type: 'spring', stiffness: 600, damping: 40, mass: 0.8 },
  },
};

/** Delay before the first row starts animating (seconds). */
const ROW_INITIAL_DELAY = 0.06;
/** Stagger between consecutive rows (seconds). */
const ROW_STAGGER = 0.04;

interface AgentListItemProps {
  path: string;
  agent: AgentManifest | null;
  /** Disambiguated display name (computed by parent to resolve duplicates). */
  displayName?: string;
  isActive: boolean;
  isExpanded: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  /** Open agent profile in the right panel hub. */
  onOpenProfile: () => void;
  /** Open the inline group-create flow, moving this agent into the new group on commit. */
  onRequestNewGroup: (agentPath: string) => void;
  /** Recent sessions for this agent (only needed when expanded). */
  sessions: Session[];
  /** True while the initial sessions fetch is in-flight (no cached data yet). */
  isLoadingSessions: boolean;
  activeSessionId: string | null;
  onSessionClick: (sessionId: string) => void;
  onNewSession: () => void;
  /** Fork a session by ID. When provided, fork option appears in session context menus. */
  onForkSession?: (sessionId: string) => void;
  /** Rename a session. When provided, rename option appears in session context menus. */
  onRenameSession?: (sessionId: string, title: string) => void;
}

/**
 * Expandable agent row in the unified dashboard sidebar.
 *
 * - Click inactive agent: selects it and opens most recent session
 * - Click active agent: toggles expand/collapse
 * - Expanded view: recent sessions and new session action
 * - Right-click / long-press: context menu (AgentContextMenu)
 * - `...` button: DropdownMenu with agent actions (hover-reveal on desktop)
 */
export function AgentListItem({
  path,
  agent,
  displayName: displayNameProp,
  isActive,
  isExpanded,
  onSelect,
  onToggleExpand,
  onOpenProfile,
  onRequestNewGroup,
  sessions,
  isLoadingSessions,
  activeSessionId,
  onSessionClick,
  onNewSession,
  onForkSession,
  onRenameSession,
}: AgentListItemProps) {
  const isMobile = useIsMobile();
  const visual = useAgentVisual(agent, path);
  const displayName =
    displayNameProp ?? getAgentDisplayName(agent, path.split('/').pop() ?? 'Agent');
  const previewSessions = sessions.slice(0, MAX_PREVIEW_SESSIONS);
  const showExpanded = isActive && isExpanded;

  // Aggregate status across all sessions for left-border indicator. The path
  // enables fleet-wide cwd matching: collapsed agents receive sessions=[] from
  // the parent, but session_status fan-outs carry each live session's cwd.
  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions]);
  const agentStatus = useAgentHottestStatus(sessionIds, path);
  // Use the agent's identity color as the left border when active + idle,
  // giving a strong "you are here" signal that matches the agent's visual.
  const effectiveBorderColor =
    agentStatus.kind === 'idle' && isActive ? visual.color : agentStatus.color;

  const { animate: borderAnimate, transition: borderTransition } = usePulseMotion(
    agentStatus.pulse,
    agentStatus.color,
    agentStatus.dimColor
  );

  const handleRowClick = useCallback(() => {
    if (isActive) {
      onToggleExpand();
    } else {
      onSelect();
    }
  }, [isActive, onSelect, onToggleExpand]);

  return (
    <SidebarMenuItem>
      <motion.div
        animate={borderAnimate}
        transition={borderTransition}
        style={agentStatus.pulse ? undefined : { borderLeftColor: effectiveBorderColor }}
        className="rounded-md border-l-2"
      >
        <AgentContextMenu
          path={path}
          onOpenProfile={onOpenProfile}
          onNewSession={onNewSession}
          onRequestNewGroup={onRequestNewGroup}
        >
          <div
            data-slot="agent-list-item"
            onClick={handleRowClick}
            className={cn(
              'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium transition-all duration-100 active:scale-[0.98]',
              isActive
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <span className="min-w-0 flex-1">
              <AgentIdentity {...visual} name={displayName} size="xs" />
            </span>
            <AgentActivityBadge status={agentStatus.kind} label={agentStatus.label} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuAction
                  showOnHover={!isMobile}
                  aria-label="Agent actions"
                  onClick={(e) => e.stopPropagation()}
                >
                  <MoreHorizontal className="size-4" />
                </SidebarMenuAction>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="right" align="start" className="w-48">
                <AgentRowMenuItems
                  variant="dropdown"
                  path={path}
                  onOpenProfile={onOpenProfile}
                  onNewSession={onNewSession}
                  onRequestNewGroup={onRequestNewGroup}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </AgentContextMenu>

        <motion.div
          animate={showExpanded ? 'expanded' : 'collapsed'}
          initial={false}
          variants={panelVariants}
          className={cn('overflow-hidden', !showExpanded && 'pointer-events-none')}
          aria-hidden={!showExpanded}
        >
          <div className="bg-accent/30 space-y-0.5 py-1 pl-3">
            <AnimatePresence>
              {showExpanded && isLoadingSessions && previewSessions.length === 0 && (
                <motion.div
                  key="loading"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1, transition: { duration: 0.2, delay: ROW_INITIAL_DELAY } }}
                  exit={{ opacity: 0, transition: { duration: 0.1 } }}
                >
                  <div className="text-muted-foreground/30 px-2.5 py-1.5 text-[11px]">
                    <span className="animate-pulse">Loading&hellip;</span>
                  </div>
                </motion.div>
              )}

              {showExpanded && !isLoadingSessions && previewSessions.length === 0 && (
                <motion.div
                  key="first-session"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: {
                      opacity: { duration: 0.15, ease: [0.0, 0.0, 0.2, 1] },
                      y: { type: 'spring', stiffness: 500, damping: 30 },
                      delay: ROW_INITIAL_DELAY,
                    },
                  }}
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                >
                  <div className="flex items-center gap-2 px-2.5 py-1.5">
                    <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
                      #1
                    </span>
                    <span className="text-muted-foreground/50 text-[11px]">First session</span>
                  </div>
                </motion.div>
              )}

              {showExpanded &&
                previewSessions.map((session, i) => (
                  <motion.div
                    key={session.id}
                    initial={{ opacity: 0, y: -6 }}
                    animate={{
                      opacity: 1,
                      y: 0,
                      transition: {
                        opacity: { duration: 0.15, ease: [0.0, 0.0, 0.2, 1] },
                        y: { type: 'spring', stiffness: 500, damping: 30 },
                        delay: ROW_INITIAL_DELAY + i * ROW_STAGGER,
                      },
                    }}
                    exit={{
                      opacity: 0,
                      y: -6,
                      transition: {
                        duration: 0.1,
                        delay: (previewSessions.length - 1 - i) * 0.025,
                      },
                    }}
                  >
                    <SessionRow
                      variant="compact"
                      session={session}
                      isActive={session.id === activeSessionId}
                      onClick={() => onSessionClick(session.id)}
                      onFork={onForkSession}
                      onRename={onRenameSession}
                    />
                  </motion.div>
                ))}

              {showExpanded && previewSessions.length > 0 && (
                <motion.div
                  key="new-session-btn"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: {
                      opacity: { duration: 0.15, ease: [0.0, 0.0, 0.2, 1] },
                      y: { type: 'spring', stiffness: 500, damping: 30 },
                      delay: ROW_INITIAL_DELAY + previewSessions.length * ROW_STAGGER,
                    },
                  }}
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewSession();
                    }}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors duration-100"
                  >
                    <Plus className="size-(--size-icon-xs)" />
                    New session
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </motion.div>
      </motion.div>
    </SidebarMenuItem>
  );
}
