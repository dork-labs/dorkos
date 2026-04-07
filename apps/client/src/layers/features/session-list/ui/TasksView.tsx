import { useMemo } from 'react';
import { CheckCircle2, Loader2, XCircle, MinusCircle, Clock } from 'lucide-react';
import {
  useTasks,
  useActiveTaskRunCount,
  useTaskRuns,
  useTaskTemplates,
  useTaskTemplateDialog,
} from '@/layers/entities/tasks';
import { formatCron } from '@/layers/features/tasks';
import { useAppStore, useTasksDeepLink } from '@/layers/shared/model';
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  ScrollArea,
} from '@/layers/shared/ui';
import { formatRelativeTime } from '@/layers/shared/lib';
import type { ChipState } from '@/layers/entities/agent';
import type { TaskRun, Task } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of recent (terminal) runs shown in the sidebar. */
const MAX_RECENT_RUNS = 5;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compact run status icon for sidebar items. */
function RunStatusIcon({ status }: { status: TaskRun['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="size-3 shrink-0 animate-spin text-blue-500" aria-hidden />;
    case 'completed':
      return <CheckCircle2 className="size-3 shrink-0 text-green-500" aria-hidden />;
    case 'failed':
      return <XCircle className="text-destructive size-3 shrink-0" aria-hidden />;
    case 'cancelled':
      return <MinusCircle className="text-muted-foreground size-3 shrink-0" aria-hidden />;
    default:
      return null;
  }
}

/** Format a nullable duration in ms for compact display. */
function formatDuration(ms: number | null): string {
  if (ms === null) return '';
  if (ms < 1000) return '< 1s';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface RunningRunItemProps {
  run: TaskRun;
  scheduleName: string;
}

/** A currently-running run item. */
function RunningRunItem({ run, scheduleName }: RunningRunItemProps) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton className="text-sm">
        <Loader2 className="size-3 shrink-0 animate-spin text-blue-500" aria-hidden />
        <span className="truncate">{scheduleName}</span>
        {run.startedAt && (
          <span className="text-muted-foreground/50 ml-auto shrink-0 text-xs">
            {formatRelativeTime(run.startedAt)}
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

interface UpcomingScheduleItemProps {
  schedule: Task;
  onEdit: (id: string) => void;
}

/** An upcoming scheduled execution. */
function UpcomingScheduleItem({ schedule, onEdit }: UpcomingScheduleItemProps) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton onClick={() => onEdit(schedule.id)} className="text-sm">
        <Clock className="text-muted-foreground/50 size-3 shrink-0" aria-hidden />
        <span className="truncate">{schedule.name}</span>
        {schedule.nextRun && (
          <span className="text-muted-foreground/50 ml-auto shrink-0 text-xs">
            {formatRelativeTime(schedule.nextRun)}
          </span>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

interface RecentRunItemProps {
  run: TaskRun;
  scheduleName: string;
}

/** A completed/failed/cancelled run item. */
function RecentRunItem({ run, scheduleName }: RecentRunItemProps) {
  // Derive display status: if the server left status as 'running' but finishedAt is set,
  // infer completed (or failed if there's an error).
  const displayStatus: TaskRun['status'] =
    run.status === 'running' && run.finishedAt ? (run.error ? 'failed' : 'completed') : run.status;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton className="text-sm">
        <RunStatusIcon status={displayStatus} />
        <span className="truncate">{scheduleName}</span>
        <span className="text-muted-foreground/50 ml-auto flex shrink-0 items-center gap-1.5 text-xs">
          {run.durationMs !== null && <span>{formatDuration(run.durationMs)}</span>}
          {run.finishedAt && <span>{formatRelativeTime(run.finishedAt)}</span>}
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface TasksViewProps {
  /** Per-agent Tasks chip state from useAgentToolStatus */
  toolStatus: ChipState;
  /** When non-null, only show schedules assigned to this agent. */
  agentId: string | null;
}

/** Schedule runs summary for the sidebar Schedules tab. */
export function TasksView({ toolStatus, agentId }: TasksViewProps) {
  const tasksDeepLink = useTasksDeepLink();
  const setTasksAgentFilter = useAppStore((s) => s.setTasksAgentFilter);
  const setTasksEditScheduleId = useAppStore((s) => s.setTasksEditScheduleId);
  const enabled = toolStatus !== 'disabled-by-server';
  const { data: allSchedules = [] } = useTasks(enabled);
  const { data: activeRunCount = 0 } = useActiveTaskRunCount(enabled);
  const { data: allRuns = [] } = useTaskRuns(undefined, enabled);
  const { data: presets = [] } = useTaskTemplates();
  const { openWithTemplate } = useTaskTemplateDialog();

  // Show first and third preset by index to avoid hardcoding IDs
  const featuredPresets = [presets[0], presets[2]].filter(Boolean);

  // Filter to only schedules assigned to the selected agent
  const schedules = useMemo(
    () => (agentId ? allSchedules.filter((s) => s.agentId === agentId) : allSchedules),
    [agentId, allSchedules]
  );

  // Build a name lookup for schedule IDs
  const scheduleNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of schedules) map.set(s.id, s.name);
    return map;
  }, [schedules]);

  // Filter runs to only those belonging to this agent's schedules
  const agentRuns = useMemo(
    () => allRuns.filter((r) => scheduleNameMap.has(r.scheduleId)),
    [allRuns, scheduleNameMap]
  );

  // Partition runs into running vs. terminal.
  // A run is considered finished if it has a finishedAt timestamp, regardless of
  // the status field — the server may not always update status promptly.
  const { runningRuns, recentRuns } = useMemo(() => {
    const running: TaskRun[] = [];
    const terminal: TaskRun[] = [];
    for (const run of agentRuns) {
      const isFinished = run.finishedAt != null || run.status !== 'running';
      if (isFinished) terminal.push(run);
      else running.push(run);
    }
    // Sort terminal runs by finishedAt descending (most recent first)
    terminal.sort((a, b) =>
      (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt)
    );
    return { runningRuns: running, recentRuns: terminal.slice(0, MAX_RECENT_RUNS) };
  }, [agentRuns]);

  // Upcoming: active schedules with a next run time, sorted soonest first
  const upcomingSchedules = useMemo(
    () =>
      schedules
        .filter((s) => s.enabled && s.status === 'active' && s.nextRun)
        .sort((a, b) => (a.nextRun ?? '').localeCompare(b.nextRun ?? '')),
    [schedules]
  );

  // Compose auxiliary store state (agent filter) with the URL deep-link hook.
  // The aux store fields (`tasksAgentFilter`, `tasksEditScheduleId`) aren't
  // URL-addressable yet, so we set them locally before triggering the URL open.
  const openTasks = () => {
    if (agentId) {
      setTasksAgentFilter(agentId);
      setTasksEditScheduleId(null);
    }
    tasksDeepLink.open();
  };
  const openTasksForEdit = (scheduleId: string) => {
    setTasksEditScheduleId(scheduleId);
    setTasksAgentFilter(null);
    tasksDeepLink.open();
  };

  if (toolStatus === 'disabled-by-agent') {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-4 py-8">
        <p className="text-muted-foreground/60 text-sm">Tasks disabled for this agent</p>
        <button
          onClick={openTasks}
          className="text-muted-foreground hover:text-foreground text-xs transition-colors"
        >
          Open Tasks →
        </button>
      </div>
    );
  }

  if (schedules.length === 0) {
    return (
      <div className="flex flex-col gap-3 px-3 py-4">
        <p className="text-muted-foreground/70 text-xs">No schedules yet.</p>
        {featuredPresets.length > 0 && (
          <div className="space-y-2">
            {featuredPresets.map((preset) => (
              <div key={preset.id} className="rounded-lg border p-3 text-sm">
                <div className="font-medium">{preset.name}</div>
                <p className="text-muted-foreground text-xs">{formatCron(preset.cron)}</p>
                <button
                  type="button"
                  onClick={() => {
                    openWithTemplate(preset);
                    openTasks();
                  }}
                  className="text-primary mt-2 text-xs hover:underline"
                >
                  + Use preset
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={openTasks}
          className="text-muted-foreground hover:text-foreground text-xs transition-colors"
        >
          Open Tasks →
        </button>
      </div>
    );
  }

  return (
    <ScrollArea type="scroll" className="h-full">
      <div className="pr-1">
        {runningRuns.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
              Running
              <span className="text-muted-foreground/50 ml-auto text-xs font-normal normal-case">
                {activeRunCount}
              </span>
            </SidebarGroupLabel>
            <SidebarMenu>
              {runningRuns.map((run) => (
                <RunningRunItem
                  key={run.id}
                  run={run}
                  scheduleName={scheduleNameMap.get(run.scheduleId) ?? 'Unknown'}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}

        {upcomingSchedules.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
              Upcoming
            </SidebarGroupLabel>
            <SidebarMenu>
              {upcomingSchedules.map((schedule) => (
                <UpcomingScheduleItem
                  key={schedule.id}
                  schedule={schedule}
                  onEdit={openTasksForEdit}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}

        {recentRuns.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel className="text-2xs text-muted-foreground/70 font-medium tracking-wider uppercase">
              Recent Runs
            </SidebarGroupLabel>
            <SidebarMenu>
              {recentRuns.map((run) => (
                <RecentRunItem
                  key={run.id}
                  run={run}
                  scheduleName={scheduleNameMap.get(run.scheduleId) ?? 'Unknown'}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}

        <div className="px-3 py-2">
          <button
            onClick={openTasks}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
          >
            Open Tasks →
          </button>
        </div>
      </div>
    </ScrollArea>
  );
}
