import { motion } from 'motion/react';
import { Check, X } from 'lucide-react';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { toneBadgeClass } from '../../lib/widget-tone';
import { useWidgetMotion, widgetEntrance, widgetStaggerContainer } from '../../lib/widget-motion';

type CompareNodeData = Extract<WidgetNode, { type: 'compare' }>;
type CompareCell = CompareNodeData['rows'][number]['values'][number];

/** Table body + row wrappers carrying motion variants, so rows cascade in. */
const MotionTableBody = motion.create(TableBody);
const MotionTableRow = motion.create(TableRow);

/** Render one comparison cell: booleans as icons, null as an em dash, else text. */
function CompareCellContent({ value }: { value: CompareCell }) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === 'boolean') {
    return value ? (
      <Check className="text-status-success mx-auto size-4" aria-label="Yes" />
    ) : (
      <X className="text-muted-foreground mx-auto size-4" aria-label="No" />
    );
  }
  return <span className="tabular-nums">{String(value)}</span>;
}

/**
 * `compare` node — an option-comparison matrix. Row labels lead each row; one
 * column per option, with the recommended option's header badged and its column
 * subtly highlighted. Ragged rows pad with null rather than failing validation.
 */
export function CompareNode({ node }: { node: CompareNodeData }) {
  const motionOn = useWidgetMotion();
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead />
            {node.options.map((option, oi) => (
              <TableHead
                key={oi}
                className={cn('text-center', option.recommended && 'bg-primary/5')}
              >
                <span className="text-foreground font-medium">{option.name}</span>
                {option.recommended && (
                  <span
                    className={cn(
                      'text-2xs mt-1 flex w-fit items-center justify-center rounded-md border px-1.5 py-0.5 font-medium',
                      'mx-auto',
                      toneBadgeClass('success')
                    )}
                  >
                    Recommended
                  </span>
                )}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <MotionTableBody
          variants={motionOn ? widgetStaggerContainer : undefined}
          initial={motionOn ? 'hidden' : false}
          animate={motionOn ? 'visible' : false}
        >
          {node.rows.map((row, ri) => (
            <MotionTableRow key={ri} variants={motionOn ? widgetEntrance : undefined}>
              <TableCell className="text-muted-foreground font-medium">{row.label}</TableCell>
              {node.options.map((option, oi) => (
                <TableCell
                  key={oi}
                  className={cn('text-center', option.recommended && 'bg-primary/5')}
                >
                  <CompareCellContent value={row.values[oi] ?? null} />
                </TableCell>
              ))}
            </MotionTableRow>
          ))}
        </MotionTableBody>
      </Table>
    </div>
  );
}
