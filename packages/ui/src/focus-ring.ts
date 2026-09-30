/**
 * The keyboard focus ring of Input, Textarea, Checkbox, RadioGroupItem, the
 * Slider thumb and the ScrollArea viewport, spelled once.
 *
 * **Solid, because a faint ring is not a focus indicator.** The controls used
 * to draw the ring colour at half strength, which measured about 1.9:1 against
 * a light page and 2.5:1 against a dark one, under the 3:1 WCAG AA asks of a
 * focus indicator and the design system's own rule. The ring colour itself
 * clears 3:1 on both themes, so the ring is simply that colour (DOR-2567 for
 * `Button`, DOR-2609 for the rest). `Button` spells the same three classes in
 * its variant table beside the `has-[:focus-visible]` twins only a button needs.
 *
 * **`focus-visible`, not `focus`.** A checkbox, a radio or a slider thumb that is
 * clicked or dragged takes focus without showing a ring, because the browser
 * only matches `:focus-visible` for keyboard focus there. A text box is the
 * exception by the browser's own rule, not ours: it matches on a click too,
 * since the caret is about to go there, and that is kept.
 *
 * No colour a control fills itself with is the ring colour, so every ring here
 * sits flush against the control. `Button`'s brand and destructive variants,
 * whose fill IS their ring's colour, are the only ones that need a gap.
 * `SelectTrigger` (1px), `Switch` and `Tabs` (2px with a gap) keep their own
 * solid rings.
 *
 * Internal: not part of the package's public exports.
 */

/** A solid 3px ring in the ring colour, and the border to match, on keyboard focus. */
export const FOCUS_RING =
  'focus-visible:border-dui-ring focus-visible:ring-dui-ring focus-visible:ring-[3px]';

/**
 * The same ring in the destructive colour while the control is marked invalid.
 *
 * Solid for the same reason: it is the only ring an invalid control shows when
 * focused, and at a fifth of its strength it was barely there. It is a colour
 * only; the width still comes from {@link FOCUS_RING}, so an invalid control
 * without focus shows its red border and no ring.
 */
export const INVALID_RING = 'aria-invalid:border-dui-destructive aria-invalid:ring-dui-destructive';
