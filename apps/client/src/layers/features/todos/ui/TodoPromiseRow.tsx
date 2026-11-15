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
import { closedLabel, dueLabel, toLabel } from '../lib/todo-promise-labels';
import { todoMovedLabel } from '../lib/todo-labels';

/** Props for {@link TodoPromiseRow}. */
export interface TodoPromiseRowProps {
  todoPromise: TodoPromise;
  /** The agent's name, drawn first when the list spans agents. */
  agentName?: string | null;
  /** Looks up a roster name for the recipient. */
  nameOf?: (id: string) => string | null | undefined;
  /** Mark it kept or dropped. Omitted for a closed to-do, or a read-only list. */
  onClose?: (state: 'kept' | 'dropped') => void;
  /** Answer whether a kept promise was kept: Yes, or Not yet to reopen it (DOR-3034). */
  onConfirm?: (answer: 'yes' | 'not-yet') => void;
  /** True while a change to this row is being saved. */
  busy?: boolean;
}

/** A delivered link the row can open, and its site: only a web address, never a script or a path. */
function webLink(delivered: string | null): { href: string; host: string } | null {
  if (!delivered) return null;
  try {
    const url = new URL(delivered);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { href: url.href, host: url.host };
  } catch {
    return null;
  }
}

/** One to-do, open or closed. */
export function TodoPromiseRow({
  todoPromise,
  agentName,
  nameOf,
  onClose,
  onConfirm,
  busy,
}: TodoPromiseRowProps) {
  const open = todoPromise.state === 'open';
  const who = [agentName, toLabel(todoPromise.to, nameOf)].filter(Boolean).join(' · ');
  const due = open ? dueLabel(todoPromise.dueAt) : null;
  // A moved date keeps its history in view, open or closed, so a late move can't hide (DOR-3034).
  const moved = todoMovedLabel(todoPromise);
  const link = webLink(todoPromise.delivered);

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
        {(who || due || moved || link || !open) && (
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {todoPromise.state !== 'open' && <span>{closedLabel(todoPromise)}</span>}
            {who && <span className="min-w-0 truncate">{who}</span>}
            {due && (
              <span className={cn(todoPromise.overdue && 'text-destructive font-medium')}>
                {due}
              </span>
            )}
            {moved && <span>{moved}</span>}
            {link ? (
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer noopener"
                className="focus-ring hover:text-foreground rounded-sm underline underline-offset-2"
              >
                Delivered · {link.host}
              </a>
            ) : (
              todoPromise.delivered && (
                <span className="min-w-0 truncate" title={todoPromise.delivered}>
                  Delivered: {todoPromise.delivered}
                </span>
              )
            )}
          </div>
        )}
      </div>
      {onConfirm && (
        <div className="flex shrink-0 items-center gap-1">
          <span className="text-muted-foreground mr-1 text-xs">Done?</span>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => onConfirm('yes')}
            aria-label={`Yes, kept: ${todoPromise.what}`}
          >
            Yes
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => onConfirm('not-yet')}
            aria-label={`Not yet: ${todoPromise.what}`}
          >
            Not yet
          </Button>
        </div>
      )}
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
