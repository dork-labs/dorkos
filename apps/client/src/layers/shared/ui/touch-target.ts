/**
 * The smallest a control may be under a thumb, spelled once.
 *
 * **Two forms, one number.** Which one a control takes depends on where its
 * height is decided, not on what kind of control it is:
 *
 * - **The `md:` form** ({@link TOUCH_TARGET_RESPONSIVE_H},
 *   {@link TOUCH_TARGET_RESPONSIVE_SIZE}) is for a primitive whose height is
 *   decided in CSS — `Button`, `Input`, `SelectTrigger`, `TabsList`. It needs no
 *   hook and works inside a variant table, so those primitives paint at the
 *   right size on first render instead of flashing the desktop size until a
 *   `useIsMobile()` effect runs.
 * - **The `TOUCH_TARGET_MIN_H` form** is for a surface that has already measured
 *   itself — a row that computes its own height, or one that already holds
 *   `useIsMobile()` for another reason. It is a floor, not a swap.
 *
 * Both spend the same 44px, and both gate on VIEWPORT WIDTH (Tailwind's `md:`,
 * 768px) rather than on touch capability. So the rule is really "narrow screens
 * get more headroom": a resized desktop window under 768px gets the taller
 * target too, and a touch device above it does not. That is deliberate — the
 * width is a proxy for finger-sized targets mattering more, not a claim about
 * the actual input device.
 *
 * @module shared/ui/touch-target
 */

/**
 * 44 CSS pixels of height, as a class.
 *
 * **One constant because the bar is one number and the browser measures all of
 * them.** `design-system.md` puts a touch target at 40–44px and P4 AC-4 sets
 * the floor at 40; every surface on the phone spends the full 44, so there is
 * nothing to remember per call site and nothing to drift.
 *
 * It exists because the first measured pass at 390×844 found four controls
 * under the bar in ONE header — the team menu at 28px, "New" at 27px, the
 * search pill at 33px — each of them fine on a desktop panel and each of them
 * missed by every review that read the source instead of the page. A shared
 * name is what makes the next such control obvious in a diff.
 *
 * Height only: width is the caller's, because a full-width row and a square
 * satellite are both correct and only one of them can be expressed here.
 */
export const TOUCH_TARGET_MIN_H = 'min-h-11';

/**
 * 44px tall under a thumb, back to the desktop 36px past `md`.
 *
 * The height every `responsive` primitive in `shared/ui` grows to: `Input`,
 * `SelectTrigger` and `TabsList` are this class exactly, and `Button` spends it
 * for its default size. Four primitives spelled it out privately before this
 * existed, and `SelectItem` reached the same 44px through padding instead, so a
 * compact select was compact in one half and not the other.
 */
export const TOUCH_TARGET_RESPONSIVE_H = 'h-11 md:h-9';

/**
 * The square sibling of {@link TOUCH_TARGET_RESPONSIVE_H}, for icon-only controls.
 *
 * Width matters here in a way it does not for a text field: an icon button has
 * nothing but its own box to be hit by, so both axes have to grow together.
 */
export const TOUCH_TARGET_RESPONSIVE_SIZE = 'size-11 md:size-9';
