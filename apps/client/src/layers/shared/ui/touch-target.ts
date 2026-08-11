/**
 * The smallest a control may be under a thumb, spelled once.
 *
 * @module shared/ui/touch-target
 */

/**
 * 44 CSS pixels of height, as a class.
 *
 * **One constant because the bar is one number and the browser measures all of
 * them.** `design-system.md` puts a touch target at 40–44px and P4 AC-4 sets
 * the floor at 40; every surface in the phone cockpit spends the full 44, so
 * there is nothing to remember per call site and nothing to drift.
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
