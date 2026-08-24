/**
 * Agent-scoped task dialog for viewing/managing tasks from the agent detail page.
 *
 * @module features/tasks/ui/TasksDialog
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/layers/shared/ui/dialog';
import { TasksList } from './TasksList';
import type { Task } from '@dorkos/shared/types';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

interface TasksDialogProps {
  agentId: string;
  agentName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tasks: Task[];
  agentMap: Map<string, AgentManifest>;
  isLoading: boolean;
}

/** Dialog showing tasks filtered by a specific agent. */
export function TasksDialog({
  agentId,
  agentName,
  open,
  onOpenChange,
  tasks,
  agentMap,
  isLoading,
}: TasksDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-3xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Schedules · {agentName}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto">
          <TasksList
            tasks={tasks}
            agentMap={agentMap}
            isLoading={isLoading}
            agentId={agentId}
            onEditTask={() => {}}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
