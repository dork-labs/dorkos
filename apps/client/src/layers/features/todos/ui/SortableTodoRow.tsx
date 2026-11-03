/**
 * A to-do row the list can move in "My order": a grip to drag it by, which also moves it with
 * ⌥↑ / ⌥↓ (or Space, then the arrows, as any sortable list). Outside "My order" it is the plain row.
 *
 * @module features/todos/ui/SortableTodoRow
 */
import type { KeyboardEvent } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { GripVertical } from 'lucide-react';
import { TodoRow, type TodoRowProps } from './TodoRow';

/** Props for {@link SortableTodoRow}. */
export interface SortableTodoRowProps extends Omit<TodoRowProps, 'handle' | 'rowRef' | 'style'> {
  /** Whether the list is in "My order", where rows move. */
  sortable: boolean;
  /** Move this row up (-1) or down (+1). */
  onMove: (by: -1 | 1) => void;
}

/** One to-do, draggable in "My order". */
export function SortableTodoRow({ sortable, onMove, ...row }: SortableTodoRowProps) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition } =
    useSortable({ id: row.todo.id, disabled: !sortable });

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
      // Up and down only: a list row never leaves its column.
      style={{
        transform: transform ? `translate3d(0, ${Math.round(transform.y)}px, 0)` : undefined,
        transition,
      }}
      handle={
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          onKeyDown={onKeyDown}
          aria-label={`Move ${row.todo.what}`}
          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
          className="focus-ring text-muted-foreground hover:text-foreground flex size-11 shrink-0 cursor-grab touch-none items-center justify-center rounded-md md:size-7"
        >
          <GripVertical aria-hidden className="size-4" />
        </button>
      }
    />
  );
}
