/**
 * A to-do's card in a Direct chat (DOR-3088): the to-do as the reader is allowed to see it, read
 * from the server by id, never from the card entry's own text. Its title, when it's due, and how
 * it ended, all as plain text, and "Show work" when its turn ran in a chat of its own. A to-do the
 * reader can't see says only that it's unavailable, wherever the card turns up.
 *
 * @module features/todos/ui/TodoCard
 */
import { useNavigate } from '@tanstack/react-router';
import { Check, SquareCheck } from 'lucide-react';
import { useTodo } from '@/layers/entities/todo';
import { cn, toSession } from '@/layers/shared/lib';
import { Badge, Button, Skeleton } from '@/layers/shared/ui';
import { todoDueLabel } from '../lib/todo-labels';

/** Props for {@link TodoCard}. */
export interface TodoCardProps {
  /** The to-do the card is for. */
  todoId: string;
  /** The chat the card is drawn in, so "Show work" never links to the chat already open. */
  sessionId?: string;
}

/** How a to-do stands, in a word. */
const STATE_LABEL = { open: 'Open', kept: 'Done', dropped: 'Declined', missed: 'Missed' } as const;

/** The card's frame. */
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="todo-card"
      className="bg-card w-full max-w-md rounded-lg border px-3 py-2.5 text-sm"
    >
      {children}
    </div>
  );
}

/** A to-do's card. */
export function TodoCard({ todoId, sessionId }: TodoCardProps) {
  const navigate = useNavigate();
  const { data: todo, isPending, isError } = useTodo(todoId);

  if (isPending) {
    return (
      <Frame>
        <Skeleton className="h-4 w-2/3" />
      </Frame>
    );
  }
  if (isError || !todo) {
    return (
      <Frame>
        <p className="text-muted-foreground">This to-do is unavailable.</p>
      </Frame>
    );
  }

  const due = todoDueLabel(todo);
  const work = todo.workSessionId && todo.workSessionId !== sessionId ? todo.workSessionId : null;
  return (
    <Frame>
      <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs">
        {todo.state === 'kept' ? (
          <Check aria-hidden className="size-3.5" />
        ) : (
          <SquareCheck aria-hidden className="size-3.5" />
        )}
        <span>To-do</span>
        <Badge size="xs" {...(todo.state === 'kept' ? { tone: 'success' as const } : {})}>
          {STATE_LABEL[todo.state]}
        </Badge>
      </div>
      <p
        className={cn(
          'font-medium break-words',
          todo.state !== 'open' && 'text-muted-foreground',
          todo.state === 'dropped' && 'line-through'
        )}
      >
        {todo.what}
      </p>
      {(due || todo.note) && (
        <p className="text-muted-foreground mt-0.5 text-xs break-words">
          {due && <span className={cn(todo.overdue && 'text-destructive font-medium')}>{due}</span>}
          {due && todo.note && ' · '}
          {todo.note}
        </p>
      )}
      {work && (
        <Button
          size="xs"
          variant="ghost"
          className="mt-1 -ml-2"
          onClick={() => void navigate(toSession({ session: work }))}
        >
          Show work
        </Button>
      )}
    </Frame>
  );
}
