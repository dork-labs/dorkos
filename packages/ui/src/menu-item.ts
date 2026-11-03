/**
 * The one look of everything above the page: its surfaces, how they arrive, and
 * the rows inside a menu.
 *
 * Plain class strings, so the dropdown, context menu and select cannot drift
 * apart, and the app's phone drawer rows can share them.
 *
 * @module @dork-labs/ui/menu-item
 */

/** A menu, list, popover or hover card: no scrim behind it, so dark keeps a hairline. */
export const FLOATING_SURFACE =
  'bg-dui-popover text-dui-popover-foreground dui-dark:border dui-dark:border-dui-border z-(--z-overlay) rounded-lg shadow-lg';

/** A dialog or alert: the scrim and the lift say what it is, so it has no border. */
export const MODAL_SURFACE =
  'bg-dui-popover text-dui-popover-foreground z-(--z-overlay) rounded-xl shadow-xl outline-none';

/**
 * Arrives from the control that opened it: a fade, a small zoom and 4px of travel.
 * All four sides, because Radix flips a surface near a viewport edge.
 */
export const ENTER_FAST =
  'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:duration-(--dui-dur-fast) data-[state=open]:ease-(--dui-ease-out) data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 motion-reduce:animate-none!';

/**
 * Leaves quicker than it came, and never somewhere new. For popovers and hover
 * cards only: menus and selects must close at once (DOR-1834, DOR-1835), because a
 * closing one eats the next press on its trigger.
 */
export const EXIT_FAST =
  'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=closed]:duration-(--dui-dur-instant) data-[state=closed]:ease-(--dui-ease-in)';

/** A modal's clock, for its panel and its scrim alike, so the two land together. */
export const MODAL_CLOCK =
  'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=open]:duration-(--dui-dur-normal) data-[state=open]:ease-(--dui-ease-out) data-[state=closed]:duration-(--dui-dur-fast) data-[state=closed]:ease-(--dui-ease-in) motion-reduce:animate-none! motion-reduce:transition-none!';

/** The panel of a menu. Padding plus the row's radius makes the corners concentric. */
export const MENU_SURFACE = 'max-w-80 min-w-48 p-1';

/**
 * One row in a menu: 32px, or 44px on a phone.
 *
 * The highlight is the keyboard cursor, the same job as a selected row in a list,
 * so it takes the same tint. It has no transition, because a cursor must not lag
 * the key, and no weight change, so a label does not jitter as it moves.
 *
 * Phone sizes use `max-md:` so a caller's own `pl-8` still wins on a desktop.
 */
export const MENU_ITEM =
  "text-dui-control relative flex min-h-8 cursor-default items-center gap-2 rounded-sm px-2 outline-hidden select-none max-md:min-h-11 max-md:gap-3 max-md:px-4 data-highlighted:bg-dui-row-selected data-[state=open]:bg-dui-row-selected data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[variant=destructive]:text-dui-destructive-text data-[variant=destructive]:data-highlighted:bg-dui-destructive/10 dui-dark:data-[variant=destructive]:data-highlighted:bg-dui-destructive/15 data-[variant=destructive]:*:[svg]:text-dui-destructive-text! [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-(--dui-size-icon-sm) [&_svg:not([class*='text-'])]:text-dui-muted-foreground";

/** The left gutter of a row that lines up with checkable ones. */
export const MENU_ITEM_INSET = 'pl-8 max-md:pl-9';

/** A checkable row: the gutter holds its tick, and only the tick says it is checked. */
export const MENU_ITEM_CHECKABLE = 'pr-2 pl-8 max-md:pr-4 max-md:pl-9';

/** Where a checkable row's tick sits, in {@link MENU_ITEM_CHECKABLE}'s gutter. */
export const MENU_ITEM_GLYPH =
  'text-dui-foreground pointer-events-none absolute left-2 flex size-(--dui-size-icon-sm) items-center justify-center';

/**
 * A row in the app's phone drawer: full bleed, 44px, with no line between rows.
 * The press is the only state a thumb has, so it takes the highlight's tint.
 */
export const MENU_ITEM_DRAWER =
  'text-dui-control active:bg-dui-row-selected flex min-h-11 w-full items-center gap-3 px-4 py-2 text-left disabled:pointer-events-none disabled:opacity-50';

/** Groups are split by space, not a line. The role stays for a screen reader. */
export const MENU_SEPARATOR = 'my-1 h-px';

/** The name of a group that deserves one. */
export const MENU_LABEL =
  'text-dui-2xs text-dui-muted-foreground px-2 pt-2 pb-1 font-medium max-md:px-4 max-md:leading-5';

/** A hint for the keyboard, so a phone never shows it. */
export const MENU_SHORTCUT = 'text-dui-2xs text-dui-faint ml-auto tabular-nums max-md:hidden';

/** The chevron on a row that opens a nested menu. */
export const MENU_SUB_CHEVRON = 'text-dui-faint ml-auto size-(--dui-size-icon-xs)';
