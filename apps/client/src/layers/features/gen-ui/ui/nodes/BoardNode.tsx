import { useState } from 'react';
import { motion } from 'motion/react';
import type { Variants } from 'motion/react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { cn } from '@/layers/shared/lib';
import { resolveWidgetIcon } from '../../lib/widget-icon';
import { toneBadgeClass } from '../../lib/widget-tone';
import { useWidgetActions } from '../../model/widget-context';
import { useWidgetMotion, widgetEntrance, WIDGET_SPRING } from '../../lib/widget-motion';

type NodeOf<T extends WidgetNode['type']> = Extract<WidgetNode, { type: T }>;
type BoardCellData = NodeOf<'board'>['rows'][number][number];

/** Faster stagger than the default widget entrance — a grid pops in as one quick sweep. */
const BOARD_STAGGER_STEP = 0.02;
const boardStaggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: BOARD_STAGGER_STEP } },
};

/**
 * `board` node — a CSS grid of glyph/icon cells, optionally clickable. Paired
 * with an `agent` action re-emitted each turn, this is the primitive behind
 * turn-based games like tic-tac-toe: the agent renders the board, the player
 * clicks a cell, and the agent's next turn re-renders it with the move applied.
 */
export function BoardNode({ node }: { node: NodeOf<'board'> }) {
  const motionOn = useWidgetMotion();
  const columns = Math.max(1, ...node.rows.map((row) => row.length));

  return (
    <div className="flex flex-col gap-1.5">
      {node.label && <p className="text-muted-foreground text-xs">{node.label}</p>}
      <motion.div
        role="grid"
        aria-label={node.label ?? 'Board'}
        className="grid w-fit gap-1"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 2.5rem))` }}
        variants={motionOn ? boardStaggerContainer : undefined}
        initial={motionOn ? 'hidden' : false}
        animate={motionOn ? 'visible' : false}
      >
        {node.rows.map((row, r) =>
          row.map((cell, c) => {
            // Resolved here (not inside BoardCell) so the icon lookup isn't a
            // component-during-render call in the cell's own component body.
            const icon = !cell.glyph && cell.icon ? resolveWidgetIcon(cell.icon) : null;
            return <BoardCell key={`${r}-${c}`} cell={cell} icon={icon} motionOn={motionOn} />;
          })
        )}
      </motion.div>
    </div>
  );
}

interface BoardCellProps {
  cell: BoardCellData;
  /** Pre-resolved icon component (resolved by the caller — see the map above). */
  icon: LucideIcon | null;
  motionOn: boolean;
}

function BoardCell({ cell, icon: Icon, motionOn }: BoardCellProps) {
  const { onAction, agentActionsEnabled } = useWidgetActions();
  const [pending, setPending] = useState(false);
  const isAgent = cell.action?.kind === 'agent';
  const unavailable = isAgent && !agentActionsEnabled;

  const handleClick = () => {
    if (!cell.action || unavailable || pending) return;
    const dispatched = onAction(cell.action);
    if (!isAgent) return;
    setPending(true);
    dispatched
      .catch(() => {
        toast.error("Couldn't send the move", {
          description: 'The agent may be busy right now — try again in a moment.',
        });
      })
      .finally(() => setPending(false));
  };

  const cellClass = cn(
    'flex aspect-square items-center justify-center rounded-md border text-xl leading-none',
    cell.tone && toneBadgeClass(cell.tone)
  );

  const content = (
    <>
      {cell.glyph && <span aria-hidden>{cell.glyph}</span>}
      {Icon && <Icon className="size-5" aria-hidden />}
    </>
  );

  if (!cell.action) {
    return (
      <motion.div
        role="gridcell"
        className={cellClass}
        variants={motionOn ? widgetEntrance : undefined}
      >
        {content}
      </motion.div>
    );
  }

  // `role="gridcell"` stays on this wrapper (the actual grid item) rather than
  // the button, so the button keeps its native, screen-reader-friendly "button"
  // role — an explicit role on the button itself would override it to "gridcell".
  return (
    <motion.div role="gridcell" variants={motionOn ? widgetEntrance : undefined}>
      <motion.button
        type="button"
        aria-disabled={unavailable || undefined}
        disabled={pending}
        onClick={unavailable ? undefined : handleClick}
        className={cn(
          cellClass,
          'hover:bg-muted/60 w-full transition-colors',
          unavailable && 'cursor-not-allowed opacity-50'
        )}
        whileHover={!unavailable ? { scale: 1.05 } : undefined}
        whileTap={!unavailable ? { scale: 0.95 } : undefined}
        transition={WIDGET_SPRING}
      >
        {content}
      </motion.button>
    </motion.div>
  );
}
