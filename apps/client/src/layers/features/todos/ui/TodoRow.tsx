/**
 * One to-do in a list: a check circle that completes it in place, its title, when it is due,
 * who has it, and the quiet facts about where it came from.
 *
 * @module features/todos/ui/TodoRow
 */
import { Fragment, type ReactNode } from 'react';
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

/** Which agent has it: its face and name. The person's own to-dos say nothing here. */
function AgentAssignee({ agentId: id, agent }: { agentId: string; agent?: AgentPathEntry }) {
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

/** The quiet facts under a title, kept apart by a middle dot. */
function FactLine({ parts }: { parts: ReactNode[] }) {
  return (
    <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && <span aria-hidden>·</span>}
          {part}
        </Fragment>
      ))}
    </div>
  );
}

/** "Limited", with what it means on hover and focus. */
function LimitedBadge() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge size="xs" tabIndex={0} className="focus-ring">
          Limited
        </Badge>
      </TooltipTrigger>
      <TooltipContent>
        Words DorkOS can’t vouch for touched it, so its agent has less power.
      </TooltipContent>
    </Tooltip>
  );
}

/** One to-do, open or closed. */
export function TodoRow({ todo, agent, from, roomTitle, onComplete, onUndo }: TodoRowProps) {
  const due = todoDueLabel(todo);
  const closed = todo.state !== 'open';
  // Today's and overdue dates are what the eye looks for, so they read stronger than the rest.
  const urgent = todo.overdue || due === 'Due today';
  const parts: ReactNode[] = [];
  if (closed) parts.push(<Outcome todo={todo} />);
  if (todo.assignee.kind === 'agent') {
    parts.push(<AgentAssignee agentId={todo.assignee.agentId} {...(agent ? { agent } : {})} />);
  }
  if (due) {
    parts.push(
      <span
        className={cn(urgent && 'text-foreground font-medium', todo.overdue && 'text-destructive')}
      >
        {due}
      </span>
    );
  }
  parts.push(<span>from {from}</span>);
  if (roomTitle) parts.push(<span className="min-w-0 truncate">{roomTitle}</span>);
  // Only an agent's to-do runs a turn, so the limit means nothing on the person's own.
  if (todo.strangerBound && todo.assignee.kind === 'agent') parts.push(<LimitedBadge />);
  if (todo.titleFromSource && todo.sourceAuthor) {
    parts.push(<span>Words from {todo.sourceAuthor}</span>);
  }
  return (
    <li
      data-slot="todo-row"
      data-state={todo.state}
      data-overdue={todo.overdue || undefined}
      className="flex items-start gap-1 rounded-md py-1 pr-2"
    >
      <CheckCircle todo={todo} {...(onComplete ? { onComplete } : {})} />
      <div className="min-w-0 flex-1 py-2 md:py-1">
        {/* Undo sits right after the title, beside the check that was just pressed. */}
        <div className="flex min-w-0 items-center gap-1.5">
          <p
            className={cn(
              'min-w-0 truncate text-sm',
              closed && 'text-muted-foreground',
              todo.state === 'dropped' && 'line-through'
            )}
            title={todo.what}
          >
            {todo.what}
          </p>
          {onUndo && (
            <Button size="xs" variant="ghost" className="shrink-0" onClick={onUndo}>
              Undo
            </Button>
          )}
        </div>
        <FactLine parts={parts} />
      </div>
    </li>
  );
}
