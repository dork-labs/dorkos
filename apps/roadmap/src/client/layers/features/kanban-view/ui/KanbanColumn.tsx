import { Droppable } from '@hello-pangea/dnd';
import type { RoadmapItem, RoadmapStatus } from '@dorkos/shared/roadmap-schemas';
import { KanbanCard } from './KanbanCard';

/** Display label for each kanban column status. */
const STATUS_LABELS: Record<RoadmapStatus, string> = {
  'not-started': 'Not Started',
  'in-progress': 'In Progress',
  completed: 'Completed',
  'on-hold': 'On Hold',
};

/** Tailwind color classes for each column header. */
const STATUS_HEADER_COLORS: Record<RoadmapStatus, string> = {
  'not-started': 'bg-neutral-100 text-neutral-700',
  'in-progress': 'bg-blue-50 text-blue-700',
  completed: 'bg-green-50 text-green-700',
  'on-hold': 'bg-amber-50 text-amber-700',
};

interface KanbanColumnProps {
  status: RoadmapStatus;
  items: RoadmapItem[];
}

/**
 * Droppable kanban column containing all items with the given status.
 *
 * @param status - The RoadmapStatus this column represents (used as droppableId).
 * @param items - Roadmap items filtered to this column's status.
 */
export function KanbanColumn({ status, items }: KanbanColumnProps) {
  return (
    <div className="flex min-w-[240px] flex-1 flex-col rounded-lg border border-neutral-200 bg-neutral-50">
      {/* Column header */}
      <div
        className={[
          'flex items-center justify-between rounded-t-lg px-3 py-2',
          STATUS_HEADER_COLORS[status],
        ].join(' ')}
      >
        <span className="text-sm font-semibold">{STATUS_LABELS[status]}</span>
        <span className="ml-2 rounded-full bg-white/60 px-2 py-0.5 text-xs font-medium tabular-nums">
          {items.length}
        </span>
      </div>

      {/* Droppable card list */}
      <Droppable droppableId={status}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={[
              'flex flex-1 flex-col gap-2 p-2 transition-colors',
              snapshot.isDraggingOver ? 'bg-blue-50' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {items.map((item, index) => (
              <KanbanCard key={item.id} item={item} index={index} />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}
