/**
 * One to-do in a list: a check circle that completes it in place, its title, when it is due,
 * who has it, and the quiet facts about where it came from.
 *
 * @module features/todos/ui/TodoRow
 */
import { Check } from 'lucide-react';
import type { Todo } from '@dorkos/shared/todo-schemas';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import { Badge, Button, Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import { todoDueLabel } from '../lib/todo-labels';

/** Props for {@link TodoRow}. */
export interface TodoRowProps {
  /** The to-do to draw. */
  todo: Todo;
  /** The assigned agent, when the assignee is an agent the roster knows. */
  agent?: AgentPathEntry;
  /** Who made it, already in words: "you", an agent's name, or "a guest". */
  from: string;
  /** The room it came from, by name, when that resolves. */
  roomTitle?: string;
  /** Complete it. Omitted where the row cannot be changed. */
  onComplete?: () => void;
  /** Put a just-completed row back. Present only for the moment the row is held. */
  onUndo?: () => void;
}

/** The check circle: open, or done. */
function CheckCircle({ todo, onComplete }: Pick<TodoRowProps, 'todo' | 'onComplete'>) {
  const done = todo.state === 'kept';
  const canComplete = todo.state === 'open' && onComplete !== undefined;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={todo.what}
      disabled={!canComplete}
      onClick={canComplete ? onComplete : undefined}
      className="focus-ring flex size-11 shrink-0 items-center justify-center rounded-full md:size-7"
    >
      <span
        aria-hidden
        className={cn(
          'flex size-4.5 items-center justify-center rounded-full border transition-colors duration-150',
          done ? 'bg-foreground border-foreground text-background' : 'border-muted-foreground/60',
          canComplete && 'hover:border-foreground'
        )}
      >
        {done && <Check className="size-3" strokeWidth={3} />}
      </span>
    </button>
  );
}

/** Who has it: an agent's face and name, or "You". */
function Assignee({ todo, agent }: Pick<TodoRowProps, 'todo' | 'agent'>) {
  if (todo.assignee.kind === 'person') return <span>You</span>;
  const id = todo.assignee.agentId;
  const visual = resolveAgentVisual({ id, color: agent?.color, icon: agent?.icon });
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <AgentAvatar color={visual.color} emoji={visual.emoji} size="xs" />
      <span className="truncate">{agent ? getAgentDisplayName(agent) : id}</span>
    </span>
  );
}

/** How a closed to-do ended, in a word, with a decline's reason after it. */
function Outcome({ todo }: Pick<TodoRowProps, 'todo'>) {
  if (todo.state === 'kept') return <span>Done</span>;
  if (todo.state === 'dropped') {
    return <span>{todo.note ? `Declined · ${todo.note}` : 'Declined'}</span>;
  }
  return null;
}

/** One to-do, open or closed. */
export function TodoRow({ todo, agent, from, roomTitle, onComplete, onUndo }: TodoRowProps) {
  const due = todoDueLabel(todo);
  const closed = todo.state !== 'open';
  return (
    <li
      data-slot="todo-row"
      data-state={todo.state}
      data-overdue={todo.overdue || undefined}
      className="flex items-start gap-1 rounded-md py-1 pr-2"
    >
      <CheckCircle todo={todo} {...(onComplete ? { onComplete } : {})} />
      <div className="min-w-0 flex-1 py-2 md:py-1">
        <p
          className={cn(
            'truncate text-sm',
            closed && 'text-muted-foreground',
            todo.state === 'dropped' && 'line-through'
          )}
          title={todo.what}
        >
          {todo.what}
        </p>
        <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Outcome todo={todo} />
          {due && <span className={cn(todo.overdue && 'text-destructive font-medium')}>{due}</span>}
          <Assignee todo={todo} {...(agent ? { agent } : {})} />
          <span>from {from}</span>
          {roomTitle && <span className="min-w-0 truncate">{roomTitle}</span>}
          {/* Only an agent's to-do runs a turn, so the limit means nothing on the person's own. */}
          {todo.strangerBound && todo.assignee.kind === 'agent' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge size="xs" tabIndex={0} className="focus-ring">
                  Limited
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Someone outside touched it, so guest limits apply.</TooltipContent>
            </Tooltip>
          )}
          {todo.titleFromSource && todo.sourceAuthor && <span>Words from {todo.sourceAuthor}</span>}
        </div>
      </div>
      {onUndo && (
        <Button size="xs" variant="ghost" className="mt-2 md:mt-1" onClick={onUndo}>
          Undo
        </Button>
      )}
    </li>
  );
}
