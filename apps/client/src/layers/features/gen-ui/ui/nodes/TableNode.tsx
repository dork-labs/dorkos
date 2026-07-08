import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';

type TableNodeData = Extract<WidgetNode, { type: 'table' }>;

const ALIGN_CLASS = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
} as const;

/** Render a scalar cell value; `null` reads as an em dash. */
function renderCell(value: string | number | boolean | null): string {
  if (value === null) return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** `table` node — columnar data using the shared Table primitives. */
export function TableNode({ node }: { node: TableNodeData }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {node.columns.map((col) => (
              <TableHead key={col.key} className={cn(col.align && ALIGN_CLASS[col.align])}>
                {col.label}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {node.rows.map((row, i) => (
            <TableRow key={i}>
              {node.columns.map((col) => (
                <TableCell
                  key={col.key}
                  className={cn('tabular-nums', col.align && ALIGN_CLASS[col.align])}
                >
                  {renderCell(row[col.key] ?? null)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
