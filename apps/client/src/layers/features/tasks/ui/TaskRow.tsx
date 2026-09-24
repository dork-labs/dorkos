import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import cronstrue from 'cronstrue';
import { MoreHorizontal, Pencil, Play, Trash2, AlertCircle, Shield, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import {
  isScheduleAwaitingApproval,
  useUpdateTask,
  useTriggerTask,
  useDeleteTask,
} from '@/layers/entities/tasks';
import { AgentAvatar } from '@/layers/entities/agent';
import { RuntimeMark, formatModelLabel } from '@/layers/entities/runtime';
import {
  Badge,
  Button,
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
  STATUS_TONE_DOT,
  type StatusTone,
} from '@/layers/shared/ui';
import {
  cn,
  COLLAPSE_TRANSITION,
  COLLAPSE_VARIANTS,
  getAgentDisplayName,
  shortenHomePath,
  resolveAgentVisual,
} from '@/layers/shared/lib';
import type { Task } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { TaskRunHistoryPanel } from './TaskRunHistoryPanel';

/**
 * Density steps controlling how much detail a TaskRow displays.
 *
 * Deliberately not the `xs · sm · md · lg` scale: the axis is not how big the
 * row is but how much of the task it tells you, so the steps are named for
 * that (`.claude/rules/components.md`). `comfortable` replaced a step named
 * `default`, which said nothing at all about the row it produced (DOR-1873).
 */
export type TaskRowSize = 'comfortable' | 'compact' | 'minimal';

/** Formats a cron expression into a human-readable string. */
function formatCron(cron: string): string {
  try {
    return cronstrue.toString(cron);
  } catch {
    return cron;
  }
}

/** The timezone this browser reads times in. */
const VIEWER_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Whether the timing line names the zone its cron runs in: when a person chose
 * the timing, or when the zone is not the reader's own.
 */
function showsZone(task: Task): boolean {
  if (!task.timezone) return false;
  return task.timingOverridden || task.timezone !== VIEWER_TIME_ZONE;
}

/**
 * The package's own timing for a schedule a person has retimed, as a sentence
 * fragment: "every hour, UTC", "at 09:00 AM, Europe/Berlin", "on demand".
 */
function describePackageTiming(task: Task): string {
  if (!task.defaultCron) return 'on demand';
  const words = formatCron(task.defaultCron);
  const lowered = words.charAt(0).toLowerCase() + words.slice(1);
  return task.defaultTimezone ? `${lowered}, ${task.defaultTimezone}` : lowered;
}

/**
 * What this task runs on, when that is not what its agent runs on.
 *
 * Drawn only for a task that actually sets one of the two, which is the point:
 * nearly every task inherits, and a chip on every row would be a column of the
 * same word (spec `task-runtime-model` §2, decision 11). The runtime half is the
 * shared {@link RuntimeMark} — one icon, its identity in the tooltip — so a task
 * row names a runtime exactly the way a session row does.
 *
 * A task that sets only a model shows the model alone. Naming a runtime beside
 * it would mean resolving the agent's manifest for a value the person did not
 * choose, and a guessed runtime is worse here than none.
 */
function TaskOverrideChip({ task }: { task: Task }) {
  const modelLabel = formatModelLabel(task.model);
  if (!task.runtime && !modelLabel) return null;
  return (
    <span
      data-testid="task-override-chip"
      className="text-muted-foreground/70 text-3xs inline-flex min-w-0 shrink-0 items-center gap-1"
    >
      {task.runtime && <RuntimeMark type={task.runtime} model={task.model} size={11} />}
      {modelLabel && (
        <span className="truncate" title={`Model: ${task.model}`}>
          {modelLabel}
        </span>
      )}
    </span>
  );
}

/** Color-coded dot indicating the task's current status. */
function StatusDot({ task }: { task: Task }) {
  // The shared vocabulary, so a waiting task is the same amber a waiting agent
  // is, and a paused one is neutral rather than a second grey. A schedule a
  // package shipped switched off is `pending_approval` on the row but is not
  // asking for anything (DOR-2059), so it reads exactly like any other
  // switched-off task — neutral, not amber.
  const tone: StatusTone = isScheduleAwaitingApproval(task)
    ? 'warning'
    : !task.enabled || task.status === 'paused'
      ? 'neutral'
      : 'success';

  return <span className={cn('inline-block size-2 rounded-full', STATUS_TONE_DOT[tone])} />;
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
 * Supports three density steps:
 * - `comfortable` — full detail with tags, run history, and all actions
 * - `compact` — cron info and run-only action, no tags or history
 * - `minimal` — name and status dot only, no actions
 */
export function TaskRow({
  task,
  agent,
  expanded,
  onToggleExpand,
  onEdit,
  size = 'comfortable',
  showAgent = true,
}: TaskRowProps) {
  const updateTask = useUpdateTask();
  const triggerTask = useTriggerTask();
  const deleteTask = useDeleteTask();
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const agentVisual = agent ? resolveAgentVisual(agent) : null;

  const isMinimal = size === 'minimal';
  const isCompact = size === 'compact';
  const isComfortable = size === 'comfortable';
  const shouldShowAgent = showAgent && !isMinimal;
  const shouldShowCron = !isMinimal;
  const shouldShowHistory = isComfortable;
  const isSystem = agent?.isSystem === true;
  // A package-shipped schedule found switched off draws as an ordinary
  // switched-off task — no card, no reason line (DOR-2059) — but that makes it
  // LOOK identical to a task the person switched off themselves. The reviewer's
  // finding: naming the source has to survive on the collapsed row, because the
  // file path only ever showed in the expanded run-history panel.
  //
  // Derived from `isScheduleAwaitingApproval` rather than restated by hand, so
  // the one rule that decides "does this need a card" is the same rule that
  // decides "does this need its source named" — a file-discovered row is
  // exactly one of the two, never both (delta review).
  const isQuietlyParkedFromFile =
    task.status === 'pending_approval' &&
    task.origin === 'file' &&
    !isScheduleAwaitingApproval(task);

  const handleRunNow = (e: React.MouseEvent) => {
    e.stopPropagation();
    // No local onError: the shared mutation toast (`useTriggerTask`'s
    // `meta.errorLabel`) reports a failure. Bare, not `.success` — the run
    // itself happens off-screen (the history row is what confirms it ran),
    // so this is a neutral "it started" note, same voice as Schedule approved
    // below.
    triggerTask.mutate(task.id, {
      onSuccess: () => toast('Run triggered'),
    });
  };

  const handleApprove = (e: React.MouseEvent) => {
    e.stopPropagation();
    // No local onError: the shared mutation toast (`useUpdateTask`'s
    // `meta.errorLabel`) reports a failure. Bare, matching Run triggered above.
    updateTask.mutate(
      { id: task.id, status: 'active', enabled: true },
      { onSuccess: () => toast('Schedule approved') }
    );
  };

  const handleReject = (e: React.MouseEvent) => {
    e.stopPropagation();
    // No local onError: the shared mutation toast (`useDeleteTask`'s
    // `meta.errorLabel`) reports a failure.
    deleteTask.mutate(task.id);
  };

  // A schedule that came with an installed package, running on the person's
  // own timing (DOR-2302): put it back on the package's. A person's reset is
  // itself the approval of the timing it restores, so it stays live.
  const handleResetTiming = (e: React.MouseEvent) => {
    e.stopPropagation();
    // No local onError: the shared mutation toast reports a failure.
    updateTask.mutate(
      { id: task.id, resetTiming: true },
      { onSuccess: () => toast('Back on the package’s timing') }
    );
  };

  const confirmDelete = () => {
    // No local onError: the shared mutation toast (`useDeleteTask`'s
    // `meta.errorLabel`) reports a failure.
    deleteTask.mutate(task.id, {
      onSuccess: () => setDeleteConfirmOpen(false),
    });
  };

  return (
    <>
      {/* Rounds its first and last child rather than clipping with
          `overflow-hidden` — clipping cut the keyboard focus ring off on
          three of its four sides (batch 06, N1). Rounding the edge children
          directly keeps the row's own hover/focus tint inside the same
          curve without clipping anything drawn outside the box, the focus
          ring included. In the collapsed state the row is both first and
          last child, so it lands full `rounded-lg`, same as before. */}
      <div className="rounded-lg border [&>*:first-child]:rounded-t-lg [&>*:last-child]:rounded-b-lg">
        <div
          role="button"
          tabIndex={0}
          className="hover:bg-accent/50 focus-visible:bg-accent/50 flex cursor-pointer items-center gap-3 p-3 transition-colors"
          onClick={onToggleExpand}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggleExpand()}
        >
          <StatusDot task={task} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {shouldShowAgent && agent ? (
                <>
                  <AgentAvatar
                    color={agentVisual!.color}
                    emoji={agentVisual!.emoji}
                    size="xs"
                    className="shrink-0"
                  />
                  <span className="text-sm font-medium">{getAgentDisplayName(agent)}</span>
                  {isSystem && (
                    <Badge size="xs" variant="outline" className="px-1 leading-tight">
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
              {!isMinimal && <TaskOverrideChip task={task} />}
            </div>
            {shouldShowCron && (
              <div className="text-muted-foreground text-xs">
                {task.cron ? formatCron(task.cron) : 'On-demand'}
                {/* The zone the cron is read in, whenever it is not the one the
                    reader is in or the person chose it — without it "At 07:30"
                    is a time in a place nobody named, and a timezone-only
                    override would be marked "Your timing" with nothing on the
                    row that differs. */}
                {task.cron && showsZone(task) && <>, {task.timezone}</>}
                {/* The timing a person set for a package's schedule, in place
                    of the package's own (DOR-2302). Said on the collapsed row,
                    because it is the answer to "why is this not running when
                    the package says it does". */}
                {task.timingOverridden && (
                  <span data-slot="task-timing-override"> &middot; Your timing</span>
                )}
                {task.nextRun && (
                  <>
                    {' '}
                    &middot; Next:{' '}
                    {new Date(task.nextRun).toLocaleString(undefined, { timeZoneName: 'short' })}
                  </>
                )}
              </div>
            )}
            {/* Why this one is waiting. A schedule DorkOS found in a file says
                so here — including what is wrong with the file, when something
                is — because the row is where a person meets it first and the
                Approve button is right there. Without this line, a schedule
                parked over a typo in its cron looks identical to one parked
                only for a look.

                Gated on ORIGIN, not on status. `reason` means two different
                things depending on where the row came from: DorkOS's own words
                on a file-found schedule, and an AGENT'S CASE on one an agent
                proposed. The second belongs on the approval card, which can say
                who is making it — printing it here as a bare line would put an
                agent's argument on screen with nothing attributing it (DOR-1485
                review, I5). `reasonSource` catches the other half: a schedule a
                person made themselves whose file has drifted also carries our
                words, not theirs. Both conditions are needed: a schedule that
                is already running is not waiting for anything, so whatever
                `reason` it still carries is history. */}
            {isScheduleAwaitingApproval(task) &&
              (task.origin === 'file' || task.reasonSource === 'dorkos') &&
              task.reason && (
                <div
                  data-slot="task-park-reason"
                  className="text-muted-foreground min-w-0 text-xs break-words"
                >
                  {task.reason}
                </div>
              )}
            {/* Names the source on the row itself, not only in the expanded
                panel — otherwise a package-shipped schedule found switched off
                is indistinguishable from one the person switched off
                themselves (DOR-2059 review). */}
            {!isMinimal && isQuietlyParkedFromFile && task.filePath && (
              <div
                data-slot="task-quiet-source"
                className="text-muted-foreground text-3xs min-w-0 truncate font-mono"
              >
                Installed · {shortenHomePath(task.filePath)}
              </div>
            )}
          </div>

          {/* Actions — vary by size */}
          {!isMinimal && isScheduleAwaitingApproval(task) ? (
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
          ) : isComfortable ? (
            <div className="flex items-center gap-2">
              {task.cron ? (
                <Switch
                  // A paused row's file is gone, so nothing will run whatever
                  // `enabled` says; the switch reads off and cannot be flipped
                  // until the file comes back.
                  checked={task.enabled && task.status !== 'paused'}
                  disabled={task.status === 'paused'}
                  onCheckedChange={(checked) => {
                    // A package-shipped schedule that ships off is
                    // `pending_approval` on the row even though it draws as an
                    // ordinary switched-off task (DOR-2059) — so switching it
                    // ON here is the FIRST time anybody has approved it, and
                    // has to run the same door the Approve button does
                    // (`handleApprove`, above): `status` is operator-only, and
                    // sending it alongside `enabled` is what runs the arm
                    // blocker and the permission clamp before anything is
                    // armed. Flipping an already-approved schedule off and
                    // back on needs none of that — `enabled` alone is
                    // agent-writable and reversible.
                    if (checked && task.status === 'pending_approval') {
                      updateTask.mutate({ id: task.id, status: 'active', enabled: true });
                      return;
                    }
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
                  <DropdownMenuItem
                    onClick={handleRunNow}
                    disabled={!task.enabled || task.status === 'paused'}
                  >
                    <Play className="mr-2 size-3.5" />
                    Run Now
                  </DropdownMenuItem>
                  {task.timingOverridden && (
                    <DropdownMenuItem onClick={handleResetTiming}>
                      <RotateCcw className="mr-2 size-3.5" />
                      Reset to the package’s default
                    </DropdownMenuItem>
                  )}
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

        {/* Expanded panel — file path + run history (comfortable size only) */}
        <AnimatePresence initial={false}>
          {expanded && shouldShowHistory && (
            <motion.div
              variants={COLLAPSE_VARIANTS}
              initial="initial"
              animate="animate"
              exit="exit"
              transition={COLLAPSE_TRANSITION}
              className="overflow-hidden"
            >
              <div className="border-t px-3 pt-2 pb-3">
                {task.filePath && (
                  <p className="text-muted-foreground text-2xs mb-2 truncate font-mono">
                    {shortenHomePath(task.filePath)}
                  </p>
                )}
                {task.timingOverridden && (
                  <div
                    data-slot="task-package-timing"
                    className="text-muted-foreground mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                  >
                    <span>The package runs this {describePackageTiming(task)}.</span>
                    {/* Wraps rather than overflowing the row on a narrow phone. */}
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      className="h-auto min-h-6 min-w-0 shrink whitespace-normal"
                      onClick={handleResetTiming}
                    >
                      <RotateCcw />
                      Reset to the package’s default
                    </Button>
                  </div>
                )}
                <TaskRunHistoryPanel scheduleId={task.id} scheduleCwd={null} />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {isComfortable && (
        <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete scheduled task</DialogTitle>
              <DialogDescription>
                Delete “{task.name}”? This will also remove all run history. This action cannot be
                undone.
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
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 dark:bg-destructive/60 inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
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
