/**
 * One blockage, one place on the screen — the phone's rule (DOR-1391).
 *
 * @module features/dashboard-sidebar/model/rules/suppress-covered-now-items
 */
import type { SidebarRowModel } from '../build-sidebar-model';

/**
 * Heads up's rows with the ones something above them already draws removed.
 *
 * **The phone's Home tab draws an answerable card for every approval and every
 * prompt, at the top of Heads up.** Underneath it, the same approvals and
 * prompts were also drawing as rows — so a single blocked agent appeared twice
 * in one viewport, once as a card with Allow and Deny on it and once as a line
 * of text that navigates to the same question. Which one a person pressed
 * decided whether they answered it or travelled to it.
 *
 * The card wins, because it is the one that can end the blockage where it
 * stands. What is left in the zone is everything the cards do NOT cover: a
 * session that stopped with an error, a schedule waiting for a yes, a prompt
 * whose session reported `blocked` before the prompt itself arrived.
 *
 * **Desktop passes nothing here and is unchanged**, because the desktop panel
 * has no lead slot: `SidebarState.coveredSignalIds` is the list of what the
 * slot drew, and only `widgets/mobile-tabs` fills it.
 *
 * Applied BEFORE the cap, deliberately. After it, suppressing the three visible
 * rows of seven would leave "+ 4 more" standing under seven cards — a fold
 * summarizing things the reader can already see. Before it, the cards are
 * simply the whole of the answer.
 *
 * **It removes rows, never the count.** `needsYouCount` is taken from the
 * ranked list this filters, not from its result, so the live region and the
 * phone's badge still report every blockage: a card on screen is still
 * something waiting on a person.
 *
 * @param rows - Heads up's attention rows, ranked.
 * @param covered - Signal ids already drawn as cards. Empty on desktop.
 */
export function suppressCoveredNowItems(
  rows: readonly SidebarRowModel[],
  covered: readonly string[] | undefined
): SidebarRowModel[] {
  if (covered === undefined || covered.length === 0) return [...rows];
  const drawn = new Set(covered);
  return rows.filter((row) => !(row.target.kind === 'attention' && drawn.has(row.target.signalId)));
}
