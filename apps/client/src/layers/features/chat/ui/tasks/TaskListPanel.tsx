import { useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { TaskItem } from '@dorkos/shared/types';
import { cn, COLLAPSE_TRANSITION, COLLAPSE_VARIANTS } from '@/layers/shared/lib';
import { TaskProgressHeader } from './TaskProgressHeader';
import { TaskActiveForm } from './TaskActiveForm';
import { TaskRow } from './TaskRow';

interface TaskListPanelProps {
  tasks: TaskItem[];
  taskMap: Map<string, TaskItem>;
  activeForm: string | null;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  celebratingTaskId?: string | null;
  onCelebrationComplete?: () => void;
  statusTimestamps: Map<string, { status: string; since: number }>;
}

function isTaskBlocked(task: TaskItem, taskMap: Map<string, TaskItem>): boolean {
  if (!task.blockedBy?.length) return false;
  return task.blockedBy.some((depId) => {
    const dep = taskMap.get(depId);
    return dep && dep.status !== 'completed';
  });
}

const MAX_VISIBLE = 10;

/**
 * How much of the screen the open plan may take before it scrolls itself.
 *
 * The plan sits between the transcript and the composer, so every pixel it
 * spends is a pixel of conversation. `PinnedTriageHeaderView` measured the same
 * zone once already: at 375×812 the masthead, composer and presence line spend
 * ~180px, so a half-screen panel leaves the conversation under a third of the
 * phone. Ten rows plus the progress header did exactly that. Capped here, a
 * ten-item plan scrolls inside its own box instead of pushing the conversation
 * off the screen.
 */
const PLAN_MAX_HEIGHT = 'max-h-[30svh] sm:max-h-[40svh]';

/** Orchestrator composing progress header, active form, and task rows with dependency visualization. */
export function TaskListPanel({
  tasks,
  taskMap,
  activeForm,
  isCollapsed,
  onToggleCollapse,
  celebratingTaskId,
  onCelebrationComplete,
  statusTimestamps,
}: TaskListPanelProps) {
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null);

  const handleToggleExpand = useCallback((taskId: string) => {
    setExpandedTaskId((prev) => (prev === taskId ? null : taskId));
  }, []);

  const handleScrollToTask = useCallback((taskId: string) => {
    const el = document.querySelector(`[data-task-id="${taskId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      el.classList.add('bg-blue-500/10');
      setTimeout(() => el.classList.remove('bg-blue-500/10'), 1000);
    }
  }, []);

  if (tasks.length === 0) return null;

  const visibleTasks = tasks.slice(0, MAX_VISIBLE);

  // Pre-compute hover highlights
  const hoveredTask = hoveredTaskId ? taskMap.get(hoveredTaskId) : null;

  return (
    <div className="border-t px-4 py-2">
      <TaskActiveForm activeForm={activeForm} isCollapsed={isCollapsed} />

      <TaskProgressHeader
        tasks={tasks}
        isCollapsed={isCollapsed}
        onToggleCollapse={onToggleCollapse}
      />

      <AnimatePresence>
        {!isCollapsed && (
          <motion.ul
            variants={COLLAPSE_VARIANTS}
            initial="initial"
            animate="animate"
            exit="exit"
            transition={COLLAPSE_TRANSITION}
            className={cn('mt-1 space-y-0.5 overflow-y-auto', PLAN_MAX_HEIGHT)}
          >
            {visibleTasks.map((task) => {
              const isCelebrating = task.id === celebratingTaskId && task.status === 'completed';
              const blocked = isTaskBlocked(task, taskMap);
              const timestamp = statusTimestamps.get(task.id);

              // Hover highlight computation
              const isHighlightedAsDep = hoveredTask?.blockedBy?.includes(task.id) ?? false;
              const isHighlightedAsDependent = hoveredTask?.blocks?.includes(task.id) ?? false;

              return (
                <TaskRow
                  key={task.id}
                  task={task}
                  isBlocked={blocked}
                  isExpanded={expandedTaskId === task.id}
                  onToggleExpand={() => handleToggleExpand(task.id)}
                  onHover={setHoveredTaskId}
                  isHighlightedAsDep={isHighlightedAsDep}
                  isHighlightedAsDependent={isHighlightedAsDependent}
                  taskMap={taskMap}
                  statusSince={timestamp?.since ?? null}
                  isCelebrating={isCelebrating}
                  onCelebrationComplete={onCelebrationComplete}
                  onScrollToTask={handleScrollToTask}
                />
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
