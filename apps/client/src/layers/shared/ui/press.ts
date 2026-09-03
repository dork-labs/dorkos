/**
 * How a control answers a press, in three stops and no more.
 *
 * The design system has said the rule out loud for a while — "press scales by
 * target size: `0.99` for a card, `0.98` for a row or chip, `0.94` for a mark
 * used as a button" — and the codebase said it nine different ways: 0.85, 0.90,
 * 0.93, 0.94, 0.95, 0.97, 0.98 and 0.99, through two unrelated mechanisms,
 * because `Button` shipped no press for anything to inherit and every author
 * invented a number (DOR-1751). This module is the spelling.
 *
 * **Prefer these over `whileTap`.** A CSS press costs no JavaScript and is
 * already correct under `prefers-reduced-motion`; a `whileTap` is an inline
 * style that needs its own gate. Reach for `whileTap` only when the element is
 * a `motion.*` component for other reasons, and give it the same three values.
 *
 * **Every stop is `motion-safe:`, so a reader who asked for less motion gets no
 * shrink at all.** A press that has already happened leaves nothing behind to
 * read, so there is no static end state worth keeping — the design system's own
 * test for whether a state survives reduced motion. Where the press is the only
 * acknowledgement a surface can give (a phone's tab bar, which has no hover),
 * pair it with a background tint, which does survive.
 *
 * @module shared/ui/press
 */

/**
 * The transition every press stop shares.
 *
 * **It names the colour properties too, and that is not scope creep.** An
 * element has exactly one `transition-property` list, so a row that carries
 * both `transition-colors` and a press class would silently lose one of them.
 * Naming both here means a press class is the only transition a control needs.
 *
 * Two speeds, the way the identity grammar asks for them: the press lands in
 * 80ms (`--identity-press`, before the finger lifts) and the release rides the
 * slower answer speed back up.
 */
const PRESS_TRANSITION =
  'motion-safe:transition-[color,background-color,border-color,box-shadow,scale] motion-safe:duration-(--identity-answer) motion-safe:ease-(--identity-ease-out) motion-safe:active:duration-(--identity-press)';

/**
 * A whole card is the target — a roster tile, a gallery card, a full-width CTA.
 *
 * The largest surface gets the smallest step: 1% of a 300px card is three
 * pixels of travel, and anything more reads as a jolt rather than an answer.
 */
export const PRESS_CARD = `${PRESS_TRANSITION} motion-safe:active:scale-[0.99]`;

/**
 * A row or a chip is the target — a sidebar row, a session row, a list item.
 */
export const PRESS_ROW = `${PRESS_TRANSITION} motion-safe:active:scale-[0.98]`;

/**
 * A mark is the target — an avatar used as a button, an icon control, an emoji
 * cell.
 *
 * The smallest surface gets the largest step, because a 24px disc moving 1%
 * moves a quarter of a pixel and nobody feels it.
 */
export const PRESS_MARK = `${PRESS_TRANSITION} motion-safe:active:scale-[0.94]`;
