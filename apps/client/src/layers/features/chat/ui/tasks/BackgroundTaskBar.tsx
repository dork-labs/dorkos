import { useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChevronDown } from 'lucide-react';
import type { BackgroundTaskStatus } from '@dorkos/shared/types';
import { cn, partitionAmbientTasks } from '@/layers/shared/lib';
import type { VisibleBackgroundTask } from '../../model/use-background-tasks';
import { AgentRunner, type AgentRunnerStatus } from './AgentRunner';
import { TaskDotSection } from './TaskDotSection';
import { TaskDetailPanel } from './TaskDetailPanel';

interface BackgroundTaskBarProps {
  /**
   * All visible background tasks (agent and bash) returned by
   * `useBackgroundTasks`, housekeeping ones included — the bar splits them
   * itself so the collapsed row and its panel cannot disagree.
   */
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

/**
 * Invisible reach on the expand toggle, sized to what the collapsed bar's row
 * actually has to give.
 *
 * The bar (`overflow-hidden`, `maxHeight: 44` collapsed) clips anything a
 * descendant's `::after` pushes past the row's own rendered box — the row's
 * real height today is the 24px `AgentRunner` SVG plus `py-1.5` (12px) =
 * 36px, comfortably under the 44px cap, so `-inset-y-2.5` (10px each side)
 * fits inside that headroom without being cut off or growing the bar.
 * `-inset-x-1` mirrors the filter-bar's half-gap budget so the reach does not
 * swallow taps meant for the "N tools · Ns" stats text beside it.
 */
const EXPAND_TOGGLE_TOUCH_REACH =
  'relative after:absolute after:-inset-x-1 after:-inset-y-2.5 md:after:hidden';

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
 *
 * Housekeeping tasks take no part in any of that: no figure, no dot, no slot in
 * the count, no share of the stats. When they are the only thing running the
 * row empties out to just the chevron — quiet, and still a way in, because the
 * expanded panel is the only place they can be seen and a bar that vanished
 * would make them unreachable rather than merely quiet. The session still reads
 * as working because the working line follows the turn in flight, not this bar.
 * One that FAILS is promoted back into everything above by `useBackgroundTasks`,
 * so nothing here has to special-case it.
 */
export function BackgroundTaskBar({ tasks, onStopTask }: BackgroundTaskBarProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  const { shown, ambient: ambientTasks } = partitionAmbientTasks(tasks);
  const agentTasks = shown.filter((t) => t.taskType === 'agent');
  const bashTasks = shown.filter((t) => t.taskType === 'bash');
  const count = shown.length;

  const visibleAgents = agentTasks.slice(0, MAX_VISIBLE_AGENTS);
  const overflowAgentCount = agentTasks.length - MAX_VISIBLE_AGENTS;

  const totalTools = agentTasks.reduce((sum, t) => sum + (t.toolUses ?? 0), 0);
  const maxDurationSeconds = Math.max(
    0,
    ...shown.map((t) => Math.round((t.durationMs ?? 0) / 1000))
  );

  const barTransition = prefersReducedMotion
    ? { duration: 0 }
    : { duration: 0.35, ease: barTransitionEase };

  // `role="status"` announces itself, which is the right thing for work the
  // person is waiting on and the wrong thing for the agent's own housekeeping.
  // With nothing to count, the bar is a labelled control and says nothing.
  const announces = count > 0;

  return (
    <AnimatePresence>
      {(count > 0 || ambientTasks.length > 0) && (
        <motion.div
          key="background-task-bar"
          {...(announces
            ? {
                role: 'status',
                'aria-live': 'polite' as const,
                'aria-label': `${count} background task${count !== 1 ? 's' : ''} running`,
              }
            : { role: 'group', 'aria-label': 'Background tasks' })}
          initial={{ opacity: 0, y: 6, maxHeight: 0 }}
          animate={{ opacity: 1, y: 0, maxHeight: isExpanded ? 400 : 44 }}
          exit={{ opacity: 0, maxHeight: 0 }}
          transition={barTransition}
          className="border-border bg-card overflow-hidden rounded-lg border"
        >
          {/* Collapsed bar row. `min-h-9` is the height an agent figure gives it
              anyway (24px SVG + 12px padding); pinned so the row does not shrink
              when housekeeping is all that is left — the expand toggle's
              invisible reach is sized to this height and the bar clips it. */}
          <div className="flex min-h-9 items-center gap-2 px-2 py-1.5">
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

            {count > 0 && (
              <>
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
              </>
            )}

            {/* ExpandToggle — chevron + task count */}
            <button
              type="button"
              onClick={() => setIsExpanded((prev) => !prev)}
              className={cn(
                'text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-1 transition-colors duration-150',
                // Pushed to the far end when the stats span that usually holds
                // that place is not drawn.
                count > 0 ? 'ml-1' : 'ml-auto',
                EXPAND_TOGGLE_TOUCH_REACH
              )}
              aria-label={isExpanded ? 'Collapse task details' : 'Expand task details'}
              aria-expanded={isExpanded}
            >
              {/* No number when there is nothing to count: the hidden tally is
                  stated inside the panel and nowhere else. */}
              {count > 0 && <span className="text-3xs tabular-nums">{count}</span>}
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
            {isExpanded && (
              <TaskDetailPanel tasks={shown} ambientTasks={ambientTasks} onStopTask={onStopTask} />
            )}
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
          md:block`) — it needs a `:hover` no touch pointer has. The
          tap-to-expand task list (the chevron beside the bar, grown by
          {@link EXPAND_TOGGLE_TOUCH_REACH}) already lists every task,
          overflow included, as the touch path to the same names. */}
      <div
        data-testid="overflow-badge-tooltip"
        className={cn(
          'pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 hidden',
          '-translate-x-1/2 translate-y-1 opacity-0 transition-[opacity,translate] duration-150',
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
