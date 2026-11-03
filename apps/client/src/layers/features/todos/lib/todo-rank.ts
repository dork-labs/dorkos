/**
 * The person's own order for to-dos ("My order"): sortable string keys, so moving one to-do
 * rewrites that one row. Keys use only `a`–`z`, which sort the same by code point and by the
 * server's `localeCompare`, and a key this file makes never ends in `a`, so there is always room
 * below it.
 *
 * @module features/todos/lib/todo-rank
 */
import { TODO_RANK_MAX } from '@dorkos/shared/todo-schemas';
import type { Todo } from '@dorkos/shared/todo-schemas';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
/** One past the last digit: "no upper bound". */
const TOP = ALPHABET.length;
/** One below the first digit: "nothing here yet". */
const BOTTOM = -1;

/** A key's digit at one position, or `fallback` past its end. */
function digit(key: string | null, at: number, fallback: number): number {
  if (key === null || at >= key.length) return fallback;
  const value = ALPHABET.indexOf(key[at]!);
  return value === -1 ? fallback : value;
}

/**
 * A key that sorts strictly between two others.
 *
 * @param before - The key above, or null for the top of the list.
 * @param after - The key below, or null for the bottom.
 * @returns The new key, or null when none fits (a key from elsewhere left no room).
 */
export function rankBetween(before: string | null, after: string | null): string | null {
  let upper = after;
  let key = '';
  for (let at = 0; key.length < TODO_RANK_MAX; at++) {
    const low = digit(before, at, BOTTOM);
    const high = digit(upper, at, TOP);
    if (low === high) {
      key += ALPHABET[low];
      continue;
    }
    // Pick a digit strictly between, never `a`, so the key keeps room below it.
    const first = Math.max(low + 1, 1);
    const last = high - 1;
    if (first <= last) {
      key += ALPHABET[Math.floor((first + last) / 2)];
      break;
    }
    if (low === BOTTOM && high === 0) {
      // The key below has `a` here: follow it down.
      key += ALPHABET[0];
      continue;
    }
    // Take the lower digit; anything after it now sorts below the upper key.
    key += ALPHABET[Math.max(low, 0)];
    upper = null;
  }
  const fits =
    key.length <= TODO_RANK_MAX &&
    (before === null || key > before) &&
    (after === null || key < after);
  return fits ? key : null;
}

/** A to-do's new rank, for {@link planMove}. */
export interface RankChange {
  /** The to-do. */
  id: string;
  /** Its new key. */
  rank: string;
  /** The key it had. */
  previous: string | null;
}

/**
 * The rank changes that move one to-do to a new place in "My order". Usually that is the moved
 * to-do alone; the first time a list is ordered, the unranked ones above its new place get keys
 * too, since unranked to-dos always sort after ranked ones.
 *
 * @param rows - The open to-dos, in the order the list draws them.
 * @param from - The moved to-do's index.
 * @param to - Its new index.
 * @returns The changes, top first (a to-do whose key already fits is left alone), an empty list
 *   when nothing moves, or null when no key fits.
 */
export function planMove(
  rows: readonly Pick<Todo, 'id' | 'rank'>[],
  from: number,
  to: number
): RankChange[] | null {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return [];
  const order = [...rows];
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  const changes: RankChange[] = [];
  let previous: string | null = null;
  for (let index = 0; index <= to; index++) {
    const row = order[index]!;
    const keeps = index !== to && row.rank !== null && (previous === null || row.rank > previous);
    if (keeps) {
      previous = row.rank;
      continue;
    }
    const next = order[index + 1]?.rank ?? null;
    const rank = rankBetween(
      previous,
      next !== null && (previous === null || next > previous) ? next : null
    );
    if (rank === null) return null;
    // A key equal to the one it has means it already sits right: saving it again is refused.
    if (rank !== row.rank) changes.push({ id: row.id, rank, previous: row.rank });
    previous = rank;
  }
  return changes;
}
