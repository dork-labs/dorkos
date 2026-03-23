import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import type { AgentManifest, AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import { Badge } from '@/layers/shared/ui/badge';
import { Button } from '@/layers/shared/ui/button';
import { cn } from '@/layers/shared/lib';
import { AgentDialog } from '@/layers/features/agent-settings';
import { relativeTime } from '@/layers/features/mesh/lib/relative-time';
import { SessionLaunchPopover } from './SessionLaunchPopover';
import { UnregisterAgentDialog } from './UnregisterAgentDialog';

/** Derive the last 2 path segments for a compact display. */
function truncatePath(fullPath: string): string {
  const segments = fullPath.split('/').filter(Boolean);
  return segments.length <= 2 ? fullPath : segments.slice(-2).join('/');
}

interface AgentRowProps {
  agent: AgentManifest;
  /** Filesystem path of the agent's project directory. */
  projectPath: string;
  sessionCount: number;
  healthStatus: AgentHealthStatus;
  lastActive: string | null;
}

const healthDotClass: Record<AgentHealthStatus, string> = {
  active: 'bg-emerald-500',
  inactive: 'bg-amber-500',
  stale: 'bg-muted-foreground/30',
  unreachable: 'bg-red-500',
};

/** Animation variants for the expandable detail section. */
const expandVariants = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1 },
  exit: { height: 0, opacity: 0 },
} as const;

/** Transition config for the expand/collapse animation. */
const expandTransition = { duration: 0.2, ease: [0, 0, 0.2, 1] } as const;

/**
 * Expandable two-line agent card for the fleet management list.
 * Line 1: health dot, name, runtime badge, relative last-active time, chevron.
 * Line 2: truncated path, session count badge, session launch action.
 * Expanded: full description, all capabilities, behavior/budget config, and management actions.
 */
export function AgentRow({
  agent,
  projectPath,
  sessionCount,
  healthStatus,
  lastActive,
}: AgentRowProps) {
  const [open, setOpen] = useState(false);
  const [unregisterOpen, setUnregisterOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <>
      <div className="hover:bg-accent/50 rounded-xl border px-4 py-3 transition-colors">
        {/* Collapsed: two-line card header — clicking anywhere toggles expand */}
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Card toggle; interactive children handle their own events */}
        <div className="cursor-pointer" onClick={() => setOpen((v) => !v)}>
          {/* Line 1: health dot + name + runtime badge + relative time + chevron */}
          <div className="flex items-center gap-3">
            <span
              className={cn(
                'size-2 shrink-0 rounded-full',
                healthDotClass[healthStatus],
                healthStatus === 'active' && 'animate-health-pulse'
              )}
              aria-label={`Status: ${healthStatus}`}
            />

            <span className="text-sm font-medium">{agent.name}</span>

            <Badge variant="secondary">{agent.runtime}</Badge>

            <span className="text-muted-foreground ml-auto text-xs">
              {relativeTime(lastActive)}
            </span>

            <ChevronDown
              className={cn(
                'text-muted-foreground size-4 shrink-0 transition-transform duration-200',
                open && 'rotate-180'
              )}
            />
          </div>

          {/* Line 2: truncated path + session count + session launch */}
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-muted-foreground max-w-[240px] truncate font-mono text-xs">
              {truncatePath(projectPath)}
            </span>

            {sessionCount > 0 && (
              <Badge variant="outline" className="text-xs">
                {sessionCount} active
              </Badge>
            )}

            {/* Stop propagation so clicking the popover doesn't toggle the card */}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Event boundary only */}
            <div className="ml-auto" onClick={(e) => e.stopPropagation()}>
              <SessionLaunchPopover projectPath={projectPath} />
            </div>
          </div>
        </div>

        {/* Expanded detail section — height-animated via motion */}
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="expanded"
              variants={expandVariants}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={expandTransition}
              style={{ overflow: 'hidden' }}
            >
              <div className="space-y-3 px-0 pt-3 pb-2">
                {/* Full description */}
                {agent.description && (
                  <p className="text-muted-foreground text-sm">{agent.description}</p>
                )}

                {/* All capabilities */}
                {agent.capabilities.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {agent.capabilities.map((cap) => (
                      <Badge key={cap} variant="outline" className="text-xs">
                        {cap}
                      </Badge>
                    ))}
                  </div>
                )}

                {/* Behavior config */}
                {agent.behavior && (
                  <div className="text-muted-foreground text-xs">
                    <span className="font-medium">Response mode:</span>{' '}
                    {agent.behavior.responseMode}
                    {agent.behavior.escalationThreshold != null && (
                      <span> · Escalation threshold: {agent.behavior.escalationThreshold}</span>
                    )}
                  </div>
                )}

                {/* Budget */}
                {agent.budget && (
                  <div className="text-muted-foreground text-xs">
                    <span className="font-medium">Budget:</span> max{' '}
                    {agent.budget.maxHopsPerMessage} hops · {agent.budget.maxCallsPerHour} calls/hr
                  </div>
                )}

                {/* Namespace */}
                {agent.namespace && (
                  <div className="text-muted-foreground text-xs">Namespace: {agent.namespace}</div>
                )}

                {/* Registration info */}
                <div className="text-muted-foreground text-xs">
                  Registered {new Date(agent.registeredAt).toLocaleDateString()} by{' '}
                  {agent.registeredBy}
                </div>

                {/* Management actions */}
                <div className="flex gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
                    Edit
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setUnregisterOpen(true)}
                  >
                    Unregister
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AgentDialog projectPath={projectPath} open={settingsOpen} onOpenChange={setSettingsOpen} />

      <UnregisterAgentDialog
        agentName={agent.name}
        agentId={agent.id}
        open={unregisterOpen}
        onOpenChange={setUnregisterOpen}
      />
    </>
  );
}
