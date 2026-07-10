import { describe, it, expect } from 'vitest';
import type { WidgetNode } from '@dorkos/shared/ui-widget';
import { reconcileBoardState } from '../lib/reconcile-board-state';

type BoardRows = Extract<WidgetNode, { type: 'board' }>['rows'];

/** Agent-action cell whose payload carries the given game `state` string. */
function actionCell(id: string, state?: string): BoardRows[number][number] {
  return {
    action: {
      kind: 'agent',
      id,
      payload: state !== undefined ? { glyph: 'O', state } : { glyph: 'O' },
    },
  };
}

/**
 * The real session fixture (transcript f3fb9d67, lines ~76-96): the model
 * played X at (2,2), wrote it into every payload's `state` (`X../.O./..X`),
 * but rendered the (2,2) cell as empty-with-action — the user saw no X.
 */
const SESSION_STATE = 'X../.O./..X';
function sessionRows(): BoardRows {
  return [
    [{ glyph: 'X' }, actionCell('move-0-1', SESSION_STATE), actionCell('move-0-2', SESSION_STATE)],
    [actionCell('move-1-0', SESSION_STATE), { glyph: 'O' }, actionCell('move-1-2', SESSION_STATE)],
    [
      actionCell('move-2-0', SESSION_STATE),
      actionCell('move-2-1', SESSION_STATE),
      actionCell('move-2-2', SESSION_STATE),
    ],
  ];
}

describe('reconcileBoardState', () => {
  it('fills the cell the model forgot to render and strips its action (session fixture)', () => {
    const healed = reconcileBoardState(sessionRows());
    // (2,2): state says X, rows said empty-with-action → mark appears, click gone.
    expect(healed[2][2].glyph).toBe('X');
    expect(healed[2][2].action).toBeUndefined();
    // Genuinely empty squares stay empty and clickable.
    expect(healed[0][1].glyph).toBeUndefined();
    expect(healed[0][1].action?.kind).toBe('agent');
    // Rendered glyphs untouched.
    expect(healed[0][0].glyph).toBe('X');
    expect(healed[1][1].glyph).toBe('O');
  });

  it('never erases or changes a visibly rendered glyph (fill-only)', () => {
    // State '.O/O.' disagrees with the drawn board everywhere it is filled:
    // '.' where an X is drawn at (0,0), 'O' where an X is drawn at (0,1).
    // The drawn board wins, always — only the truly empty (1,0) heals.
    const rows: BoardRows = [
      [{ glyph: 'X' }, { glyph: 'X' }],
      [actionCell('m', '.O/O.'), {}],
    ];
    const healed = reconcileBoardState(rows);
    expect(healed[0][0].glyph).toBe('X');
    expect(healed[0][1].glyph).toBe('X');
    expect(healed[1][0].glyph).toBe('O');
    expect(healed[1][0].action).toBeUndefined();
    // (1,1)'s state char is '.', so it stays empty.
    expect(healed[1][1].glyph).toBeUndefined();
  });

  it('heals an empty cell but leaves empty-state cells alone', () => {
    const rows: BoardRows = [
      [actionCell('a', 'X./..'), actionCell('b', 'X./..')],
      [{}, {}],
    ];
    const healed = reconcileBoardState(rows);
    expect(healed[0][0].glyph).toBe('X');
    expect(healed[0][0].action).toBeUndefined();
    expect(healed[0][1].glyph).toBeUndefined();
    expect(healed[1][0].glyph).toBeUndefined();
  });

  it('ignores garbage state strings', () => {
    const rows: BoardRows = [[actionCell('a', 'not a board at all'), {}]];
    expect(reconcileBoardState(rows)).toBe(rows);
  });

  it('ignores states whose dimensions do not match the grid', () => {
    const rows: BoardRows = [
      [actionCell('a', 'X../.O./..X'), {}],
      [{}, {}],
    ];
    // 3x3 state on a 2x2 board — untouched.
    expect(reconcileBoardState(rows)).toBe(rows);
  });

  it('ignores disagreeing states with no majority', () => {
    const rows: BoardRows = [
      [actionCell('a', 'X./..'), actionCell('b', 'O./..')],
      [{}, {}],
    ];
    expect(reconcileBoardState(rows)).toBe(rows);
  });

  it('follows the majority when states disagree', () => {
    const rows: BoardRows = [
      [actionCell('a', '.X/..'), actionCell('b', '.X/..')],
      [actionCell('c', '.O/..'), {}],
    ];
    const healed = reconcileBoardState(rows);
    expect(healed[0][1].glyph).toBe('X');
    expect(healed[0][1].action).toBeUndefined();
  });

  it('returns the original array when there is nothing to heal', () => {
    const rows: BoardRows = [
      [{ glyph: 'X' }, actionCell('a', 'X./..')],
      [{}, {}],
    ];
    // State agrees with the rendered board — identity, no new arrays.
    expect(reconcileBoardState(rows)).toBe(rows);
  });

  it('returns the original array when no payload carries a state', () => {
    const rows: BoardRows = [[{ glyph: 'X' }, actionCell('a')]];
    expect(reconcileBoardState(rows)).toBe(rows);
  });

  it('does not fill over an icon cell — icons are visibly filled too', () => {
    // State 'XO' claims (0,0) is an X, but the cell already renders an icon.
    const rows: BoardRows = [[{ icon: 'star' }, actionCell('a', 'XO')]];
    const healed = reconcileBoardState(rows);
    expect(healed[0][0].icon).toBe('star');
    expect(healed[0][0].glyph).toBeUndefined();
    expect(healed[0][1].glyph).toBe('O');
    expect(healed[0][1].action).toBeUndefined();
  });
});
