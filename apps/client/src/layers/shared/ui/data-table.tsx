import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type TableOptions,
} from '@tanstack/react-table';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './table';

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
}

/**
 * Generic data table powered by TanStack Table.
 *
 * Handles the core rendering loop: header groups → header cells, data rows →
 * visible cells, and an empty-state row when no data is present. Pass
 * `tableOptions` to enable sorting, selection, pagination, or other TanStack
 * Table features.
 */
function DataTable<TData, TValue>({
  columns,
  data,
  emptyMessage = 'No results.',
  tableOptions,
}: DataTableProps<TData, TValue>) {
  const table = useReactTable({
    data,
    columns,
    getCoreRowModel: getCoreRowModel(),
    ...tableOptions,
  });

  return (
    <div data-slot="data-table" className="rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} data-state={row.getIsSelected() ? 'selected' : undefined}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell colSpan={columns.length} className="h-24 text-center">
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
export type { DataTableProps };
