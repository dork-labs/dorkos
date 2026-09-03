/**
 * The one place the package grid decides how many columns it draws.
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
 */

/**
 * Marks the element whose width the grid measures itself against.
 *
 * Goes on an ancestor of the grid, never on the grid itself: an element cannot
 * query its own container.
 */
export const PACKAGE_GRID_CONTAINER = '@container/packages';

/**
 * Column counts for a grid of package cards, keyed to the container marked with
 * {@link PACKAGE_GRID_CONTAINER}.
 *
 * Thresholds are chosen so a card is never narrower than about 240px, which is
 * where its name, type badge and Install button all still read.
 */
export const PACKAGE_GRID_COLUMNS =
  'grid grid-cols-1 gap-4 @lg/packages:grid-cols-2 @3xl/packages:grid-cols-3 @5xl/packages:grid-cols-4';
