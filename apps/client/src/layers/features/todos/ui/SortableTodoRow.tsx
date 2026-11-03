/**
 * A to-do row the list can move in "My order". With a mouse: a grip to drag it by, which also
 * moves it with ⌥↑ / ⌥↓ (or Space, then the arrows, as any sortable list). On a touch screen: a
 * long press on the row's words. In Reorder mode: ↑ and ↓ buttons at the row's end, the way in
 * for anyone who can't drag. Outside "My order" it is the plain row.
 *
 * @module features/todos/ui/SortableTodoRow
 */
import type { KeyboardEvent, TouchEvent } from 'react';
import {
  defaultAnimateLayoutChanges,
  useSortable,
  type AnimateLayoutChanges,
} from '@dnd-kit/sortable';
import { useReducedMotion } from 'motion/react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { usePrefersLongPress } from '../model/use-prefers-long-press';
import { TodoRow, type TodoRowProps } from './TodoRow';

/** Props for {@link SortableTodoRow}. */
export interface SortableTodoRowProps extends Omit<
  TodoRowProps,
  'handle' | 'rowRef' | 'style' | 'dragging' | 'pressToMove' | 'trailing'
> {
  /** Whether the list is in "My order", where rows move. */
  sortable: boolean;
  /** Move this row up (-1) or down (+1). */
  onMove: (by: -1 | 1) => void;
  /**
   * The list is in Reorder mode: the row moves by its ↑ and ↓, and a stray gesture can't finish
   * or lift it. Where it sits decides which button works.
   */
  reorder?: { first: boolean; last: boolean };
}

/**
 * A row slides to its new place however it moved: after a drag, and after a Reorder button or ⌥↑ /
 * ⌥↓, which change the order with nothing being dragged. Same slide either way (DOR-3715).
 */
const slideOnEveryMove: AnimateLayoutChanges = (args) =>
  defaultAnimateLayoutChanges({ ...args, wasDragging: true });

/** The `data-todo-move` key of one of a row's Reorder buttons, which the list refocuses. */
export function todoMoveKey(id: string, by: -1 | 1): string {
  return `${id}:${by === -1 ? 'up' : 'down'}`;
}

/** One to-do, movable in "My order". */
export function SortableTodoRow({ sortable, onMove, reorder, ...row }: SortableTodoRowProps) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: row.todo.id,
    disabled: !sortable,
    animateLayoutChanges: slideOnEveryMove,
  });
  // Under reduced motion a move is instant, a drag's settle included.
  const reducedMotion = useReducedMotion();
  // By pointer, not width (DOR-3715): a touch tablet has no hover to show a grip, and a narrow
  // desktop window still has a mouse and the keyboard moves.
  const longPress = usePrefersLongPress();

  // ⌥↑ / ⌥↓ move it at once; every other key goes on to the drag's own keyboard handling.
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      onMove(event.key === 'ArrowUp' ? -1 : 1);
      return;
    }
    listeners?.onKeyDown?.(event);
  }

  if (!sortable) return <TodoRow {...row} />;
  // In Reorder mode the check stays, disabled, and with it the swipe to finish.
  const { onComplete: _complete, ...rest } = row;
  return (
    <TodoRow
      {...(reorder ? rest : row)}
      rowRef={setNodeRef}
      dragging={isDragging}
      // Up and down only: a list row never leaves its column.
      style={{
        transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
        transition: reducedMotion ? undefined : transition,
      }}
      {...(longPress && !reorder
        ? {
            pressToMove: {
              onTouchStart: (event: TouchEvent<HTMLDivElement>) => listeners?.onTouchStart?.(event),
            },
          }
        : {})}
      {...(longPress
        ? {}
        : {
            handle: (
              <button
                type="button"
                ref={setActivatorNodeRef}
                data-todo-grip={row.todo.id}
                {...attributes}
                {...listeners}
                onKeyDown={onKeyDown}
                aria-label={`Move ${row.todo.what}`}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                // Out of the way until wanted: it shows when the row is hovered or the grip has focus.
                className="focus-ring text-muted-foreground hover:text-foreground flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
              >
                <GripVertical aria-hidden className="size-4" />
              </button>
            ),
          })}
      {...(reorder
        ? {
            trailing: (
              <div className="animate-in fade-in flex shrink-0 items-center duration-150 motion-reduce:animate-none">
                <MoveButton
                  todoId={row.todo.id}
                  title={row.todo.what}
                  by={-1}
                  disabled={reorder.first}
                  onMove={onMove}
                />
                <MoveButton
                  todoId={row.todo.id}
                  title={row.todo.what}
                  by={1}
                  disabled={reorder.last}
                  onMove={onMove}
                />
              </div>
            ),
          }
        : {})}
    />
  );
}

/** One of a row's Reorder buttons: a finger's reach on a phone, a quiet square on a desktop. */
function MoveButton({
  todoId,
  title,
  by,
  disabled,
  onMove,
}: {
  todoId: string;
  title: string;
  by: -1 | 1;
  disabled: boolean;
  onMove: (by: -1 | 1) => void;
}) {
  const Icon = by === -1 ? ArrowUp : ArrowDown;
  return (
    <Button
      type="button"
      size="icon-md"
      variant="ghost"
      data-todo-move={todoMoveKey(todoId, by)}
      aria-label={`Move ${title} ${by === -1 ? 'up' : 'down'}`}
      disabled={disabled}
      onClick={() => onMove(by)}
      className="size-11 md:size-7"
    >
      <Icon aria-hidden className="size-4" />
    </Button>
  );
}
