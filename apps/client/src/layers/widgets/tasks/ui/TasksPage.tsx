import { useMemo, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { motion } from 'motion/react';
import { Button } from '@/layers/shared/ui/button';
import { FeatureDisabledState } from '@/layers/shared/ui';
import { icons } from '@dorkos/icons/registry';
import { useTasksEnabled, useTasks, useTaskTemplateDialog } from '@/layers/entities/tasks';
import type { TaskTemplate } from '@/layers/entities/tasks';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import type { Task } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { TasksList } from '@/layers/features/tasks/ui/TasksList';
import { TasksEmptyState, CreateTaskDialog } from '@/layers/features/tasks';

/** Tasks page -- full-viewport task management surface at /tasks. */
export function TasksPage() {
  const tasksEnabled = useTasksEnabled();
  const { data: allTasks = [], isLoading, isError, refetch } = useTasks(tasksEnabled);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editTask, setEditTask] = useState<Task | undefined>();
  const [appliedPreset, setAppliedPreset] = useState<TaskTemplate | null>(null);

  // Fetch registered mesh agents for building the agent map
  const hasAgentIdTasks = allTasks.some((t) => t.agentId);
  const { data: meshAgentsData } = useRegisteredAgents(undefined, hasAgentIdTasks || !isLoading);
  const agentMap = useMemo(() => {
    const map = new Map<string, AgentManifest>();
    for (const agent of meshAgentsData?.agents ?? []) {
      map.set(agent.id, agent);
    }
    return map;
  }, [meshAgentsData]);

  // Wire external trigger from useTaskTemplateDialog
  const { externalTrigger } = useTaskTemplateDialog();

  if (externalTrigger && !dialogOpen) {
    setEditTask(undefined);
    setDialogOpen(true);
  }

  const handleCreateWithPreset = (preset: TaskTemplate) => {
    setAppliedPreset(preset);
    setEditTask(undefined);
    setDialogOpen(true);
  };

  const handleCreateBlank = () => {
    setAppliedPreset(null);
    setEditTask(undefined);
    setDialogOpen(true);
  };

  const handleEditTask = (task: Task) => {
    setEditTask(task);
    setDialogOpen(true);
  };

  const handleDialogOpenChange = (open: boolean) => {
    setDialogOpen(open);
    if (!open) setAppliedPreset(null);
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

  if (isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <div className="bg-destructive/10 rounded-xl p-3">
          <TriangleAlert className="text-destructive size-6" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Could not load tasks</p>
          <p className="text-muted-foreground mt-1 text-xs">
            The tasks API is unreachable. Check that the server is running correctly.
          </p>
        </div>
        <Button size="sm" onClick={() => void refetch()} className="mt-1">
          Retry
        </Button>
      </div>
    );
  }

  const hasTasks = allTasks.length > 0;

  return (
    <>
      {!hasTasks && !isLoading ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
          className="flex h-full flex-col items-center justify-center"
        >
          <TasksEmptyState
            onCreateWithPreset={handleCreateWithPreset}
            onCreateBlank={handleCreateBlank}
          />
        </motion.div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
          className="flex h-full flex-col"
        >
          <TasksList
            tasks={allTasks}
            isLoading={isLoading}
            agentMap={agentMap}
            onEditTask={handleEditTask}
          />
        </motion.div>
      )}

      <CreateTaskDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        editTask={editTask}
        initialPreset={appliedPreset}
      />
    </>
  );
}
