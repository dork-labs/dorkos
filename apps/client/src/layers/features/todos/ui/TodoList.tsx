/**
 * The to-do list a person works from: one view at a time, open ones first in the server's order,
 * each completed in place with a moment to undo it. In "My order" the open ones move: drag one by
 * its grip, press ⌥↑ / ⌥↓ inside it, long-press it on a touch screen, or use Reorder mode's ↑ and ↓.
 *
 * @module features/todos/ui/TodoList
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { SquareCheck } from 'lucide-react';
import type { Todo } from '@dorkos/shared/todo-schemas';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { useMeshAgentPaths } from '@/layers/entities/mesh';
import { roomDisplayTitle, useRooms } from '@/layers/entities/room';
import { useTodos, useUpdateTodo } from '@/layers/entities/todo';
import { cn, getAgentDisplayName } from '@/layers/shared/lib';
import { Button, EmptyState, QueryErrorState, Skeleton } from '@/layers/shared/ui';
import { assignedByLabel } from '../lib/todo-labels';
import { useLingeringDone, withLingering } from '../model/use-lingering-done';
import { useTodoFilters } from '../model/use-todo-filters';
import { usePrefersLongPress } from '../model/use-prefers-long-press';
import { useRowSlide } from '../model/use-row-slide';
import { useTodoReorder } from '../model/use-todo-reorder';
import { SortableTodoRow, todoMoveKey } from './SortableTodoRow';
import { TODO_FILTER_TRIGGER, TodoFilterBar } from './TodoFilterBar';

/** Props for {@link TodoList}. */
export interface TodoListProps {
  /** Open the New to-do dialog, offered from the empty "Assigned to me" view. */
  onNewTodo: () => void;
}

/** The roster and room names a row reads, by id. */
function useNameLookups() {
  const { data: agentsData } = useMeshAgentPaths();
  const { data: rooms } = useRooms();
  return useMemo(() => {
    const agents = new Map<string, AgentPathEntry>();
    for (const agent of agentsData?.agents ?? []) agents.set(agent.id, agent);
    const roomTitles = new Map<string, string>();
    for (const room of rooms ?? []) roomTitles.set(room.id, roomDisplayTitle(room));
    return {
      agentOf: (id: string) => agents.get(id),
      agentName: (id: string) => {
        const agent = agents.get(id);
        return agent ? getAgentDisplayName(agent) : undefined;
      },
      roomTitleOf: (id: string | null) => (id ? roomTitles.get(id) : undefined),
    };
  }, [agentsData, rooms]);
}

/** The to-do list, its controls, and its footer. */
export function TodoList({ onNewTodo }: TodoListProps) {
  const { filters, query, set } = useTodoFilters();
  const list = useTodos(query);
  const update = useUpdateTodo();
  const lingering = useLingeringDone(JSON.stringify(query));
  const names = useNameLookups();

  const rows = useMemo(
    () => withLingering(list.data?.todos ?? [], lingering.held),
    [list.data, lingering.held]
  );
  // Only open, settled rows move, and only in the person's own order.
  const movable = useMemo(
    () => rows.filter((todo) => todo.state === 'open' && !lingering.held[todo.id]),
    [rows, lingering.held]
  );
  // "My order" is the assignee's own order, so only the person's own list moves.
  const sortable = filters.sort === 'rank' && filters.view === 'mine' && movable.length > 1;
  const reorder = useTodoReorder(query, rows, movable);
  const [announcement, setAnnouncement] = useState('');
  // Reorder mode: ↑ and ↓ on each movable row, for anyone who can't drag (DOR-3715). It ends
  // with Done, Esc, or anything that stops the list from moving.
  const [reorderMode, setReorderMode] = useState(false);
  // Ended for good, not paused, so a list that can move again doesn't drop back into it.
  if (reorderMode && !sortable) setReorderMode(false);
  const reordering = reorderMode && sortable;
  // The control that moved keeps focus: a row moving down is re-inserted, which would blur it.
  // Put back before the browser paints, so the focus ring never blinks out (DOR-3715).
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const target = refocus.current;
    if (!target) return;
    refocus.current = null;
    focusFirst(target);
  }, [movable, reordering]);
  const longPress = usePrefersLongPress();
  // A Reorder button's move slides; a drag already does.
  const slide = useRowSlide(movable);
  const sensors = useSensors(
    // A few pixels of travel first, so a click on the grip is not a drag.
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    // A long press: a quick sideways swipe on the same row finishes it instead (DOR-3715).
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function startReorder() {
    setReorderMode(true);
    const first = movable[0];
    if (first) refocus.current = moveButton(todoMoveKey(first.id, 1));
  }

  function endReorder() {
    setReorderMode(false);
    refocus.current = `[${TODO_FILTER_TRIGGER}]`;
  }

  // Esc leaves Reorder mode from anywhere on the page.
  useEffect(() => {
    if (!reordering) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setReorderMode(false);
      refocus.current = `[${TODO_FILTER_TRIGGER}]`;
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [reordering]);

  function moveTo(id: string, from: number, to: number, focus: string) {
    if (!reorder.move(from, to)) return;
    // The new order lands on a later render, so this still measures the old one.
    if (reordering) slide.measure();
    refocus.current = focus;
    setAnnouncement(`Moved to position ${to + 1} of ${movable.length}.`);
  }

  function moveBy(todo: Todo, by: -1 | 1) {
    const from = movable.findIndex((row) => row.id === todo.id);
    const to = Math.min(Math.max(from + by, 0), movable.length - 1);
    if (from === -1 || to === from) return;
    // A Reorder button keeps focus, or hands it to its row's other one once it's disabled at an
    // end; the grip keeps its own.
    const focus = reordering
      ? `${moveButton(todoMoveKey(todo.id, by))}:not(:disabled), ${moveButton(todoMoveKey(todo.id, by === -1 ? 1 : -1))}`
      : `[data-todo-grip="${CSS.escape(todo.id)}"]`;
    moveTo(todo.id, from, to, focus);
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id) return;
    const from = movable.findIndex((row) => row.id === active.id);
    const to = movable.findIndex((row) => row.id === over.id);
    if (from !== -1 && to !== -1) {
      moveTo(String(active.id), from, to, `[data-todo-grip="${CSS.escape(String(active.id))}"]`);
    }
  }

  function complete(todo: Todo, index: number) {
    lingering.hold(todo, index);
    update
      .mutateAsync({ id: todo.id, body: { state: 'kept' } })
      .then(() => lingering.saved(todo.id))
      .catch(() => lingering.release(todo.id));
  }

  function undo(todo: Todo) {
    lingering.reopen(todo.id);
    // `from` refuses the Undo if someone changed the to-do since it was completed.
    update
      .mutateAsync({ id: todo.id, body: { state: 'open', from: 'kept' } })
      .catch(() => undefined)
      .finally(() => lingering.release(todo.id));
  }

  return (
    <div data-slot="todo-list" className="flex flex-col gap-3">
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <TodoFilterBar
        filters={filters}
        onChange={set}
        reorder={{
          available: sortable,
          active: reordering,
          onStart: startReorder,
          onDone: endReorder,
        }}
      />
      {list.isPending && <Skeleton className="h-24 w-full" />}
      {list.isError && (
        <QueryErrorState
          title="Couldn’t load your to-dos"
          description="The DorkOS server didn’t answer. Check that it’s running."
          onRetry={() => void list.refetch()}
        />
      )}
      {list.isSuccess && rows.length === 0 && (
        <TodoListEmpty
          mine={filters.view === 'mine'}
          narrowed={filters.due !== 'any'}
          onNewTodo={onNewTodo}
        />
      )}
      {list.isSuccess && rows.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext
            items={movable.map((todo) => todo.id)}
            strategy={verticalListSortingStrategy}
          >
            <ul
              className={cn(
                'flex flex-col',
                // The check circles line up with the chips' edge on a phone, and a desktop's
                // grips hang in the gutter rather than leaving an empty column (DOR-3715).
                'max-md:-ml-2.5',
                sortable && !longPress && 'md:-ml-8'
              )}
              aria-label="To-dos"
              aria-busy={reorder.moving || undefined}
            >
              {rows.map((todo, index) => {
                const agent =
                  todo.assignee.kind === 'agent' ? names.agentOf(todo.assignee.agentId) : undefined;
                const roomTitle = names.roomTitleOf(todo.roomId);
                const entry = lingering.held[todo.id];
                const held = entry !== undefined;
                return (
                  <SortableTodoRow
                    key={todo.id}
                    sortable={sortable && todo.state === 'open' && !held}
                    onMove={(by) => moveBy(todo, by)}
                    {...(reordering && todo.state === 'open' && !held
                      ? {
                          reorder: {
                            first: movable[0]?.id === todo.id,
                            last: movable[movable.length - 1]?.id === todo.id,
                          },
                        }
                      : {})}
                    todo={todo}
                    from={assignedByLabel(todo.assignedBy, names.agentName)}
                    {...(agent ? { agent } : {})}
                    {...(roomTitle ? { roomTitle } : {})}
                    {...(todo.state === 'open' && !held
                      ? { onComplete: () => complete(todo, index) }
                      : {})}
                    {...(entry && !entry.saving && todo.state === 'kept'
                      ? { onUndo: () => undo(todo) }
                      : {})}
                  />
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>
      )}
      {!filters.showDone && (list.data?.doneCount ?? 0) > 0 && (
        <Button
          size="sm"
          variant="ghost"
          // Under the empty state's centred message it sits centred too (DOR-3715).
          className={list.isSuccess && rows.length === 0 ? 'self-center' : 'self-start'}
          onClick={() => set('showDone', true)}
        >
          Show done ({list.data?.doneCount})
        </Button>
      )}
      {filters.showDone && (
        <Button
          size="sm"
          variant="ghost"
          className="self-start"
          onClick={() => set('showDone', false)}
        >
          Hide done
        </Button>
      )}
    </div>
  );
}

/** The selector for one of a row's Reorder buttons, by its `data-todo-move` key. */
function moveButton(key: string): string {
  return `[data-todo-move="${CSS.escape(key)}"]`;
}

/** Focus the first element a selector list finds, in the order the selectors are given. */
function focusFirst(selectors: string) {
  for (const selector of selectors.split(', ')) {
    const target = document.querySelector<HTMLElement>(selector);
    if (target) {
      target.focus();
      return;
    }
  }
}

/**
 * Nothing in this view: a way to add one on your own unfiltered list, a quiet line elsewhere, so
 * a date filter never claims nothing is assigned to you.
 */
function TodoListEmpty({
  mine,
  narrowed,
  onNewTodo,
}: {
  mine: boolean;
  narrowed: boolean;
  onNewTodo: () => void;
}) {
  if (!mine || narrowed) {
    return <p className="text-muted-foreground px-2 py-4 text-sm">No to-dos here.</p>;
  }
  return (
    <EmptyState
      icon={SquareCheck}
      headline="Nothing assigned to you."
      description="Add one, or ask an agent to."
      action={{ label: 'New to-do', onClick: onNewTodo }}
    />
  );
}
