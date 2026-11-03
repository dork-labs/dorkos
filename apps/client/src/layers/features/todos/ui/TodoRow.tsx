/**
 * One to-do in a list: a check circle that completes it in place, its title, when it is due,
 * who has it, and the quiet facts about where it came from.
 *
 * @module features/todos/ui/TodoRow
 */
import { Fragment, type CSSProperties, type ReactNode, type Ref } from 'react';
import { motion } from 'motion/react';
import { Check } from 'lucide-react';
import type { Todo } from '@dorkos/shared/todo-schemas';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
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
  /** The drag handle, drawn first, while the list is in "My order". */
  handle?: ReactNode;
  /** The row's node, for a list that drags it. */
  rowRef?: Ref<HTMLLIElement>;
  /** Where a drag has moved the row to. */
  style?: CSSProperties;
  /** Whether the row is the one being dragged, so it draws over its neighbours. */
  dragging?: boolean;
}

/** How far right a phone swipe travels before it finishes the to-do, in pixels. */
const SWIPE_TO_FINISH_PX = 80;

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

/**
 * How a closed to-do ended, in a word, with the one line left on it after: what was done, or why
 * it was declined. Plain text, since an agent or a guest may have written it.
 */
function outcomeParts(todo: Todo): ReactNode[] {
  if (todo.state === 'open') return [];
  const word = <span key="outcome">{todo.state === 'kept' ? 'Done' : 'Declined'}</span>;
  if (!todo.note) return [word];
  return [
    word,
    <span key="note" className="min-w-0 truncate" title={todo.note}>
      {todo.note}
    </span>,
  ];
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
        Made or changed by someone DorkOS couldn’t confirm, so its agent has limited power.
      </TooltipContent>
    </Tooltip>
  );
}

/** One to-do, open or closed. */
export function TodoRow({
  todo,
  agent,
  from,
  roomTitle,
  onComplete,
  onUndo,
  handle,
  rowRef,
  style,
  dragging = false,
}: TodoRowProps) {
  const due = todoDueLabel(todo);
  const closed = todo.state !== 'open';
  // On a phone an open row also finishes with a swipe to the right; the check stays for everyone.
  const swipes = useIsMobile() && todo.state === 'open' && onComplete !== undefined;
  // Today's and overdue dates are what the eye looks for, so they read stronger than the rest.
  const urgent = todo.overdue || due === 'Due today';
  const parts: ReactNode[] = [];
  parts.push(...outcomeParts(todo));
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
      ref={rowRef}
      style={style}
      data-slot="todo-row"
      data-state={todo.state}
      data-overdue={todo.overdue || undefined}
      className={cn(
        'flex items-start gap-1 rounded-md py-1 pr-2',
        dragging && 'bg-card relative z-10 shadow-sm'
      )}
    >
      {handle}
      <CheckCircle todo={todo} {...(onComplete ? { onComplete } : {})} />
      <motion.div
        className="min-w-0 flex-1 py-2 md:py-1"
        data-swipe-to-finish={swipes || undefined}
        drag={swipes ? 'x' : false}
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        // Rightward only, and it springs back: the row stays until the server says it's done.
        dragElastic={{ left: 0, right: 0.6 }}
        dragMomentum={false}
        onDragEnd={(_event, info) => {
          if (swipes && info.offset.x > SWIPE_TO_FINISH_PX) onComplete?.();
        }}
      >
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
            <Button
              size="xs"
              variant="ghost"
              // A full finger's reach on a phone: it's the button wanted right after a swipe.
              className="shrink-0 max-md:h-11 max-md:px-3"
              onClick={onUndo}
            >
              Undo
            </Button>
          )}
        </div>
        <FactLine parts={parts} />
      </motion.div>
    </li>
  );
}
