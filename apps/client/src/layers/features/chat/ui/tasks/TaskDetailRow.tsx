import { cn } from '@/layers/shared/lib';
import type { VisibleBackgroundTask } from '../../model/use-background-tasks';
import { InlineKillButton } from './InlineKillButton';

interface TaskDetailRowProps {
  task: VisibleBackgroundTask;
  onStop: () => void;
}

/**
 * Single row in the task detail panel — chip-style with color dot, type badge,
 * label (description or command), optional tool count, duration, and kill button.
 *
 * Only running tasks show the kill button. Completed/error/stopped tasks render
 * with reduced opacity.
 */
export function TaskDetailRow({ task, onStop }: TaskDetailRowProps) {
  const label =
    task.taskType === 'agent'
      ? (task.description ?? 'Background agent')
      : (task.command ?? 'Background task');

  const durationSeconds = task.durationMs ? Math.round(task.durationMs / 1000) : 0;
  const isActive = task.status === 'running';

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1 text-xs',
        isActive ? 'bg-muted' : 'bg-muted/50 opacity-60'
      )}
    >
      {/* Color indicator */}
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: task.color }} />

      {/* Type badge */}
      <span className="text-muted-foreground/60 text-3xs shrink-0 tracking-wider uppercase">
        {task.taskType}
      </span>

      {/* Label — truncated for long descriptions/commands */}
      <span className="text-foreground min-w-0 flex-1 truncate">{label}</span>

      {/* Tool count — agent tasks only */}
      {task.taskType === 'agent' && task.toolUses !== undefined && task.toolUses > 0 && (
        <span className="text-muted-foreground/60 text-3xs shrink-0 font-mono">
          {task.toolUses} tools
        </span>
      )}

      {/* Duration */}
      {durationSeconds > 0 && (
        <span className="text-muted-foreground/60 text-3xs shrink-0 font-mono">
          {durationSeconds}s
        </span>
      )}

      {/* Kill button — only for running tasks */}
      {isActive && <InlineKillButton taskType={task.taskType} onConfirm={onStop} />}
    </div>
  );
}
