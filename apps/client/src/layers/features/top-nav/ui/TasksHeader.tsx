import { Plus } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { useTasksEnabled, useTaskTemplateDialog } from '@/layers/entities/tasks';
import { PageHeader } from './PageHeader';

/** Tasks route header — page title, new task action, and command palette trigger. */
export function TasksHeader() {
  const tasksEnabled = useTasksEnabled();
  const openBlank = useTaskTemplateDialog((s) => s.openBlank);

  return (
    <PageHeader
      title="Tasks"
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
