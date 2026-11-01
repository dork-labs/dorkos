/**
 * The look of a form field, spelled once so a primitive and a raw `<input>` or
 * native `<select>` cannot drift.
 *
 * **Only colour properties transition, never `outline-color`.** The ring appears
 * at once: "did my input register?" should not wait, and `transition-colors` would
 * fade it. Disabled uses a muted fill and muted text rather than opacity, so the
 * value stays readable.
 *
 * @module @dork-labs/ui/field-control
 */

/** Border, fill, text size, focus ring and states shared by every field, trigger included. */
export const FIELD_CONTROL =
  'focus-ring text-field border-dui-control-edge dui-dark:bg-dui-input/30 w-full min-w-0 rounded-md border bg-transparent px-3 ' +
  'transition-[color,background-color,border-color] duration-150 motion-reduce:transition-none! ' +
  'hover:border-dui-control-edge-hover ' +
  'aria-invalid:border-dui-destructive aria-invalid:hover:border-dui-destructive ' +
  'disabled:bg-dui-muted disabled:text-dui-muted-foreground disabled:border-dui-input disabled:cursor-not-allowed disabled:hover:border-dui-input';

/** Text entry only: `:read-only` also matches a button, so never put this on a trigger. */
export const FIELD_READ_ONLY =
  'read-only:bg-dui-muted read-only:border-transparent read-only:hover:border-transparent';
