import { Draggable } from '@hello-pangea/dnd';
import { useAppStore } from '@/layers/shared/model/app-store';
import type { RoadmapItem } from '@dorkos/shared/roadmap-schemas';

/** Display label for each item type value. */
const TYPE_LABELS: Record<RoadmapItem['type'], string> = {
  feature: 'Feature',
  bugfix: 'Bugfix',
  'technical-debt': 'Tech Debt',
  research: 'Research',
  epic: 'Epic',
};

/** Display label for each MoSCoW priority value. */
const MOSCOW_LABELS: Record<RoadmapItem['moscow'], string> = {
  'must-have': 'Must',
  'should-have': 'Should',
  'could-have': 'Could',
  'wont-have': "Won't",
};

/** Tailwind color classes for each MoSCoW priority. */
const MOSCOW_COLORS: Record<RoadmapItem['moscow'], string> = {
  'must-have': 'bg-red-100 text-red-700',
  'should-have': 'bg-amber-100 text-amber-700',
  'could-have': 'bg-blue-100 text-blue-700',
  'wont-have': 'bg-neutral-100 text-neutral-500',
};

interface KanbanCardProps {
  item: RoadmapItem;
  index: number;
}

/**
 * Draggable kanban card representing a single roadmap item.
 *
 * @param item - The roadmap item to display.
 * @param index - Position in the column, required by Draggable.
 */
export function KanbanCard({ item, index }: KanbanCardProps) {
  const setEditingItemId = useAppStore((s) => s.setEditingItemId);

  return (
    <Draggable draggableId={item.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          onClick={() => setEditingItemId(item.id)}
          className={[
            'cursor-pointer rounded-md border bg-white p-3 shadow-sm transition-shadow',
            'hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400',
            snapshot.isDragging ? 'rotate-1 shadow-lg ring-2 ring-neutral-300' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <p className="mb-2 text-sm font-medium text-neutral-900 leading-snug">{item.title}</p>
          <div className="flex flex-wrap gap-1">
            <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-neutral-100 text-neutral-600">
              {TYPE_LABELS[item.type]}
            </span>
            <span
              className={[
                'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
                MOSCOW_COLORS[item.moscow],
              ].join(' ')}
            >
              {MOSCOW_LABELS[item.moscow]}
            </span>
          </div>
        </div>
      )}
    </Draggable>
  );
}
