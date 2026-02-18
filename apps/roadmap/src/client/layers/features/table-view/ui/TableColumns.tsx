import { createColumnHelper, type SortingFn } from '@tanstack/react-table';
import type {
  RoadmapItem,
  RoadmapItemType,
  Moscow,
  RoadmapStatus,
  Health,
  TimeHorizon,
} from '@dorkos/shared/roadmap-schemas';

const columnHelper = createColumnHelper<RoadmapItem>();

// ── Badge helpers ────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<RoadmapItemType, string> = {
  feature: 'bg-blue-100 text-blue-700',
  bugfix: 'bg-red-100 text-red-700',
  'technical-debt': 'bg-orange-100 text-orange-700',
  research: 'bg-purple-100 text-purple-700',
  epic: 'bg-indigo-100 text-indigo-700',
};

const MOSCOW_COLORS: Record<Moscow, string> = {
  'must-have': 'bg-red-100 text-red-700',
  'should-have': 'bg-amber-100 text-amber-700',
  'could-have': 'bg-green-100 text-green-700',
  'wont-have': 'bg-neutral-100 text-neutral-500',
};

const STATUS_COLORS: Record<RoadmapStatus, string> = {
  'not-started': 'bg-neutral-100 text-neutral-500',
  'in-progress': 'bg-blue-100 text-blue-700',
  completed: 'bg-green-100 text-green-700',
  'on-hold': 'bg-amber-100 text-amber-700',
};

const HEALTH_COLORS: Record<Health, string> = {
  'on-track': 'bg-green-100 text-green-700',
  'at-risk': 'bg-amber-100 text-amber-700',
  'off-track': 'bg-red-100 text-red-700',
  blocked: 'bg-red-200 text-red-800',
};

/** Pill-shaped badge with contextual colour. */
function Badge({ value, colorClass }: { value: string; colorClass: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colorClass}`}
    >
      {value}
    </span>
  );
}

/** Format an ISO datetime string as a compact locale date. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

// Stable sort function for string enum columns
const stringSortFn: SortingFn<RoadmapItem> = (rowA, rowB, columnId) => {
  const a = rowA.getValue<string>(columnId) ?? '';
  const b = rowB.getValue<string>(columnId) ?? '';
  return a.localeCompare(b);
};

// ── Column definitions ───────────────────────────────────────────────────────

/**
 * TanStack Table column definitions for the roadmap items table.
 *
 * All columns are sortable. Badge columns use contextual colour maps.
 */
export const roadmapColumns = [
  columnHelper.accessor('title', {
    header: 'Title',
    enableSorting: true,
    cell: (info) => (
      <span className="font-medium text-neutral-900">{info.getValue()}</span>
    ),
    sortingFn: stringSortFn,
  }),

  columnHelper.accessor('type', {
    header: 'Type',
    enableSorting: true,
    cell: (info) => {
      const value = info.getValue();
      return <Badge value={value} colorClass={TYPE_COLORS[value]} />;
    },
    sortingFn: stringSortFn,
  }),

  columnHelper.accessor('moscow', {
    header: 'MoSCoW',
    enableSorting: true,
    cell: (info) => {
      const value = info.getValue();
      return <Badge value={value} colorClass={MOSCOW_COLORS[value]} />;
    },
    sortingFn: stringSortFn,
  }),

  columnHelper.accessor('status', {
    header: 'Status',
    enableSorting: true,
    cell: (info) => {
      const value = info.getValue();
      return <Badge value={value} colorClass={STATUS_COLORS[value]} />;
    },
    sortingFn: stringSortFn,
  }),

  columnHelper.accessor('health', {
    header: 'Health',
    enableSorting: true,
    cell: (info) => {
      const value = info.getValue();
      return <Badge value={value} colorClass={HEALTH_COLORS[value]} />;
    },
    sortingFn: stringSortFn,
  }),

  columnHelper.accessor('timeHorizon', {
    header: 'Horizon',
    enableSorting: true,
    cell: (info) => {
      const value = info.getValue() as TimeHorizon;
      const horizonColors: Record<TimeHorizon, string> = {
        now: 'bg-green-100 text-green-700',
        next: 'bg-blue-100 text-blue-700',
        later: 'bg-neutral-100 text-neutral-500',
      };
      return <Badge value={value} colorClass={horizonColors[value]} />;
    },
    sortingFn: stringSortFn,
  }),

  columnHelper.accessor('effort', {
    header: 'Effort',
    enableSorting: true,
    cell: (info) => {
      const val = info.getValue();
      return (
        <span className="text-sm text-neutral-600">
          {val !== undefined ? val : '—'}
        </span>
      );
    },
  }),

  columnHelper.accessor('updatedAt', {
    header: 'Updated',
    enableSorting: true,
    cell: (info) => (
      <span className="text-sm text-neutral-500">{formatDate(info.getValue())}</span>
    ),
    sortingFn: stringSortFn,
  }),
];
