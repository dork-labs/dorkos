import type { RoadmapItem, RoadmapStatus } from '@dorkos/shared/roadmap-schemas';
import { useRoadmapItems } from '@/layers/entities/roadmap-item';
import { useAppStore } from '@/layers/shared/model/app-store';

/** Bar color keyed by roadmap status. */
const STATUS_COLORS: Record<RoadmapStatus, string> = {
  'in-progress': '#3b82f6',
  completed: '#22c55e',
  'on-hold': '#f59e0b',
  'not-started': '#94a3b8',
};

/** An item that has both startDate and endDate present. */
type GanttItem = RoadmapItem & { startDate: string; endDate: string };

/**
 * Narrow a RoadmapItem to a GanttItem by asserting both date fields exist.
 *
 * @param item - Roadmap item to check
 */
function hasDateRange(item: RoadmapItem): item is GanttItem {
  return Boolean(item.startDate && item.endDate);
}

/** Millisecond timestamp for a date string. */
function ms(dateStr: string): number {
  return new Date(dateStr).getTime();
}

/**
 * Calculate the left offset and width of a Gantt bar as percentages.
 *
 * @param item - Item with guaranteed startDate/endDate
 * @param rangeStart - Start of the full timeline in ms
 * @param range - Total timeline duration in ms (never zero)
 */
function calcBarStyle(
  item: GanttItem,
  rangeStart: number,
  range: number,
): { left: string; width: string } {
  const left = ((ms(item.startDate) - rangeStart) / range) * 100;
  const width = ((ms(item.endDate) - ms(item.startDate)) / range) * 100;
  return {
    left: `${Math.max(0, left).toFixed(2)}%`,
    width: `${Math.max(0.5, width).toFixed(2)}%`,
  };
}

/** Format an ISO date string to a short human-readable date. */
function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * GanttView renders a horizontal bar chart for roadmap items that have both
 * `startDate` and `endDate` set. Items without date ranges are excluded and
 * a count is shown. Clicking a bar opens the item editor.
 */
export function GanttView() {
  const { data: items = [], isLoading } = useRoadmapItems();
  const setEditingItemId = useAppStore((s) => s.setEditingItemId);

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        Loading…
      </div>
    );
  }

  const ganttItems = items.filter(hasDateRange);
  const hiddenCount = items.length - ganttItems.length;

  if (ganttItems.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm text-neutral-500">
          No items with date ranges. Add startDate and endDate to items to see them on the Gantt
          chart.
        </p>
      </div>
    );
  }

  // Timeline range derived from the earliest startDate to the latest endDate
  const rangeStart = Math.min(...ganttItems.map((i) => ms(i.startDate)));
  const rangeEnd = Math.max(...ganttItems.map((i) => ms(i.endDate)));
  // Guard against a zero-length range (all items start and end on the same ms)
  const range = rangeEnd - rangeStart || 1;

  return (
    <div className="flex h-full flex-col gap-4 overflow-auto p-4">
      {hiddenCount > 0 && (
        <p className="text-xs text-neutral-400">
          {hiddenCount} item{hiddenCount !== 1 ? 's' : ''} hidden — missing startDate or endDate.
        </p>
      )}

      {/* Timeline header */}
      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span>{formatDate(new Date(rangeStart).toISOString())}</span>
        <span>{formatDate(new Date(rangeEnd).toISOString())}</span>
      </div>

      {/* Gantt rows */}
      <div className="flex flex-col gap-2">
        {ganttItems.map((item) => {
          const barStyle = calcBarStyle(item, rangeStart, range);
          const barColor = STATUS_COLORS[item.status];

          return (
            <div key={item.id} className="flex items-center gap-3">
              {/* Label */}
              <div
                className="w-40 shrink-0 truncate text-sm text-neutral-700 dark:text-neutral-300"
                title={item.title}
              >
                {item.title}
              </div>

              {/* Bar track */}
              <div className="relative h-6 flex-1 rounded-sm bg-neutral-100 dark:bg-neutral-800">
                <button
                  type="button"
                  className="absolute inset-y-0 cursor-pointer rounded-sm opacity-90 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-offset-1"
                  style={{
                    left: barStyle.left,
                    width: barStyle.width,
                    backgroundColor: barColor,
                  }}
                  title={`${item.title} — ${formatDate(item.startDate)} to ${formatDate(item.endDate)}`}
                  onClick={() => setEditingItemId(item.id)}
                  aria-label={`Edit ${item.title}`}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
