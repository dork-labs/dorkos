import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import cronstrue from 'cronstrue';
import { MoreHorizontal, Pencil, Play, Trash2, AlertCircle, FolderOpen } from 'lucide-react';
import { toast } from 'sonner';
import {
  useUpdateSchedule,
  useTriggerSchedule,
  useDeleteSchedule,
} from '@/layers/entities/pulse';
import {
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
import { cn } from '@/layers/shared/lib';
import { shortenHomePath } from '@/layers/shared/lib';
import { hashToHslColor, hashToEmoji } from '@/layers/shared/lib/favicon-utils';
import type { PulseSchedule } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { RunHistoryPanel } from './RunHistoryPanel';

/** Formats a cron expression into a human-readable string. */
function formatCron(cron: string): string {
  try {
    return cronstrue.toString(cron);
  } catch {
    return cron;
  }
}

/** Color-coded dot indicating the schedule's current status. */
function StatusDot({ schedule }: { schedule: PulseSchedule }) {
  const color =
    schedule.status === 'pending_approval'
      ? 'bg-yellow-500'
      : !schedule.enabled
        ? 'bg-neutral-400'
        : 'bg-green-500';

  return <span className={cn('inline-block size-2 rounded-full', color)} />;
}

interface ScheduleRowProps {
  schedule: PulseSchedule;
  /** Resolved agent for the schedule's CWD, or null if no agent is registered. */
  agent?: AgentManifest | null;
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
}

/**
 * A single schedule row with status dot, cron description, action controls,
 * and an animated run history panel that expands on click.
 */
export function ScheduleRow({ schedule, agent, expanded, onToggleExpand, onEdit }: ScheduleRowProps) {
  const updateSchedule = useUpdateSchedule();
  const triggerSchedule = useTriggerSchedule();
  const deleteSchedule = useDeleteSchedule();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  const handleRunNow = (e: React.MouseEvent) => {
    e.stopPropagation();
    triggerSchedule.mutate(schedule.id, {
      onSuccess: () => toast('Run triggered'),
      onError: (err) => toast.error(`Failed to trigger run: ${err.message}`),
    });
  };

  const handleApprove = (e: React.MouseEvent) => {
    e.stopPropagation();
    updateSchedule.mutate(
      { id: schedule.id, status: 'active', enabled: true },
      {
        onSuccess: () => toast('Schedule approved'),
        onError: (err) => toast.error(`Failed to approve: ${err.message}`),
      }
    );
  };

  const handleReject = (e: React.MouseEvent) => {
    e.stopPropagation();
    deleteSchedule.mutate(schedule.id, {
      onError: (err) => toast.error(`Failed to reject: ${err.message}`),
    });
  };

  const confirmDelete = () => {
    deleteSchedule.mutate(schedule.id, {
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
          <StatusDot schedule={schedule} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {agent ? (
                <>
                  <span
                    className="inline-block size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: agent.color ?? hashToHslColor(agent.id) }}
                  />
                  <span className="text-xs leading-none">{agent.icon ?? hashToEmoji(agent.id)}</span>
                  <span className="text-sm font-medium">{agent.name}</span>
                  <span className="text-muted-foreground text-xs">&middot;</span>
                </>
              ) : schedule.agentId ? (
                // agentId is set but agent is not found — show warning
                <>
                  <AlertCircle className="text-destructive size-3.5 shrink-0" />
                  <span className="text-destructive text-xs">Agent not found</span>
                  <span className="text-muted-foreground text-xs">&middot;</span>
                </>
              ) : schedule.cwd ? (
                // No agentId, show folder icon + CWD
                <>
                  <FolderOpen className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="text-muted-foreground font-mono text-xs">{shortenHomePath(schedule.cwd)}</span>
                  <span className="text-muted-foreground text-xs">&middot;</span>
                </>
              ) : null}
              <span className={agent || schedule.agentId || schedule.cwd ? 'text-muted-foreground text-xs' : 'text-sm font-medium'}>
                {schedule.name}
              </span>
            </div>
            <div className="text-xs text-muted-foreground">
              {formatCron(schedule.cron)}
              {schedule.nextRun && (
                <> &middot; Next: {new Date(schedule.nextRun).toLocaleString()}</>
              )}
            </div>
          </div>

          {schedule.status === 'pending_approval' ? (
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
          ) : (
            <div className="flex items-center gap-2">
              <Switch
                checked={schedule.enabled}
                onCheckedChange={(checked) => {
                  updateSchedule.mutate({ id: schedule.id, enabled: checked });
                }}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Toggle ${schedule.name}`}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors"
                    aria-label={`Actions for ${schedule.name}`}
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
                  <DropdownMenuItem onClick={handleRunNow} disabled={!schedule.enabled}>
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
          )}
        </div>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
              className="overflow-hidden"
            >
              <div className="border-t px-3 pb-3 pt-2">
                <RunHistoryPanel scheduleId={schedule.id} scheduleCwd={schedule.cwd} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete schedule</DialogTitle>
            <DialogDescription>
              Delete &ldquo;{schedule.name}&rdquo;? This will also remove all run history. This
              action cannot be undone.
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
    </>
  );
}
