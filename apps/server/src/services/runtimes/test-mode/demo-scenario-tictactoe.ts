import type { StreamEvent } from '@dorkos/shared/types';
import type { WidgetDocument, WidgetNode } from '@dorkos/shared/ui-widget';
import type { ScenarioFn } from './scenario-store.js';
import { DEMO_SESSION_ID, DEMO_MODEL, delay, streamText } from './demo-scenario-shared.js';

/**
 * The tic-tac-toe demo scenario for the marketing product-capture pipeline
 * (`apps/e2e/capture`, the `gen-ui-tictactoe` shot): a two-turn script proving
 * out the `board` widget's full interaction loop end to end — the agent
 * renders a mid-game grid, a real click round-trips through
 * `POST /api/sessions/:id/ui-action`, and the agent's next turn re-renders the
 * board with the move applied. Exists ONLY to stage a truthful capture; every
 * event below streams through the exact same normalizer → projector → SSE
 * path a production runtime uses, so the client renders the real `BoardNode` /
 * `MoodNode` components against real (seeded) stream data. Reachable only when
 * `DORKOS_TEST_RUNTIME=true`, selectable only via `POST /api/test/scenario`.
 *
 * Split out of `demo-scenarios.ts` (which was pushing the 500-line split
 * threshold — `.claude/rules/conventions.md`).
 *
 * @module services/runtimes/test-mode/demo-scenario-tictactoe
 */

/** A board square: the mark it holds, or `''` for empty. */
type Glyph = 'X' | 'O' | '';

/** A 3×3 board, row-major. */
type Board = readonly (readonly Glyph[])[];

/** Board size — both the capture drive and {@link boardLines} assume 3×3. */
const SIZE = 3;

/**
 * The mid-game board the scenario opens on: two moves each, with the player's
 * X's on the main diagonal ((0,0), (1,1)) one square short of a win at (2,2) —
 * the capture drive clicks exactly that square.
 */
const OPENING_BOARD: Board = [
  ['X', '', 'O'],
  ['', 'X', ''],
  ['O', '', ''],
];

/** Serialize a board to the `payload.state` wire format (`"X.O/.X./O.."`, rows joined by `/`). */
function boardToState(board: Board): string {
  return board.map((row) => row.map((cell) => cell || '.').join('')).join('/');
}

/** A completed 3-in-a-row: which glyph, and the cells forming it. */
interface WinLine {
  readonly glyph: Glyph;
  readonly cells: readonly { r: number; c: number }[];
}

/** Every line a 3×3 board can complete: three rows, three columns, two diagonals. */
function boardLines(): { r: number; c: number }[][] {
  const lines: { r: number; c: number }[][] = [];
  for (let i = 0; i < SIZE; i++) {
    lines.push(Array.from({ length: SIZE }, (_, j) => ({ r: i, c: j })));
    lines.push(Array.from({ length: SIZE }, (_, j) => ({ r: j, c: i })));
  }
  lines.push(Array.from({ length: SIZE }, (_, i) => ({ r: i, c: i })));
  lines.push(Array.from({ length: SIZE }, (_, i) => ({ r: i, c: SIZE - 1 - i })));
  return lines;
}

/** Detect a completed line of identical non-empty glyphs, or `null` — mirrors `board-lines.ts`'s client-side detector. */
function detectWin(board: Board): WinLine | null {
  for (const cells of boardLines()) {
    const first = board[cells[0]!.r]![cells[0]!.c]!;
    if (!first) continue;
    if (cells.every(({ r, c }) => board[r]![c] === first)) return { glyph: first, cells };
  }
  return null;
}

/** A cell's action id, encoding its coordinates (`move-r0-c0`) — recovered by {@link parseMove}. */
function moveActionId(r: number, c: number): string {
  return `move-r${r}-c${c}`;
}

/**
 * Recover the clicked cell from the `<ui_action>` block's `Action:` line
 * (`formatUiActionMessage`'s output), or `null` for the opening turn (no
 * prior interaction) or an unrecognized/out-of-range action id.
 */
function parseMove(content: string): { r: number; c: number } | null {
  const action = content.match(/^Action: (\S+)$/m)?.[1];
  const cell = action?.match(/^move-r(\d+)-c(\d+)$/);
  if (!cell) return null;
  const r = Number(cell[1]);
  const c = Number(cell[2]);
  if (r < 0 || r >= SIZE || c < 0 || c >= SIZE) return null;
  return { r, c };
}

/**
 * Build the `board` node for a board matrix. `interactive` wires every empty
 * cell to a `move-r{r}-c{c}` agent action (the player always plays X); a
 * non-interactive board (the finished game) renders every cell as history.
 */
function boardChild(board: Board, interactive: boolean): WidgetNode {
  const state = boardToState(board);
  return {
    type: 'board',
    label: 'You (X) · Atlas (O)',
    rows: board.map((row, r) =>
      row.map((glyph, c) => {
        if (glyph) return { glyph };
        if (!interactive) return {};
        return {
          action: {
            kind: 'agent',
            id: moveActionId(r, c),
            label: 'Play here',
            payload: { r, c, glyph: 'X', state },
          },
        };
      })
    ),
  };
}

/** Turn one: the mid-game board, offered to the player as an interactive move. */
function openingDocument(): WidgetDocument {
  return {
    version: 1,
    title: 'Tic-tac-toe',
    root: { type: 'card', title: 'Tic-tac-toe', children: [boardChild(OPENING_BOARD, true)] },
  };
}

/**
 * Turn two: the board with the player's move applied (now history, no more
 * actions) plus the agent's reaction — a celebrating mood face when the move
 * completed the diagonal, a neutral one otherwise.
 */
function replyDocument(board: Board, win: WinLine | null): WidgetDocument {
  const mood: WidgetNode = win
    ? { type: 'mood', emotion: 'celebrating', message: 'Well played.' }
    : { type: 'mood', emotion: 'thinking', message: 'Hm — let me think.' };
  return {
    version: 1,
    title: 'Tic-tac-toe',
    root: { type: 'card', title: 'Tic-tac-toe', children: [boardChild(board, false), mood] },
  };
}

/** Render a widget document as the `dorkos-ui` fence body, streamed word-by-word. */
function fence(doc: WidgetDocument): string {
  return '```dorkos-ui\n' + JSON.stringify(doc) + '\n```\n\n';
}

/** Opening line, streamed before the mid-game board renders. */
const OPENING_INTRO = `Your move. Take your time — or don't.\n\n`;
/** Closing line after the board settles — the capture drive's "fully rendered" signal. */
const OPENING_OUTRO = `Board's set.`;

/** Trash talk streamed once the player's winning move re-triggers the agent's turn. */
const WIN_REPLY = `Oh — nice. Didn't see that diagonal coming.\n\n`;
/** Trash talk streamed for any other (off-script) move — manual `/api/test/scenario` testing only. */
const OTHER_REPLY = `Hm — let me think.\n\n`;

/**
 * Pause before the reply turn's first token — an agent-thinking beat that lets
 * the player's just-drawn optimistic mark hold on camera before the reply
 * pushes in.
 */
const REPLY_THINK_MS = 900;

/**
 * The tic-tac-toe demo turn: opens on a mid-game board (ignoring `content` —
 * there is no prior interaction yet) and, once the player's click round-trips
 * through `/ui-action` as a `<ui_action>` block, re-renders the board with the
 * move applied. The capture drive always plays the diagonal-completing square,
 * which draws the board's win-line and a celebrating mood face; any other
 * (off-script) square still responds sensibly for manual testing.
 */
const demoGenUiTicTacToe: ScenarioFn = async function* (content) {
  yield {
    type: 'session_status',
    data: { sessionId: DEMO_SESSION_ID, model: DEMO_MODEL },
  } as StreamEvent;

  const move = parseMove(content);
  if (!move || OPENING_BOARD[move.r]![move.c] !== '') {
    yield* streamText(OPENING_INTRO);
    yield* streamText(fence(openingDocument()));
    yield* streamText(OPENING_OUTRO);
    yield { type: 'done', data: { sessionId: DEMO_SESSION_ID } } as StreamEvent;
    return;
  }

  const board = OPENING_BOARD.map((row) => [...row]) as Glyph[][];
  board[move.r]![move.c] = 'X';
  const win = detectWin(board);
  await delay(REPLY_THINK_MS);
  yield* streamText(win ? WIN_REPLY : OTHER_REPLY);
  yield* streamText(fence(replyDocument(board, win)));
  yield { type: 'done', data: { sessionId: DEMO_SESSION_ID } } as StreamEvent;
};

export { demoGenUiTicTacToe };
