import { SquareCheck } from 'lucide-react';
import { useTodosEnabledState } from '@/layers/entities/todo';
import { openNewTodo, TodoList } from '@/layers/features/todos';
import { FeatureDisabledState, PageContainer, PageHeading, Skeleton } from '@/layers/shared/ui';

/**
 * To-dos page, at `/todos`: the person's list, opening on what is assigned to them. New to-do
 * lives in the page's bar (`NewTodoButton`). While the server has to-dos off it says so and how
 * to turn them on.
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
      <TodoList onNewTodo={openNewTodo} />
    </PageContainer>
  );
}
