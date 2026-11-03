/**
 * A to-do row the list can move in "My order": a grip to drag it by, which also moves it with
 * ⌥↑ / ⌥↓ (or Space, then the arrows, as any sortable list). Outside "My order" it is the plain row.
 *
 * @module features/todos/ui/SortableTodoRow
 */
import type { KeyboardEvent, PointerEvent } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { GripVertical } from 'lucide-react';
import { useIsMobile } from '@/layers/shared/model';
import { TodoRow, type TodoRowProps } from './TodoRow';

/** Props for {@link SortableTodoRow}. */
export interface SortableTodoRowProps extends Omit<
  TodoRowProps,
  'handle' | 'rowRef' | 'style' | 'dragging' | 'pressToMove'
> {
  /** Whether the list is in "My order", where rows move. */
  sortable: boolean;
  /** Move this row up (-1) or down (+1). */
  onMove: (by: -1 | 1) => void;
}

/** One to-do, draggable in "My order". */
export function SortableTodoRow({ sortable, onMove, ...row }: SortableTodoRowProps) {
  const {
    setNodeRef,
    setActivatorNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: row.todo.id, disabled: !sortable });
  // A phone has no grip column: a long press on the row's words picks it up (DOR-3715).
  const isMobile = useIsMobile();

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
  return (
    <TodoRow
      {...row}
      rowRef={setNodeRef}
      dragging={isDragging}
      // Up and down only: a list row never leaves its column.
      style={{
        transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
        transition,
      }}
      {...(isMobile
        ? {
            pressToMove: {
              onPointerDown: (event: PointerEvent<HTMLDivElement>) =>
                listeners?.onPointerDown?.(event),
            },
          }
        : {})}
      {...(isMobile
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
    />
  );
}
