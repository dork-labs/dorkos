import { Plus } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { useTasksEnabled, useTaskTemplateDialog } from '@/layers/entities/tasks';

/**
 * Scheduled's page action: make a new one.
 *
 * Renaming the page did not rename the noun. The tab says **Scheduled** because
 * that is what people call a run that happens later, but the thing you create
 * here is still a task and the dialogs still say so.
 *
 * Draws nothing when tasks are switched off, because a button that opens a
 * dialog for a disabled feature is a promise the cockpit cannot keep.
 */
export function NewTaskAction() {
  const tasksEnabled = useTasksEnabled();
  const openBlank = useTaskTemplateDialog((s) => s.openBlank);

  if (!tasksEnabled) return null;

  return (
    <Button variant="outline" size="xs" onClick={openBlank}>
      <Plus />
      New Task
    </Button>
  );
}
