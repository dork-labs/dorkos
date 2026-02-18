import { Draggable } from '@hello-pangea/dnd';
import type { RoadmapItem, RoadmapStatus, RoadmapItemType } from '@dorkos/shared/roadmap-schemas';
import { useAppStore } from '@/layers/shared/model';

/** Map from status value to display label and color class. */
const STATUS_STYLES: Record<RoadmapStatus, { label: string; className: string }> = {
  'not-started': { label: 'Not Started', className: 'bg-neutral-100 text-neutral-600' },
  'in-progress': { label: 'In Progress', className: 'bg-blue-100 text-blue-700' },
  completed: { label: 'Completed', className: 'bg-green-100 text-green-700' },
  'on-hold': { label: 'On Hold', className: 'bg-amber-100 text-amber-700' },
};

/** Map from item type value to display label and color class. */
const TYPE_STYLES: Record<RoadmapItemType, { label: string; className: string }> = {
  feature: { label: 'Feature', className: 'bg-purple-100 text-purple-700' },
  bugfix: { label: 'Bug Fix', className: 'bg-red-100 text-red-700' },
  'technical-debt': { label: 'Tech Debt', className: 'bg-orange-100 text-orange-700' },
  research: { label: 'Research', className: 'bg-sky-100 text-sky-700' },
  epic: { label: 'Epic', className: 'bg-violet-100 text-violet-700' },
};

interface MoscowCardProps {
  item: RoadmapItem;
  index: number;
}

/**
 * Draggable card representing a single roadmap item in the MoSCoW grid view.
 *
 * Displays the item title, status badge, and type badge. Clicking the card
 * opens the item in the edit panel via `setEditingItemId`.
 */
export function MoscowCard({ item, index }: MoscowCardProps) {
  const setEditingItemId = useAppStore((s) => s.setEditingItemId);
  const statusStyle = STATUS_STYLES[item.status];
  const typeStyle = TYPE_STYLES[item.type];

  return (
    <Draggable draggableId={item.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          role="button"
          tabIndex={0}
          aria-label={`Edit ${item.title}`}
          className={[
            'cursor-pointer rounded-md border bg-white p-3 shadow-sm',
            'hover:border-neutral-300 hover:shadow-md',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400',
            'transition-shadow duration-150',
            snapshot.isDragging ? 'rotate-1 shadow-lg' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => setEditingItemId(item.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setEditingItemId(item.id);
            }
          }}
        >
          <p className="mb-2 text-sm font-medium text-neutral-800 leading-snug">{item.title}</p>
          <div className="flex flex-wrap gap-1">
            <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${statusStyle.className}`}>
              {statusStyle.label}
            </span>
            <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${typeStyle.className}`}>
              {typeStyle.label}
            </span>
          </div>
        </div>
      )}
    </Draggable>
  );
}
