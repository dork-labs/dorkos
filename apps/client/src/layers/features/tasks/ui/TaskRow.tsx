import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import cronstrue from 'cronstrue';
import { MoreHorizontal, Pencil, Play, Trash2, AlertCircle, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { useUpdateTask, useTriggerTask, useDeleteTask } from '@/layers/entities/tasks';
import {
  Badge,
  Switch,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/layers/shared/ui';
import { cn, shortenHomePath, resolveAgentVisual } from '@/layers/shared/lib';
import type { Task } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { TaskRunHistoryPanel } from './TaskRunHistoryPanel';

/** Size variants controlling how much detail a TaskRow displays. */
export type TaskRowSize = 'default' | 'compact' | 'minimal';

/** Formats a cron expression into a human-readable string. */
function formatCron(cron: string): string {
  try {
    return cronstrue.toString(cron);
  } catch {
    return cron;
  }
}

/** Color-coded dot indicating the task's current status. */
function StatusDot({ task }: { task: Task }) {
  const color =
    task.status === 'pending_approval'
      ? 'bg-yellow-500'
      : !task.enabled
        ? 'bg-neutral-400'
        : 'bg-green-500';

  return <span className={cn('inline-block size-2 rounded-full', color)} />;
}

interface TaskRowProps {
  task: Task;
  /** Resolved agent for the task's CWD, or null if no agent is registered. */
  agent?: AgentManifest | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
  /** Controls how much detail the row renders. */
  size?: TaskRowSize;
  /** Whether to show the agent column. Ignored when size is 'minimal'. */
  showAgent?: boolean;
}

/**
 * A single task row with status dot, cron description, action controls,
 * and an animated run history panel that expands on click.
 *
 * Supports three size variants:
 * - `default` — full detail with tags, run history, and all actions
 * - `compact` — cron info and run-only action, no tags or history
 * - `minimal` — name and status dot only, no actions
 */
export function TaskRow({
  task,
  agent,
  expanded,
  onToggleExpand,
  onEdit,
  size = 'default',
  showAgent = true,
}: TaskRowProps) {
  const updateTask = useUpdateTask();
  const triggerTask = useTriggerTask();
  const deleteTask = useDeleteTask();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const agentVisual = agent ? resolveAgentVisual(agent) : null;

  const isMinimal = size === 'minimal';
  const isCompact = size === 'compact';
  const isDefault = size === 'default';
  const shouldShowAgent = showAgent && !isMinimal;
  const shouldShowCron = !isMinimal;
  const shouldShowHistory = isDefault;
  const isSystem = agent?.isSystem === true;

  const handleRunNow = (e: React.MouseEvent) => {
    e.stopPropagation();
    triggerTask.mutate(task.id, {
      onSuccess: () => toast('Run triggered'),
      onError: (err) => toast.error(`Failed to trigger run: ${err.message}`),
    });
  };

  const handleApprove = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateTask.mutate(
      { id: task.id, status: 'active', enabled: true },
      {
        onSuccess: () => toast('Schedule approved'),
        onError: (err) => toast.error(`Failed to approve: ${err.message}`),
      }
    );
  };

  const handleReject = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteTask.mutate(task.id, {
      onError: (err) => toast.error(`Failed to reject: ${err.message}`),
    });
  };

  const confirmDelete = () => {
    deleteTask.mutate(task.id, {
      onSuccess: () => setDeleteConfirmOpen(false),
      onError: (err) => toast.error(`Failed to delete: ${err.message}`),
    });
  };

  return (
    <>
      <div className="rounded-lg border">
        <div
          role="button"
          tabIndex={0}
          className="flex cursor-pointer items-center gap-3 p-3"
          onClick={onToggleExpand}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggleExpand()}
        >
          <StatusDot task={task} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {shouldShowAgent && agent ? (
                <>
                  <span
                    className="inline-block size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: agentVisual!.color }}
                  />
                  <span className="text-xs leading-none">{agentVisual!.emoji}</span>
                  <span className="text-sm font-medium">{agent.name}</span>
                  {isSystem && (
                    <Badge variant="outline" className="px-1 py-0 text-[10px] leading-tight">
                      <Shield className="mr-0.5 size-2.5" />
                      System
                    </Badge>
                  )}
                  <span className="text-muted-foreground text-xs">&middot;</span>
                </>
              ) : shouldShowAgent && task.agentId ? (
                <>
                  <AlertCircle className="text-destructive size-3.5 shrink-0" />
                  <span className="text-destructive text-xs">Agent not found</span>
                  <span className="text-muted-foreground text-xs">&middot;</span>
                </>
              ) : null}
              <span
                className={
                  shouldShowAgent && (agent || task.agentId)
                    ? 'text-muted-foreground text-xs'
                    : 'text-sm font-medium'
                }
              >
                {task.displayName ?? task.name}
              </span>
            </div>
            {shouldShowCron && (
              <div className="text-muted-foreground text-xs">
                {task.cron ? formatCron(task.cron) : 'On-demand'}
                {task.nextRun && <> &middot; Next: {new Date(task.nextRun).toLocaleString()}</>}
              </div>
            )}
          </div>

          {/* Actions — vary by size */}
          {!isMinimal && task.status === 'pending_approval' ? (
            <div className="flex gap-1">
              <button
                className="border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md border bg-transparent px-2.5 py-1 text-xs font-medium shadow-sm transition-colors"
                onClick={handleApprove}
              >
                Approve
              </button>
              <button
                className="hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors"
                onClick={handleReject}
              >
                Reject
              </button>
            </div>
          ) : isCompact ? (
            <button
              className="border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center gap-1 rounded-md border bg-transparent px-2 py-1 text-xs font-medium shadow-sm transition-colors"
              onClick={handleRunNow}
              aria-label={`Run ${task.name}`}
            >
              <Play className="size-3" />
              Run
            </button>
          ) : isDefault ? (
            <div className="flex items-center gap-2">
              {task.cron ? (
                <Switch
                  checked={task.enabled}
                  onCheckedChange={(checked) => {
                    updateTask.mutate({ id: task.id, enabled: checked });
                  }}
                  onClick={(e) => e.stopPropagation()}
                  aria-label={`Toggle ${task.name}`}
                />
              ) : (
                <button
                  className="border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center gap-1 rounded-md border bg-transparent px-2 py-1 text-xs font-medium shadow-sm transition-colors"
                  onClick={handleRunNow}
                  aria-label={`Run ${task.name}`}
                >
                  <Play className="size-3" />
                  Run
                </button>
              )}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors"
                    aria-label={`Actions for ${task.name}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <MoreHorizontal className="size-4" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => onEdit()}>
                    <Pencil className="mr-2 size-3.5" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleRunNow} disabled={!task.enabled}>
                    <Play className="mr-2 size-3.5" />
                    Run Now
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteConfirmOpen(true);
                    }}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 size-3.5" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : null}
        </div>

        {/* Expanded panel — file path + run history (default size only) */}
        <AnimatePresence initial={false}>
          {expanded && shouldShowHistory && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
              className="overflow-hidden"
            >
              <div className="border-t px-3 pt-2 pb-3">
                {task.filePath && (
                  <p className="text-muted-foreground mb-2 truncate font-mono text-[11px]">
                    {shortenHomePath(task.filePath)}
                  </p>
                )}
                <TaskRunHistoryPanel scheduleId={task.id} scheduleCwd={null} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {isDefault && (
        <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete task</DialogTitle>
              <DialogDescription>
                Delete &ldquo;{task.name}&rdquo;? This will also remove all run history. This action
                cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button
                onClick={() => setDeleteConfirmOpen(false)}
                className="border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md border bg-transparent px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
              >
                Delete
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
