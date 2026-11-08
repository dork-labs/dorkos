/**
 * What agents promised, as a list a person can act on (spec `heartbeats` §12).
 *
 * Open to-dos first, soonest due first, with overdue ones marked. Kept,
 * missed and dropped ones sit folded under them. A person marks one kept or
 * drops it (with an Undo), and, on one agent's list, adds one for that agent.
 * A read-only list (someone else's agent) shows the same rows as facts, with
 * no controls.
 *
 * @module features/todos/ui/TodoPromiseList
 */
import { useState } from 'react';
import { toast } from 'sonner';
import type { TodoPromise } from '@dorkos/shared/todo-promise-schemas';
import { ChevronRight, Plus } from 'lucide-react';
import { useTodoPromises, useUpdateTodoPromise } from '@/layers/entities/todo';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Skeleton,
} from '@/layers/shared/ui';
import { splitTodos } from '../lib/todo-promise-labels';
import { AddTodoForm } from './AddTodoForm';
import { TodoPromiseRow } from './TodoPromiseRow';

/** Props for {@link TodoPromiseList}. */
export interface TodoPromiseListProps {
  /** One agent's promises; omit for the whole team's. */
  agentId?: string;
  /**
   * Looks up a roster name by id: the agent on each row when the list spans
   * agents, and the person or agent a promise was made to.
   */
  nameOf?: (id: string) => string | null | undefined;
  /** Offer "Add to-do" for this agent. Only on one agent's list. */
  canAdd?: boolean;
  /** Facts only: no Mark kept, no Drop, no Add. */
  readOnly?: boolean;
  /**
   * Whether this person may change one row, for a list that spans agents (the
   * Team page): you can change your own agents' to-dos, not someone
   * else's. Defaults to every row unless `readOnly`.
   */
  canChange?: (todoPromise: TodoPromise) => boolean;
}

/** What the Undo toast says each close was. */
const CLOSED_TOAST: Record<'kept' | 'dropped', string> = {
  kept: 'Marked kept',
  dropped: 'To-do dropped',
};

/** A list of promises, open first. */
export function TodoPromiseList({
  agentId,
  nameOf,
  canAdd = false,
  readOnly = false,
  canChange,
}: TodoPromiseListProps) {
  const query = useTodoPromises(agentId ? { agentId } : {});
  const update = useUpdateTodoPromise();
  const [adding, setAdding] = useState(false);
  const spansAgents = agentId === undefined;

  /** Close one, then offer to put it back the way it was. */
  function closeWithUndo(todoPromise: TodoPromise, state: 'kept' | 'dropped') {
    update.mutate(
      { id: todoPromise.id, body: { state } },
      {
        onSuccess: () =>
          toast.success(CLOSED_TOAST[state], {
            // Reopening keeps the old date; the server gives an overdue one a
            // fresh hour rather than marking it missed the moment it reopens.
            action: {
              label: 'Undo',
              // `from` makes the Undo refuse if someone changed it since.
              onClick: () =>
                update.mutate({ id: todoPromise.id, body: { state: 'open', from: state } }),
            },
          }),
      }
    );
  }

  if (query.isPending) return <Skeleton className="h-16 w-full" />;
  if (query.isError) {
    return <p className="text-muted-foreground text-sm">Couldn’t read to-dos.</p>;
  }

  const { open, closed } = splitTodos(query.data);
  const busyId = update.isPending ? update.variables?.id : undefined;

  return (
    <div data-slot="todo-promise-list" className="flex flex-col gap-2">
      {open.length === 0 && closed.length === 0 && !adding && (
        <p className="text-muted-foreground text-sm">No to-dos yet.</p>
      )}
      {open.length > 0 && (
        <ul className="flex flex-col" aria-label="Open to-dos">
          {open.map((todoPromise) => (
            <TodoPromiseRow
              key={todoPromise.id}
              todoPromise={todoPromise}
              agentName={spansAgents ? nameOf?.(todoPromise.agentId) : undefined}
              nameOf={nameOf}
              busy={busyId === todoPromise.id}
              {...(readOnly || (canChange && !canChange(todoPromise))
                ? {}
                : { onClose: (state: 'kept' | 'dropped') => closeWithUndo(todoPromise, state) })}
            />
          ))}
        </ul>
      )}
      {update.isError && (
        <p role="alert" className="text-destructive text-xs">
          Couldn’t change that to-do. Try again.
        </p>
      )}
      {closed.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="focus-ring text-muted-foreground hover:text-foreground group flex items-center gap-1 rounded-md px-2 py-1 text-xs">
            <ChevronRight
              aria-hidden
              className="size-3.5 transition-transform group-data-[state=open]:rotate-90"
            />
            Closed ({closed.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="flex flex-col" aria-label="Closed to-dos">
              {closed.map((todoPromise) => (
                <TodoPromiseRow
                  key={todoPromise.id}
                  todoPromise={todoPromise}
                  agentName={spansAgents ? nameOf?.(todoPromise.agentId) : undefined}
                  nameOf={nameOf}
                />
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
      {canAdd && !readOnly && agentId && adding && (
        <AddTodoForm agentId={agentId} onDone={() => setAdding(false)} />
      )}
      {canAdd && !readOnly && agentId && !adding && (
        <Button size="sm" variant="ghost" className="self-start" onClick={() => setAdding(true)}>
          <Plus aria-hidden />
          Add to-do
        </Button>
      )}
    </div>
  );
}
