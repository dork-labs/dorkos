/**
 * One to-do in a list: what was promised, to whom, when it is due, and
 * (while open, for someone who may change it) the two things a person does
 * with it.
 *
 * @module features/todos/ui/TodoPromiseRow
 */
import type { TodoPromise } from '@dorkos/shared/todo-promise-schemas';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { CLOSED_STATE_LABEL, dueLabel, toLabel } from '../lib/todo-promise-labels';

/** Props for {@link TodoPromiseRow}. */
export interface TodoPromiseRowProps {
  todoPromise: TodoPromise;
  /** The agent's name, drawn first when the list spans agents. */
  agentName?: string | null;
  /** Looks up a roster name for the recipient. */
  nameOf?: (id: string) => string | null | undefined;
  /** Mark it kept or dropped. Omitted for a closed to-do, or a read-only list. */
  onClose?: (state: 'kept' | 'dropped') => void;
  /** True while a change to this row is being saved. */
  busy?: boolean;
}

/** One to-do, open or closed. */
export function TodoPromiseRow({
  todoPromise,
  agentName,
  nameOf,
  onClose,
  busy,
}: TodoPromiseRowProps) {
  const open = todoPromise.state === 'open';
  const who = [agentName, toLabel(todoPromise.to, nameOf)].filter(Boolean).join(' · ');
  const due = open ? dueLabel(todoPromise.dueAt) : null;

  return (
    <li
      data-slot="todo-promise-row"
      data-state={todoPromise.state}
      data-overdue={todoPromise.overdue || undefined}
      className="flex flex-col gap-2 rounded-md px-2 py-2 sm:flex-row sm:items-center sm:gap-3"
    >
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-sm break-words',
            !open && 'text-muted-foreground',
            todoPromise.state === 'dropped' && 'line-through'
          )}
        >
          {todoPromise.what}
        </p>
        {(who || due || !open) && (
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {todoPromise.state !== 'open' && <span>{CLOSED_STATE_LABEL[todoPromise.state]}</span>}
            {who && <span className="min-w-0 truncate">{who}</span>}
            {due && (
              <span className={cn(todoPromise.overdue && 'text-destructive font-medium')}>
                {due}
              </span>
            )}
          </div>
        )}
      </div>
      {open && onClose && (
        <div className="flex shrink-0 gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => onClose('kept')}
            aria-label={`Mark kept: ${todoPromise.what}`}
          >
            Mark kept
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => onClose('dropped')}
            aria-label={`Drop: ${todoPromise.what}`}
          >
            Drop
          </Button>
        </div>
      )}
    </li>
  );
}
