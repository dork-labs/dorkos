import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  type SortingState,
  type ColumnFiltersState,
} from '@tanstack/react-table';
import { useState } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react';
import { useRoadmapItems } from '@/layers/entities/roadmap-item';
import { useAppStore } from '@/layers/shared/model';
import { roadmapColumns } from './TableColumns';

/** Icon rendered in a sortable column header based on current sort state. */
function SortIcon({
  isSorted,
}: {
  isSorted: false | 'asc' | 'desc';
}) {
  if (isSorted === 'asc') return <ChevronUp className="h-3.5 w-3.5" />;
  if (isSorted === 'desc') return <ChevronDown className="h-3.5 w-3.5" />;
  return <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />;
}

/**
 * Full roadmap items table powered by TanStack Table.
 *
 * Supports column sorting and global text filtering. Clicking a row opens
 * the item editor via the global app store.
 */
export function TableView() {
  const { data: items = [], isLoading, isError } = useRoadmapItems();
  const setEditingItemId = useAppStore((s) => s.setEditingItemId);

  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');

  const table = useReactTable({
    data: items,
    columns: roadmapColumns,
    state: { sorting, columnFilters, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  if (isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
        Loading items…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-red-500">
        Failed to load roadmap items.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <input
        type="search"
        placeholder="Filter items…"
        value={globalFilter}
        onChange={(e) => setGlobalFilter(e.target.value)}
        className="w-full max-w-sm rounded-md border border-neutral-200 bg-white px-3 py-1.5 text-sm text-neutral-900 placeholder:text-neutral-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900"
        aria-label="Filter roadmap items"
      />

      <div className="overflow-x-auto rounded-lg border border-neutral-200">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-neutral-50">
            {table.getHeaderGroups().map((headerGroup) => (
              <tr key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <th
                    key={header.id}
                    className="border-b border-neutral-200 px-4 py-2.5 text-left font-medium text-neutral-600"
                  >
                    {header.column.getCanSort() ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="flex items-center gap-1.5 hover:text-neutral-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900"
                      >
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext()
                        )}
                        <SortIcon isSorted={header.column.getIsSorted()} />
                      </button>
                    ) : (
                      flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )
                    )}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody className="divide-y divide-neutral-100 bg-white">
            {table.getRowModel().rows.length === 0 ? (
              <tr>
                <td
                  colSpan={roadmapColumns.length}
                  className="px-4 py-8 text-center text-neutral-400"
                >
                  No items match the current filter.
                </td>
              </tr>
            ) : (
              table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => setEditingItemId(row.original.id)}
                  className="cursor-pointer hover:bg-neutral-50 focus-within:bg-neutral-50"
                  tabIndex={0}
                  role="button"
                  aria-label={`Edit ${row.original.title}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      setEditingItemId(row.original.id);
                    }
                  }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-2.5">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-neutral-400">
        {table.getRowModel().rows.length} of {items.length} item
        {items.length !== 1 ? 's' : ''}
      </p>
    </div>
  );
}
