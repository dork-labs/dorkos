import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import type { BackgroundTaskStatus } from '@dorkos/shared/types';
import { cn } from '@/layers/shared/lib';
import type { VisibleBackgroundTask } from '../../model/use-background-tasks';
import { AgentRunner, type AgentRunnerStatus } from './AgentRunner';
import { TaskDotSection } from './TaskDotSection';
import { TaskDetailPanel } from './TaskDetailPanel';

interface BackgroundTaskBarProps {
  /** All visible background tasks (agent and bash) returned by useBackgroundTasks. */
  tasks: VisibleBackgroundTask[];
  /** Called when the user requests to stop a task. */
  onStopTask: (taskId: string) => void;
}

/** Maximum agent runner figures before the overflow badge appears. */
const MAX_VISIBLE_AGENTS = 4;

/**
 * Collapse a background task's five statuses onto the four marks AgentRunner
 * draws.
 *
 * Only `stopped` shares: it is a real ending somebody observed, so it takes the
 * tick like `complete`. `untracked` keeps its own mark — DorkOS did not see how
 * that one ended, and both the tick and the cross would say it did (DOR-1108).
 */
function toRunnerStatus(status: BackgroundTaskStatus): AgentRunnerStatus {
  if (status === 'stopped') return 'complete';
  return status;
}

const barTransitionEase = [0.16, 1, 0.3, 1] as const;

const agentEnterTransition = {
  width: { duration: 0.4, ease: barTransitionEase },
  opacity: { duration: 0.25 },
} as const;

/**
 * Unified background-task bar — renders agent runner figures, bash task dots,
 * an expand toggle, and a detail panel in a single dismissable bar above the
 * chat input.
 *
 * Agent tasks are represented as animated SVG running figures via AgentRunner.
 * Bash tasks are represented as pulsing dots via TaskDotSection (task #17).
 * The expand toggle reveals per-task chips via TaskDetailPanel (task #18).
 */
export function BackgroundTaskBar({ tasks, onStopTask }: BackgroundTaskBarProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  const agentTasks = tasks.filter((t) => t.taskType === 'agent');
  const bashTasks = tasks.filter((t) => t.taskType === 'bash');
  const count = tasks.length;

  const visibleAgents = agentTasks.slice(0, MAX_VISIBLE_AGENTS);
  const overflowAgentCount = agentTasks.length - MAX_VISIBLE_AGENTS;

  const totalTools = agentTasks.reduce((sum, t) => sum + (t.toolUses ?? 0), 0);
  const maxDurationSeconds = Math.max(
    0,
    ...tasks.map((t) => Math.round((t.durationMs ?? 0) / 1000))
  );

  const barTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.35, ease: barTransitionEase };

  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          key="background-task-bar"
          role="status"
          aria-live="polite"
          aria-label={`${count} background task${count !== 1 ? 's' : ''} running`}
          initial={{ opacity: 0, y: 6, maxHeight: 0 }}
          animate={{ opacity: 1, y: 0, maxHeight: isExpanded ? 400 : 44 }}
          exit={{ opacity: 0, maxHeight: 0 }}
          transition={barTransition}
          className="border-border bg-card overflow-hidden rounded-lg border"
        >
          {/* Collapsed bar row */}
          <div className="flex items-center gap-2 px-2 py-1.5">
            {/* AgentRunnerSection — animated SVG figures for agent tasks */}
            {agentTasks.length > 0 && (
              <AgentRunnerSection
                visibleAgents={visibleAgents}
                overflowAgentCount={overflowAgentCount}
                allAgentTasks={agentTasks}
              />
            )}

            {/* Separator — only when both agent and bash tasks are present */}
            {agentTasks.length > 0 && bashTasks.length > 0 && (
              <div className="bg-border h-4 w-px shrink-0" />
            )}

            {bashTasks.length > 0 && <TaskDotSection bashTasks={bashTasks} />}

            {/* Task count label */}
            <span className="text-muted-foreground text-xs whitespace-nowrap">
              <strong className="text-foreground font-semibold">{count}</strong> task
              {count !== 1 ? 's' : ''} running
            </span>

            {/* Stats — tools and max duration */}
            <span className="text-muted-foreground/60 text-2xs ml-auto font-mono whitespace-nowrap">
              {totalTools > 0 && <>{totalTools} tools &middot; </>}
              {maxDurationSeconds}s
            </span>

            {/* ExpandToggle — chevron + task count */}
            <button
              type="button"
              onClick={() => setIsExpanded((prev) => !prev)}
              className="text-muted-foreground hover:text-foreground ml-1 flex shrink-0 items-center gap-1 transition-colors duration-150"
              aria-label={isExpanded ? 'Collapse task details' : 'Expand task details'}
              aria-expanded={isExpanded}
            >
              <span className="text-3xs tabular-nums">{count}</span>
              <ChevronDown
                className={cn(
                  'size-3.5 transition-transform duration-200',
                  isExpanded && 'rotate-180'
                )}
              />
            </button>
          </div>

          {/* TaskDetailPanel — chip list (task #18 will replace this placeholder) */}
          <AnimatePresence>
            {isExpanded && <TaskDetailPanel tasks={tasks} onStopTask={onStopTask} />}
          </AnimatePresence>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Internal sub-components
// ---------------------------------------------------------------------------

interface AgentRunnerSectionProps {
  visibleAgents: VisibleBackgroundTask[];
  overflowAgentCount: number;
  allAgentTasks: VisibleBackgroundTask[];
}

/** Renders animated running figures for agent tasks with an overflow badge. */
function AgentRunnerSection({
  visibleAgents,
  overflowAgentCount,
  allAgentTasks,
}: AgentRunnerSectionProps) {
  return (
    <div className="flex items-center gap-0">
      <AnimatePresence mode="popLayout">
        {visibleAgents.map((task, i) => (
          <motion.div
            key={task.taskId}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 22, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={agentEnterTransition}
            className="shrink-0"
          >
            <AgentRunner
              agent={{
                taskId: task.taskId,
                description: task.description ?? '',
                // AgentRunner knows three states and the task has five, so two
                // of them share. `error` is the only one that may draw as a
                // failure: `stopped` and `untracked` are endings, not failures —
                // and `untracked` in particular means DorkOS lost sight of the
                // task, which is not evidence that anything went wrong
                // (DOR-1108).
                status: toRunnerStatus(task.status),
                color: task.color,
                toolUses: task.toolUses,
                lastToolName: task.lastToolName,
                durationMs: task.durationMs,
                summary: task.summary,
              }}
              index={i}
            />
          </motion.div>
        ))}
      </AnimatePresence>

      {overflowAgentCount > 0 && (
        <OverflowBadge
          count={overflowAgentCount}
          overflowTasks={allAgentTasks.slice(MAX_VISIBLE_AGENTS)}
        />
      )}
    </div>
  );
}

interface OverflowBadgeProps {
  count: number;
  overflowTasks: VisibleBackgroundTask[];
}

/** Badge showing the count of agent tasks beyond MAX_VISIBLE_AGENTS with a hover tooltip. */
function OverflowBadge({ count, overflowTasks }: OverflowBadgeProps) {
  return (
    <div className="group relative">
      <div
        className="text-muted-foreground bg-muted text-3xs flex size-6 shrink-0 items-center justify-center rounded-full font-semibold"
        aria-label={`${count} more subagent${count === 1 ? '' : 's'} running`}
      >
        +{count}
      </div>

      {/* Hover tooltip listing overflow agents. Desktop-only (`hidden
          md:block`) — it needs a `:hover` no touch pointer has, and the
          tap-to-expand task list (the chevron beside the bar) already lists
          every task, overflow included, as the touch path to the same
          names. */}
      <div
        className={cn(
          'pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 hidden',
          '-translate-x-1/2 translate-y-1 opacity-0 transition-all duration-150',
          'group-hover:translate-y-0 group-hover:opacity-100',
          'border-border bg-popover z-10 rounded-lg border px-3 py-2 whitespace-nowrap',
          'text-foreground text-2xs shadow-lg md:block'
        )}
      >
        {overflowTasks.map((task) => (
          <div key={task.taskId} className="flex items-center gap-1.5 py-0.5">
            <div
              className="size-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: task.color }}
            />
            <span className="text-3xs">{task.description}</span>
          </div>
        ))}
        <div className="border-t-border absolute top-full left-1/2 -translate-x-1/2 border-5 border-transparent" />
      </div>
    </div>
  );
}
