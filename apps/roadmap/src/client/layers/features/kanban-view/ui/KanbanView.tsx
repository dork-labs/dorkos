import { DragDropContext, type DropResult } from '@hello-pangea/dnd';
import { useRoadmapItems, useUpdateItem, useReorderItems } from '@/layers/entities/roadmap-item';
import type { RoadmapStatus } from '@dorkos/shared/roadmap-schemas';
import { KanbanColumn } from './KanbanColumn';

/** Ordered list of kanban columns and their status values. */
const COLUMNS: RoadmapStatus[] = ['not-started', 'in-progress', 'completed', 'on-hold'];

/**
 * Kanban board view for roadmap items with drag-and-drop status updates and reordering.
 *
 * Renders four columns (not-started, in-progress, completed, on-hold).
 * Dropping a card into a new column calls `updateItem` with the new status.
 * Dropping a card within the same column calls `reorderItems` to persist the new order.
 * Items are sorted by their `order` field (ascending) before display.
 */
export function KanbanView() {
  const { data: items = [], isLoading } = useRoadmapItems();
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
    const { destination, source, draggableId } = result;

    // Dropped outside a column — no-op
    if (!destination) return;

    if (source.droppableId === destination.droppableId) {
      // Reorder within the same column
      const columnItems = sortedItems.filter((i) => i.status === source.droppableId);
      const reordered = Array.from(columnItems);
      const [moved] = reordered.splice(source.index, 1);
      reordered.splice(destination.index, 0, moved);
      reorderItems.mutate({ orderedIds: reordered.map((i) => i.id) });
    } else {
      // Move to a different column — update status
      const newStatus = destination.droppableId as RoadmapStatus;
      updateItem.mutate({ id: draggableId, body: { status: newStatus } });
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        Loading…
      </div>
    );
  }

  return (
    <DragDropContext onDragEnd={handleDragEnd}>
      <div className="flex h-full gap-4 overflow-x-auto pb-4">
        {COLUMNS.map((status) => {
          const columnItems = sortedItems.filter((item) => item.status === status);
          return <KanbanColumn key={status} status={status} items={columnItems} />;
        })}
      </div>
    </DragDropContext>
  );
}
