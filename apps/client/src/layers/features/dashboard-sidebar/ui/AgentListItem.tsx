import { useCallback, useMemo, useState } from 'react';
import { motion, AnimatePresence, type Variants } from 'motion/react';
import { Plus, MoreHorizontal, BellOff } from 'lucide-react';
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
import {
  useAgentHottestStatus,
  usePulseMotion,
  SessionRow,
  partitionSessionsByOrigin,
} from '@/layers/entities/session';
import { AgentContextMenu } from './AgentContextMenu';
import { AgentRowMenuItems } from './AgentRowMenuItems';
import { AgentActivityBadge } from './AgentActivityBadge';
import { useMenuCloseFocusGuard } from '../model/use-menu-close-focus-guard';
import type { SortableBindings } from './dnd/SidebarDndPrimitives';

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

/**
 * Barely-visible resting border color, matching the idle state's own
 * constant (`use-agent-hottest-status.ts`, `use-session-border-state.ts`) —
 * a muted row renders as if idle regardless of live session activity
 * (DOR-339 decision 4: mute owns ALL attention signals at once).
 */
const MUTED_BORDER_COLOR = 'rgba(128, 128, 128, 0.08)';

interface AgentListItemProps {
  path: string;
  agent: AgentManifest | null;
  /** Disambiguated display name (computed by parent to resolve duplicates). */
  displayName?: string;
  isActive: boolean;
  isExpanded: boolean;
  /**
   * Whether this agent is muted — individually, or via its containing
   * group's mute lens (computed once by the orchestrator so every appearance
   * of the same agent, home row or pinned copy, renders muted identically).
   * Drops the activity badge and live-work border emphasis, dims the row,
   * and shows a small mute glyph after the name; the row stays in place and
   * clickable (DOR-339).
   */
  isMuted?: boolean;
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
  /** Drag bindings applied to the row's root when the sidebar drag layer is active. */
  sortable?: SortableBindings;
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
  isMuted = false,
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
  sortable,
}: AgentListItemProps) {
  const isMobile = useIsMobile();
  const visual = useAgentVisual(agent, path);
  const displayName =
    displayNameProp ?? getAgentDisplayName(agent, path.split('/').pop() ?? 'Agent');
  // Conversations preview first, capped: automated sessions (agent/channel/task/
  // external origin) stay tucked behind the reveal row below (session-origin-legibility).
  const { conversations, automated } = useMemo(
    () => partitionSessionsByOrigin(sessions),
    [sessions]
  );
  const previewSessions = conversations.slice(0, MAX_PREVIEW_SESSIONS);
  const [automatedExpanded, setAutomatedExpanded] = useState(false);
  const showExpanded = isActive && isExpanded;

  // Aggregate status across all sessions for left-border indicator. The path
  // enables fleet-wide cwd matching: collapsed agents receive sessions=[] from
  // the parent, but session_status fan-outs carry each live session's cwd.
  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions]);
  const rawAgentStatus = useAgentHottestStatus(sessionIds, path);
  // Mute suppresses every attention-driven emphasis at once: force the
  // status this row renders from to idle-shaped, regardless of the agent's
  // real live work, so the badge (which returns null for 'idle') and the
  // pulsing/colored border both drop together (DOR-339 decision 4).
  const agentStatus = isMuted
    ? {
        kind: 'idle' as const,
        color: MUTED_BORDER_COLOR,
        pulse: false,
        label: rawAgentStatus.label,
      }
    : rawAgentStatus;
  // Use the agent's identity color as the left border when active + idle,
  // giving a strong "you are here" signal that matches the agent's visual.
  // Selection is orthogonal to mute, so this still applies to a muted row.
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

  // "New group…" mounts an inline editor; the dropdown's close-time focus
  // restore would blur (and blur-cancel) it, so that item arms this guard
  // (DOR-329). The context-menu variant guards itself inside AgentContextMenu.
  const { arm: armCloseFocusGuard, onCloseAutoFocus } = useMenuCloseFocusGuard();

  return (
    <SidebarMenuItem
      ref={sortable?.setNodeRef}
      style={sortable?.style}
      {...(sortable?.handleProps ?? {})}
      className={cn(
        sortable &&
          'focus-visible:ring-sidebar-ring rounded-md outline-hidden focus-visible:ring-2',
        sortable?.isDragging && 'opacity-40',
        sortable?.isOver && 'ring-sidebar-ring ring-2'
      )}
    >
      <motion.div
        animate={borderAnimate}
        transition={borderTransition}
        style={agentStatus.pulse ? undefined : { borderLeftColor: effectiveBorderColor }}
        className={cn('rounded-md border-l-2', isMuted && 'opacity-60')}
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
            <span className="flex min-w-0 flex-1 items-center gap-1">
              <AgentIdentity {...visual} name={displayName} size="xs" />
              {isMuted && (
                <BellOff className="text-muted-foreground/60 size-3 shrink-0" aria-label="Muted" />
              )}
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
              <DropdownMenuContent
                side="right"
                align="start"
                className="w-48"
                onCloseAutoFocus={onCloseAutoFocus}
              >
                <AgentRowMenuItems
                  variant="dropdown"
                  path={path}
                  onOpenProfile={onOpenProfile}
                  onNewSession={onNewSession}
                  onRequestNewGroup={(agentPath) => {
                    armCloseFocusGuard();
                    onRequestNewGroup(agentPath);
                  }}
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

              {showExpanded &&
                !isLoadingSessions &&
                previewSessions.length === 0 &&
                automated.length === 0 && (
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

              {showExpanded && (previewSessions.length > 0 || automated.length > 0) && (
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

              {showExpanded && automated.length > 0 && (
                <motion.div
                  key="automated-reveal"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{
                    opacity: 1,
                    y: 0,
                    transition: {
                      opacity: { duration: 0.15, ease: [0.0, 0.0, 0.2, 1] },
                      y: { type: 'spring', stiffness: 500, damping: 30 },
                      delay: ROW_INITIAL_DELAY + (previewSessions.length + 1) * ROW_STAGGER,
                    },
                  }}
                  exit={{ opacity: 0, y: -6, transition: { duration: 0.1 } }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAutomatedExpanded((prev) => !prev);
                    }}
                    aria-expanded={automatedExpanded}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors duration-100"
                  >
                    {automatedExpanded ? 'Hide' : `+ ${automated.length} automated`}
                  </button>
                </motion.div>
              )}

              {showExpanded &&
                automatedExpanded &&
                automated.slice(0, MAX_PREVIEW_SESSIONS).map((session, i) => (
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
                      transition: { duration: 0.1 },
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
            </AnimatePresence>
          </div>
        </motion.div>
      </motion.div>
    </SidebarMenuItem>
  );
}
