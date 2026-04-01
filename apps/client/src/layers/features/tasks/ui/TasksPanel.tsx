import { useState, useEffect, useMemo } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { FeatureDisabledState } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { icons } from '@dorkos/icons/registry';
import { useTasksEnabled, useTasks, useTaskTemplateDialog } from '@/layers/entities/tasks';
import type { TaskTemplate } from '@/layers/entities/tasks';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import type { Task } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { CreateTaskDialog } from './CreateTaskDialog';
import { TasksEmptyState } from './TasksEmptyState';
import { TaskRow } from './TaskRow';

/** Main Tasks panel — renders schedule list or empty/loading/disabled states. */
export function TasksPanel() {
  const tasksEnabled = useTasksEnabled();
  const { data: allSchedules = [], isLoading } = useTasks(tasksEnabled);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTask, setEditTask] = useState<Task | undefined>();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [appliedPresetForDialog, setAppliedPresetForDialog] = useState<TaskTemplate | null>(null);

  const tasksAgentFilter = useAppStore((s) => s.tasksAgentFilter);
  const setTasksAgentFilter = useAppStore((s) => s.setTasksAgentFilter);
  const tasksEditScheduleId = useAppStore((s) => s.tasksEditScheduleId);
  const setTasksEditScheduleId = useAppStore((s) => s.setTasksEditScheduleId);

  // Filter schedules by agent when filter is active
  const schedules = tasksAgentFilter
    ? allSchedules.filter((s) => s.agentId === tasksAgentFilter)
    : allSchedules;

  // Fetch registered mesh agents for agentId-based schedules
  const hasAgentIdSchedules = allSchedules.some((s) => s.agentId);
  const { data: meshAgentsData } = useRegisteredAgents(undefined, hasAgentIdSchedules);
  const meshAgentsById = useMemo(() => {
    const map = new Map<string, AgentManifest>();
    for (const agent of meshAgentsData?.agents ?? []) {
      map.set(agent.id, agent);
    }
    return map;
  }, [meshAgentsData]);

  // Open edit dialog for a specific schedule via store
  /* eslint-disable react-hooks/set-state-in-effect -- respond to store-driven navigation to edit a schedule */
  useEffect(() => {
    if (!tasksEditScheduleId || isLoading) return;
    const target = allSchedules.find((s) => s.id === tasksEditScheduleId);
    if (target) {
      setEditTask(target);
      setDialogOpen(true);
    }
    setTasksEditScheduleId(null);
  }, [tasksEditScheduleId, allSchedules, isLoading, setTasksEditScheduleId]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Resolve filtered agent name for the filter chip
  const filterAgentName = useMemo(() => {
    if (!tasksAgentFilter) return null;
    return meshAgentsById.get(tasksAgentFilter)?.name ?? tasksAgentFilter;
  }, [tasksAgentFilter, meshAgentsById]);

  const { externalTrigger } = useTaskTemplateDialog();

  /* eslint-disable react-hooks/set-state-in-effect -- open dialog in response to external preset trigger */
  useEffect(() => {
    if (externalTrigger) {
      setEditTask(undefined);
      setDialogOpen(true);
    }
  }, [externalTrigger]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const handleCreateWithPreset = (preset: TaskTemplate) => {
    setAppliedPresetForDialog(preset);
    setEditTask(undefined);
    setDialogOpen(true);
  };

  const handleCreateBlank = () => {
    setAppliedPresetForDialog(null);
    setEditTask(undefined);
    setDialogOpen(true);
  };

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) setAppliedPresetForDialog(null);
  };

  if (!tasksEnabled) {
    return (
      <FeatureDisabledState
        icon={icons.tasks}
        name="Tasks"
        description="Tasks runs AI agent tasks on a schedule. Start DorkOS with the --tasks flag to enable it."
        command="dorkos --tasks"
      />
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border p-3">
            <div className="flex items-center gap-3">
              <div className="bg-muted animate-tasks size-2 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <div className="bg-muted animate-tasks h-4 w-32 rounded" />
                <div className="bg-muted animate-tasks h-3 w-48 rounded" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (schedules.length === 0) {
    return (
      <>
        {tasksAgentFilter ? (
          <div className="flex flex-col items-center gap-3 p-8">
            <AgentFilterChip name={filterAgentName} onClear={() => setTasksAgentFilter(null)} />
            <p className="text-muted-foreground text-sm">No schedules for this agent.</p>
            <button
              onClick={handleCreateBlank}
              className="border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md border bg-transparent px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
            >
              New Schedule
            </button>
          </div>
        ) : (
          <TasksEmptyState
            onCreateWithPreset={handleCreateWithPreset}
            onCreateBlank={handleCreateBlank}
          />
        )}
        <CreateTaskDialog
          open={dialogOpen}
          onOpenChange={handleDialogOpenChange}
          editTask={editTask}
          initialPreset={appliedPresetForDialog}
          initialAgentId={tasksAgentFilter ?? undefined}
        />
      </>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="space-y-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="text-muted-foreground text-sm font-medium">Schedules</h3>
            {tasksAgentFilter && (
              <AgentFilterChip name={filterAgentName} onClear={() => setTasksAgentFilter(null)} />
            )}
          </div>
          <button
            onClick={() => {
              setEditTask(undefined);
              setDialogOpen(true);
            }}
            className="border-input hover:bg-accent hover:text-accent-foreground inline-flex items-center rounded-md border bg-transparent px-3 py-1.5 text-sm font-medium shadow-sm transition-colors"
          >
            New Schedule
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        <AnimatePresence initial={false}>
          {schedules.map((task) => (
            <motion.div
              key={task.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
              className="mb-2"
            >
              <TaskRow
                task={task}
                agent={task.agentId ? (meshAgentsById.get(task.agentId) ?? null) : null}
                expanded={expandedId === task.id}
                onToggleExpand={() => setExpandedId(expandedId === task.id ? null : task.id)}
                onEdit={() => {
                  setEditTask(task);
                  setDialogOpen(true);
                }}
              />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <CreateTaskDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editTask={editTask}
        initialPreset={appliedPresetForDialog}
        initialAgentId={tasksAgentFilter ?? undefined}
      />
    </div>
  );
}

/** Compact chip showing the active agent filter with a clear button. */
function AgentFilterChip({ name, onClear }: { name: string | null; onClear: () => void }) {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs">
      {name ?? 'Agent'}
      <button
        type="button"
        onClick={onClear}
        className="hover:text-foreground -mr-0.5 rounded-full p-0.5 transition-colors"
        aria-label="Clear agent filter"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}
