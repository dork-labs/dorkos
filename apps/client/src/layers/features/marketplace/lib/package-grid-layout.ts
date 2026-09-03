/**
 * The one place a grid of package cards decides how many columns it draws —
 * the full catalog grid and the featured rail's shorter one alike.
 *
 * Marketplace never owns the whole window: the sidebar takes a slice, the right
 * panel takes another, and a resize handle splits what is left. A viewport
 * breakpoint knows none of that, so `md:grid-cols-3` put three cards into a
 * 236px column — 78px each, names cut mid-word, buttons overlapping. Container
 * queries ask the only question that matters: how wide is this grid, right now.
 *
 * The card grid and its loading skeleton both read from here, because the
 * skeleton's whole job is to hold the shape the real cards are about to take —
 * two different column rules would make the page jump the moment data lands.
 * The rail reads from here too, capped one column lower to match its own,
 * shorter row of cards — one module owning the rule, not two copies of the
 * same 240px reasoning.
 */

/**
 * Marks the element whose width a package grid measures itself against.
 *
 * Goes on an ancestor of the grid, never on the grid itself: an element cannot
 * query its own container. Shared by the full catalog grid and the featured
 * rail — the two never nest inside each other, so one container name serves
 * both without either shadowing the other's query.
 */
export const PACKAGE_GRID_CONTAINER = '@container/packages';

/**
 * Column counts for the full catalog grid of package cards, keyed to the
 * container marked with {@link PACKAGE_GRID_CONTAINER}.
 *
 * Thresholds are chosen so a card is never narrower than about 240px, which is
 * where its name, type badge and Install button all still read.
 */
export const PACKAGE_GRID_COLUMNS =
  'grid grid-cols-1 gap-4 @lg/packages:grid-cols-2 @3xl/packages:grid-cols-3 @5xl/packages:grid-cols-4';

/**
 * Column counts for the featured rail's shorter grid, keyed to the same
 * {@link PACKAGE_GRID_CONTAINER} and the same ~240px-card reasoning as
 * {@link PACKAGE_GRID_COLUMNS}, capped at 3 instead of 4 — one column per card
 * in a rail that never shows more than three.
 */
export const RAIL_GRID_COLUMNS =
  'grid grid-cols-1 gap-4 @lg/packages:grid-cols-2 @3xl/packages:grid-cols-3';
