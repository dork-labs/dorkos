import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { FeatureDisabledState, PageContainer, QueryErrorState } from '@/layers/shared/ui';
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

  // Wire external trigger from useTaskTemplateDialog.
  // Render-time state adjustment avoids useEffect + setState cascade.
  // See: https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const { externalTrigger, clear: clearTrigger } = useTaskTemplateDialog();
  const [prevTrigger, setPrevTrigger] = useState(false);

  if (externalTrigger && !prevTrigger && !dialogOpen) {
    setPrevTrigger(true);
    setEditTask(undefined);
    setDialogOpen(true);
    clearTrigger();
  } else if (!externalTrigger && prevTrigger) {
    setPrevTrigger(false);
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
        name="Scheduling"
        description="Scheduled tasks let your agents work on a timer, even when you're not here."
        command="dorkos --tasks"
      />
    );
  }

  if (isError) {
    return (
      <QueryErrorState
        className="h-full"
        title="Could not load your scheduled tasks"
        description="The scheduler is unreachable. Check that the server is running correctly."
        onRetry={() => void refetch()}
      />
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
          className="h-full min-h-0"
        >
          {/* The empty state is a four-card gallery, not a one-line message: on a
              phone it is taller than the region it sits in. Centring it there
              pushed its heading up behind the sticky header and out of reach, so
              it gets the page's own scroller (`PageContainer` with its default
              `scroll`) and starts at the top. */}
          <PageContainer width="full">
            <TasksEmptyState
              onCreateWithPreset={handleCreateWithPreset}
              onCreateBlank={handleCreateBlank}
            />
          </PageContainer>
        </motion.div>
      ) : (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.15 }}
          className="h-full min-h-0"
        >
          <PageContainer width="full" scroll={false}>
            <TasksList
              tasks={allTasks}
              isLoading={isLoading}
              agentMap={agentMap}
              onEditTask={handleEditTask}
            />
          </PageContainer>
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
