/**
 * `board` node — a CSS grid of glyph/icon cells, optionally clickable. Paired
 * with an `agent` action re-emitted each turn, this is the primitive behind
 * turn-based games like tic-tac-toe: the agent renders the board, the player
 * clicks a cell (the mark draws itself instantly), and the agent's next turn
 * re-renders it with the move applied.
 *
 * While the player's move is in flight the board latches into a calm "thinking"
 * state (a breathing ring, not a spinner). Once a completed line appears, the
 * winning stroke draws through it. Superseded boards read as history — full
 * contrast, affordances quietly gone.
 *
 * @module features/gen-ui/ui/nodes/board/BoardNode
 */
import { motion } from 'motion/react';
import type { Variants } from 'motion/react';
import type { WidgetNode, WidgetTone } from '@dorkos/shared/ui-widget';
import { cn } from '@/layers/shared/lib';
import { resolveWidgetIcon } from '../../../lib/widget-icon';
import { useWidgetMotion } from '../../../lib/widget-motion';
import { useWidgetActions } from '../../../model/widget-context';
import {
  detectWinLine,
  isWinningCell,
  type WinLine as WinLineData,
} from '../../../lib/board-lines';
import { BoardCell, type WinRole } from './BoardCell';
import { WinLine } from './WinLine';

type NodeOf<T extends WidgetNode['type']> = Extract<WidgetNode, { type: T }>;
type BoardCellData = NodeOf<'board'>['rows'][number][number];

/** A cell rendered where a jagged row falls short of the widest row. */
const EMPTY_CELL: BoardCellData = {};

/** Faster stagger than the default widget entrance — a grid pops in as one quick sweep. */
const BOARD_STAGGER_STEP = 0.02;
const boardStaggerContainer: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: BOARD_STAGGER_STEP } },
};

/** Classify a cell's role in the winning line for emphasis/dimming. */
function resolveWinRole(
  win: WinLineData | null,
  row: number,
  col: number,
  cell: BoardCellData
): WinRole {
  if (!win) return 'none';
  if (isWinningCell(win, row, col)) return 'winner';
  return cell.glyph ? 'loser' : 'none';
}

/** Boards up to this many columns get roomier cells so games feel deliberate. */
const SMALL_BOARD_MAX_COLUMNS = 4;
/** Cell edge (rem) for small vs larger boards; gap is shared. Small ≥ 44px touch target. */
const CELL_UNIT_SMALL = 3.25;
const CELL_UNIT_LARGE = 2.5;
const GAP_UNIT = 0.25;

/** Text-color token the winning stroke and cells inherit, keyed by the line's tone. */
const WIN_TONE_TEXT: Record<WidgetTone, string> = {
  default: 'text-primary',
  success: 'text-status-success-fg',
  warning: 'text-status-warning-fg',
  error: 'text-status-error-fg',
  info: 'text-status-info-fg',
};

/**
 * Render a `board` node: a square/rectangular grid of cells with roomier sizing
 * for small boards, a self-drawing mark per cell, a breathing "thinking" ring
 * while a move is in flight, and a victory stroke when a line completes.
 *
 * @param node - The validated `board` widget node.
 */
export function BoardNode({ node }: { node: NodeOf<'board'> }) {
  const motionOn = useWidgetMotion();
  const { latched, superseded } = useWidgetActions();
  const columns = Math.max(1, ...node.rows.map((row) => row.length));
  const cellUnit = columns <= SMALL_BOARD_MAX_COLUMNS ? CELL_UNIT_SMALL : CELL_UNIT_LARGE;

  const win = detectWinLine(node.rows);
  const winTone: WidgetTone = win
    ? (node.rows[win.cells[0].row]?.[win.cells[0].col]?.tone ?? 'default')
    : 'default';
  const winColorClass = WIN_TONE_TEXT[winTone];

  // The board breathes while the player's move is in flight and no newer message
  // has superseded it — a calm "opponent is thinking" cue.
  const thinking = latched && !superseded;

  return (
    <div className="flex flex-col gap-1.5">
      {node.label && <p className="text-muted-foreground text-xs">{node.label}</p>}
      <div className={cn('relative w-fit', superseded && 'saturate-[0.9]')}>
        {thinking && (
          <motion.div
            aria-hidden
            className="ring-primary/40 pointer-events-none absolute -inset-1 rounded-lg ring-2"
            initial={motionOn ? { opacity: 0.25 } : false}
            animate={motionOn ? { opacity: [0.25, 0.6, 0.25] } : { opacity: 0.4 }}
            transition={motionOn ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : undefined}
          />
        )}
        <motion.div
          role="grid"
          aria-label={node.label ?? 'Board'}
          className="grid w-fit gap-1"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, ${cellUnit}rem))` }}
          variants={motionOn ? boardStaggerContainer : undefined}
          initial={motionOn ? 'hidden' : false}
          animate={motionOn ? 'visible' : false}
        >
          {/* `display: contents` row wrappers keep the single CSS grid layout while
              giving the grid real row semantics; jagged rows are padded to the
              widest row with blank cells so columns always align. */}
          {node.rows.map((row, r) => (
            <div key={r} role="row" className="contents">
              {Array.from({ length: columns }, (_, c) => {
                const cell = row[c] ?? EMPTY_CELL;
                const icon = !cell.glyph && cell.icon ? resolveWidgetIcon(cell.icon) : null;
                const winRole = resolveWinRole(win, r, c, cell);
                return (
                  <BoardCell
                    key={`${r}-${c}`}
                    cell={cell}
                    icon={icon}
                    motionOn={motionOn}
                    row={r}
                    col={c}
                    winRole={winRole}
                  />
                );
              })}
            </div>
          ))}
        </motion.div>
        {win && (
          <WinLine
            win={win}
            size={columns}
            cellUnit={cellUnit}
            gapUnit={GAP_UNIT}
            colorClass={winColorClass}
            motionOn={motionOn}
          />
        )}
      </div>
    </div>
  );
}
