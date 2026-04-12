import { useCallback, useMemo } from 'react';
import { motion, AnimatePresence, type TargetAndTransition, type Transition } from 'motion/react';
import { ChevronRight, Plus, ListTree, MoreHorizontal, Pin, PinOff, Settings } from 'lucide-react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { Session } from '@dorkos/shared/types';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import {
  SidebarMenuItem,
  SidebarMenuAction,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/layers/shared/ui';
import { useIsMobile } from '@/layers/shared/model';
import { useAgentVisual, AgentIdentity } from '@/layers/entities/agent';
import { useAgentHottestStatus } from '@/layers/entities/session';
import { AgentContextMenu } from './AgentContextMenu';
import { AgentActivityBadge } from './AgentActivityBadge';
import { AgentSessionPreview } from './AgentSessionPreview';

/** Maximum sessions shown in the expanded agent preview. */
const MAX_PREVIEW_SESSIONS = 3;

interface AgentListItemProps {
  path: string;
  agent: AgentManifest | null;
  /** Disambiguated display name (computed by parent to resolve duplicates). */
  displayName?: string;
  isActive: boolean;
  isExpanded: boolean;
  /** Whether this agent is currently pinned. */
  isPinned: boolean;
  onSelect: () => void;
  onToggleExpand: () => void;
  /** Toggle pin state for this agent. */
  onTogglePin: () => void;
  /** Navigate to manage this agent (e.g. session sidebar). */
  onManage: () => void;
  /** Open agent settings dialog. */
  onEditSettings: () => void;
  /** Recent sessions for this agent (only needed when expanded). */
  sessions: Session[];
  /** Total session count — available for future use. */
  totalSessionCount: number;
  activeSessionId: string | null;
  onSessionClick: (sessionId: string) => void;
  onNewSession: () => void;
  onDrillIntoSessions: () => void;
}

/**
 * Expandable agent row in the unified dashboard sidebar.
 *
 * - Click inactive agent: selects it and opens most recent session
 * - Click active agent: toggles expand/collapse
 * - Chevron: always toggles expand/collapse
 * - Expanded view: recent sessions, new session, and "Sessions" drill-down (always visible)
 * - Right-click / long-press: context menu (AgentContextMenu)
 * - `...` button: DropdownMenu with same actions (hover-reveal on desktop)
 */
export function AgentListItem({
  path,
  agent,
  displayName: displayNameProp,
  isActive,
  isExpanded,
  isPinned,
  onSelect,
  onToggleExpand,
  onTogglePin,
  onManage,
  onEditSettings,
  sessions,
  activeSessionId,
  onSessionClick,
  onNewSession,
  onDrillIntoSessions,
}: AgentListItemProps) {
  const isMobile = useIsMobile();
  const visual = useAgentVisual(agent, path);
  const displayName =
    displayNameProp ?? getAgentDisplayName(agent, path.split('/').pop() ?? 'Agent');
  const previewSessions = sessions.slice(0, MAX_PREVIEW_SESSIONS);

  // Aggregate status across all sessions for left-border indicator
  const sessionIds = useMemo(() => sessions.map((s) => s.id), [sessions]);
  const agentStatus = useAgentHottestStatus(sessionIds);
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

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!isActive) {
        onSelect();
      } else {
        onToggleExpand();
      }
    },
    [isActive, onSelect, onToggleExpand]
  );

  return (
    <SidebarMenuItem>
      <AgentContextMenu
        agentPath={path}
        isPinned={isPinned}
        onTogglePin={onTogglePin}
        onManage={onManage}
        onEditSettings={onEditSettings}
        onNewSession={onNewSession}
      >
        <motion.div
          role="button"
          tabIndex={0}
          onClick={handleRowClick}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleRowClick();
            }
          }}
          animate={borderAnimate}
          transition={borderTransition}
          style={agentStatus.pulse ? undefined : { borderLeftColor: effectiveBorderColor }}
          className={cn(
            'flex w-full cursor-pointer items-center gap-2 rounded-md border-l-2 px-2.5 py-1.5 text-xs font-medium transition-all duration-100 active:scale-[0.98]',
            isActive
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          <span className="min-w-0 flex-1">
            <AgentIdentity {...visual} name={displayName} size="xs" />
          </span>
          <AgentActivityBadge status={agentStatus.kind} label={agentStatus.label} />
          <span
            role="button"
            tabIndex={-1}
            onClick={handleChevronClick}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleChevronClick(e as unknown as React.MouseEvent);
              }
            }}
            className="text-muted-foreground/60 hover:text-muted-foreground shrink-0 rounded p-0.5 transition-colors duration-100"
            aria-label={isExpanded ? 'Collapse agent' : 'Expand agent'}
            aria-expanded={isActive ? isExpanded : undefined}
          >
            <motion.div
              animate={{ rotate: isExpanded && isActive ? 90 : 0 }}
              transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            >
              <ChevronRight className="size-(--size-icon-xs)" />
            </motion.div>
          </span>
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
              <DropdownMenuItem onClick={onTogglePin}>
                {isPinned ? (
                  <>
                    <PinOff className="mr-2 size-4" />
                    Unpin agent
                  </>
                ) : (
                  <>
                    <Pin className="mr-2 size-4" />
                    Pin agent
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onManage}>
                <ListTree className="mr-2 size-4" />
                Manage agent
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onEditSettings}>
                <Settings className="mr-2 size-4" />
                Edit settings
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onNewSession}>
                <Plus className="mr-2 size-4" />
                New session
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </motion.div>
      </AgentContextMenu>

      <AnimatePresence initial={false}>
        {isActive && isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
            className="overflow-hidden"
          >
            <div className="border-border/30 mt-1 ml-4 space-y-0.5 border-l pl-2.5">
              {previewSessions.length === 0 && (
                <p className="text-muted-foreground/50 px-2.5 py-1.5 text-[11px] italic">
                  No sessions yet
                </p>
              )}
              {previewSessions.map((session) => (
                <AgentSessionPreview
                  key={session.id}
                  session={session}
                  isActive={session.id === activeSessionId}
                  onClick={() => onSessionClick(session.id)}
                />
              ))}

              {/* New session action */}
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

              {/* Sessions drill-down — always visible in expanded view */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onDrillIntoSessions();
                }}
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors duration-100"
              >
                <ListTree className="size-(--size-icon-xs)" />
                Sessions
                <ChevronRight className="text-muted-foreground/40 ml-auto size-(--size-icon-xs)" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </SidebarMenuItem>
  );
}

/** Build stable motion props for the border pulse animation. */
function usePulseMotion(
  pulse: boolean,
  color: string,
  dimColor: string | undefined
): { animate: TargetAndTransition | undefined; transition: Transition | undefined } {
  return useMemo(() => {
    if (!pulse || !dimColor) return { animate: undefined, transition: undefined };
    return {
      animate: { borderLeftColor: [color, dimColor, color] },
      transition: {
        borderLeftColor: { duration: 2, repeat: Infinity, ease: 'easeInOut' as const },
      },
    };
  }, [pulse, color, dimColor]);
}
