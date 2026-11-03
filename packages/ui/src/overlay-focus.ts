/**
 * Where the keyboard lands when a dialog or sheet opens.
 *
 * Left to itself, Radix focuses the first thing that can take focus. That lands
 * on a Delete button in a dialog that starts with one, and on the close button in
 * one with no other control. So: the first field, and otherwise the panel itself,
 * which a screen reader announces by its title.
 *
 * @module @dork-labs/ui/overlay-focus
 */

const FIELD = [
  'input:not([type="hidden"]):not(:disabled):not([tabindex="-1"]):not([aria-hidden="true"])',
  'textarea:not(:disabled):not([tabindex="-1"])',
  'select:not(:disabled):not([tabindex="-1"]):not([aria-hidden="true"])',
  '[contenteditable="true"]',
  '[role="combobox"]:not(:disabled):not([aria-disabled="true"])',
].join(',');

/**
 * Focus an opening panel's first field, or the panel. Hand it to `onOpenAutoFocus`.
 *
 * @param event - The event Radix fires on the panel as it opens.
 */
export function focusFirstFieldOrPanel(event: Event): void {
  const panel = event.currentTarget;
  if (!(panel instanceof HTMLElement)) return;
  event.preventDefault();
  for (const field of panel.querySelectorAll<HTMLElement>(FIELD)) {
    field.focus();
    // A field that isn't drawn refuses focus and leaves it where it was.
    if (document.activeElement === field) return;
  }
  panel.focus();
}
