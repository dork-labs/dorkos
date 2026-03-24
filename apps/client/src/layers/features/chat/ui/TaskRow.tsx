import { Loader2, Circle, CheckCircle2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import type { TaskItem, TaskStatus } from '@dorkos/shared/types';
import { TaskDetail } from './TaskDetail';

const STATUS_ICON: Record<TaskStatus, React.ReactNode> = {
  in_progress: <Loader2 className="size-(--size-icon-xs) shrink-0 animate-spin text-blue-400" />,
  pending: <Circle className="text-muted-foreground size-(--size-icon-xs) shrink-0" />,
  completed: <CheckCircle2 className="size-(--size-icon-xs) shrink-0 text-green-500" />,
};

interface TaskRowProps {
  task: TaskItem;
  isBlocked: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onHover: (taskId: string | null) => void;
  isHighlightedAsDep: boolean;
  isHighlightedAsDependent: boolean;
  taskMap: Map<string, TaskItem>;
  statusSince: number | null;
  isCelebrating: boolean;
  onCelebrationComplete?: () => void;
  onScrollToTask: (taskId: string) => void;
}

/** Single task row with status icon, expand/collapse, hover dep highlights, and a11y. */
export function TaskRow({
  task,
  isBlocked,
  isExpanded,
  onToggleExpand,
  onHover,
  isHighlightedAsDep,
  isHighlightedAsDependent,
  taskMap,
  statusSince,
  isCelebrating,
  onCelebrationComplete,
  onScrollToTask,
}: TaskRowProps) {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggleExpand();
    }
  };

  return (
    <motion.li data-task-id={task.id}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
        data-task-id={task.id}
        onClick={onToggleExpand}
        onKeyDown={handleKeyDown}
        onMouseEnter={() => onHover(task.id)}
        onMouseLeave={() => onHover(null)}
        className={cn(
          'relative flex items-center gap-2 rounded py-0.5 text-xs transition-colors',
          task.status === 'completed' && 'text-muted-foreground/50 line-through',
          task.status === 'in_progress' && 'text-foreground font-medium',
          task.status === 'pending' && !isBlocked && 'text-muted-foreground',
          task.status === 'pending' && isBlocked && 'text-muted-foreground/50',
          isHighlightedAsDep && 'border-l-2 border-blue-400 pl-1.5',
          isHighlightedAsDependent && 'border-l-2 border-amber-400 pl-1.5',
          !isHighlightedAsDep && !isHighlightedAsDependent && 'border-l-2 border-transparent pl-1.5'
        )}
      >
        {/* Celebration shimmer overlay */}
        {isCelebrating && (
          <motion.div
            aria-hidden="true"
            className="absolute inset-0 rounded"
            initial={{ backgroundPosition: '-200% 0' }}
            animate={{ backgroundPosition: '200% 0' }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
            style={{
              backgroundImage:
                'linear-gradient(90deg, transparent 0%, rgba(255,215,0,0.2) 50%, transparent 100%)',
              backgroundSize: '200% 100%',
            }}
          />
        )}

        {/* Status icon — spring-pop on celebration */}
        {isCelebrating ? (
          <motion.span
            initial={{ scale: 1 }}
            animate={{ scale: [1, 1.4, 1] }}
            transition={{ type: 'spring', stiffness: 400, damping: 10 }}
            onAnimationComplete={() => onCelebrationComplete?.()}
          >
            {STATUS_ICON[task.status]}
          </motion.span>
        ) : (
          STATUS_ICON[task.status]
        )}

        <span className="truncate">{task.subject}</span>
      </div>

      <AnimatePresence>
        {isExpanded && (
          <TaskDetail
            task={task}
            taskMap={taskMap}
            statusSince={statusSince}
            onScrollToTask={onScrollToTask}
          />
        )}
      </AnimatePresence>
    </motion.li>
  );
}
