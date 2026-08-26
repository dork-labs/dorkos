import { Plus } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { useTasksEnabled, useTaskTemplateDialog } from '@/layers/entities/tasks';

/**
 * The Schedules page action: make a new one.
 *
 * Says "Schedule", not "Task", and so does every dialog it opens (DOR-1490).
 * The product now calls these **scheduled tasks** in full and **schedules**
 * where a label has no room, because the bare word "task" collides with the
 * to-do list a chat turn keeps. Only the words moved: the route is still
 * `/tasks` and the component names still say Task.
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
      New Schedule
    </Button>
  );
}
