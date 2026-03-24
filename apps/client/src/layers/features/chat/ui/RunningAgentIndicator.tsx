import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import type { RunningAgent } from '../model/use-running-subagents';
import { AgentRunner } from './AgentRunner';

interface RunningAgentIndicatorProps {
  agents: RunningAgent[];
}

/** Maximum number of agent dots to render before showing an overflow badge. */
const MAX_VISIBLE_AGENTS = 4;

/** Persistent indicator bar showing running background agents above the chat input. */
export function RunningAgentIndicator({ agents }: RunningAgentIndicatorProps) {
  const prefersReducedMotion = useReducedMotion();

  const count = agents.length;
  const visibleAgents = agents.slice(0, MAX_VISIBLE_AGENTS);
  const overflowCount = count - MAX_VISIBLE_AGENTS;

  const totalTools = agents.reduce((sum, a) => sum + (a.toolUses ?? 0), 0);
  const maxDurationSeconds = Math.max(
    0,
    ...agents.map((a) => Math.round((a.durationMs ?? 0) / 1000))
  );

  const barTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.35, ease: [0.16, 1, 0.3, 1] as const };

  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          key="running-agent-indicator"
          role="status"
          aria-live="polite"
          aria-label={`${count} background agent${count !== 1 ? 's' : ''} running`}
          initial={{ opacity: 0, y: 6, maxHeight: 0 }}
          animate={{ opacity: 1, y: 0, maxHeight: 44 }}
          exit={{ opacity: 0, maxHeight: 0 }}
          transition={barTransition}
          className="flex items-center gap-2 rounded-lg border border-[hsl(0_0%_15%)] bg-[hsl(0_0%_6%)] px-2 py-1.5"
        >
          {/* Running figures */}
          <div className="flex items-center gap-0">
            <AnimatePresence mode="popLayout">
              {visibleAgents.map((agent, i) => (
                <motion.div
                  key={agent.taskId}
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 22, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  transition={{
                    width: { duration: 0.4, ease: [0.16, 1, 0.3, 1] },
                    opacity: { duration: 0.25 },
                  }}
                  className="shrink-0"
                >
                  <AgentRunner agent={agent} index={i} />
                </motion.div>
              ))}
            </AnimatePresence>
            {overflowCount > 0 && (
              <div className="group relative">
                <div
                  className="text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full bg-[hsl(0_0%_15%)] text-[0.625rem] font-semibold"
                  aria-label={`${overflowCount} more agents running`}
                >
                  +{overflowCount}
                </div>

                {/* Overflow tooltip listing extra agents */}
                <div
                  className={cn(
                    'pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2',
                    '-translate-x-1/2 translate-y-1 opacity-0 transition-all duration-150',
                    'group-hover:translate-y-0 group-hover:opacity-100',
                    'z-10 rounded-lg border border-[hsl(0_0%_22%)] bg-[hsl(0_0%_12%)] px-3 py-2 whitespace-nowrap',
                    'text-foreground text-[0.6875rem] shadow-[0_4px_12px_hsl(0_0%_0%/0.4)]'
                  )}
                >
                  {agents.slice(MAX_VISIBLE_AGENTS).map((agent) => (
                    <div key={agent.taskId} className="flex items-center gap-1.5 py-0.5">
                      <div
                        className="size-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: agent.color }}
                      />
                      <span className="text-[0.625rem]">{agent.description}</span>
                    </div>
                  ))}
                  <div
                    className="absolute top-full left-1/2 -translate-x-1/2"
                    style={{
                      borderWidth: 5,
                      borderStyle: 'solid',
                      borderColor: 'hsl(0 0% 22%) transparent transparent transparent',
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Label */}
          <span className="text-muted-foreground text-xs whitespace-nowrap">
            <strong className="text-foreground font-semibold">{count}</strong> agent
            {count !== 1 ? 's' : ''} running
          </span>

          {/* Stats */}
          <span className="text-muted-foreground/60 ml-auto font-mono text-[0.6875rem] whitespace-nowrap">
            {totalTools} tools &middot; {maxDurationSeconds}s
          </span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
