import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import type { VisibleBackgroundTask } from '../../model/use-background-tasks';
import './agent-runner.css';

interface TaskDotSectionProps {
  /** Visible background tasks — component renders every one that is not a helper agent. */
  bashTasks: VisibleBackgroundTask[];
}

/**
 * Pulsing colored dots representing running background shells and other tasks
 * (Monitors, Workflows): everything that is not a helper agent.
 *
 * Each dot is 6px with a pulsing ring animation for running tasks. Dots enter
 * and exit via Motion AnimatePresence. A count label shows the total number of
 * visible tasks.
 */
export function TaskDotSection({ bashTasks }: TaskDotSectionProps) {
  const prefersReducedMotion = useReducedMotion();

  const tasks = bashTasks.filter((t) => t.taskType !== 'agent');
  const count = tasks.length;

  if (count === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${count} background task${count !== 1 ? 's' : ''} running`}
      className="flex items-center gap-1.5"
    >
      <AnimatePresence mode="popLayout">
        {tasks.map((task) => (
          <motion.div
            key={task.taskId}
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ duration: 0.25 }}
            className="relative flex size-3 items-center justify-center"
          >
            {/* Tasks ring — only for running tasks */}
            {task.status === 'running' && !prefersReducedMotion && (
              <span
                className="task-dot-tasks absolute inset-0 rounded-full opacity-40"
                style={{
                  backgroundColor: task.color,
                  animation: 'task-dot-tasks 2s ease-in-out infinite',
                }}
              />
            )}
            {/* Solid 6px dot */}
            <span
              className="relative size-1.5 rounded-full"
              style={{ backgroundColor: task.color }}
            />
          </motion.div>
        ))}
      </AnimatePresence>

      {/* Count label */}
      <span className="text-muted-foreground text-xs whitespace-nowrap">
        {count} task{count !== 1 ? 's' : ''}
      </span>
    </div>
  );
}
