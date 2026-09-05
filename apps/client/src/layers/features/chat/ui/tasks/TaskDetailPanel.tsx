import { motion } from 'motion/react';
import { COLLAPSE_TRANSITION, COLLAPSE_VARIANTS } from '@/layers/shared/lib';
import type { VisibleBackgroundTask } from '../../model/use-background-tasks';
import { TaskDetailRow } from './TaskDetailRow';

interface TaskDetailPanelProps {
  tasks: VisibleBackgroundTask[];
  onStopTask: (taskId: string) => void;
}

/**
 * Expandable panel listing all background tasks with kill controls.
 *
 * Animates open/closed with a height transition. Each task is rendered
 * as a compact chip row via `TaskDetailRow`.
 */
export function TaskDetailPanel({ tasks, onStopTask }: TaskDetailPanelProps) {
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
      </div>
    </motion.div>
  );
}
