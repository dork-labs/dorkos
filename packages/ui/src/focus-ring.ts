/**
 * The keyboard focus ring of every shared control, spelled once.
 *
 * The drawing lives in `packages/ui/tailwind.css` as the `focus-ring` utility: a
 * 2px outline in the ring colour, 2px off the control. Client, design system,
 * Community and site all import that stylesheet, so a control and a hand-written
 * `focus-ring` class can never differ. This constant only names it for the
 * primitives, so a rename has one place to go.
 *
 * **An outline, not a box-shadow.** Its gap is truly transparent on any ground, it
 * follows the control's radius, and it survives forced colours, which erase a
 * box-shadow and left those readers with no ring at all.
 *
 * **`:focus-visible`, not `:focus`.** A checkbox, a radio, a switch or a select
 * that is clicked takes focus without showing a ring. A text box is the exception
 * by the browser's own rule, and that is kept: a field holds focus for a moment,
 * and the ring says where the caret is.
 *
 * The ring turns destructive on its own under `aria-invalid="true"`.
 *
 * Internal: not part of the package's public exports.
 */

/** The class that draws the ring on keyboard focus. */
export const FOCUS_RING = 'focus-ring';
