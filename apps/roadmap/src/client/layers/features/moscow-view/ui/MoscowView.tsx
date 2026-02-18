import { DragDropContext, type DropResult } from '@hello-pangea/dnd';
import type { Moscow } from '@dorkos/shared/roadmap-schemas';
import { useRoadmapItems, useUpdateItem, useReorderItems } from '@/layers/entities/roadmap-item';
import { MoscowColumn } from './MoscowColumn';

/** Column configuration for the four MoSCoW priority categories. */
const MOSCOW_COLUMNS = [
  { moscow: 'must-have' as Moscow, label: 'Must Have', colorClass: 'text-green-600' },
  { moscow: 'should-have' as Moscow, label: 'Should Have', colorClass: 'text-blue-600' },
  { moscow: 'could-have' as Moscow, label: 'Could Have', colorClass: 'text-amber-600' },
  { moscow: 'wont-have' as Moscow, label: "Won't Have", colorClass: 'text-gray-500' },
] as const;

/**
 * MoSCoW priority grid view with drag-and-drop support and reordering.
 *
 * Renders four columns (Must Have, Should Have, Could Have, Won't Have) with
 * roadmap items filtered by their moscow field. Dragging a card between columns
 * triggers an optimistic update via `useUpdateItem`. Dragging within the same
 * column calls `useReorderItems` to persist the new order.
 * Items are sorted by their `order` field (ascending) before display.
 */
export function MoscowView() {
  const { data: items = [], isLoading, error } = useRoadmapItems();
  const updateItem = useUpdateItem();
  const reorderItems = useReorderItems();

  // Sort by persisted order, falling back to createdAt for items without an order value
  const sortedItems = [...items].sort((a, b) => {
    const aOrder = a.order ?? Infinity;
    const bOrder = b.order ?? Infinity;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.createdAt < b.createdAt ? -1 : 1;
  });

  function handleDragEnd(result: DropResult) {
    const { source, destination, draggableId } = result;

    // Dropped outside a droppable — no-op
    if (!destination) return;

    if (source.droppableId === destination.droppableId) {
      // Reorder within the same column
      const columnItems = sortedItems.filter((i) => i.moscow === source.droppableId);
      const reordered = Array.from(columnItems);
      const [moved] = reordered.splice(source.index, 1);
      reordered.splice(destination.index, 0, moved);
      reorderItems.mutate({ orderedIds: reordered.map((i) => i.id) });
    } else {
      // Move to a different column — update moscow priority
      const newMoscow = destination.droppableId as Moscow;
      updateItem.mutate({ id: draggableId, body: { moscow: newMoscow } });
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-neutral-500">Loading items…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-red-500">Failed to load roadmap items.</p>
      </div>
    );
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="grid h-full grid-cols-4 gap-4">
        {MOSCOW_COLUMNS.map((config) => {
          const columnItems = sortedItems.filter((item) => item.moscow === config.moscow);
          return <MoscowColumn key={config.moscow} config={config} items={columnItems} />;
        })}
      </div>
    </DragDropContext>
  );
}
