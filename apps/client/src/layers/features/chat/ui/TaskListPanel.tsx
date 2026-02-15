import { Loader2, Circle, CheckCircle2, ChevronDown, ChevronRight, ListTodo } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { TaskItem, TaskStatus } from '@dorkos/shared/types';

interface TaskListPanelProps {
  tasks: TaskItem[];
  activeForm: string | null;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  celebratingTaskId?: string | null;
  onCelebrationComplete?: () => void;
}

const STATUS_ICON: Record<TaskStatus, React.ReactNode> = {
  in_progress: <Loader2 className="size-(--size-icon-xs) shrink-0 animate-spin text-blue-400" />,
  pending: <Circle className="size-(--size-icon-xs) shrink-0 text-muted-foreground" />,
  completed: <CheckCircle2 className="size-(--size-icon-xs) shrink-0 text-green-500" />,
};

const MAX_VISIBLE = 10;

export function TaskListPanel({ tasks, activeForm, isCollapsed, onToggleCollapse, celebratingTaskId, onCelebrationComplete }: TaskListPanelProps) {
  if (tasks.length === 0) return null;

  const done = tasks.filter(t => t.status === 'completed').length;
  const inProgress = tasks.filter(t => t.status === 'in_progress').length;
  const open = tasks.filter(t => t.status === 'pending').length;
  const visibleTasks = tasks.slice(0, MAX_VISIBLE);
  const overflow = tasks.length - MAX_VISIBLE;

  return (
    <div className="border-t px-4 py-2">
      <AnimatePresence>
        {activeForm && !isCollapsed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-2 text-xs text-blue-400 mb-1"
          >
            <Loader2 className="size-(--size-icon-xs) shrink-0 animate-spin" />
            <span className="truncate">{activeForm}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <button
        onClick={onToggleCollapse}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground w-full"
      >
        {isCollapsed ? <ChevronRight className="size-(--size-icon-xs)" /> : <ChevronDown className="size-(--size-icon-xs)" />}
        <ListTodo className="size-(--size-icon-xs)" />
        <span>
          {tasks.length} task{tasks.length !== 1 ? 's' : ''}
          {' '}({done} done{inProgress > 0 ? `, ${inProgress} in progress` : ''}, {open} open)
          {overflow > 0 && ` +${overflow} more`}
        </span>
      </button>

      <AnimatePresence>
        {!isCollapsed && (
          <motion.ul
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-1 space-y-0.5"
          >
            {visibleTasks.map(task => {
              const isCelebrating = task.id === celebratingTaskId && task.status === 'completed';

              return (
                <motion.li
                  key={task.id}
                  className={`relative flex items-center gap-2 text-xs py-0.5 ${
                    task.status === 'completed'
                      ? 'text-muted-foreground/50 line-through'
                      : task.status === 'in_progress'
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground'
                  }`}
                  animate={isCelebrating ? {
                    scale: [1, 1.05, 1],
                  } : undefined}
                  transition={isCelebrating ? { type: 'spring', stiffness: 400, damping: 10 } : undefined}
                  onAnimationComplete={() => {
                    if (isCelebrating) onCelebrationComplete?.();
                  }}
                >
                  {/* Shimmer background for celebrating row */}
                  {isCelebrating && (
                    <motion.div
                      aria-hidden="true"
                      className="absolute inset-0 rounded"
                      initial={{ backgroundPosition: '-200% 0' }}
                      animate={{ backgroundPosition: '200% 0' }}
                      transition={{ duration: 0.4, ease: 'easeOut' }}
                      style={{
                        backgroundImage: 'linear-gradient(90deg, transparent 0%, rgba(255,215,0,0.2) 50%, transparent 100%)',
                        backgroundSize: '200% 100%',
                      }}
                    />
                  )}

                  {/* Checkmark spring-pop */}
                  {isCelebrating ? (
                    <motion.span
                      initial={{ scale: 1 }}
                      animate={{ scale: [1, 1.4, 1] }}
                      transition={{ type: 'spring', stiffness: 400, damping: 10 }}
                    >
                      {STATUS_ICON[task.status]}
                    </motion.span>
                  ) : (
                    STATUS_ICON[task.status]
                  )}

                  <span className="truncate">{task.subject}</span>
                </motion.li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
