import { useState, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { TaskItem } from '@dorkos/shared/types';
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
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-1 space-y-0.5"
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
