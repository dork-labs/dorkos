import { Plus } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { useTasksEnabled, useTaskTemplateDialog } from '@/layers/entities/tasks';
import { HomeSurfaceBar } from './HomeSurfaceBar';

/**
 * `/tasks` route bar — the home surface strip with Scheduled lit, and the one
 * thing this page lets you make.
 *
 * The tab says **Scheduled**: what people call a run that happens later is not
 * what the route was named after. Only the page's *name* changes — the route
 * stays `/tasks`, and the thing you create here is still a task, so the New Task
 * button and the task dialogs keep their own vocabulary.
 */
export function TasksHeader() {
  const tasksEnabled = useTasksEnabled();
  const openBlank = useTaskTemplateDialog((s) => s.openBlank);

  return (
    <HomeSurfaceBar
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
