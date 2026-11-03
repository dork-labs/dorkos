import { useState } from 'react';
import { Plus, SquareCheck } from 'lucide-react';
import { useTodosEnabledState } from '@/layers/entities/todo';
import { NewTodoDialog, TodoList } from '@/layers/features/todos';
import {
  Button,
  FeatureDisabledState,
  PageContainer,
  PageHeading,
  Skeleton,
} from '@/layers/shared/ui';

/**
 * To-dos page, at `/todos`: the person's list, opening on what is assigned to them, with a way
 * to add one. While the server has to-dos off it says so and how to turn them on.
 */
export function TodosPage() {
  return (
    <>
      <PageHeading>To-dos</PageHeading>
      <TodosPageBody />
    </>
  );
}

/** Every state of the `/todos` page below its heading. */
function TodosPageBody() {
  const flag = useTodosEnabledState();
  const [dialogOpen, setDialogOpen] = useState(false);

  if (flag.isLoading) {
    return (
      <PageContainer width="wide">
        <Skeleton className="h-24 w-full" />
      </PageContainer>
    );
  }

  if (!flag.enabled) {
    return (
      <FeatureDisabledState
        icon={SquareCheck}
        name="To-do list"
        description="One list of what you and your agents need to do."
        command="DORKOS_TODOS_ENABLED=true dorkos"
      />
    );
  }

  return (
    <PageContainer width="wide">
      <div className="flex flex-col gap-4">
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus aria-hidden />
            New to-do
          </Button>
        </div>
        <TodoList onNewTodo={() => setDialogOpen(true)} />
      </div>
      <NewTodoDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </PageContainer>
  );
}
