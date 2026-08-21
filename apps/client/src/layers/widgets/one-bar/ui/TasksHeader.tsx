import { Plus } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { useTasksEnabled, useTaskTemplateDialog } from '@/layers/entities/tasks';
import { BarTitle, OneBar } from './OneBar';

/**
 * `/tasks` route bar — page title and the new task action.
 *
 * The title says **Scheduled**, matching the tab that opens this page: what
 * people call a run that happens later is not what the route was named after.
 * Only the page's *name* changes — the route stays `/tasks`, and the thing you
 * create here is still a task, so the New Task button and the task dialogs keep
 * their own vocabulary.
 */
export function TasksHeader() {
  const tasksEnabled = useTasksEnabled();
  const openBlank = useTaskTemplateDialog((s) => s.openBlank);

  return (
    <OneBar
      identity={<BarTitle>Scheduled</BarTitle>}
      actions={
        tasksEnabled ? (
          <Button variant="outline" size="xs" onClick={openBlank}>
            <Plus />
            New Task
          </Button>
        ) : undefined
      }
    />
  );
}
