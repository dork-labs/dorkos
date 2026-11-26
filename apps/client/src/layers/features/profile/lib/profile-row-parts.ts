/**
 * The small pieces every profile row table is built from: a count in words, a
 * fold's summary line, and the fold itself.
 *
 * @module features/profile/lib/profile-row-parts
 */
import type { ProfileFoldId, ProfileRowGroup, ProfileRowModel } from './profile-rows';

/**
 * A count, or `null` when nothing has answered yet — a row says nothing rather
 * than "0" it invented.
 *
 * @param count - How many, or nothing while unknown.
 * @param one - The word for one.
 * @param many - The word for any other number.
 */
export function countValue(
  count: number | null | undefined,
  one: string,
  many: string
): string | null {
  if (count === null || count === undefined) return null;
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/**
 * Summary parts that are known, joined; `null` when none is.
 *
 * @param parts - The parts, unknown ones as `null` or `undefined`.
 */
export function summaryOf(parts: Array<string | null | undefined>): string | null {
  const known = parts.filter((part): part is string => Boolean(part));
  return known.length > 0 ? known.join(' · ') : null;
}

/**
 * A fold, wrapped around its rows.
 *
 * @param id - Which fold.
 * @param title - The fold header's title.
 * @param rows - What it holds.
 * @param summary - One line of what is inside, or `null`.
 */
export function fold(
  id: ProfileFoldId,
  title: string,
  rows: ProfileRowModel[],
  summary: string | null
): ProfileRowGroup {
  return { id, rows, fold: { id, title, summary } };
}
