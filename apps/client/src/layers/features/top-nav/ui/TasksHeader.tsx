import { Plus } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { useTasksEnabled, useTaskTemplateDialog } from '@/layers/entities/tasks';
import { PageHeader } from './PageHeader';

/**
 * `/tasks` route header — page title, new task action, and command palette
 * trigger.
 *
 * The title says **Scheduled**, matching the tab that opens this page: what
 * people call a run that happens later is not what the route was named after,
 * and the tab bar sits directly below this header. Only the page's *name*
 * changes — the route stays `/tasks`, and the thing you create here is still a
 * task, so the New Task button and the task dialogs keep their own vocabulary.
 */
export function TasksHeader() {
  const tasksEnabled = useTasksEnabled();
  const openBlank = useTaskTemplateDialog((s) => s.openBlank);

  return (
    <PageHeader
      title="Scheduled"
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
