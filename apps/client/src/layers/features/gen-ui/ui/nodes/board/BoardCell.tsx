/**
 * A single board cell. Non-interactive cells render their glyph/icon as
 * beautiful history; interactive cells add a hover ghost preview, an instant
 * self-drawing mark on click (optimistic placement), and settle into a latched
 * or superseded state without ever graying out the board.
 *
 * @module features/gen-ui/ui/nodes/board/BoardCell
 */
import { motion } from 'motion/react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import type { WidgetAction, WidgetNode } from '@dorkos/shared/ui-widget';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { toneBadgeClass } from '../../../lib/widget-tone';
import { useAgentActionState, useWidgetActions } from '../../../model/widget-context';
import { WIDGET_SPRING } from '../../../lib/widget-motion';
import { defaultMarkColorClass, DrawnMark } from './DrawnMark';

type NodeOf<T extends WidgetNode['type']> = Extract<WidgetNode, { type: T }>;
type BoardCellData = NodeOf<'board'>['rows'][number][number];

/** Where a winning-line flourish places this cell. */
export type WinRole = 'none' | 'winner' | 'loser';

interface BoardCellProps {
  cell: BoardCellData;
  /** Pre-resolved icon component (resolved by the caller). */
  icon: LucideIcon | null;
  motionOn: boolean;
  /** 0-based row index (label shows the 1-based value). */
  row: number;
  /** 0-based column index. */
  col: number;
  /** This cell's role in the board's winning line, if any. */
  winRole: WinRole;
}

/** Read the player's mark from an agent action's payload, if the model included one. */
function optimisticMarkFor(action: WidgetAction | undefined): string {
  if (!action || action.kind !== 'agent') return '';
  const payload = action.payload;
  const raw = payload?.glyph ?? payload?.mark;
  return typeof raw === 'string' ? raw : '';
}

/** Human-readable description of a cell's contents for the accessible name. */
function contentLabel(cell: BoardCellData): string {
  if (cell.glyph) return cell.glyph;
  if (cell.icon) return cell.icon;
  return 'filled';
}

/** Shared cell frame — the square, its border, tone, and text sizing. */
function cellClassName(cell: BoardCellData): string {
  return cn(
    'relative flex aspect-square items-center justify-center rounded-md border text-2xl leading-none',
    cell.tone && toneBadgeClass(cell.tone)
  );
}

/**
 * Color class for a mark in this cell. An explicit `tone` from the model wins
 * (the cell frame's tone classes already color the mark via `currentColor`);
 * otherwise the classic marks get their per-player default (X blue, O amber).
 */
function markColorClass(mark: string, cell: BoardCellData): string | undefined {
  if (cell.tone) return undefined;
  return defaultMarkColorClass(mark) ?? undefined;
}

/** A cell with no action: pure history. Full-contrast glyph, no affordance. */
function StaticBoardCell({ cell, icon: Icon, motionOn, row, col, winRole }: BoardCellProps) {
  const hasContent = Boolean(cell.glyph || cell.icon);
  return (
    <motion.div
      role="gridcell"
      aria-label={
        hasContent ? `Row ${row + 1}, column ${col + 1}: ${contentLabel(cell)}` : undefined
      }
      className={cn(cellClassName(cell), winRole === 'loser' && 'opacity-60')}
      animate={motionOn && winRole === 'winner' ? { scale: [1, 1.08, 1] } : undefined}
      transition={
        motionOn && winRole === 'winner'
          ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: 0.6 }
          : undefined
      }
    >
      {cell.glyph && (
        <DrawnMark
          mark={cell.glyph}
          motionOn={motionOn}
          colorClass={markColorClass(cell.glyph, cell)}
        />
      )}
      {!cell.glyph && Icon && <Icon className="size-6" aria-hidden />}
    </motion.div>
  );
}

/** A cell wired to an action: clickable when live, latched/superseded otherwise. */
function ActionBoardCell({
  cell,
  icon: Icon,
  motionOn,
  row,
  col,
  winRole,
}: BoardCellProps & { cell: BoardCellData & { action: WidgetAction } }) {
  const { onAction } = useWidgetActions();
  const state = useAgentActionState(cell.action);

  const optimisticMark = state.isDispatched ? optimisticMarkFor(cell.action) : null;
  const showGhost =
    state.interactive && cell.action.kind === 'agent' && Boolean(optimisticMarkFor(cell.action));
  const inert = !state.interactive;

  const handleClick = () => {
    if (!state.interactive) return;
    const dispatched = onAction(cell.action);
    if (cell.action.kind !== 'agent') return;
    dispatched.catch(() => {
      toast.error("Couldn't send the move", {
        description: 'The agent may be busy right now — try again in a moment.',
      });
    });
  };

  const label = ((): string => {
    const prefix = `Row ${row + 1}, column ${col + 1}`;
    if (state.isDispatched) return `${prefix}: ${optimisticMark || 'played'}`;
    if (cell.glyph || cell.icon) return `${prefix}: ${contentLabel(cell)}`;
    return state.interactive ? `${prefix}: empty — play here` : `${prefix}: empty`;
  })();

  // Every inert flavor explains itself (mirrors WidgetActionButton's copy) —
  // including a sibling-latch, so a quick second tap right after a move gets
  // "waiting", not silence. The dispatched cell itself needs no words: its
  // drawn mark IS the feedback.
  let tooltipText: string | null = null;
  if (state.superseded)
    tooltipText = 'This board is from an earlier turn — play on the newest one.';
  else if (state.unavailable) tooltipText = "Interactions aren't available here";
  else if (state.latched) tooltipText = "Move sent — waiting for the agent's reply";

  const buttonEl = (
    <motion.button
      type="button"
      aria-label={label}
      aria-disabled={inert || undefined}
      onClick={inert ? undefined : handleClick}
      className={cn(
        cellClassName(cell),
        'group focus-ring w-full transition-colors',
        state.interactive && 'hover:bg-muted/60 cursor-pointer',
        inert && 'cursor-default',
        winRole === 'loser' && 'opacity-60'
      )}
      whileHover={state.interactive ? { scale: 1.05 } : undefined}
      whileTap={state.interactive ? { scale: 0.95 } : undefined}
      transition={WIDGET_SPRING}
    >
      {/* Hover ghost — a faint preview of your mark; desktop hover only (Tailwind
          v4 gates `hover:` on hover-capable pointers), never on inert boards. */}
      {showGhost && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-2xl opacity-0 transition-opacity duration-150 group-hover:opacity-20">
          <DrawnMark
            mark={optimisticMarkFor(cell.action)}
            motionOn={false}
            colorClass={markColorClass(optimisticMarkFor(cell.action), cell)}
          />
        </span>
      )}
      <CellMark cell={cell} optimisticMark={optimisticMark} icon={Icon} motionOn={motionOn} />
    </motion.button>
  );

  // `role="gridcell"` stays on the wrapper so the button keeps its native
  // "button" role for screen readers. Inert cells wrap in the app Tooltip
  // (same pattern as WidgetActionButton): aria-disabled keeps the button
  // focusable, so the explanation is keyboard- and pointer-reachable.
  return (
    <motion.div
      role="gridcell"
      animate={motionOn && winRole === 'winner' ? { scale: [1, 1.08, 1] } : undefined}
      transition={
        motionOn && winRole === 'winner'
          ? { duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: 0.6 }
          : undefined
      }
    >
      {tooltipText ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>{buttonEl}</TooltipTrigger>
            <TooltipContent>{tooltipText}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        buttonEl
      )}
    </motion.div>
  );
}

/** The visible mark inside an action cell: optimistic placement, glyph, or icon. */
function CellMark({
  cell,
  optimisticMark,
  icon: Icon,
  motionOn,
}: {
  cell: BoardCellData;
  optimisticMark: string | null;
  icon: LucideIcon | null;
  motionOn: boolean;
}) {
  if (optimisticMark !== null) {
    return (
      <DrawnMark
        mark={optimisticMark}
        motionOn={motionOn}
        colorClass={markColorClass(optimisticMark, cell)}
      />
    );
  }
  if (cell.glyph) {
    return (
      <DrawnMark
        mark={cell.glyph}
        motionOn={motionOn}
        colorClass={markColorClass(cell.glyph, cell)}
      />
    );
  }
  if (Icon) return <Icon className="size-6" aria-hidden />;
  return null;
}

/** Route to the static or interactive cell based on whether it carries an action. */
export function BoardCell(props: BoardCellProps) {
  if (props.cell.action) {
    return (
      <ActionBoardCell {...props} cell={props.cell as BoardCellData & { action: WidgetAction }} />
    );
  }
  return <StaticBoardCell {...props} />;
}
