import { motion } from 'motion/react';
import type { TaskItem } from '@dorkos/shared/types';
import { useElapsedTime } from '@/layers/shared/model';

interface TaskDetailProps {
  task: TaskItem;
  taskMap: Map<string, TaskItem>;
  statusSince: number | null;
  onScrollToTask: (taskId: string) => void;
}

const STATUS_PREFIX: Record<string, string> = {
  in_progress: '',
  pending: 'waiting ',
  completed: 'done ',
};

function DependencyList({
  tasks,
  onScrollToTask,
}: {
  tasks: TaskItem[];
  onScrollToTask: (taskId: string) => void;
}) {
  return (
    <>
      {tasks.map((dep, i) => (
        <span key={dep.id}>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onScrollToTask(dep.id);
            }}
            className="hover:text-foreground underline decoration-dotted"
          >
            {dep.subject}
          </button>
          {i < tasks.length - 1 && ', '}
        </span>
      ))}
    </>
  );
}

/** Expanded accordion content showing description, elapsed time, owner, and dependencies. */
export function TaskDetail({ task, taskMap, statusSince, onScrollToTask }: TaskDetailProps) {
  const elapsed = useElapsedTime(statusSince);
  const prefix = STATUS_PREFIX[task.status] ?? '';

  const blockedByTasks =
    task.blockedBy?.map((id) => taskMap.get(id)).filter((t): t is TaskItem => t != null) ?? [];

  const blocksTasks =
    task.blocks?.map((id) => taskMap.get(id)).filter((t): t is TaskItem => t != null) ?? [];

  const metaItems: React.ReactNode[] = [];

  if (statusSince !== null) {
    metaItems.push(
      <span key="time">
        {prefix}
        {elapsed.formatted}
      </span>
    );
  }

  if (task.owner) {
    metaItems.push(<span key="owner">{task.owner}</span>);
  }

  if (blockedByTasks.length > 0) {
    metaItems.push(
      <span key="blocked-by" className="inline-flex items-center gap-1">
        {'← '}
        <DependencyList tasks={blockedByTasks} onScrollToTask={onScrollToTask} />
      </span>
    );
  }

  if (blocksTasks.length > 0) {
    metaItems.push(
      <span key="blocks" className="inline-flex items-center gap-1">
        {'→ '}
        <DependencyList tasks={blocksTasks} onScrollToTask={onScrollToTask} />
      </span>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="mt-0.5 ml-6 space-y-1"
    >
      {task.description && (
        <p className="text-muted-foreground text-xs whitespace-pre-wrap">{task.description}</p>
      )}
      {metaItems.length > 0 && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-1 text-[11px]">
          {metaItems.map((item, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted-foreground/50">·</span>}
              {item}
            </span>
          ))}
        </div>
      )}
    </motion.div>
  );
}
