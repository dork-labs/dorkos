/**
 * The sidebar's glyph sizes, spelled once. (Its focus ring is the row's own,
 * `ROW_FOCUS_CLASS` in `./row`.)
 *
 * Every number here has two halves: the first is a mouse's, the second a
 * thumb's. A phone row is 44px tall, and a 14px glyph in it reads as a speck
 * (Phase 4 B2), so the slot and the glyphs grow with the row rather than staying
 * desktop-sized in a phone-sized box.
 *
 * @module shared/ui/sidebar-glyph
 */

/**
 * A glyph that names a row or acts like a control: a `#`, a door's icon, the
 * "⋮", a section's `+`. 16px with a mouse, 20 with a thumb.
 */
export const SIDEBAR_ICON_CONTROL = 'size-(--size-icon-sm) max-md:size-(--size-icon-md)';

/**
 * A mark that sits inline with a label: mute, pause, a section's chevron.
 * 12px with a mouse, 15 with a thumb.
 */
export const SIDEBAR_ICON_INLINE = 'size-(--size-icon-xs) max-md:size-[15px]';

/**
 * The square a row's glyph sits in: 18px with a mouse, 24 with a thumb. The
 * label after it starts 8px on, or 12 on a phone, so the bigger glyph still has
 * room to breathe.
 */
export const SIDEBAR_GLYPH_SLOT = 'size-[18px] max-md:size-6';

/**
 * A face in that slot: an `xs` avatar is 18px, the desktop slot exactly, and
 * this lets it fill the 24px phone slot too. Without it the disc stayed 18 while
 * its badge and emoji, which are sized off the phone's larger type, grew to cover
 * most of it. Pass to the avatar's `className`; the slot already holds 24.
 */
export const SIDEBAR_FACE = 'max-md:size-6';

/** The gap between a row's glyph slot and its label. See {@link SIDEBAR_GLYPH_SLOT}. */
export const SIDEBAR_GLYPH_GAP = 'ml-2 max-md:ml-3';
