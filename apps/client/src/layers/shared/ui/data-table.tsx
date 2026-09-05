import { Fragment, type ReactNode, useMemo } from 'react';
import {
  type ColumnDef,
  type RowData,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type TableOptions,
} from '@tanstack/react-table';
import { useIsMobile } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib/utils';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

// ---------------------------------------------------------------------------
// Module augmentation — allow column meta to declare responsive visibility.
// Any column with `meta: { hideOnMobile: true }` is automatically hidden
// when the viewport is below the mobile breakpoint (768 px).
// ---------------------------------------------------------------------------

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Hide this column on viewports below the mobile breakpoint (768 px). */
    hideOnMobile?: boolean;
    /** Extra classes for this column's header cell — typically a width. */
    headClassName?: string;
    /** Extra classes for this column's body cells. */
    cellClassName?: string;
  }
}

// ---------------------------------------------------------------------------
// DataTable
// ---------------------------------------------------------------------------

/**
 * Renders a full-width header row above each run of rows sharing a group key.
 *
 * Grouping is presentational only: `data` must already be ordered so every
 * group is contiguous, because the header is emitted wherever the key changes.
 * That keeps the ordering decision with the caller that owns it, and means a
 * user-chosen column sort simply stops passing `groupBy` to flatten the table.
 */
interface DataTableGrouping<TData> {
  /** Group key for a row. Rows must already be ordered by group. */
  key: (row: TData) => string;
  /** Header content for a group, given its key and how many rows it holds. */
  header: (key: string, count: number) => ReactNode;
}

/** Props for the generic DataTable component. */
interface DataTableProps<TData, TValue> {
  /** TanStack Table column definitions. */
  columns: ColumnDef<TData, TValue>[];
  /** Data rows to render. */
  data: TData[];
  /** Message shown when data is empty. */
  emptyMessage?: string;
  /** Additional TanStack Table options (sorting, selection, pagination, etc.). */
  tableOptions?: Partial<Omit<TableOptions<TData>, 'data' | 'columns' | 'getCoreRowModel'>>;
  /** Optional grouping — renders a header row at each group boundary. */
  groupBy?: DataTableGrouping<TData>;
  /** Optional className for the outer wrapper div. */
  className?: string;
  /**
   * Optional className for the `<table>` itself. Pass `table-fixed` when column
   * cells must truncate: auto layout sizes a table to its content, so `truncate`
   * inside a cell has no width to truncate against.
   */
  tableClassName?: string;
}

/** Extract the stable column ID from a column definition. */
function getColumnId<TData, TValue>(col: ColumnDef<TData, TValue>): string | undefined {
  if ('id' in col && col.id) return col.id;
  if ('accessorKey' in col && typeof col.accessorKey === 'string') return col.accessorKey;
  return undefined;
}

/**
 * Generic data table powered by TanStack Table.
 *
 * Handles the core rendering loop: header groups → header cells, data rows →
 * visible cells, and an empty-state row when no data is present. Pass
 * `tableOptions` to enable sorting, selection, pagination, or other TanStack
 * Table features.
 *
 * Columns with `meta: { hideOnMobile: true }` are automatically hidden on
 * viewports below 768 px. User-provided `columnVisibility` in `tableOptions`
 * takes precedence per-column.
 *
 * Pass `groupBy` to render a header row at each group boundary in already-grouped
 * data. Per-column `meta.headClassName` / `meta.cellClassName` set widths and
 * alignment.
 */
function DataTable<TData, TValue>({
  columns,
  data,
  emptyMessage = 'No results.',
  tableOptions,
  groupBy,
  className,
  tableClassName,
}: DataTableProps<TData, TValue>) {
  const isMobile = useIsMobile();

  // Auto-compute column visibility from meta.hideOnMobile
  const responsiveVisibility = useMemo(() => {
    if (!isMobile) return {};
    const vis: Record<string, boolean> = {};
    for (const col of columns) {
      const id = getColumnId(col);
      if (id && col.meta?.hideOnMobile) {
        vis[id] = false;
      }
    }
    return vis;
  }, [columns, isMobile]);

  // Merge responsive defaults with any user-provided visibility (user wins)
  const mergedVisibility = useMemo(
    () => ({
      ...responsiveVisibility,
      ...(tableOptions?.state?.columnVisibility ?? {}),
    }),
    [responsiveVisibility, tableOptions?.state?.columnVisibility]
  );

  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    ...tableOptions,
    state: {
      ...tableOptions?.state,
      columnVisibility: mergedVisibility,
    },
  });

  const rows = table.getRowModel().rows;
  const visibleColumnCount = table.getVisibleLeafColumns().length;

  // Rows per group key, so a header can state its own count.
  const groupCounts = useMemo(() => {
    if (!groupBy) return new Map<string, number>();
    const counts = new Map<string, number>();
    for (const row of rows) {
      const key = groupBy.key(row.original);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [groupBy, rows]);

  return (
    <div data-slot="data-table" className={cn('rounded-md border', className)}>
      <Table className={tableClassName}>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id} className={header.column.columnDef.meta?.headClassName}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length ? (
            rows.map((row, index) => {
              const groupKey = groupBy?.key(row.original);
              const previousKey = index > 0 ? groupBy?.key(rows[index - 1].original) : undefined;
              const startsGroup = groupKey !== undefined && groupKey !== previousKey;
              return (
                <Fragment key={row.id}>
                  {startsGroup && (
                    <TableRow
                      data-slot="data-table-group-header"
                      className="bg-muted/40 hover:bg-muted/40"
                    >
                      {/*
                        No `scope`: rowgroup scope is delimited by `<tbody>`, and
                        every group here lives in the same one, so all the headers
                        would claim the same rowgroup. A `<th colSpan>` alone in
                        its row already reads as that row's header, which is what
                        it is.
                      */}
                      <TableHead colSpan={visibleColumnCount} className="h-8">
                        {groupBy?.header(groupKey, groupCounts.get(groupKey) ?? 0)}
                      </TableHead>
                    </TableRow>
                  )}
                  <TableRow data-state={row.getIsSelected() ? 'selected' : undefined}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell
                        key={cell.id}
                        className={cell.column.columnDef.meta?.cellClassName}
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                </Fragment>
              );
            })
          ) : (
            <TableRow>
              <TableCell colSpan={visibleColumnCount} className="h-24 text-center">
                {emptyMessage}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export { DataTable };
export type { DataTableProps, DataTableGrouping };
