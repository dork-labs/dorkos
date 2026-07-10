import { describe, it, expect } from 'vitest';
import { detectWinLine, isWinningCell } from '../lib/board-lines';

/** Build a square board of glyph cells from a compact string grid (`''` = empty). */
function board(rows: string[][]) {
  return rows.map((row) => row.map((glyph) => (glyph ? { glyph } : {})));
}

describe('detectWinLine', () => {
  it('detects a winning row', () => {
    const win = detectWinLine(
      board([
        ['X', 'X', 'X'],
        ['O', 'O', ''],
        ['', '', ''],
      ])
    );
    expect(win).toEqual({
      glyph: 'X',
      cells: [
        { row: 0, col: 0 },
        { row: 0, col: 1 },
        { row: 0, col: 2 },
      ],
    });
  });

  it('detects a winning column', () => {
    const win = detectWinLine(
      board([
        ['O', 'X', ''],
        ['O', 'X', ''],
        ['O', '', ''],
      ])
    );
    expect(win?.glyph).toBe('O');
    expect(win?.cells.map((c) => c.row)).toEqual([0, 1, 2]);
    expect(win?.cells.every((c) => c.col === 0)).toBe(true);
  });

  it('detects the main diagonal', () => {
    const win = detectWinLine(
      board([
        ['X', 'O', ''],
        ['O', 'X', ''],
        ['', '', 'X'],
      ])
    );
    expect(win?.glyph).toBe('X');
    expect(win?.cells).toEqual([
      { row: 0, col: 0 },
      { row: 1, col: 1 },
      { row: 2, col: 2 },
    ]);
  });

  it('detects the anti-diagonal', () => {
    const win = detectWinLine(
      board([
        ['', '', 'O'],
        ['', 'O', ''],
        ['O', '', ''],
      ])
    );
    expect(win?.glyph).toBe('O');
    expect(win?.cells).toEqual([
      { row: 0, col: 2 },
      { row: 1, col: 1 },
      { row: 2, col: 0 },
    ]);
  });

  it('returns null when there is no completed line', () => {
    expect(
      detectWinLine(
        board([
          ['X', 'O', 'X'],
          ['X', 'O', 'O'],
          ['O', 'X', 'X'],
        ])
      )
    ).toBeNull();
  });

  it('does not treat empty cells as a line', () => {
    expect(
      detectWinLine(
        board([
          ['', '', ''],
          ['X', 'O', ''],
          ['', '', ''],
        ])
      )
    ).toBeNull();
  });

  it('ignores non-square boards', () => {
    expect(
      detectWinLine(
        board([
          ['X', 'X', 'X'],
          ['O', 'O', ''],
        ])
      )
    ).toBeNull();
  });

  it('ignores jagged rows', () => {
    expect(detectWinLine([[{ glyph: 'X' }, { glyph: 'X' }], [{ glyph: 'X' }]])).toBeNull();
  });

  it('ignores boards larger than 5×5', () => {
    const bigRow = Array.from({ length: 6 }, () => 'X');
    const big = Array.from({ length: 6 }, () => [...bigRow]);
    expect(detectWinLine(board(big))).toBeNull();
  });
});

describe('isWinningCell', () => {
  it('reports membership in the winning line', () => {
    const win = {
      glyph: 'X',
      cells: [
        { row: 0, col: 0 },
        { row: 1, col: 1 },
      ],
    };
    expect(isWinningCell(win, 1, 1)).toBe(true);
    expect(isWinningCell(win, 2, 2)).toBe(false);
    expect(isWinningCell(null, 0, 0)).toBe(false);
  });
});
