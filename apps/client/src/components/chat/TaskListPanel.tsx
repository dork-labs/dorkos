import { Loader2, Circle, CheckCircle2, ChevronDown, ChevronRight, ListTodo } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { TaskItem, TaskStatus } from '@lifeos/shared/types';

interface TaskListPanelProps {
  tasks: TaskItem[];
  activeForm: string | null;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

const STATUS_ICON: Record<TaskStatus, React.ReactNode> = {
  in_progress: <Loader2 className="size-(--size-icon-xs) shrink-0 animate-spin text-blue-400" />,
  pending: <Circle className="size-(--size-icon-xs) shrink-0 text-muted-foreground" />,
  completed: <CheckCircle2 className="size-(--size-icon-xs) shrink-0 text-green-500" />,
};

const MAX_VISIBLE = 10;

export function TaskListPanel({ tasks, activeForm, isCollapsed, onToggleCollapse }: TaskListPanelProps) {
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
            {visibleTasks.map(task => (
              <li
                key={task.id}
                className={`flex items-center gap-2 text-xs py-0.5 ${
                  task.status === 'completed'
                    ? 'text-muted-foreground/50 line-through'
                    : task.status === 'in_progress'
                    ? 'text-foreground font-medium'
                    : 'text-muted-foreground'
                }`}
              >
                {STATUS_ICON[task.status]}
                <span className="truncate">{task.subject}</span>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
