import { ChevronDown, ChevronRight } from 'lucide-react';
import type { TaskItem } from '@dorkos/shared/types';

interface TaskProgressHeaderProps {
  tasks: TaskItem[];
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

/** Compact progress header with animated bar, fraction count, and collapse toggle. */
export function TaskProgressHeader({
  tasks,
  isCollapsed,
  onToggleCollapse,
}: TaskProgressHeaderProps) {
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === 'completed').length;
  const allDone = done === total && total > 0;
  const pct = total > 0 ? (done / total) * 100 : 0;

  return (
    <button
      onClick={onToggleCollapse}
      className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-xs"
    >
      {isCollapsed ? (
        <ChevronRight className="size-(--size-icon-xs) shrink-0" />
      ) : (
        <ChevronDown className="size-(--size-icon-xs) shrink-0" />
      )}
      <div className="bg-muted h-0.5 flex-1 overflow-hidden rounded-full">
        <div
          data-slot="progress-fill"
          className={`h-full rounded-full transition-all duration-300 ease-out ${allDone ? 'bg-green-500' : 'bg-blue-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="shrink-0 tabular-nums">
        {done}/{total} {total === 1 ? 'task' : 'tasks'}
      </span>
    </button>
  );
}
