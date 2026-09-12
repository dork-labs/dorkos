import { motion } from 'motion/react';
import { COLLAPSE_TRANSITION, COLLAPSE_VARIANTS } from '@/layers/shared/lib';
import type { VisibleBackgroundTask } from '../../model/use-background-tasks';
import { TaskDetailRow } from './TaskDetailRow';

interface TaskDetailPanelProps {
  /** Tasks the collapsed bar already counts and draws. */
  tasks: VisibleBackgroundTask[];
  /** Housekeeping tasks the bar hides. This panel is the only place they appear. */
  ambientTasks?: VisibleBackgroundTask[];
  onStopTask: (taskId: string) => void;
}

/**
 * Expandable panel listing all background tasks with kill controls.
 *
 * Animates open/closed with a height transition. Each task is rendered
 * as a compact chip row via `TaskDetailRow`.
 *
 * Housekeeping tasks follow the ordinary ones under a line saying how many
 * there are. That line is the only place the hidden count is ever stated — the
 * collapsed bar stays quiet about them, which is the whole point of hiding them.
 */
export function TaskDetailPanel({ tasks, ambientTasks = [], onStopTask }: TaskDetailPanelProps) {
  return (
    <motion.div
      variants={COLLAPSE_VARIANTS}
      initial="initial"
      animate="animate"
      exit="exit"
      transition={COLLAPSE_TRANSITION}
      className="border-border overflow-hidden border-t px-2 py-1.5"
    >
      <div className="flex flex-col gap-1">
        {tasks.map((task) => (
          <TaskDetailRow key={task.taskId} task={task} onStop={() => onStopTask(task.taskId)} />
        ))}

        {ambientTasks.length > 0 && (
          <>
            <p className="text-muted-foreground/60 text-3xs mt-1 px-2">
              {ambientTasks.length} housekeeping task{ambientTasks.length !== 1 ? 's' : ''} the
              agent runs for itself
            </p>
            {ambientTasks.map((task) => (
              <TaskDetailRow key={task.taskId} task={task} onStop={() => onStopTask(task.taskId)} />
            ))}
          </>
        )}
      </div>
    </motion.div>
  );
}
