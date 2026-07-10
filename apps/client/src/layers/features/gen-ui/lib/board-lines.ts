/**
 * Win-line detection for square game boards — the pure geometry behind the
 * board widget's victory flourish. No React, no motion; just "is there a
 * completed line, and which cells form it".
 *
 * @module features/gen-ui/lib/board-lines
 */

/** The smallest and largest square board the win flourish applies to. */
const MIN_BOARD_SIZE = 2;
const MAX_BOARD_SIZE = 5;

/** A cell coordinate on the board (0-based). */
export interface BoardCoord {
  row: number;
  col: number;
}

/** A detected winning line: the cells that form it and the glyph they share. */
export interface WinLine {
  /** The shared, non-empty glyph (e.g. `'X'`). */
  glyph: string;
  /** The cells forming the line, in scan order. */
  cells: BoardCoord[];
}

/** Minimal shape this module reads off a board cell — just its glyph, if any. */
interface GlyphCell {
  glyph?: string;
}

/**
 * A cell's glyph normalized for line comparison: trimmed, whitespace-only →
 * `null`. The schema layer already strips whitespace-only glyphs, but this
 * module also runs on unvalidated shapes (belt and braces) — a board of
 * `glyph: " "` cells must never read as a winning line of identical marks.
 */
function effectiveGlyph(cell: GlyphCell | undefined): string | null {
  const trimmed = cell?.glyph?.trim();
  return trimmed ? trimmed : null;
}

/** A line of coordinates wins when every cell holds the same non-empty glyph. */
function lineGlyph(rows: GlyphCell[][], coords: BoardCoord[]): string | null {
  const first = effectiveGlyph(rows[coords[0].row]?.[coords[0].col]);
  if (!first) return null;
  for (const { row, col } of coords) {
    if (effectiveGlyph(rows[row]?.[col]) !== first) return null;
  }
  return first;
}

/**
 * Detect a single completed line (a full row, column, or main/anti diagonal) of
 * identical non-empty glyphs on a SQUARE board of size 2–5. Returns the first
 * line found (scan order: rows top-to-bottom, columns left-to-right, main
 * diagonal, anti-diagonal) or `null`.
 *
 * Non-square, jagged, or out-of-range boards return `null` — the victory
 * flourish is scoped to classic square boards (tic-tac-toe and its cousins),
 * where a "line" is unambiguous.
 *
 * @param rows - The board's rows of cells (only `glyph` is read).
 */
export function detectWinLine(rows: GlyphCell[][]): WinLine | null {
  const size = rows.length;
  if (size < MIN_BOARD_SIZE || size > MAX_BOARD_SIZE) return null;
  if (rows.some((row) => row.length !== size)) return null;

  const lines: BoardCoord[][] = [];
  // Rows and columns.
  for (let i = 0; i < size; i++) {
    lines.push(Array.from({ length: size }, (_, j) => ({ row: i, col: j })));
    lines.push(Array.from({ length: size }, (_, j) => ({ row: j, col: i })));
  }
  // Diagonals.
  lines.push(Array.from({ length: size }, (_, i) => ({ row: i, col: i })));
  lines.push(Array.from({ length: size }, (_, i) => ({ row: i, col: size - 1 - i })));

  for (const cells of lines) {
    const glyph = lineGlyph(rows, cells);
    if (glyph) return { glyph, cells };
  }
  return null;
}

/** Membership test: is this coordinate part of the winning line? */
export function isWinningCell(win: WinLine | null, row: number, col: number): boolean {
  return win !== null && win.cells.some((c) => c.row === row && c.col === col);
}
