/**
 * The to-do list a person works from: one view at a time, open ones first in the server's order,
 * each completed in place with a moment to undo it.
 *
 * @module features/todos/ui/TodoList
 */
import { useMemo } from 'react';
import { SquareCheck } from 'lucide-react';
import type { Todo } from '@dorkos/shared/todo-schemas';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { roomDisplayTitle, useRooms } from '@/layers/entities/room';
import { useTodos, useUpdateTodo } from '@/layers/entities/todo';
import { getAgentDisplayName } from '@/layers/shared/lib';
import { Button, EmptyState, QueryErrorState, Skeleton } from '@/layers/shared/ui';
import { assignedByLabel } from '../lib/todo-labels';
import { useLingeringDone, withLingering } from '../model/use-lingering-done';
import { useTodoFilters } from '../model/use-todo-filters';
import { TodoFilterBar } from './TodoFilterBar';
import { TodoRow } from './TodoRow';

/** Props for {@link TodoList}. */
export interface TodoListProps {
  /** Open the New to-do dialog, offered from the empty "Assigned to me" view. */
  onNewTodo: () => void;
}

/** The roster and room names a row reads, by id. */
function useNameLookups() {
  const { data: agentsData } = useMeshAgentPaths();
  const { data: rooms } = useRooms();
  return useMemo(() => {
    const agents = new Map<string, AgentPathEntry>();
    for (const agent of agentsData?.agents ?? []) agents.set(agent.id, agent);
    const roomTitles = new Map<string, string>();
    for (const room of rooms ?? []) roomTitles.set(room.id, roomDisplayTitle(room));
    return {
      agentOf: (id: string) => agents.get(id),
      agentName: (id: string) => {
        const agent = agents.get(id);
        return agent ? getAgentDisplayName(agent) : undefined;
      },
      roomTitleOf: (id: string | null) => (id ? roomTitles.get(id) : undefined),
    };
  }, [agentsData, rooms]);
}

/** The to-do list, its controls, and its footer. */
export function TodoList({ onNewTodo }: TodoListProps) {
  const { filters, query, set } = useTodoFilters();
  const list = useTodos(query);
  const update = useUpdateTodo();
  const lingering = useLingeringDone(JSON.stringify(query));
  const names = useNameLookups();

  const rows = useMemo(
    () => withLingering(list.data?.todos ?? [], lingering.held),
    [list.data, lingering.held]
  );

  function complete(todo: Todo, index: number) {
    lingering.hold(todo, index);
    update
      .mutateAsync({ id: todo.id, body: { state: 'kept' } })
      .then(() => lingering.saved(todo.id))
      .catch(() => lingering.release(todo.id));
  }

  function undo(todo: Todo) {
    lingering.reopen(todo.id);
    // `from` refuses the Undo if someone changed the to-do since it was completed.
    update
      .mutateAsync({ id: todo.id, body: { state: 'open', from: 'kept' } })
      .catch(() => undefined)
      .finally(() => lingering.release(todo.id));
  }

  return (
    <div data-slot="todo-list" className="flex flex-col gap-3">
      <TodoFilterBar filters={filters} onChange={set} />
      {list.isPending && <Skeleton className="h-24 w-full" />}
      {list.isError && (
        <QueryErrorState
          title="Couldn’t load your to-dos"
          description="The DorkOS server didn’t answer. Check that it’s running."
          onRetry={() => void list.refetch()}
        />
      )}
      {list.isSuccess && rows.length === 0 && (
        <TodoListEmpty mine={filters.view === 'mine'} onNewTodo={onNewTodo} />
      )}
      {list.isSuccess && rows.length > 0 && (
        <ul className="flex flex-col" aria-label="To-dos">
          {rows.map((todo, index) => {
            const agent =
              todo.assignee.kind === 'agent' ? names.agentOf(todo.assignee.agentId) : undefined;
            const roomTitle = names.roomTitleOf(todo.roomId);
            const entry = lingering.held[todo.id];
            const held = entry !== undefined;
            return (
              <TodoRow
                key={todo.id}
                todo={todo}
                from={assignedByLabel(todo.assignedBy, names.agentName)}
                {...(agent ? { agent } : {})}
                {...(roomTitle ? { roomTitle } : {})}
                {...(todo.state === 'open' && !held
                  ? { onComplete: () => complete(todo, index) }
                  : {})}
                {...(entry && !entry.saving && todo.state === 'kept'
                  ? { onUndo: () => undo(todo) }
                  : {})}
              />
            );
          })}
        </ul>
      )}
      {!filters.showDone && (list.data?.doneCount ?? 0) > 0 && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => set('showDone', true)}
        >
          Show done ({list.data?.doneCount})
        </Button>
      )}
      {filters.showDone && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => set('showDone', false)}
        >
          Hide done
        </Button>
      )}
    </div>
  );
}

/** Nothing in this view: a way to add one on your own list, a quiet line elsewhere. */
function TodoListEmpty({ mine, onNewTodo }: { mine: boolean; onNewTodo: () => void }) {
  if (!mine) return <p className="text-muted-foreground px-2 py-4 text-sm">No to-dos here.</p>;
  return (
    <EmptyState
      icon={SquareCheck}
      headline="Nothing assigned to you."
      description="Add one, or ask an agent to."
      action={{ label: 'New to-do', onClick: onNewTodo }}
    />
  );
}
