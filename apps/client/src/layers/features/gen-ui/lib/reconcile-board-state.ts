/**
 * Fill-only reconciliation of a board's rendered cells against the `state`
 * strings its action payloads carry.
 *
 * The game protocol teaches the model to trust `payload.state` (`"X../.O./..X"`
 * — rows joined by `/`, one character per cell, `.` for empty) over its own
 * memory, so the game's FUTURE follows state. A real session showed the model
 * writing a move into every payload's `state` but forgetting it in `rows` — the
 * user saw an empty, clickable square the agent believed was occupied, and the
 * two played different boards. Rendering must follow state too.
 *
 * Direction of trust is strictly FILL-ONLY (Postel): a cell rendered empty
 * whose state character is a mark gets that mark (and loses its action — an
 * occupied square must not be clickable). A visibly rendered glyph or icon is
 * NEVER erased or changed by state. Boards whose payloads carry no state, an
 * unparseable state, disagreeing states, or dimensions that don't match the
 * grid are returned untouched.
 *
 * @module features/gen-ui/lib/reconcile-board-state
 */
import type { WidgetNode } from '@dorkos/shared/ui-widget';

type BoardRows = Extract<WidgetNode, { type: 'board' }>['rows'];
type BoardCell = BoardRows[number][number];

/** State characters that mean "this square is empty" (lenient set). */
const EMPTY_CHARS = new Set(['.', ' ', '-', '_']);

/** The canonical empty marker every {@link EMPTY_CHARS} member normalizes to. */
const EMPTY = '.';

/**
 * Read one row segment's per-cell characters, or `null` if it can't match the
 * expected length. The UNTRIMMED read wins so a leading/trailing space can mean
 * "this edge square is empty" (space is a documented empty marker — trimming
 * first would shorten `" X."` to 2 chars and silently discard a valid heal,
 * caught in #191 review); when the raw length misses, a trimmed read salvages
 * decorative padding. Empty-marker characters normalize to `.` so equivalent
 * states (`"X."` vs `"X "`) vote as one in the consensus.
 */
function segmentChars(segment: string, expected: number): string[] | null {
  const normalize = (chars: string[]) => chars.map((c) => (EMPTY_CHARS.has(c) ? EMPTY : c));
  const raw = [...segment];
  if (raw.length === expected) return normalize(raw);
  const trimmed = [...segment.trim()];
  if (trimmed.length === expected) return normalize(trimmed);
  return null;
}

/**
 * Parse one payload `state` string against the board's exact shape. Returns the
 * per-cell characters (empty markers normalized to `.`), or `null` unless every
 * row segment matches its rendered row's length (lenient about padding and
 * trailing newlines, strict about shape — we only act when the state cleanly
 * describes THIS grid).
 */
function parseState(state: string, rows: BoardRows): string[][] | null {
  const segments = state.split('/');
  if (segments.length !== rows.length) return null;
  const parsed: string[][] = [];
  for (let r = 0; r < segments.length; r++) {
    const chars = segmentChars(segments[r], rows[r].length);
    if (!chars) return null;
    parsed.push(chars);
  }
  return parsed;
}

/** Collect every `state` string carried by the board's agent-action payloads. */
function collectStates(rows: BoardRows): string[] {
  const states: string[] = [];
  for (const row of rows) {
    for (const cell of row) {
      if (cell.action?.kind !== 'agent') continue;
      const state = cell.action.payload?.state;
      if (typeof state === 'string' && state.trim() !== '') states.push(state);
    }
  }
  return states;
}

/**
 * Pick the consensus state among the candidates that cleanly parse to this
 * board's shape: the majority value wins; a tie between different values means
 * no consensus (`null`). Comparison is on the parsed characters, so formatting
 * differences (padding, whitespace) don't split the vote.
 */
function consensusState(states: string[], rows: BoardRows): string[][] | null {
  const counts = new Map<string, { parsed: string[][]; count: number }>();
  for (const state of states) {
    const parsed = parseState(state, rows);
    if (!parsed) continue;
    const key = parsed.map((row) => row.join('')).join('/');
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { parsed, count: 1 });
  }
  if (counts.size === 0) return null;
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  if (ranked.length > 1 && ranked[0].count === ranked[1].count) return null;
  return ranked[0].parsed;
}

/**
 * Heal a board's rows against the consensus of its payload `state` strings,
 * fill-only: an empty cell (no glyph, no icon) whose state character is a mark
 * gets that mark as its glyph and loses its action; everything else — filled
 * cells, empty state characters, boards with no usable consensus — is
 * untouched. Returns the ORIGINAL array when nothing changes, so callers can
 * cheaply detect a no-op.
 *
 * @param rows - The board node's rows as authored by the model.
 */
export function reconcileBoardState(rows: BoardRows): BoardRows {
  const states = collectStates(rows);
  if (states.length === 0) return rows;
  const state = consensusState(states, rows);
  if (!state) return rows;

  let changed = false;
  const healed = rows.map((row, r) =>
    row.map((cell, c) => {
      const char = state[r][c];
      // Fill-only: never touch a visibly filled cell, never act on an
      // empty-state character (normalized to `.` at parse).
      if (cell.glyph || cell.icon || char === EMPTY) return cell;
      changed = true;
      const { action: _action, ...rest } = cell;
      return { ...rest, glyph: char } satisfies BoardCell;
    })
  );
  return changed ? healed : rows;
}
