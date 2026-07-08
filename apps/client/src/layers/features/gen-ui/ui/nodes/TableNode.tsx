import { motion } from 'motion/react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useWidgetMotion, widgetEntrance, widgetStaggerContainer } from '../../lib/widget-motion';

type TableNodeData = Extract<WidgetNode, { type: 'table' }>;

/** Table body + row wrappers that carry motion variants, so body rows cascade in. */
const MotionTableBody = motion.create(TableBody);
const MotionTableRow = motion.create(TableRow);

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

/** `table` node — columnar data using the shared Table primitives; body rows cascade in. */
export function TableNode({ node }: { node: TableNodeData }) {
  const motionOn = useWidgetMotion();
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
        <MotionTableBody
          variants={motionOn ? widgetStaggerContainer : undefined}
          initial={motionOn ? 'hidden' : false}
          animate={motionOn ? 'visible' : false}
        >
          {node.rows.map((row, i) => (
            <MotionTableRow key={i} variants={motionOn ? widgetEntrance : undefined}>
              {node.columns.map((col) => (
                <TableCell
                  key={col.key}
                  className={cn('tabular-nums', col.align && ALIGN_CLASS[col.align])}
                >
                  {renderCell(row[col.key] ?? null)}
                </TableCell>
              ))}
            </MotionTableRow>
          ))}
        </MotionTableBody>
      </Table>
    </div>
  );
}
